#!/usr/bin/env node
// Parent-owned source artifact: no independent Git/npm publication required.
import { build } from 'esbuild';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const api = fileURLToPath(new URL('../', import.meta.url));
const result = await build({ entryPoints: [api + 'sandbox-cli/entry.ts'], bundle: true, platform: 'node',
  format: 'esm', target: 'node22', write: false, minify: true,
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";const require=__createRequire(import.meta.url);' } });
const source = result.outputFiles[0].text;
const skill = await readFile(api + 'sandbox-cli/SKILL.md', 'utf8');
await mkdir(api + 'sandbox-cli/dist', { recursive: true });
await writeFile(api + 'sandbox-cli/dist/bayleaf.mjs', source, { mode: 0o700 });
// Build-time schema projection works on the operator's Mac too, without running
// the deliberately Linux-only executable or reading any credential.
const catalog = await build({ stdin: { contents: 'import {tools} from "./sandbox-cli/contracts.ts"; export default tools.map(({name,group})=>({name,group}));',
  resolveDir: api }, bundle: true, platform: 'node', format: 'esm', write: false });
const { default: tools } = await import('data:text/javascript;base64,' + Buffer.from(catalog.outputFiles[0].text).toString('base64'));
const groups = Object.fromEntries(['computer', 'inboxes', 'previews'].map(group => [group,
  tools.filter(tool => tool.group === group).map(tool => tool.name)]));
await writeFile(api + '.sandbox-cli-assets.json', JSON.stringify({ 'bayleaf.mjs': source, 'SKILL.md': skill,
  groups, sha256: createHash('sha256').update(source).digest('hex'), version: '0.1.0' }));
console.log('Built parent-owned sandbox CLI/MCP assets');
