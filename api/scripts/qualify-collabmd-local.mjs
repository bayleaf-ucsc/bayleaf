/** Local real-package smoke, invoked by qualify-collabmd-local.py. No BayLeaf credentials. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
const [app, root] = process.argv.slice(2);
const require = createRequire(app+'/package.json');
const WebSocket = require('ws');
const Y = require('yjs');
const sync = await import(pathToFileURL(require.resolve('y-protocols/sync')).href);
const encoding = await import(pathToFileURL(require.resolve('lib0/encoding')).href);
const decoding = await import(pathToFileURL(require.resolve('lib0/decoding')).href);
const vault=root+'/vault';await mkdir(vault);
await writeFile(vault+'/notes.md','# Gathering\r\n\r\nOriginal.\r\n');
await writeFile(root+'/outside.md','DO NOT DISCLOSE');
await symlink(root+'/outside.md',vault+'/escape.md');
await symlink(root,vault+'/outside-dir');
const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const origin='https://synthetic-room.example.test',base='http://127.0.0.1:'+port;
const password='synthetic-room-password';
let child, exit, maxFrame=0;
const sockets=[];
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<100;i++){if(await fn())return;await wait(40);}throw Error('condition timed out');}
async function start(secret=password){
  child=spawn(process.execPath,[app+'/bin/collabmd.js',vault,'--host','127.0.0.1','--port',String(port),'--no-tunnel'],{
    env:{PATH:process.env.PATH,HOME:root,NODE_ENV:'production',AUTH_STRATEGY:'password',AUTH_PASSWORD:secret,
      AUTH_SESSION_SECRET:secret+'-cookie-secret',COLLABMD_PUBLIC_ORIGIN:origin,COLLABMD_GIT_ENABLED:'false',
      COLLABMD_AGENT_ACCESS_ENABLED:'false',COLLABMD_HOSTED_ENABLED:'false',
      PLANTUML_SERVER_URL:'http://127.0.0.1:9/disabled',COLLABMD_DRAWIO_BASE_URL:origin+'/disabled'},
    stdio:['ignore','ignore','pipe']});
  let errors='';child.stderr.on('data',data=>{errors+=data;});
  exit=once(child,'exit');
  await until(async()=>{
    if(child.exitCode!==null)throw Error('CollabMD exited: '+errors);
    try{return (await fetch(base+'/api/auth/status')).ok;}catch{return false;}
  });
}
async function login(value){return fetch(base+'/api/auth/session',{method:'POST',headers:{Origin:origin,
  'Content-Type':'application/json','X-Forwarded-Proto':'https'},body:JSON.stringify({password:value})});}
async function deniedSocket(headers,expected){
  const ws=new WebSocket(base.replace('http:','ws:')+'/ws/notes.md',{headers});sockets.push(ws);
  const code=await new Promise((resolve,reject)=>{ws.on('unexpected-response',(_,res)=>{res.resume();resolve(res.statusCode);});ws.on('open',()=>reject(Error('unexpected WS admission')));ws.on('error',()=>{});});
  assert.equal(code,expected);ws.terminate();
}
async function connect(cookie){
  const doc=new Y.Doc();
  const ws=new WebSocket(base.replace('http:','ws:')+'/ws/notes.md',{headers:{Cookie:cookie,Origin:origin,'X-Forwarded-Proto':'https'}});
  sockets.push(ws);
  ws.on('message',data=>{
    maxFrame=Math.max(maxFrame,data.length);
    const decoder=decoding.createDecoder(new Uint8Array(data));
    if(decoding.readVarUint(decoder)!==0)return;
    const encoder=encoding.createEncoder();encoding.writeVarUint(encoder,0);
    sync.readSyncMessage(decoder,encoder,doc,ws);
    if(encoding.length(encoder)>1)ws.send(encoding.toUint8Array(encoder));
  });
  doc.on('update',(update,source)=>{
    if(source===ws)return;
    const encoder=encoding.createEncoder();encoding.writeVarUint(encoder,0);sync.writeUpdate(encoder,update);
    ws.send(encoding.toUint8Array(encoder));
  });
  await once(ws,'open');
  const encoder=encoding.createEncoder();encoding.writeVarUint(encoder,0);sync.writeSyncStep1(encoder,doc);ws.send(encoding.toUint8Array(encoder));
  await until(()=>doc.getText('codemirror').length>0);
  return {ws,doc,text:doc.getText('codemirror')};
}
try {
  await start();
  const status=await(await fetch(base+'/api/auth/status')).json();
  assert.equal(status.auth.strategy,'password');assert.equal(status.authenticated,false);
  assert.equal((await fetch(base+'/api/files')).status,401);
  assert.equal((await login('wrong')).status,401);
  await deniedSocket({Origin:origin},401);
  const aLogin=await login(password),bLogin=await login(password);
  assert.equal(aLogin.status,200);assert.equal(bLogin.status,200);
  const aCookie=aLogin.headers.get('set-cookie').split(';')[0],bCookie=bLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base+'/api/files',{headers:{Cookie:aCookie}})).status,200);
  await deniedSocket({Origin:'https://evil.example',Cookie:aCookie},403);
  const evil=await fetch(base+'/api/file',{method:'POST',headers:{Cookie:aCookie,Origin:'https://evil.example','Content-Type':'application/json'},body:JSON.stringify({path:'evil.md',content:'bad'})});
  assert.equal(evil.status,403);
  for(const path of ['../outside.md','escape.md','outside-dir/outside.md']){
    const r=await fetch(base+'/api/file?path='+encodeURIComponent(path),{headers:{Cookie:aCookie}});
    assert(r.status>=400,path+' must be denied');assert(!(await r.text()).includes('DO NOT DISCLOSE'));
  }
  const a=await connect(aCookie),b=await connect(bCookie);
  assert.equal(await readFile(vault+'/notes.md','utf8'),'# Gathering\r\n\r\nOriginal.\r\n','opening preserves CRLF source');
  a.text.insert(a.text.length,'\nAlice.');await until(()=>b.text.toString().includes('Alice.'));
  b.text.insert(b.text.length,'\nBob.');await until(()=>a.text.toString().includes('Bob.'));
  await until(async()=>(await readFile(vault+'/notes.md','utf8')).includes('Bob.'));
  a.text.insert(a.text.length,'\nFinal unsaved keystroke.');
  await until(()=>b.text.toString().includes('Final unsaved keystroke.'));
  child.kill('SIGTERM');assert.equal((await exit)[0],0,'graceful CLI exit');
  assert((await readFile(vault+'/notes.md','utf8')).includes('Final unsaved keystroke.'),'final flush');
  for(const ws of sockets)ws.terminate();
  await start('fresh-room-password');
  assert.equal((await fetch(base+'/api/files',{headers:{Cookie:aCookie}})).status,401,'old cookie must not survive fresh room');
  assert.equal((await login(password)).status,401,'old password must not survive fresh room');
  const recoveredLogin=await login('fresh-room-password');assert.equal(recoveredLogin.status,200);
  const recovered=await connect(recoveredLogin.headers.get('set-cookie').split(';')[0]);
  assert(recovered.text.toString().includes('Final unsaved keystroke.'),'room reopens persisted text and Yjs sidecar');
  child.kill('SIGTERM');assert.equal((await exit)[0],0);
  console.log('PASS real CollabMD 0.1.55: password/HTTP/WS, explicit public origin, traversal/symlinks, two protocol clients, CRLF fidelity, disk reads, SIGTERM final save and fresh credentials');
  console.log('Largest observed document frame: '+maxFrame+' bytes. Two document sockets, not a browser-tab capacity measurement.');
} finally {
  for(const ws of sockets)ws.terminate();
  if(child?.exitCode===null){child.kill('SIGKILL');await exit;}
}
