import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { dashboardDocument, displayedText } from './dashboard-dom.mjs';

// The only substitutes are browser boundaries: DOM, storage, timers, clipboard
// and HTTP. The emitted client is unmodified; no closure state is captured.
export async function checkTemporaryTokenBrowser(html, request) {
  const section = html.match(/<section\b[^>]*id="temporary-inference-tokens"[^>]*>[\s\S]*?<\/section>/)?.[0];
  assert.ok(section, 'temporary-token card exists');
  const storage = () => {
    const values = new Map();
    return { getItem: key => values.get(String(key)) ?? null,
      setItem: (key, value) => values.set(String(key), String(value)),
      removeItem: key => values.delete(String(key)), clear: () => values.clear(),
      key: index => [...values.keys()][index] ?? null, get length() { return values.size; },
      snapshot: () => JSON.stringify([...values]) };
  };
  const localStorage = storage(), sessionStorage = storage(), copied = [];
  let issued;
  async function load() {
    const pending = new Set(), errors = [];
    const track = promise => {
      pending.add(promise);
      promise.then(() => pending.delete(promise), error => { errors.push(error); pending.delete(promise); });
      return promise;
    };
    const document = dashboardDocument(section, track), timers = new Map();
    const scripts = document.rawTextElements.filter(node => node.tag === 'script');
    assert.equal(scripts.length, 1, 'one temporary-token client script');
    // Inline classic JavaScript only. No external loads, modules, async/defer,
    // nomodule or data blocks. Non-execution metadata is deliberately narrow.
    const { attributes, text: script } = scripts[0];
    assert.ok(Object.keys(attributes).every(name => ['id', 'class', 'nonce', 'type'].includes(name)), 'unsupported executable-script attributes');
    assert.ok(['', 'text/javascript', 'application/javascript'].includes((attributes.type || '').trim().toLowerCase()), 'unsupported executable-script type');
    assert.ok(document.descendants().every(node => Object.keys(node.attributes).every(name => !name.startsWith('on'))), 'inline handlers unsupported in runtime fixture');
    let timer = 0;
    const context = { document, localStorage, sessionStorage, URL, console,
      navigator: { clipboard: { writeText: async text => { copied.push(text); } } },
      setTimeout: callback => { timers.set(++timer, callback); return timer; },
      clearTimeout: id => timers.delete(id),
      fetch: (path, init = {}) => track((async () => {
        assert.ok(['/grants', '/grants/models'].includes(path), 'expected browser endpoint');
        const response = await request(path, init);
        if (path === '/grants' && init.method === 'POST') {
          assert.equal(response.status, 200, 'browser issuance succeeds');
          issued = await response.clone().json();
        }
        return response;
      })()),
    };
    context.window = context;
    runInNewContext(script, context, { timeout: 1000 });
    const settle = async () => {
      // Drain event/fetch continuations, without running the long expiry timer.
      for (let turns = 0; ; turns++) {
        assert.ok(turns < 1000, 'browser work settles');
        await new Promise(resolve => setImmediate(resolve));
        if (!pending.size) break;
      }
      if (errors.length) throw errors[0];
    };
    await settle();
    return { document, settle };
  }
  const assertSecretAbsent = document => {
    assert.ok(issued?.access_token, 'issuance observed at HTTP boundary');
    const secret = issued.access_token;
    assert.ok(!displayedText(document).includes(secret), 'credential absent from visible text');
    const dom = document.descendants().map(node => ({ text: node.textContent, attributes: node.attributes, value: node.value }));
    assert.ok(!JSON.stringify(dom).includes(secret), 'credential absent from DOM, including hidden fields/attributes');
    assert.ok(!String(document.cookie || '').includes(secret), 'credential absent from cookies');
    for (const store of [localStorage, sessionStorage]) {
      assert.ok(!store.snapshot().includes(secret), 'credential absent from storage values');
      assert.ok(!JSON.stringify(store).includes(secret), 'credential absent from storage properties');
    }
  };
  const buttons = document => document.descendants().filter(node => node.tagName === 'BUTTON');
  const page = await load();
  assert.equal(page.document.getElementById('create-grant').disabled, false, 'loaded catalog permits creation');
  page.document.getElementById('grant-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await page.settle();
  assertSecretAbsent(page.document);
  const copy = buttons(page.document).filter(node => displayedText(node) === 'Copy token');
  assert.equal(copy.length, 1, 'only newly created token has Copy');
  assert.ok(displayedText(page.document).includes(issued.name), 'recognition name is displayed');
  copy[0].click(); await page.settle();
  assert.deepEqual(copied, [issued.access_token], 'clipboard receives the exact full credential');
  assertSecretAbsent(page.document);
  const reloaded = await load();
  assertSecretAbsent(reloaded.document);
  assert.ok(displayedText(reloaded.document).includes(issued.name), 'reload retains server recognition metadata');
  assert.equal(buttons(reloaded.document).filter(node => displayedText(node) === 'Copy token').length, 0, 'fresh script cannot recover credential');
  assert.deepEqual(copied, [issued.access_token], 'reload does not copy a credential');
}
