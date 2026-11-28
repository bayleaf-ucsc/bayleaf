/** Same-origin browser adapter tests. Fake RPC, no external services or compute. */
import assert from 'node:assert/strict';
import { build } from '../api/node_modules/esbuild/lib/main.js';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({ absWorkingDir: root, entryPoints: ['sandbox/worker.js'],
  bundle: true, write: false, format: 'esm', platform: 'browser',
  jsx: 'automatic', jsxImportSource: 'hono/jsx', nodePaths: [root + 'api/node_modules'] });
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const origin = 'https://sandbox.bayleaf.dev';
const sessionCookie = '__Host-bayleaf-sandbox-session=synthetic-session';
const transactionCookie = '__Host-bayleaf-sandbox-transaction=synthetic-verifier';
const calls = [], background = [];
let failWake = false, authenticated = true, validExchange = true;
let managedReply;
const management = {
  async beginLogin(input) { calls.push(['begin', input]); return { flow: 'flow', authorizeUrl: 'https://api.bayleaf.dev/auth/services/authorize?flow=flow' }; },
  async proveLogin(input) { calls.push(['prove', input]); return { authorizeUrl: 'https://api.bayleaf.dev/auth/services/authorize?flow=flow' }; },
  async exchangeLogin(input) { calls.push(['exchange', input]); return validExchange ? { session: 'synthetic-session', expiresAt: Math.floor(Date.now()/1000)+3600 } : null; },
  async readSession(input) { calls.push(['read', input]); return authenticated ? { user: { email: 'owner@example.test', name: '<script>untrusted</script>' } } : null; },
  async logout(input) { calls.push(['logout', input]); return true; },
  async desktopEmbed(input) { calls.push(['embed', input]);
    return { status: 200, body: { url: 'https://owner-private-000000000000000000000000.bayleaf-proxies.dev/__preview/embed?code=' + 'a'.repeat(64) } }; },
  async managed(input) {
    calls.push(['managed', input]);
    if (input.operation === 'wake-existing' && failWake) throw Error('synthetic unavailable');
    if (input.operation !== 'wake-existing' && !['opencode-web', 'code-server', 'dufs', 'ttyd'].includes(input.service))
      return { status: 400, body: { error: 'invalid_operation' } };
    return managedReply ?? { status: 200, body: { phase: 'idle', machine: 'absent' } };
  },
};
async function request(path, { method = 'GET', cookie, headers = {}, host = origin, browserArrivalsEnabled } = {}) {
  return worker.fetch(new Request(host + path, { method, headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) } }),
    { MANAGEMENT: management, BROWSER_ARRIVALS_ENABLED: browserArrivalsEnabled }, { waitUntil(promise) { background.push(promise); } });
}
const mutations = () => calls.filter(([name, input]) => name === 'managed' && input.operation !== 'status');
const discoveryCalls = calls.length;
const discovery = await request('/llms.txt', { cookie: sessionCookie });
assert.equal(discovery.status, 200);
assert.match(discovery.headers.get('content-type'), /^text\/plain/);
assert.match(await discovery.text(), /https:\/\/api\.bayleaf\.dev\/llms\.txt/);
assert.equal(await (await request('/llms.txt', { method: 'HEAD' })).text(), '');
assert.equal(calls.length, discoveryCalls, 'Discovery never authenticates or wakes compute');

