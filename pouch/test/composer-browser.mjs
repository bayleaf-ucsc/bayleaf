// Repeatable full-UI offline check. Fixture replaces only Tinfoil at build time;
// production artifact is also opened with every network request blocked.
// POUCH_OUT=/approved/temp/build node build.mjs
// POUCH_OUT=/approved/temp/build node test/composer-browser.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || '/private/var/folders/qj/gyqbn5y57956rrqd_g6yfqwr0000gn/T/opencode', 'pouch-composer-'));
const model = (id, multimodal) => ({ id, name: id, tool_calling: true, multimodal, endpoints: ['/v1/chat/completions'] });
const stub = `
const wait = ms => new Promise(r => setTimeout(r,ms));
window.requests=[]; window.titles=[]; window.gate=false;
const chunk=(delta,finish=null)=>({id:'offline',object:'chat.completion.chunk',created:0,model:'old',choices:[{index:0,delta,finish_reason:finish}]});
function sse(deltas, slow=false) { const enc=new TextEncoder(); return new Response(new ReadableStream({async start(c){
  for(const d of deltas){ if(slow) await wait(130); c.enqueue(enc.encode('data: '+JSON.stringify(d)+'\\n\\n')); }
  c.enqueue(enc.encode('data: [DONE]\\n\\n'));c.close();
}}),{headers:{'content-type':'text/event-stream'}}); }
export class TinfoilAI {
  constructor(){ this.openAIOptions={apiKey:'offline'};
    this.chat={completions:{create:async b=>{window.titles.push(b);return {choices:[{message:{content:'Offline title'}}]};}}};
    this.secureClient={fetch:async (url,init)=>{
      const b=JSON.parse(init.body);window.requests.push(b);
      if(window.requests.length===1){while(!window.gate)await wait(10);
        const all=JSON.stringify(b.messages);const path=all.match(/\\/work\\/\\.attachments\\/[a-z0-9-]+-notes\\.txt/)?.[0]||'/work/AGENTS.md';
        return sse([chunk({role:'assistant',tool_calls:[{index:0,id:'offline_read',type:'function',function:{name:'read',arguments:JSON.stringify({path})}}]}),chunk({},'tool_calls')]);}
      if(window.requests.length===2) return sse([chunk({role:'assistant',reasoning_content:'Literal **reasoning**, not markdown. '}),...Array.from({length:14},()=>chunk({reasoning_content:'still thinking. '})),chunk({content:'## Local result\\nRead your file. '+(window.localImagePath?'![local screenshot]('+window.localImagePath+')':'')+'\\n![remote](https://example.invalid/track.png)\\n![unsafe](/work/unsafe.svg)'}),chunk({},'stop')],true);
      return sse([chunk({role:'assistant',content:'Offline response'}),chunk({},'stop')]);
    }};
  }
  async ready(){} async getVerificationDocument(){return {securityVerified:true};}
}
`;
const bundled = await build({ entryPoints: [join(root,'src/main.js')], bundle:true, write:false, format:'iife', alias:{'node:zlib':join(root,'src/shims/zlib.js'),zlib:join(root,'src/shims/zlib.js'),'decode-named-character-reference':join(root,'node_modules/decode-named-character-reference/index.js')}, plugins:[{
  name:'offline-tinfoil', setup(b){b.onResolve({filter:/^tinfoil$/},()=>({path:'offline',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:stub,loader:'js'}));},
}] });
let fixture = readFileSync(join(root,'pouch.html'),'utf8').replace('<script>/*APP*/</script>',()=>'<script>'+bundled.outputFiles[0].text.replaceAll('</script','<\\/script')+'</script>');
const hashes = [...fixture.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([,s])=>`'sha256-${createHash('sha256').update(s).digest('base64')}'`);
fixture = fixture.replace('__SCRIPT_HASHES__',hashes.join(' '));
const production = readFileSync(join(process.env.POUCH_OUT || join(root,'dist'),'pouch.html'));
const server = createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(req.url==='/production'?production:fixture);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url = `http://127.0.0.1:${server.address().port}`;
const errors=[];
async function opfsFiles(page) { return page.evaluate(async()=>{const root=await navigator.storage.getDirectory(), work=await root.getDirectoryHandle('work').catch(()=>root);let dir;try{dir=await work.getDirectoryHandle('.attachments');}catch{return [];}
  const out=[];for await(const [name,h] of dir.entries())out.push({name,bytes:Array.from(new Uint8Array(await(await h.getFile()).arrayBuffer()))});return out;}); }
