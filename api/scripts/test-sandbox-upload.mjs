/** Synthetic Toolbox checks for uploadFile's mkdir argv. No real sandbox or credentials. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/daytona.ts'], bundle: true,
  write: false, format: 'esm', platform: 'browser' });
const { uploadFile, unsafeUploadPath } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const env = { DAYTONA_API_URL: 'https://daytona.example.test/api', DAYTONA_API_KEY: 'synthetic' };
const commands = [];
globalThis.fetch = async (url, options) => {
  if (new URL(url).pathname.endsWith('/process/execute')) commands.push(JSON.parse(options.body).command);
  return new Response('{}', { status: 200 });
};

// Toolbox splits argv but runs no shell: spaces must stay inside one quoted argument,
// and `$(…)` is literal text, not a substitution.
await uploadFile('sbx', '/home/daytona/my docs/$(id)/a.txt', new ArrayBuffer(1), env);
assert.deepEqual(commands, ["mkdir -p -- '/home/daytona/my docs/$(id)'"]);

for (const path of ["/home/daytona/it's/a.txt", '/home/daytona/a\nb.txt', '/home/daytona/a\x00.txt'])
  assert.equal(unsafeUploadPath(path), true, JSON.stringify(path));
assert.equal(unsafeUploadPath('/home/daytona/my docs/a.txt'), false);

commands.length = 0;
await assert.rejects(uploadFile('sbx', "/home/daytona/x' /etc/y/a.txt", new ArrayBuffer(1), env));
assert.deepEqual(commands, [], 'an unsafe path never reaches Toolbox');

console.log('PASS: uploadFile quotes mkdir as one argument and refuses quote-breaking paths');