let response = await request('/');
assert.equal(response.status, 200);
assert.equal(response.headers.get('Link'), '</llms.txt>; rel="describedby"');
assert.equal((await request('/', { method: 'HEAD' })).headers.get('Link'), '</llms.txt>; rel="describedby"');
assert.equal(response.headers.get('Referrer-Policy'), 'strict-origin', 'native sign-in forms need an Origin header');
let html = await response.text();
assert(!html.includes('/services/openchamber') && !html.includes('openchamber-start'), 'retired hosted OpenChamber has no card');
assert(html.includes('href="https://openchamber.dev/">OpenChamber</a>'), 'desktop OpenChamber is the next step');
assert(!/nanobot/i.test(html), 'retired agent is not advertised');
assert(html.includes('OpenCode Web'));
assert(html.includes('code-server'));
assert(html.includes('Files (dufs)'));
assert(html.includes('Shell (ttyd)'));
assert(!/collabmd/i.test(html), 'retired collaborative editor is not advertised');
assert(html.includes('VS Code (code-server)'));
assert(html.includes('A small computer in the cloud'));
assert(html.includes('on your own computer'));
assert(!html.includes('App help &amp; diagnostics'));
assert(html.includes('class="callout"'), 'retention warning is outside disclosures');
for (const url of ['https://opencode.ai/docs/cli/web',
  'https://github.com/coder/code-server', 'https://jupyter.org/',
  'https://github.com/sigoden/dufs', 'https://tsl0922.github.io/ttyd/']) {
  assert(html.includes('href="'+url+'">'+url+'</a>'), 'upstream URL is fully visible');
}
assert(!html.includes('id="dufs-start"'));
assert(!html.includes('id="code-server-start"'));
assert(!html.includes('browser-restart'));
assert.match(html, /class="screen" aria-hidden="true"/);
assert(!html.includes('screen-connect'), 'hero is decorative, not a sign-in or launch control');
assert(!html.includes('<iframe') && !html.includes('id="screen-frame"') && !html.includes('id="screen-connect"'), 'signed-out screen never frames');
assert(!response.headers.get('Content-Security-Policy').includes('frame-src'));
assert.equal(calls.length, 0, 'anonymous overview does not contact management');
assert.equal((await request('/', { method: 'HEAD' })).status, 200);
assert.equal((await request('/login')).status, 303);
assert.equal(calls.length, 0, 'prefetched login link is passive');
for (const badOrigin of [undefined, 'https://chat.bayleaf.dev', 'https://attacker.example']) {
  assert.equal((await request('/login', { method: 'POST', headers: badOrigin ? { Origin: badOrigin } : {} })).status, 403);
}
response = await request('/login', { method: 'POST', headers: { Origin: origin } });
assert.equal(response.status, 200);
assert.match(await response.text(), /http-equiv="refresh"/);
assert.match(calls.at(-1)[1].verifierHash, /^[a-f0-9]{64}$/);
assert.match(response.headers.get('Set-Cookie'), /Secure; HttpOnly; SameSite=Lax/);
assert(!response.headers.get('Set-Cookie').includes('Domain='));
assert.equal(mutations().length, 0);
assert.equal((await request('/auth/prove?flow=flow')).status, 400);
assert.equal((await request('/auth/prove?flow=flow', { cookie: transactionCookie })).status, 303);
assert.equal((await request('/auth/callback?flow=flow&code=code')).status, 400);
validExchange = false;
assert.equal((await request('/auth/callback?flow=flow&code=code', { cookie: transactionCookie })).status, 400);
assert.equal(mutations().length, 0);
validExchange = true; failWake = true;
response = await request('/auth/callback?flow=flow&code=code', { cookie: transactionCookie });
assert.equal(response.status, 303, 'wake outage must not block login');
await Promise.all(background);
assert.equal(mutations().length, 1);
assert.equal(mutations()[0][1].operation, 'wake-existing');
assert.match(response.headers.get('Set-Cookie'), /__Host-bayleaf-sandbox-session=synthetic-session/);
for (let i=0; i<3; i++) {
  response = await request('/', { cookie: sessionCookie });
  html = await response.text();
  assert.match(response.headers.get('Cache-Control'), /\bno-store\b/);
  assert(!html.includes('<script>untrusted</script>'));
  assert(!/collabmd|room_password|copy-password|copy-link|End sharing/i.test(html), 'retired sharing controls and presentation are absent');
  assert.equal((await request('/services/opencode-web/status', { cookie: sessionCookie })).status, 200);
}
assert.equal(mutations().length, 1, 'refresh and status never repeat login wake');
assert(html.includes('id="code-server-start"'));
assert(html.includes('id="opencode-web-start"'));
assert(!html.includes('screen-connect') && !html.includes('screen-frame') && !html.includes('<iframe'), 'signed-in hero remains static');
assert(html.includes('Start with OpenCode Web'));
assert.match(html, /id="desktop-open"[^>]+target="_blank"/);
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
assert.equal(new Set(ids).size,ids.length,'service controls have unique ids');
for (const service of ['opencode-web', 'code-server', 'dufs', 'ttyd', 'openchamber', 'unknown']) {
  const path='/services/'+service;
  const live=!['openchamber','unknown'].includes(service);
  assert.equal((await request(path+'/status')).status,401);
  assert.equal((await request(path+'/status',{cookie:sessionCookie})).status,live?200:400);
  assert.equal((await request(path+'/start',{method:'POST',cookie:sessionCookie})).status,403);
  assert.equal((await request(path+'/start',{method:'POST',cookie:sessionCookie,
    headers:{Origin:origin,'X-BayLeaf-Action':'managed-service'}})).status,live?200:400);
  assert.equal((await request(path+'/stop',{method:'POST',cookie:sessionCookie})).status,403);
  assert.equal((await request(path+'/stop',{method:'POST',cookie:sessionCookie,
    headers:{Origin:origin,'X-BayLeaf-Action':'managed-service'}})).status,live?200:400);
}
assert.equal((await request('/services/opencode-web/start', { method: 'POST' })).status, 401);
assert.equal((await request('/services/opencode-web/start', { method: 'POST', cookie: sessionCookie,
  headers: { Origin: 'https://chat.bayleaf.dev', 'X-BayLeaf-Action': 'managed-service' } })).status, 403);
