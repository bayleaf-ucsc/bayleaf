// Synthetic HTML only, for the fully intercepted browser harness.
import { build } from '../../api/node_modules/esbuild/lib/main.js';
import { fileURLToPath } from 'node:url';
import { artifacts } from './build.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const result = await build({ absWorkingDir: root, stdin: { contents: `
  import { jsx } from 'hono/jsx';
  import { LandingPage } from './api/src/templates/landing';
  import { renderSandboxPage } from './sandbox/page';
  export async function fixtures() {
    const api = async enabled => '<!doctype html>' + await jsx(LandingPage, {
      showCampusPass:false,recommendedModel:'synthetic/model',loginButtonText:'Sign in',
      browserArrivalsEnabled:enabled }).toString();
    const sandbox = async (user, enabled) => {
      const response = renderSandboxPage(user, {browserArrivalsEnabled:enabled});
      return {html:await response.text(),headers:Object.fromEntries(response.headers)};
    };
    return { api: await api(true), apiDisabled: await api(false),
      sandbox: await sandbox(null,true), sandboxDisabled: await sandbox(null,false),
      sandboxPrivate: await sandbox({email:'synthetic@example.test'},true) };
  }`, resolveDir: root }, bundle: true, write: false, format: 'esm', platform: 'browser',
  jsx: 'automatic', jsxImportSource: 'hono/jsx', nodePaths: [root + 'api/node_modules'] });
const { fixtures } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
console.log(JSON.stringify({ ...await fixtures(), landingActive: (await artifacts({ landingEnabled: true })).landing,
  landingDisabled: (await artifacts({ landingEnabled: false })).landing }));
