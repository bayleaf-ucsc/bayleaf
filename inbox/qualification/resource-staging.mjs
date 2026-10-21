#!/usr/bin/env node
// Explicitly authorized, ephemeral Cloudflare qualification. See ../QUALIFICATION.md.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { dkimSign } from 'mailauth/lib/dkim/sign';

if (!process.argv.includes('--deploy-test-delete')) throw new Error('Requires --deploy-test-delete');
const root = fileURLToPath(new URL('../', import.meta.url));
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!/^[a-f0-9]{32}$/.test(account || '')) throw new Error('Requires explicit CLOUDFLARE_ACCOUNT_ID');
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
if (!output || output.startsWith('--')) throw new Error('Requires --output path');
const name = 'bayleaf-inboxes-temp-resource-' + Date.now().toString(36);
const work = await mkdtemp(join(root, 'qualification/.resource-staging-'));
const token = randomBytes(32).toString('hex');
const hash = createHash('sha256').update(token).digest('hex');
const run = (args, env = process.env) => execFileSync(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
execFileSync('cf', ['workers', 'list', '--profile', 'ucsc'], { cwd: root, stdio: 'ignore' });
const credentials = JSON.parse(await readFile(join(homedir(), 'Library/Preferences/cloudflare/config/ucsc.json')));
const bearer = credentials.oauth_token;
if (!bearer) throw new Error('Missing refreshed OAuth bearer');
const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: bearer };
async function api(path, options = {}) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/${path}`, { ...options, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...options.headers } });
  const j = await r.json();
  if (!j.success) throw new Error(`Cloudflare ${r.status}: ${JSON.stringify(j.errors)}`);
  return j.result;
}
const report = { started: new Date().toISOString(), worker: name, cpu_limit_ms: 30000, samples: [], tail: [] };
let deployed = false, socket, tail;
try {
  execFileSync(process.execPath, ['scripts/build-dkim.mjs'], { cwd: root, stdio: 'ignore' });
  const source = await readFile(join(root, 'src/worker.js'), 'utf8');
  report.source_sha256 = createHash('sha256').update(source).digest('hex');
  report.verifier_sha256 = createHash('sha256').update(await readFile(join(root, '.generated/dkim-verifier.mjs'))).digest('hex');
  // Only exports are added to a temporary copy. Imports retain their original targets.
  const copied = source.replace(/from (['"])(\.[^'"]+)\1/g, (_, quote, relative) => `from ${quote}${join(root, 'src', relative)}${quote}`);
  await writeFile(join(work, 'receiver.mjs'), copied + '\nexport { readBounded, parseEmail, emailMeta, emailSearch, htmlToText, MimeResourceLimit };\n');
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'der' } });
  const dns = `v=DKIM1; k=rsa; p=${key.publicKey.toString('base64')}`;
  await writeFile(join(work, 'entry.mjs'), `
