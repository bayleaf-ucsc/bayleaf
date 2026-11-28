/** Synthetic Toolbox checks for uploadFile's mkdir argv. No real sandbox or credentials. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/daytona.ts'], bundle: true,
  write: false, format: 'esm', platform: 'browser' });
const { uploadFile, unsafeUploadPath } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const env = { DAYTONA_API_KEY: 'synthetic', DAYTONA_DEPLOYMENT_LABEL: 'synthetic' };
const id = 'sbx_fixture';
const sandbox = { id, status: 'running', toolbox_proxy_url: 'https://proxy.ash-1.us-east.daytona.app/toolbox' };
const argvs = [], uploads = [];
globalThis.fetch = async (input, options) => {
  const request = new Request(input, options);
  const url = new URL(request.url);
  if (url.pathname === `/sandboxes/${id}`) return Response.json(sandbox);
  if (url.pathname === `/toolbox/${id}/processes`) {
    argvs.push((await request.json()).argv);
    return Response.json({ id: 'process', exitCode: 0, logs: { frames: [], eof: true } });
  }
  assert.equal(url.pathname, `/toolbox/${id}/files/upload`);
  uploads.push(url.searchParams.get('path'));
  return new Response(null, { status: 200 });
};

// Toolbox takes argv without a shell: spaces stay inside one argument,
// and `$(…)` is literal text, not a substitution.
await uploadFile(id, '/home/daytona/my docs/$(id)/a.txt', new ArrayBuffer(1), env);
assert.deepEqual(argvs, [['mkdir', '-p', '--', '/home/daytona/my docs/$(id)']]);
assert.deepEqual(uploads, ['/home/daytona/my docs/$(id)/a.txt']);

for (const path of ["/home/daytona/it's/a.txt", '/home/daytona/a\nb.txt', '/home/daytona/a\x00.txt'])
  assert.equal(unsafeUploadPath(path), true, JSON.stringify(path));
assert.equal(unsafeUploadPath('/home/daytona/my docs/a.txt'), false);

argvs.length = 0; uploads.length = 0;
await assert.rejects(uploadFile(id, "/home/daytona/x' /etc/y/a.txt", new ArrayBuffer(1), env));
assert.deepEqual([argvs, uploads], [[], []], 'an unsafe path never reaches Toolbox');

console.log('PASS: uploadFile passes mkdir as one argv entry and refuses quote-breaking paths');
