// Stored layout prefs are validated, not trusted: a bad field falls back to its default.
import assert from 'node:assert/strict';
globalThis.document ??= new EventTarget(); // dismiss.ts listens on document at import
const { parsePrefs } = await import('../src/layout.ts');

assert.deepEqual(parsePrefs(null), { widths: {} });
assert.deepEqual(parsePrefs('junk'), { widths: {} });
assert.deepEqual(parsePrefs({ widths: { files: 320, terminal: '9', bogus: 300, usage: NaN }, sideW: 300, side: true, panel: 'usage' }),
  { widths: { files: 320 }, sideW: 300, side: true, panel: 'usage' });
// null is a real choice (the chat); an unknown panel, a stringy flag or width is dropped.
assert.deepEqual(parsePrefs({ panel: null }), { widths: {}, panel: null });
assert.deepEqual(parsePrefs({ panel: 'bogus', side: 'yes', sideW: '300', widths: [1] }), { widths: {} });
assert.deepEqual(parsePrefs({ panel: 'toString' }), { widths: {} });
console.log('layout-node: ok');