assert.equal((await request('/services/opencode-web/start', { method: 'POST', cookie: sessionCookie,
  headers: { Origin: origin } })).status, 403);
assert.equal((await request('/services/opencode-web/start', { method: 'POST', cookie: sessionCookie,
  headers: { Origin: origin, 'X-BayLeaf-Action': 'managed-service' } })).status, 200);
assert.deepEqual(calls.at(-1), ['managed', { session: 'synthetic-session', service: 'opencode-web', operation: 'start' }]);
assert.equal((await request('/services/opencode-web/start', { cookie: sessionCookie })).status, 405);
// Desktop embed: same exact-Origin action protections; desktop only; never a lifecycle call.
const beforeEmbed = mutations().length;
const embedHeaders = { Origin: origin, 'X-BayLeaf-Action': 'managed-service' };
assert.equal((await request('/services/desktop/embed', { cookie: sessionCookie })).status, 405);
assert.equal((await request('/services/desktop/embed', { method: 'POST', headers: embedHeaders })).status, 401);
assert.equal((await request('/services/desktop/embed', { method: 'POST', cookie: sessionCookie })).status, 403);
assert.equal((await request('/services/desktop/embed', { method: 'POST', cookie: sessionCookie,
  headers: { Origin: 'https://attacker.example', 'X-BayLeaf-Action': 'managed-service' } })).status, 403);
