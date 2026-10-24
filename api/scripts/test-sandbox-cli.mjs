import { build } from 'esbuild';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'bayleaf-cli-suite-'));
try {
  const file=join(dir,'tests.mjs');
  const fixture=join(dir,'stdio.mjs');
  await build({entryPoints:['sandbox-cli/stdio-fixture.ts'],outfile:fixture,bundle:true,platform:'node',format:'esm',target:'node22',
    banner:{js:'import { createRequire } from "node:module";const require=createRequire(import.meta.url);'}});
  process.env.BAYLEAF_TEST_STDIO_FIXTURE=fixture;
  await build({entryPoints:['sandbox-cli/test.ts'],outfile:file,bundle:true,platform:'node',format:'esm',target:'node22',
    banner:{js:'import { createRequire } from "node:module";const require=createRequire(import.meta.url);'}});
  await import(pathToFileURL(file).href);
  const main=join(dir,'main.mjs'), link=join(dir,'bayleaf');
  await build({entryPoints:['sandbox-cli/entry.ts'],outfile:main,bundle:true,platform:'node',format:'esm',target:'node22',
    banner:{js:'import { createRequire } from "node:module";const require=createRequire(import.meta.url);'}});
  await symlink(main,link);
  const result=spawnSync(process.execPath,[link,'--help'],{encoding:'utf8'});
  assert.equal(result.status,process.platform==='linux'?0:2);
  assert.match(result.stdout+result.stderr,process.platform==='linux'?/usage/:/linux_sandbox_only/);
} finally { delete process.env.BAYLEAF_TEST_STDIO_FIXTURE; await rm(dir,{recursive:true,force:true}); }
