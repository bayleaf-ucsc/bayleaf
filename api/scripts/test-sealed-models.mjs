/** Credential-free discovery regression checks. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  stdin: { contents: "export { curatedSealedEntries } from './src/routes/wellknown';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'browser',
  jsx: 'automatic', jsxImportSource: 'hono/jsx', loader: { '.py': 'text' },
});
const { curatedSealedEntries } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);
const model = (id, extra = {}) => ({ id, name: id, type: 'chat', endpoints: ['/v1/chat/completions'], ...extra });
const catalog = [
  model('glm', { pricing: { inputTokenPricePer1M: 1.8, outputTokenPricePer1M: 5.75, cachedInputTokenPricePer1M: 0.45 } }),
  model('flash', { deprecated: true }),
  model('cheap', { pricing: { inputTokenPricePer1M: 0.15, outputTokenPricePer1M: 0.6 } }),
  model('experimental', { experimental: true }),
  model('embedding', { type: 'embedding', endpoints: ['/v1/embeddings'] }),
  model('wrong-endpoint', { endpoints: ['/v1/responses'] }),
  model('unknown-endpoint', { endpoints: undefined }),
  model('bad-price', { pricing: { inputTokenPricePer1M: -1, outputTokenPricePer1M: '2' } }),
];
const result = curatedSealedEntries(catalog, ['glm', 'flash', 'missing', 'cheap', 'experimental', 'embedding', 'wrong-endpoint', 'unknown-endpoint', 'bad-price', 'glm']);
assert.deepEqual(Object.keys(result), ['glm', 'cheap', 'experimental', 'bad-price']);
assert.deepEqual(result.glm.cost, { input: 1.8, output: 5.75, cacheRead: 0.45, cacheWrite: 1.8 });
assert.deepEqual(result.cheap.cost, { input: 0.15, output: 0.6, cacheRead: 0.15, cacheWrite: 0.15 });
assert.equal(result['bad-price'].cost, undefined);
assert.deepEqual(curatedSealedEntries([], ['glm']), {});
assert.deepEqual(curatedSealedEntries(catalog, []), {});
assert.deepEqual(curatedSealedEntries([model('glm', { deprecated: true })], ['glm']), {});
console.log('PASS: Sealed ordering, deprecation, chat eligibility, experimental opt-in, and pricing');
