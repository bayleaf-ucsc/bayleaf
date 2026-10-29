// v2 qualification: agent variants (prompt, few-shot, multi-edit, sampling) over five
// tasks, plus a throughput phase. Fresh /tmp Chrome profile, headless, loopback only.
// Usage: node run2.mjs agent|perf [variant,...]
import {chromium} from 'playwright-core';
import {writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {execSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('.',import.meta.url)));
const phase=process.argv[2]??'agent',only=process.argv[3]?.split(',');await mkdir('results',{recursive:true});
const profile=await mkdtemp(join(tmpdir(),'lfm3-v2-'));
const context=await chromium.launchPersistentContext(profile,{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-first-run','--no-default-browser-check','--enable-unsafe-webgpu','--enable-features=WebGPU'],viewport:{width:1000,height:700}});
const page=await context.newPage();page.setDefaultTimeout(600000);
const network=[],errors=[];context.on('request',r=>network.push(r.url()));page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
const out=`results/agent-v2-${phase}${only?'-'+only.join('+'):''}.json`;
const result={phase,at:new Date().toISOString(),browser:context.browser()?.version(),profile,headless:true};
const call=(action,args={})=>page.evaluate(({action,args})=>window.call(action,args),{action,args});
const save=()=>writeFile(out,JSON.stringify({...result,externalRequests:network.filter(u=>!u.startsWith('http://127.0.0.1:8768/')),errors},null,1)+'\n');
// Apple unified memory: GPU-resident bytes are visible via IOAccelerator, Chrome RSS via ps.
const mem=()=>{const o={};try{o.gpuInUseBytes=+execSync("ioreg -r -d 1 -w 0 -c IOAccelerator | grep -o '\"In use system memory\"=[0-9]*' | head -1 | cut -d= -f2").toString().trim()}catch{}try{o.chromeRssKB=execSync(`ps -axo rss,command | grep -F '${profile}' | grep -v grep | awk '{s+=$1} END {print s}'`).toString().trim()*1}catch{}return o;};

const base={'/work/README.md':'# Lantern\nA small temperature converter. src/convert.js is logic, src/ui.js is display.\n','/work/src/convert.js':'export function celsiusToFahrenheit(c) {\n  return c * 9 / 5 + 30;\n}\n','/work/src/ui.js':'export const label = "Temperature";\n','/work/docs/notes.txt':'Keep output concise.\n'};
const fixed=f=>({...f,'/work/src/convert.js':f['/work/src/convert.js'].replace('+ 30','+ 32')});
const uiR='import { celsiusToFahrenheit } from "./convert.js";\nexport const label = "Temperature";\nexport function show(c) {\n  return label + ": " + celsiusToFahrenheit(c);\n}\n';
const renameFiles={...fixed(base),'/work/src/convert.js':'export function celsiusToFahrenheit(c) {\n  return c * 9 / 5 + 32;\n}\n','/work/src/ui.js':uiR};
const cfgFiles={'/work/README.md':base['/work/README.md'],'/work/config.json':'{\n  "precision": 1\n}\n','/work/src/convert.js':fixed(base)['/work/src/convert.js'],'/work/src/ui.js':'import config from "../config.json" with { type: "json" };\nimport { celsiusToFahrenheit } from "./convert.js";\nexport function show(c) {\n  return celsiusToFahrenheit(c).toFixed(config.precision);\n}\n'};
const same=(a,b)=>JSON.stringify(Object.entries(a).sort())===JSON.stringify(Object.entries(b).sort());
const tasks=[
 {name:'tree',files:base,prompt:'Inspect this unfamiliar workspace using tools. List its tree, read the README and source files, then summarize what the project does. Do not change files.',
  check:(f,r,ans)=>same(f,base)&&r.trace.some(x=>x.call?.function.name==='bash')&&r.trace.filter(x=>x.call?.function.name==='read').length>=3&&/convert|temperature|celsius/i.test(ans)},
 {name:'edit',files:base,prompt:'Read src/convert.js and correct the Celsius-to-Fahrenheit offset from 30 to 32. Change nothing else.',check:f=>same(f,fixed(base))},
 {name:'feature',files:base,prompt:'Add the exact line export const unit = "F"; followed by a newline to the end of src/ui.js. Create docs/unit.txt with exactly Fahrenheit followed by a newline. Also fix the offset in src/convert.js from 30 to 32. Read files first; change nothing else.',
  check:f=>same(f,{...fixed(base),'/work/src/ui.js':base['/work/src/ui.js']+'export const unit = "F";\n','/work/docs/unit.txt':'Fahrenheit\n'}),
  // Semantic check: same, ignoring blank lines (separates intent from byte fidelity).
  lenient:f=>{const n=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,v.replace(/\n\s*\n/g,'\n')]));return same(n(f),n({...fixed(base),'/work/src/ui.js':base['/work/src/ui.js']+'export const unit = "F";\n','/work/docs/unit.txt':'Fahrenheit\n'}))}},
 {name:'rename',files:renameFiles,prompt:'Rename the function celsiusToFahrenheit to toFahrenheit everywhere in the workspace: its definition, imports and calls. Find all uses first. Change nothing else.',
  check:f=>same(f,Object.fromEntries(Object.entries(renameFiles).map(([k,v])=>[k,v.replaceAll('celsiusToFahrenheit','toFahrenheit')])))},
 {name:'config',files:cfgFiles,prompt:'Add a "unit" field with the value "F" to config.json, keeping "precision". Then change show() in src/ui.js so it returns the formatted number followed by a space and config.unit, for example "50.0 F". Read files first. Change nothing else.',
  check:f=>{try{const c=JSON.parse(f['/work/config.json']);if(JSON.stringify(c)!=='{"precision":1,"unit":"F"}')return false;
   if(!same({...f,'/work/config.json':0,'/work/src/ui.js':0},{...cfgFiles,'/work/config.json':0,'/work/src/ui.js':0}))return false;
   const ui=f['/work/src/ui.js'];if(!/^import config from "\.\.\/config\.json" with \{ type: "json" \};\nimport \{ celsiusToFahrenheit \} from "\.\/convert\.js";\n/.test(ui))return false;
   const body=ui.split('\n').slice(2).join('\n').replace(/export /g,'');
   return new Function('config','celsiusToFahrenheit',body+'\nreturn show(10);')(c,x=>x*9/5+32)==='50.0 F';}catch{return false}}},
];
const S={temperature:0.3,top_p:0.95};
const variants={
 v0_greedy:{n:2},
 v1_sampled:{n:6,sampling:S},
 v2_fidelity:{n:2,system:'fidelity'},
 v2_fidelity_sampled:{n:6,system:'fidelity',sampling:S},
 v3_fewshot:{n:2,fewshot:true},
 v3_fewshot_sampled:{n:6,fewshot:true,sampling:S},
 v4_multiedit_fidelity:{n:2,system:'fidelity',multiEdit:true},
 v4_multiedit_fidelity_sampled:{n:6,system:'fidelity',multiEdit:true,sampling:S},
 v5_fidelity_fewshot_r12:{n:2,system:'fidelity',fewshot:true,maxRounds:12},
 v5_fidelity_fewshot_r12_sampled:{n:6,system:'fidelity',fewshot:true,maxRounds:12,sampling:S},
 v6_grounded:{n:2,system:'grounded',explainEmpty:true},
 v6_grounded_sampled:{n:6,system:'grounded',explainEmpty:true,sampling:S},
 v7_grounded_multiedit:{n:2,system:'grounded',explainEmpty:true,multiEdit:true},
 v7_grounded_multiedit_sampled:{n:6,system:'grounded',explainEmpty:true,multiEdit:true,sampling:S},
 v8_grounded_fewshot_nl:{n:2,system:'grounded',explainEmpty:true,fewshot:true,normalizeNl:true},
 v8_grounded_fewshot_nl_sampled:{n:6,system:'grounded',explainEmpty:true,fewshot:true,normalizeNl:true,sampling:S},
 v9_grounded_nl:{n:2,system:'grounded',explainEmpty:true,normalizeNl:true},
 v9_grounded_nl_sampled:{n:6,system:'grounded',explainEmpty:true,normalizeNl:true,sampling:S},
};
try{
 await page.goto('http://127.0.0.1:8768/');await page.waitForFunction(()=>window.ready);
 result.memBefore=mem();result.load=await call('load');result.memAfterLoad=mem();
 if(phase==='agent'){
  result.trials=[];result.summary={};
  for(const [vn,v] of Object.entries(variants)){if(only&&!only.includes(vn))continue;
   for(const task of tasks){const s={pass:0,lenient:0,n:0,ms:[],rounds:[],statuses:{}};
    for(let trial=1;trial<=v.n;trial++){
     const r=await call('agent',{prompt:task.prompt,options:{files:task.files,variant:v}});
     const ans=r.trace.filter(x=>x.text).at(-1)?.text??'';
     const pass=r.status==='final'&&!!task.check(r.files,r,ans);const lenient=task.lenient?r.status==='final'&&task.lenient(r.files):pass;
     s.n++;s.pass+=pass;s.lenient+=lenient;s.ms.push(Math.round(r.duration_ms));s.rounds.push(r.rounds);s.statuses[r.status]=(s.statuses[r.status]??0)+1;
     delete r.messages;result.trials.push({variant:vn,task:task.name,trial,pass,lenient,...r});
     console.log(vn,task.name,trial,pass,lenient,r.status,r.rounds,Math.round(r.duration_ms));
    }
    s.median_ms=[...s.ms].sort((a,b)=>a-b)[s.ms.length>>1];(result.summary[vn]??={})[task.name]=s;await save();}
  }
 }else if(phase==='perf'){
  // Throughput at ~1k and ~4k prompt tokens. Prefill = input/TTFT; decode = (n-1)/(last-first).
  const filler=n=>Array.from({length:n},(_,i)=>`Line ${i+1}: the lantern project converts temperatures between units for display.`).join('\n');
  result.perf=[];
  for(const [label,lines] of [['~1k',62],['~4k',250]])for(let i=0;i<3;i++){
   const g=await call('generate',{messages:[{role:'user',content:filler(lines)+'\n\nNow write the numbers from 1 to 200, separated by commas, and nothing else.'}],options:{max_new_tokens:256,min_new_tokens:256,includePrompt:false}});
   const row={label,input_tokens:g.input_tokens,output_tokens:g.output_token_callbacks,ttft_ms:Math.round(g.ttft_ms),decode_ms:Math.round(g.decode_ms),prefill_tok_s:+(g.input_tokens/(g.ttft_ms/1000)).toFixed(1),decode_tok_s:+((g.output_token_callbacks-1)/(g.decode_ms/1000)).toFixed(1),...mem()};
   result.perf.push(row);console.log(JSON.stringify(row));await save();}
  result.memAfterPerf=mem();
 }
 await call('dispose');
}catch(e){result.fatal=String(e);console.error(String(e));}
finally{await save();await context.close();}
console.log(JSON.stringify({out,fatal:result.fatal,adapter:result.load?.adapter,summary:result.summary}));
