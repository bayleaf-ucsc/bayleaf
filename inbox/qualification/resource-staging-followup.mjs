#!/usr/bin/env node
// Reuse the reviewed fixture/processing harness; narrowly replace instrumentation
// and scheduling. No production settings or runtime sources are edited.
import { readFile, writeFile, unlink } from 'node:fs/promises';
const base = new URL('./resource-staging.mjs', import.meta.url);
let source = await readFile(base, 'utf8');
function replace(before, after) {
  if (!source.includes(before)) throw new Error('Base harness drift: '+before.slice(0,80));
  source=source.replace(before,after);
}
replace("'bayleaf-inboxes-temp-resource-'", "'bayleaf-inboxes-temp-resfollow-'");
replace("observability: { enabled: false }", "observability: { enabled: true, head_sampling_rate: 1 }");
replace("workers_dev: true", "workers_dev: false");
replace("const url = deployment.match(/https:\\/\\/[^\\s]+\\.workers\\.dev/)?.[0];", `
  // Avoid workers.dev enable immediately after upload: allow propagation first.
  await new Promise(r=>setTimeout(r,10000));
  for(let attempt=0;attempt<3;attempt++) {
    try { await api('scripts/'+name+'/subdomain',{method:'POST',body:JSON.stringify({enabled:true,previews_enabled:false})}); break; }
    catch(e) { if(attempt===2) throw e; await new Promise(r=>setTimeout(r,10000)); }
  }
  const subdomain=await api('subdomain');
  const url='https://'+name+'.'+subdomain.subdomain+'.workers.dev';
  await new Promise(r=>setTimeout(r,10000));
`);
replace("report.tail.push({ outcome:x.outcome,", "report.tail.push({ keys:Object.keys(x), sample:new URL(x.event?.request?.url||'https://invalid').searchParams.get('sample'), outcome:x.outcome,");
replace("socket.send(JSON.stringify({debug:true}));", `socket.send(JSON.stringify({debug:true}));
  await new Promise(r=>setTimeout(r,2000));
  report.budget={max_requests:12,max_concurrency:4,max_upload_bytes:210000000,max_cpu_ms_per_request:30000,max_workers:1,storage_bindings:0,max_observability_queries:6,expiry_minutes:20};
  let queryCount=0, requestCount=0;
  async function metrics() {
    if(++queryCount>6) throw new Error('Query budget exhausted');
    const result=await api('observability/telemetry/query',{method:'POST',body:JSON.stringify({
      queryId:crypto.randomUUID(),view:'events',dry:true,limit:50,
      timeframe:{from:Date.parse(report.started),to:Date.now()},
      parameters:{filters:[{key:'$metadata.service',operation:'eq',type:'string',value:name}],limit:50}
    })});
    const events=result.events?.events||[];
    report.metrics=events.map(e=>{const w=e.$workers||{};return {
      sample:new URL(w.event?.request?.url||e.$metadata?.url||'https://invalid').searchParams.get('sample'),
      timestamp:e.timestamp,type:e.$metadata?.type,cpuTimeMs:w.cpuTimeMs,wallTimeMs:w.wallTimeMs,
      outcome:w.outcome,status:w.event?.response?.status,version:w.scriptVersion?.id,
      workerKeys:Object.keys(w),error:e.$metadata?.error
    }});
    report.query_statistics=result.statistics;
    report.query_count=queryCount;
    console.log(JSON.stringify({metrics:report.metrics,query_count:queryCount}));
    return report.metrics;
  }
`);
replace("const started=Date.now();", "if((requestCount+=concurrency)>12) throw new Error('Request budget exhausted');\n    const started=Date.now();");
replace("async()=>{\n      const t=Date.now();", "async(_,index)=>{\n      const t=Date.now();");
replace("url+'/?mode='+mode", "url+'/?mode='+mode+'&sample='+label+'-'+index");
replace("for(const [label,bytes,mode] of cases) for(const concurrency of process.argv.includes('--cpu-pass')?[1]:[1,2,4]) await sample(label,bytes,mode,concurrency);", `
  await sample('control',Buffer.from(head('text/plain')+'\\r\\ncontrol'),'receive',1);
  await new Promise(r=>setTimeout(r,15000));
  let measured=await metrics();
  if(!measured.some(e=>e.sample==='control-0' && Number.isFinite(e.cpuTimeMs))) {
    await new Promise(r=>setTimeout(r,30000)); measured=await metrics();
  }
  if(!measured.some(e=>e.sample==='control-0' && Number.isFinite(e.cpuTimeMs))) throw new Error('Tiny control CPU unavailable; larger tests skipped');
  // Eight processing requests: four serial fixture types, then four concurrent
  // restricted DKIM messages. Total nine with the tiny instrumentation control.
  for(const [label,bytes,mode] of cases) await sample(label,bytes,mode,1);
  await sample('restricted-parallel',dkim,'dkim',4);
  await new Promise(r=>setTimeout(r,15000));
  measured=await metrics();
  if(measured.filter(e=>Number.isFinite(e.cpuTimeMs)).length<requestCount) {
    await new Promise(r=>setTimeout(r,30000)); await metrics();
  }
  report.request_count=requestCount;
`);
replace("report.error = 'Qualification interrupted: ' + (error.status ? `subprocess status ${error.status}` : error.name);", "report.error = 'Qualification interrupted: ' + (error.status ? `subprocess status ${error.status}` : error.message); console.error(report.error);");
// All persisted records are allowlisted counters. Raw request headers and the
// ephemeral authorization bearer are never written to evidence.
const generated=new URL('./.resource-staging-followup-run.mjs',import.meta.url);
await writeFile(generated,source);
try { await import(generated.href); }
finally { await unlink(generated); }
// Node's native WebSocket can retain an event-loop handle after close(). The
// imported harness has already awaited cleanup and evidence writes at this point.
process.exit(0);