let context;
try {
  for(const mobile of [false,true]) {
    context=await chromium.launchPersistentContext(join(scratch,mobile?'phone-profile':'desktop-profile'),{headless:true,viewport:mobile?{width:390,height:844}:{width:1280,height:800},isMobile:mobile,hasTouch:mobile,colorScheme:'dark'});
    const network=[];
    await context.route('https://**/*',async r=>{const u=new URL(r.request().url());network.push({url:u.href,method:r.request().method()});
      if(u.pathname==='/sealed/models')return r.fulfill({json:{data:[model('old',false),model('new',true)]}});
      if(u.pathname.includes('usage'))return r.fulfill({json:{}});
      return r.abort();
    });
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(url);await page.waitForSelector('#badge.ok');
    const settings=async()=>{if(mobile){await page.click('#more');await page.getByRole('button',{name:'Settings',exact:true}).click();}else await page.click('#rail [data-panel="settings"]');};
    await settings();assert.equal(await page.locator('#settings #theme-preference').count(),1);assert.equal(await page.locator('#trust #theme-preference').count(),0);
    assert.equal(await page.isChecked('#reasoning-expanded'),false);assert.equal(await page.isChecked('#tools-expanded'),false);
    assert.equal(await page.getAttribute('html','data-theme'),'dark');
    await page.selectOption('#theme-preference','system');await page.emulateMedia({colorScheme:'light'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
    await page.check('#reasoning-expanded');await page.check('#tools-expanded');
    await page.selectOption('#theme-preference','light');await page.reload();await page.waitForSelector('#badge.ok');
    assert.equal(await page.getAttribute('html','data-theme'),'light');
    if(mobile) await settings();
    assert.equal(await page.isChecked('#reasoning-expanded'),true);assert.equal(await page.isChecked('#tools-expanded'),true);
    await page.locator('#settings .panel-close').click();
    await page.click('#welcome-dismiss');
    await page.selectOption('#model','old');
    // Picker and drop use identical ingest and preserve byte-exact originals before auth.
    const raw=Buffer.from('exact text\r\n\u0000binary-tail');
    await page.locator('#attachment-picker').setInputFiles({name:'notes.txt',mimeType:'text/plain',buffer:raw});
    await page.waitForFunction(()=>document.querySelectorAll('.attachment').length===1);
    await page.evaluate(()=>{const dt=new DataTransfer();dt.items.add(new File(['drop bytes'],'drop.txt',{type:'text/plain'}));document.getElementById('composer').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));});
    await page.waitForFunction(()=>document.querySelectorAll('.attachment').length===2);
    assert.equal(await page.evaluate(()=>requests.length),0);
    const saved=await opfsFiles(page);assert.deepEqual(saved.find(f=>f.name.endsWith('-notes.txt')).bytes,Array.from(raw));assert.equal(Buffer.from(saved.find(f=>f.name.endsWith('-drop.txt')).bytes).toString(),'drop bytes');
    await page.getByRole('button',{name:'Remove attachment drop.txt',exact:true}).click();assert.equal(await page.locator('.attachment').count(),1);
    // Local raster for markdown rendering, also exercises browser resize path.
    const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=2400;c.height=1200;c.getContext('2d').fillRect(0,0,2400,1200);return c.toDataURL('image/png').split(',')[1];});
    await page.locator('#attachment-picker').setInputFiles({name:'screen.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
    await page.waitForFunction(()=>document.querySelectorAll('.attachment').length===2);
    await page.evaluate(async()=>{let root=await navigator.storage.getDirectory();let work=await root.getDirectoryHandle('work').catch(()=>root);const dir=await work.getDirectoryHandle('.attachments');for await(const name of dir.keys())if(name.endsWith('-screen.png'))window.localImagePath='/work/.attachments/'+name;});
    await page.fill('#input','Review these files');await page.click('#send');
    await page.waitForFunction(()=>document.getElementById('status').textContent.includes('Choose a model'));
    assert.equal(await page.evaluate(()=>requests.length),0);assert.equal(await page.locator('.attachment').count(),2);
    // Remove image for old-model mid-run test; original remains available in VFS.
    await page.getByRole('button',{name:'Remove attachment screen.png',exact:true}).click();
    await page.click('#send');await page.waitForFunction(()=>requests.length===1);
    await page.selectOption('#model','new');await page.evaluate(()=>window.gate=true);
    await page.waitForSelector('details.reasoning');
    assert.equal(await page.locator('details.reasoning').evaluate(d=>d.open),true);
    assert.equal(await page.locator('details.tool').first().evaluate(d=>d.open),true);
    await page.locator('details.reasoning summary').click();await page.locator('details.tool summary').first().click();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('details.reasoning').evaluate(d=>d.open),false);assert.equal(await page.locator('details.tool').first().evaluate(d=>d.open),false);
    await page.waitForFunction(()=>document.getElementById('send-label').textContent==='Send' && window.titles.length===1);
    assert.deepEqual(await page.evaluate(()=>requests.map(r=>r.model)),['old','old']);assert.equal(await page.evaluate(()=>titles[0].model),'old');
    assert.ok(await page.locator('.attachment-refs').textContent().then(t=>t.includes('notes.txt')));
    assert.match(await page.locator('details.reasoning .thinking').textContent(),/\*\*reasoning\*\*/);
    assert.equal(await page.locator('details.reasoning .thinking strong').count(),0);
    await page.waitForSelector('.local-image img');assert.equal(await page.locator('img[src^="https:"]').count(),0);assert.equal(await page.locator('img[src$="svg"]').count(),0);
    await page.waitForFunction(()=>document.querySelector('.local-image img')?.naturalWidth>0);
    // Actual image paste uses ingest, text paste is not prevented.
    const normal=await page.evaluate(()=>{const dt=new DataTransfer();dt.setData('text/plain','ordinary');const e=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt});document.getElementById('input').dispatchEvent(e);return e.defaultPrevented;});assert.equal(normal,false);
    await page.evaluate(png=>{const dt=new DataTransfer();const raw=Uint8Array.from(atob(png),c=>c.charCodeAt(0));dt.items.add(new File([raw],'paste.png',{type:'image/png'}));document.getElementById('input').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));},png);
    await page.waitForFunction(()=>document.querySelectorAll('.attachment').length===1);
    assert.equal(await page.evaluate(()=>requests.length),2);
    await page.fill('#input','Now see the screenshot');await page.click('#send');await page.waitForFunction(()=>requests.length===3 && document.getElementById('send-label').textContent==='Send');
    assert.equal(await page.evaluate(()=>requests.at(-1).model),'new');
    assert.ok(await page.evaluate(()=>requests.at(-1).messages.at(-1).content.some(b=>b.type==='image_url'&&b.image_url.url.startsWith('data:image/png;base64,'))));
    const dimensions=await page.evaluate(async()=>{const u=requests.at(-1).messages.at(-1).content.find(b=>b.type==='image_url').image_url.url;const img=new Image();img.src=u;await img.decode();return [img.naturalWidth,img.naturalHeight];});assert.deepEqual(dimensions,[2000,1000]);
    for(const mode of ['light','dark']) {
      await settings();await page.selectOption('#theme-preference',mode);
      await page.screenshot({path:join(scratch,`${mobile?'mobile':'desktop'}-${mode}-settings.png`)});
      await page.locator('#settings .panel-close').click();
      await page.screenshot({path:join(scratch,`${mobile?'mobile':'desktop'}-${mode}-chat.png`)});
      const sizes=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,toolbar:document.getElementById('composer-toolbar').getBoundingClientRect().toJSON(),input:document.getElementById('input').getBoundingClientRect().toJSON(),model:document.getElementById('model').getBoundingClientRect().toJSON(),attach:document.getElementById('attach-file').getBoundingClientRect().toJSON(),send:document.getElementById('send').getBoundingClientRect().toJSON()}));
      assert.ok(sizes.scroll<=sizes.width);assert.ok(sizes.toolbar.top>=sizes.input.bottom);assert.ok(sizes.attach.width>=44&&sizes.attach.height>=44&&sizes.send.height>=44&&sizes.model.height>=44);
    }
    await page.reload();await page.waitForSelector('#badge.ok');await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>requests.length),0,'reload makes no inference');
    assert.ok(await page.locator('.attachment-refs').count());
    assert.ok(!network.some(r=>r.method==='POST'),'no HTTP POSTs, including inference');
    // Erase resets both the existing theme and new display preferences.
    page.on('dialog',d=>d.accept());
    if(mobile){await page.click('#more');await page.getByRole('button',{name:'Erase all Pouch data in this browser',exact:true}).click();}else await page.click('#erase');
    await page.click('#sheet-actions button >> text=Erase all'); // asked inline (Batch C: no native confirm)
    await page.waitForSelector('#erased:visible');
    assert.equal(await page.evaluate(()=>localStorage.getItem('pouch.display')),null);assert.equal(await page.evaluate(()=>localStorage.getItem('pouch.theme')),null);
    await page.goto(url+'/production');await page.waitForSelector('#tree .row',{state:'attached'});await page.reload();await page.waitForTimeout(200);
    await page.locator('#attachment-picker').setInputFiles({name:'signed-out.txt',mimeType:'text/plain',buffer:Buffer.from('before authentication')});
    await page.waitForFunction(()=>document.querySelectorAll('.attachment').length===1);
    assert.equal(Buffer.from((await opfsFiles(page)).find(f=>f.name.endsWith('-signed-out.txt')).bytes).toString(),'before authentication');
    assert.equal(await page.locator('#send').isDisabled(),true);
    await context.close();context=null;
  }
  assert.deepEqual(errors,[]);
  console.log('PASS Settings/theme/defaults/streaming overrides, toolbar 390px, picker/drop/paste, exact local bytes, preflight, models/title freeze, vision resize+storage, local raster markdown, reload no inference, erase. Screenshots:',scratch);
} finally { await context?.close();await new Promise(r=>server.close(r)); }
