import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { build } from '../../api/node_modules/esbuild/lib/main.js';
import { fileURLToPath } from 'node:url';
import { artifacts, configuration } from './build.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const generated = await artifacts();
const active = await artifacts({ landingEnabled: true });
async function runtime() {
  const bundle = await build({ absWorkingDir: root, entryPoints: ['telemetry/browser/runtime.ts'],
    bundle: true, write: false, format: 'esm' });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
}
const { arrivalScript } = await runtime();

async function execute(code, { origin = 'https://bayleaf.dev', path = '/', failure = false,
  referrer = 'https://example.org/private/filename?secret=token#fragment' } = {}) {
  const calls = [], timers = [];
  const context = vm.createContext({ URL, TextEncoder, AbortController,
    location: { origin, pathname: path }, document: { referrer },
    setTimeout(fn, ms) { timers.push(ms); return setTimeout(fn, failure === 'hang' ? 5 : ms); }, clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (failure === 'hang') return new Promise(() => {});
      if (failure) throw new Error('Synthetic unavailable');
      return new Response(null, { status: 204 });
    },
  });
  vm.runInContext(code, context);
  await new Promise(resolve => setTimeout(resolve, failure === 'hang' ? 15 : 0));
  return { calls, timers };
}

test('checked-in bundles match shared policy and explicit landing configuration', async () => {
  assert.equal(await readFile(new URL('./runtime.ts', import.meta.url), 'utf8'), generated.runtime);
  assert.equal(await readFile(new URL('../../landing/arrival.js', import.meta.url), 'utf8'), generated.landing);
  assert.equal((await execute(generated.landing)).calls.length, Number((await configuration()).landingEnabled));
  assert.equal((await execute((await artifacts({ landingEnabled: false })).landing)).calls.length, 0);
  assert.equal((await execute(active.landing)).calls.length, 1);
  const html = await readFile(new URL('../../landing/index.html', import.meta.url), 'utf8');
  assert.match(html, /<script defer src="arrival.js" referrerpolicy="no-referrer"><\/script>/);
});

test('all public destinations send only approved schema and hostname, with credential/referrer omission', async () => {
  for (const [destination, origin, code] of [
    ['landing', 'https://bayleaf.dev', active.landing],
    ['api', 'https://api.bayleaf.dev', arrivalScript('api')],
    ['sandbox', 'https://sandbox.bayleaf.dev', arrivalScript('sandbox')],
  ]) {
    const { calls, timers } = await execute(code, { origin });
    assert.equal(calls.length, 1);
    const { url, options } = calls[0];
    assert.equal(url, 'https://telemetry.bayleaf.dev/v1/browser');
    assert.deepEqual(JSON.parse(options.body), { schema_version: 1, destination, referring_hostname: 'example.org' });
    assert.deepEqual(Object.keys(options.headers), ['Content-Type']);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrer, '');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.cache, 'no-store');
    assert.deepEqual(timers, [1000]);
  }
});

test('exact origin/root only: no private routes, chat, previews, or client navigation hooks', async () => {
  for (const [origin, code] of [
    ['https://bayleaf.dev', active.landing], ['https://api.bayleaf.dev', arrivalScript('api')],
    ['https://sandbox.bayleaf.dev', arrivalScript('sandbox')],
  ]) {
    for (const path of ['/dashboard', '/c/private-chat', '/auth/callback', '/login', '/services/openchamber/status']) {
      assert.equal((await execute(code, { origin, path })).calls.length, 0);
    }
    for (const wrongOrigin of ['https://chat.bayleaf.dev', 'https://owner-private-preview.bayleaf.dev']) {
      assert.equal((await execute(code, { origin: wrongOrigin })).calls.length, 0);
    }
  }
  assert(!generated.runtime.includes('addEventListener'));
  assert(!generated.runtime.includes('localStorage'));
  assert(!generated.runtime.includes('sendBeacon'));
});

test('failures are dropped without retry; hanging request aborts in bounded budget', async () => {
  for (const failure of [true, 'hang']) {
    const { calls, timers } = await execute(active.landing, { failure });
    assert.equal(calls.length, 1);
    assert.deepEqual(timers, [1000]);
    if (failure === 'hang') assert.equal(calls[0].options.signal.aborted, true);
  }
});

test('private/IP/credentialed referrers are nulled by shared adapter in actual bundle', async () => {
  for (const referrer of ['https://127.0.0.1/private', 'https://user:password@example.org/private',
    'https://owner-private-preview.bayleaf.dev/private', 'https://0123456789abcdef.example.org/private']) {
    const { calls } = await execute(active.landing, { referrer });
    assert.equal(JSON.parse(calls[0].options.body).referring_hostname, null);
  }
});

test('API landing prop defaults off and is not shared by private templates', async () => {
  const result = await build({ absWorkingDir: root, stdin: { contents: `
    import { jsx } from 'hono/jsx';
    import { LandingPage } from './api/src/templates/landing';
    export async function render(enabled) { return (await jsx(LandingPage, {
      showCampusPass:false,recommendedModel:'synthetic/model',loginButtonText:'Sign in',
      ...(enabled === undefined ? {} : {browserArrivalsEnabled:enabled})
    }).toString()); }`, resolveDir: root }, bundle: true, write: false, format: 'esm',
    platform: 'browser', jsx: 'automatic', jsxImportSource: 'hono/jsx', nodePaths: [root + 'api/node_modules'] });
  const { render } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
  assert(!(await render()).includes('BayLeafArrival'));
  assert(!(await render(false)).includes('BayLeafArrival'));
  assert((await render(true)).includes('BayLeafArrival.publicArrival("api",true)'));
  for (const file of ['layout.tsx', 'dashboard.tsx', 'grants.tsx']) {
    assert(!(await readFile(root + 'api/src/templates/' + file, 'utf8')).includes('telemetry/browser'));
  }
});