assert.equal((await request('/services/desktop/embed', { method: 'POST', cookie: sessionCookie, headers: { Origin: origin } })).status, 403);
assert.equal(calls.filter(([name]) => name === 'embed').length, 0);
response = await request('/services/desktop/embed', { method: 'POST', cookie: sessionCookie, headers: embedHeaders });
assert.equal(response.status, 200);
assert.match(response.headers.get('Cache-Control'), /no-store/);
assert.deepEqual(calls.at(-1), ['embed', { session: 'synthetic-session' }]);
for (const other of ['opencode-web', 'code-server', 'unknown']) {
  assert.equal((await request('/services/'+other+'/embed', { method: 'POST', cookie: sessionCookie, headers: embedHeaders })).status, 404);
}
assert.equal(calls.filter(([name]) => name === 'embed').length, 1, 'only Desktop mints embed codes');
assert.equal(mutations().length, beforeEmbed, 'embed never starts, stops or wakes');
assert.equal((await request('/logout', { method: 'POST', cookie: sessionCookie })).status, 403);
response = await request('/logout', { method: 'POST', cookie: sessionCookie, headers: { Origin: origin } });
assert.equal(response.status, 303); assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
authenticated = false;
response = await request('/', { cookie: sessionCookie });
assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
assert.equal((await request('/', { host: 'https://attacker.example' })).status, 400);
assert.equal((await request('/services/opencode-web/status', { method: 'OPTIONS' })).status, 405);
assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
for (const flag of [undefined, 'false', 'TRUE', true]) {
  assert(!(await (await request('/', { browserArrivalsEnabled: flag })).text()).includes('BayLeafArrival'));
}
response = await request('/', { browserArrivalsEnabled: 'true' });
html = await response.text();
assert(html.includes('BayLeafArrival.publicArrival("sandbox",true)'));
assert(response.headers.get('Content-Security-Policy').includes('connect-src \'self\' https://telemetry.bayleaf.dev;'));
assert.match(html, /<script nonce="[^"]+">/);
authenticated = true;
response = await request('/', { cookie: sessionCookie, browserArrivalsEnabled: 'true' });
assert(!(await response.text()).includes('BayLeafArrival'));
assert(!response.headers.get('Content-Security-Policy').includes('telemetry.bayleaf.dev'));
for (const path of ['/login', '/auth/callback', '/dashboard', '/services/opencode-web/status']) {
  assert(!(await (await request(path, { browserArrivalsEnabled: 'true' })).text()).includes('BayLeafArrival'));
}
// Neither page permits embedded desktops; default-src none also blocks frames.
{
  const anonymous = (await request('/')).headers.get('Content-Security-Policy');
  const signedIn = (await request('/', { cookie: sessionCookie })).headers.get('Content-Security-Policy');
  const strip = csp => csp.replace(/'nonce-[^']+'/g, 'NONCE');
  assert(!anonymous.includes('frame-src'));
  assert.equal(strip(signedIn), strip(anonymous));
  assert.match(signedIn, /frame-ancestors 'none'/);
}
// Execute the actual controls script with a tiny DOM, not a duplicated renderer.
const signedInHtml=await(await request('/',{cookie:sessionCookie})).text();
const controls=[...signedInHtml.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].at(-1)[1];
for(const [snapshot,expected] of [
  [{phase:'ready',machine:'stopped',operation:'synthetic'},true],
  [{phase:'expired',machine:'started',operation:'synthetic'},true],
  [{phase:'failed',machine:'started',operation:'synthetic'},true],
  [{phase:'stopped',cleanup_pending:true,access_revoked:true},true],
  [{phase:'stopped',cleanup_pending:false,access_revoked:true},false],
  [{phase:'idle',machine:'started'},false],
]) {
  const elements=new Map();
  const element=id=>{
    if(!elements.has(id))elements.set(id,{hidden:true,textContent:'',setAttribute(){},removeAttribute(){},
      addEventListener(){},replaceChildren(){}});
    return elements.get(id);
  };
  const root={dataset:{service:'opencode-web',endpoint:'/services/opencode-web'},querySelector:element};
  runInNewContext(controls,{URL,Date,document:{querySelectorAll:()=>[root],createElement:()=>({})},
    window:{addEventListener(){}},setTimeout(){},clearTimeout(){},setInterval(){},
    fetch:async()=>({ok:true,status:200,json:async()=>snapshot})});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(!element('#opencode-web-stop').hidden,expected,'stop visibility for '+JSON.stringify(snapshot));
}
// Execute Desktop controls to prove page loads stay passive and Start stays explicit.
function desktopPage(initial, {service='desktop', blockPopup=false}={}) {
  const elements=new Map(), fetches=[], frames=[], timers=[], tabs=[], events=[];
  const page={snapshot:initial,elements,fetches,frames,timers,tabs,events};
  const element=id=>{
    if(!elements.has(id)){const listeners={};elements.set(id,{hidden:true,disabled:false,dataset:{},textContent:'',children:[],attributes:{},listeners,focused:0,
      setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];delete this.href;},
      addEventListener(name,fn){listeners[name]=fn;},replaceChildren(...c){this.children=c;},focus(){this.focused++;}});}
    return elements.get(id);
  };
  page.element=element;
  const root={dataset:{service,endpoint:'/services/'+service},querySelector:element};
  runInNewContext(controls,{URL,Date,document:{querySelectorAll:()=>[root],getElementById:id=>element('#'+id),
      createElement:tag=>{const f={tag,attributes:{},setAttribute(k,v){this.attributes[k]=v;}};frames.push(f);return f;}},
    window:{addEventListener(){},open(url,target){
      events.push('open');
      assert.equal(url,'about:blank');assert.equal(target,'_blank');
      if(blockPopup)return null;
      const tab={closed:false,opener:{},document:{body:{},head:{append(){}},createElement:()=>({})},
        location:{replace(url){assert.equal(tab.opener,null);tab.url=url;}},
        close(){this.closed=true;}};
      tabs.push(tab);
      return tab;
    }},setTimeout(fn){timers.push(fn);},clearTimeout(){},setInterval(){},
    fetch:async(path,init={})=>{fetches.push([path,init]);
      events.push(path);
      if(path.endsWith('/embed'))return {ok:true,status:200,json:async()=>({url:'https://owner-private-000000000000000000000000.bayleaf-proxies.dev/__preview/embed?code='+'a'.repeat(64)})};
      if(path.endsWith('/start')) {
        if(page.startReply)return page.startReply();
        page.snapshot={phase:'opening',progress:'starting_desktop',machine:'started',operation:'synthetic'};
      }
      if(path.endsWith('/stop'))page.snapshot={phase:'stopped',access_revoked:true,cleanup_pending:false};
      return {ok:true,status:200,json:async()=>page.snapshot};}});
  return page;
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const embeds=page=>page.fetches.filter(([p])=>p.endsWith('/embed'));
const desktopUrl='https://owner-private-000000000000000000000000.bayleaf-proxies.dev/vnc.html';
{
  // Ready after reload: status only, with the ordinary new-tab link available.
  const page=desktopPage({phase:'ready',machine:'started',operation:'synthetic',url:desktopUrl});
  const el=page.element;
  await settle();
  assert.deepEqual(page.fetches.map(([path])=>path),['/services/desktop/status']);
  assert.equal(el('#desktop-open').hidden,false);
  assert.equal(el('#desktop-open').href,desktopUrl);
  assert.equal(el('#desktop-open-checked').hidden,true);
  assert.equal(embeds(page).length,0);
  assert.equal(page.frames.length,0);
  await el('#desktop-stop').listeners.click();
  await settle();
  assert.equal(el('#desktop-open').hidden,true,'Stop app removes the new-tab link');
}
{
  // Not running: only the card's explicit Start requests setup.
  const page=desktopPage({phase:'idle',machine:'started'});
  const el=page.element;
  await settle();
  assert.deepEqual(page.fetches.map(([path])=>path),['/services/desktop/status']);
  assert.equal(el('#desktop-start').hidden,false);
  assert.equal(embeds(page).length,0);
  await el('#desktop-start').listeners.click();
  const start=page.fetches.find(([p])=>p.endsWith('/start'));
  assert.equal(start[0],'/services/desktop/start');
  assert.equal(start[1].method,'POST');
  assert.equal(start[1].headers['X-BayLeaf-Action'],'managed-service');
  assert.equal(embeds(page).length,0,'no embed while starting');
  assert.equal(el('#desktop-status').textContent,'Starting the desktop…','card keeps the detailed status');
  page.snapshot={phase:'ready',machine:'started',operation:'synthetic',url:desktopUrl};
  page.timers.at(-1)();
  await settle(); await settle();
  assert.equal(embeds(page).length,0,'Start never embeds a live screen');
  assert.equal(page.frames.length,0);
  assert.equal(el('#desktop-open').hidden,false);
  assert.equal(el('#desktop-open').href,desktopUrl);
}
const v2Ready={phase:'ready',machine:'started',operation:'old',url:desktopUrl,validate_open:true};
const verifiedUrl=desktopUrl.replace('/vnc.html','/vnc.html?autoconnect=true&path=websockify');
const reply=(body,status=200)=>({ok:status<400,status,json:async()=>body});
{
  for(const body of [v2Ready,{phase:'stopped',cleanup_pending:true,can_resume_cleanup:true}]) {
    managedReply={status:200,body};
    const response=await request('/services/opencode-web/status',{cookie:sessionCookie});
    assert.deepEqual(await response.json(),body,'adapter preserves v2 status capabilities');
  }
  managedReply=undefined;
}
{
  const page=desktopPage(v2Ready);
  page.startReply=()=>reply({...v2Ready,url:verifiedUrl});
  await settle();
  const el=page.element;
  assert.deepEqual(page.events,['/services/desktop/status'],'ready status never performs validation');
  assert.equal(el('#desktop-open').href,undefined);
  assert.equal(el('#desktop-open').hidden,true);
  assert.equal(el('#desktop-open-checked').hidden,false);
  const launched=el('#desktop-open-checked').listeners.click();
  assert.deepEqual(page.events.slice(-2),['open','/services/desktop/start'],'reserve the popup synchronously');
  assert.equal(page.tabs[0].url,undefined,'never navigate to the passive URL while awaiting POST');
  await launched;
  assert.equal(page.tabs[0].url,verifiedUrl,'preserve the server-provided Desktop landing URL');
  assert.equal(embeds(page).length,0);
}
{
  const page=desktopPage(v2Ready,{service:'opencode-web'});
  const opening={phase:'opening',machine:'started',operation:'replacement'};
  page.startReply=()=>{page.snapshot=opening;return reply(opening,202);};
  await settle();
  await page.element('#opencode-web-open-checked').listeners.click();
  assert.equal(page.tabs[0].url,undefined);
  page.snapshot={...v2Ready,operation:opening.operation,url:'https://new-preview.example.test/'};
  page.timers.at(-1)();
  await settle();
  assert.equal(page.tabs[0].url,page.snapshot.url,'wait for the replacement from this launch');
  assert.deepEqual(page.fetches.map(([path,init])=>[path,init.method??'GET']),[
    ['/services/opencode-web/status','GET'],['/services/opencode-web/start','POST'],
    ['/services/opencode-web/status','GET'],['/services/opencode-web/status','GET'],
  ]);
}
{
  const page=desktopPage(v2Ready,{blockPopup:true});
  page.startReply=()=>reply({...v2Ready,url:verifiedUrl});
  await settle();
  assert.equal(page.element('#desktop-open').hidden,true);
  await page.element('#desktop-open-checked').listeners.click();
  assert.equal(page.element('#desktop-open').hidden,false);
  assert.equal(page.element('#desktop-open').href,verifiedUrl,'blocked popup falls back to a verified native link');
  page.timers.at(-1)();
  assert.equal(page.element('#desktop-open').hidden,true,'native fallback expires');
  assert.equal(page.element('#desktop-open-checked').hidden,false);
}
{
  const page=desktopPage(v2Ready);
  page.startReply=()=>reply({error:'lifecycle_unavailable'},503);
  await settle();
  await page.element('#desktop-open-checked').listeners.click();
  assert.equal(page.tabs[0].closed,true);
  assert.equal(page.element('#desktop-open').hidden,true,'failed validation cannot expose the old link');
}
{
  const page=desktopPage(v2Ready);
  const opening={phase:'opening',machine:'started',operation:'replacement'};
  page.startReply=()=>{page.snapshot=opening;return reply(opening,202);};
  await settle();
  await page.element('#desktop-open-checked').listeners.click();
  assert.equal(page.tabs[0].closed,false);
  await page.element('#desktop-stop').listeners.click();
  assert.equal(page.tabs[0].closed,true,'Stop closes only the pending tab and submits the no-wake action');
}
for(const canResume of [true,false]) {
  const page=desktopPage({phase:'stopped',machine:'paused',cleanup_pending:true,access_revoked:true,
    ...(canResume?{can_resume_cleanup:true}:{})});
  await settle();
  const el=page.element;
  assert.equal(el('#desktop-start').hidden,!canResume);
  assert.equal(el('#desktop-stop').hidden,false);
  assert.deepEqual(page.events,['/services/desktop/status']);
  if(canResume) {
    assert.match(el('#desktop-start').textContent,/^Resume to finish cleanup/);
    await el('#desktop-start').listeners.click();
    assert.deepEqual(page.events.slice(1),['/services/desktop/start','/services/desktop/status']);
  }
  await el('#desktop-stop').listeners.click();
  assert.equal(page.events.at(-2),'/services/desktop/stop','Stop issues only the no-wake action');
  assert.equal(page.tabs.length,0);
}
console.log('PASS sandbox overview, host-only login, CSRF, escaped identity, one-shot wake, passive reads, service dispatch, logout, no-wake stop controls and static hero');
