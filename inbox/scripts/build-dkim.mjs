// Bundles verifier.mjs for workerd, optionally redirecting mailauth's node:crypto
// import to crypto-shim.mjs. The redirect is scoped to one importer and the build
// fails unless it fires exactly once, so an upstream refactor cannot silently
// bypass (or silently stop needing) the shim.
import { build } from '../node_modules/esbuild/lib/main.js';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

const here = p => fileURLToPath(new URL(p, import.meta.url));

export async function bundle({ shim = true, entry = '../research/verifier.mjs' } = {}) {
  let redirects = 0;
  let selectorPatches = 0;
  const plugin = {
    name: 'mailauth-crypto-shim',
    setup(b) {
      b.onLoad({ filter: /mailauth[\\/]dist[\\/]esm[\\/]dkim[\\/]syntax\.js$/ }, async args => {
        const source = await readFile(args.path, 'utf8');
        const original = 'const SELECTOR = new RegExp(`^${DOMAIN_LABEL}(?:\\\\.${DOMAIN_LABEL})*$`);';
        if (source.split(original).length !== 2) throw new Error('mailauth selector patch drift');
        selectorPatches++;
        // Narrow interoperability extension: underscores only in selector labels,
        // not d= domains. Preserve every other strict mailauth check.
        return { contents: source.replace(original, () =>
          "const SELECTOR_LABEL = '[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?';\n" +
          'const SELECTOR = new RegExp(`^${SELECTOR_LABEL}(?:\\\\.${SELECTOR_LABEL})*$`);'), loader: 'js' };
      });
      b.onResolve({ filter: /^node:crypto$/ }, args => {
        if (!shim || !/mailauth[\\/]dist[\\/]esm[\\/]dkim[\\/]dkim-verifier\.js$/.test(args.importer)) return null;
        redirects++;
        return { path: here('./crypto-shim.mjs') };
      });
    }
  };
  const result = await build({
    entryPoints: [here(entry)], bundle: true, write: false,
    format: 'esm', platform: 'node', target: 'es2022', minify: true,
    conditions: ['import'], external: ['node:*'], plugins: [plugin],
    // A few transitive CommonJS modules still call require() for node builtins.
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire('/bundle.mjs');" }
  });
  if (shim && redirects !== 1) throw new Error(`crypto shim applied ${redirects} times, expected 1`);
  if (selectorPatches !== 1) throw new Error(`selector patch applied ${selectorPatches} times, expected 1`);
  const code = result.outputFiles[0].text;
  return { code, bytes: Buffer.byteLength(code), gzipBytes: gzipSync(code).length };
}

export async function generateVerifier() {
  const result = await bundle({ entry: '../src/dkim-verifier.mjs' });
  await mkdir(here('../.generated'), { recursive: true });
  await writeFile(here('../.generated/dkim-verifier.mjs'), result.code);
  return result;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await generateVerifier();
  console.log(`DKIM verifier: ${result.bytes} bytes, ${result.gzipBytes} gzip`);
}
