import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { chatClient } from './build-chat.mjs';
import { validate } from '../src/validate.js';
import { ORIGINS } from '../src/policies.js';

const client = await chatClient();
const gate = await readFile(new URL('./chat-gate.js', import.meta.url), 'utf8');

test('gate is inert on auth/private/session documents and stops unresolved observation at its bound', () => {
  for (const mode of ['root', 'session', 'cookie', 'auth', 'private', 'wrong-origin', 'storage-denied']) {
    let observe = 0, disconnect = 0, check, deadline, delay, removed = 0;
    const location = { origin: mode === 'wrong-origin' ? 'https://example.org' : 'https://chat.bayleaf.dev',
      pathname: mode === 'auth' ? '/auth' : mode === 'private' ? '/c/synthetic' : '/' };
    const context = vm.createContext({ location,
      get localStorage() { if (mode === 'storage-denied') throw Error('denied'); return mode === 'session' ? { token: '' } : {}; },
      document: { documentElement: {}, cookie: mode === 'cookie' ? 'token=' : '', getElementById: () => null,
        get referrer() { throw Error('referrer read'); } },
      MutationObserver: class { constructor(fn) { check = fn; } observe() { observe++; } disconnect() { disconnect++; } },
      setTimeout(fn, ms) { deadline = fn; delay = ms; }, clearTimeout() {},
      window: { addEventListener() {}, removeEventListener() { removed++; } },
    });
    vm.runInContext(gate, context);
    assert.equal(observe, mode === 'root' ? 1 : 0, mode);
    if (mode === 'root') {
      assert.equal(delay, 15000);
      check(); // Unresolved DOM alone never loads collection code.
      assert.equal(disconnect, 0);
      deadline();
      assert.equal(disconnect, 1);
      assert.equal(removed, 1);
      check();
      assert.equal(disconnect, 1);
    }
  }
});

test('Chat artifact is reproducible and destination/origin already explicitly admitted', async () => {
  assert.equal(await readFile(new URL('./chat-client.mjs', import.meta.url), 'utf8'), client);
  assert.equal(ORIGINS['https://chat.bayleaf.dev'], 'chat');
  const event = { schema_version: 1, destination: 'chat', referring_hostname: null };
  assert.equal(validate('browser', event, {}).destination, 'chat');
  for (const field of ['visitorID', 'url', 'query', 'referrer', 'account', 'token', 'chat', 'observed_at']) {
    assert.throws(() => validate('browser', { ...event, [field]: 'forbidden' }, {}));
  }
});

test('Chat client rechecks resolved state and never reads referrer, query, text or token values', async () => {
  for (const mode of ['public', 'session', 'cookie', 'private', 'wrong-origin', 'unresolved', 'storage-denied', 'login-race']) {
    const calls = [];
    const storage = mode === 'session' ? { token: 'synthetic-not-exported' } : {};
    const context = vm.createContext({ URL, TextEncoder, AbortController, Response, setTimeout, clearTimeout,
      location: { origin: mode === 'wrong-origin' ? 'https://example.org' : 'https://chat.bayleaf.dev',
        pathname: mode === 'private' ? '/c/synthetic' : '/auth',
        get search() { throw Error('query read'); } },
      get localStorage() { if (mode === 'storage-denied') throw Error('denied'); return storage; },
      document: { cookie: mode === 'cookie' ? 'token=synthetic-not-exported' : '',
        get referrer() { throw Error('referrer read'); },
        getElementById: () => mode === 'unresolved' ? null : {} },
      fetch: async (url, options) => { calls.push({ url, options }); return new Response(null, { status: 204 }); },
    });
    // Exercise the exact generated ESM body with only its export declaration removed.
    const name = client.match(/export\{(\w+) as resolvedChatArrival\}/)[1];
    vm.runInContext(client.replace(/export\{[^}]+\};?/, '') + `;${name}();`
      + (mode === 'login-race' ? 'localStorage.token="synthetic-not-exported";' : `;${name}();`), context);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(calls.length, mode === 'public' ? 1 : 0, mode);
    if (calls.length) {
      const options = calls[0].options;
      assert.deepEqual(JSON.parse(options.body), { schema_version: 1, destination: 'chat', referring_hostname: null });
      assert.deepEqual(Object.keys(options.headers), ['Content-Type']);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.referrer, '');
      assert.equal(options.referrerPolicy, 'no-referrer');
      assert.equal(options.redirect, 'manual');
    }
  }
});