import { readBounded, parseEmail, emailMeta, emailSearch, htmlToText, MimeResourceLimit } from './receiver.mjs';
import { verifyEmailDomain } from '../../.generated/dkim-verifier.mjs';
const expiry = ${Date.now() + 20 * 60000};
let active = 0;
export default { async fetch(req) {
 const auth = req.headers.get('authorization') || '';
 const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(auth.replace(/^Bearer /,''))))].map(b=>b.toString(16).padStart(2,'0')).join('');
 if (Date.now()>expiry || digest!==${JSON.stringify(hash)}) return new Response(null,{status:404});
 if(req.method!=='POST') return new Response(null,{status:405});
 const u=new URL(req.url), mode=u.searchParams.get('mode');
 if(!['receive','read','dkim'].includes(mode)) return new Response(null,{status:400});
 if(active>=4) return new Response(null,{status:429});
 const concurrent=++active;
 try {
  const max=mode==='dkim'?1048576:26214400;
  const raw=await readBounded(req.body,max);
  if(raw===null) return Response.json({outcome:'size-reject',concurrent});
  let trusted=null;
  if(mode==='dkim') {
   const v=await verifyEmailDomain(raw,{domains:['fixture.invalid']},async()=>Response.json({Status:0,Answer:[{type:16,data:${JSON.stringify(JSON.stringify(dns))}}]}));
   trusted=v.trusted;
   if(!trusted) return Response.json({outcome:'dkim-reject',concurrent});
  }
  const parsed=await parseEmail(raw,max,mode==='dkim');
  const meta=emailMeta({from:'sender@fixture.invalid',headers:new Headers()},'sink@fixture.invalid',parsed);
  const search=emailSearch(meta,parsed,32768);
  const text=parsed.text?parsed.text.slice(0,262144):htmlToText(parsed.html||'',262144).text;
  return Response.json({outcome:'parsed',bytes:raw.byteLength,attachments:meta.attachments.length,search_chars:search.length,text_chars:text.length,trusted,concurrent});
 } catch(e) { return Response.json({outcome:e instanceof MimeResourceLimit?'resource-reject':'exception',concurrent}); }
 finally {active--;}
}};
`);
  const config = join(work, 'wrangler.json');
  await writeFile(config, JSON.stringify({ name, account_id: account, main: 'entry.mjs', compatibility_date: '2026-08-01', compatibility_flags: ['nodejs_compat'], workers_dev: true, preview_urls: false, observability: { enabled: false }, limits: { cpu_ms: 30000 } }));
  deployed = true;
  const deployment = run(['deploy', '--config', config], env);
  report.deployment = deployment.replace(/https:\/\/[^\s]+/g, '[temporary endpoint]');
  const url = deployment.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
  if (!url || !url.includes(name)) throw new Error('Missing isolated endpoint');
  tail = await api(`scripts/${name}/tails`, { method: 'POST', body: '{}' });
  socket = new WebSocket(tail.url, 'trace-v1');
  socket.addEventListener('message', async event => {
    try { const x=JSON.parse(typeof event.data==='string'?event.data:await event.data.text()); report.tail.push({ outcome:x.outcome, cpuTime:x.cpuTime, wallTime:x.wallTime, eventTimestamp:x.eventTimestamp, exceptions:x.exceptions?.map(e=>({name:e.name,message:/memory/i.test(e.message)?'memory':/cpu/i.test(e.message)?'cpu':'other'})) }); } catch {}
  });
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.send(JSON.stringify({debug:true}));
  const head = type => `From: sender@fixture.invalid\r\nSubject: synthetic\r\nMIME-Version: 1.0\r\nContent-Type: ${type}\r\n`;
  const target=26214400-16384;
  const attach = Buffer.from(head('application/octet-stream; name="fixture.bin"')+'Content-Transfer-Encoding: base64\r\n\r\n'+('QUFB'.repeat(19)+'\r\n').repeat(Math.floor((target-256)/78)));
  const text = Buffer.from(head('text/plain')+'Content-Transfer-Encoding: base64\r\n\r\n'+('QUFB'.repeat(19)+'\r\n').repeat(Math.floor((target-256)/78)));
  const unit='--BOUNDARYX not quite\r\n--BOUNDAR\r\n--BOUNDARY-\r\n';
  const boundary=Buffer.from(head('multipart/mixed; boundary="BOUNDARY"')+'\r\n--BOUNDARY\r\nContent-Type: text/plain\r\n\r\n'+unit.repeat(Math.floor((target-500)/unit.length))+'--BOUNDARY--\r\n');
  const mail=head('text/plain')+'\r\n'+'x'.repeat(1048576-4096);
  const signed=await dkimSign(mail,{signatureData:[{signingDomain:'fixture.invalid',selector:'bench',privateKey:key.privateKey}]});
  if(signed.errors.length) throw new Error('Synthetic signing failed');
  const dkim=Buffer.from(signed.signatures+mail);
  const cases=[['attachment',attach,'receive'],['text',text,'receive'],['boundary',boundary,'receive'],['restricted-rsa',dkim,'dkim']];
  async function sample(label, bytes, mode, concurrency) {
    const started=Date.now();
    const results=await Promise.all(Array.from({length:concurrency},async()=>{
      const t=Date.now(); let at=0;
      const body=new ReadableStream({pull(c){if(at>=bytes.length)return c.close();c.enqueue(bytes.subarray(at,at+65536));at+=65536;}});
      try {
        const r=await fetch(url+'/?mode='+mode,{method:'POST',headers:{authorization:'Bearer '+token},body,duplex:'half',signal:AbortSignal.timeout(45000)});
        const txt=await r.text(); let data;
        try { data=JSON.parse(txt); } catch { data={platform_error:/1102/.test(txt)?1102:/1101/.test(txt)?1101:null}; }
        return {status:r.status,wall_ms:Date.now()-t,...data};
      } catch {return {outcome:'client-error',wall_ms:Date.now()-t};}
    }));
    const row={label,mode,bytes:bytes.length,concurrency,started:new Date(started).toISOString(),wall_ms:Date.now()-started,results};
    report.samples.push(row);console.log(JSON.stringify(row));
  }
  // Fixed budget: 28 invocations, max four concurrent, no retries or ramp loop.
  for(const [label,bytes,mode] of cases) for(const concurrency of process.argv.includes('--cpu-pass')?[1]:[1,2,4]) await sample(label,bytes,mode,concurrency);
  await new Promise(r=>setTimeout(r,4000));
} catch(error) {
  report.error = 'Qualification interrupted: ' + (error.status ? `subprocess status ${error.status}` : error.name);
  throw error;
} finally {
  socket?.close();
  if(tail) await api(`scripts/${name}/tails/${tail.id}`,{method:'DELETE'}).catch(()=>{});
  // A deploy may upload successfully and then fail while enabling workers.dev.
  if(deployed) {
    // The script-list endpoint can briefly omit a freshly uploaded Worker.
    // Delete the exact task-created name, even after a partial deployment failure.
    await new Promise(r=>setTimeout(r,5000));
    await api(`scripts/${name}`,{method:'DELETE'});
    await new Promise(r=>setTimeout(r,3000));
    const remaining=await api('scripts');
    report.deleted=!remaining.some(w=>w.id===name);
    if(!report.deleted) throw new Error('Temporary Worker deletion not confirmed');
  } else report.deleted = true;
  report.finished=new Date().toISOString();
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  await rm(work,{recursive:true,force:true});
}
