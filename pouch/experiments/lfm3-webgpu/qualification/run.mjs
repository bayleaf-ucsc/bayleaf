import {chromium} from 'playwright-core';
import {writeFile,appendFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('.',import.meta.url)));
const phase=process.argv[2]??'baseline';await mkdir('results',{recursive:true});
const context=await chromium.launchPersistentContext('profile',{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:false,args:['--no-first-run','--no-default-browser-check','--enable-unsafe-webgpu'],viewport:{width:1000,height:700},serviceWorkers:'allow'});
const page=await context.newPage();page.setDefaultTimeout(180000);
const network=[],errors=[];context.on('request',r=>network.push({url:r.url(),method:r.method(),serviceWorker:!!r.serviceWorker()}));page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
const result={phase,at:new Date().toISOString(),browser:context.browser()?.version()};
const call=(action,args={})=>page.evaluate(({action,args})=>window.call(action,args),{action,args});
const save=async()=>writeFile(`results/${phase}.json`,JSON.stringify({...result,network,errors},null,2)+'\n');
try{
 await page.goto('http://127.0.0.1:8768/');await page.waitForFunction(()=>window.ready);
 result.load=await call('load');
 if(phase==='baseline'){
  result.generation=await call('generate',{messages:[{role:'system',content:'You are a helpful assistant.'},{role:'user',content:'What is the capital of France? Answer in one sentence.'}],options:{max_new_tokens:48}});
  result.inventory=await call('inventory');result.csp=await page.evaluate(()=>window.cspViolations);
 } else if(phase==='agent'){
  const files={'/work/README.md':'# Lantern\nA small temperature converter. src/convert.js is logic, src/ui.js is display.\n','/work/src/convert.js':'export function celsiusToFahrenheit(c) {\n  return c * 9 / 5 + 30;\n}\n','/work/src/ui.js':'export const label = "Temperature";\n','/work/docs/notes.txt':'Keep output concise.\n'};
  const tasks=[
   {name:'tree',prompt:'Inspect this unfamiliar workspace using tools. List its tree, read the README and source files, then summarize what the project does. Do not change files.'},
   {name:'edit',prompt:'Read src/convert.js and correct the Celsius-to-Fahrenheit offset from 30 to 32. Change nothing else.'},
   {name:'feature',prompt:'Add the exact line export const unit = "F"; followed by a newline to the end of src/ui.js. Create docs/unit.txt with exactly Fahrenheit followed by a newline. Also fix the offset in src/convert.js from 30 to 32. Read files first; change nothing else.'},
   {name:'missing',prompt:'The previous read failed. Find the actual converter file, read it, and fix its offset from 30 to 32. Change nothing else.',inject:{type:'function',function:{name:'read',arguments:{path:'src/converter.js'}}}},
   {name:'ambiguous',prompt:'The previous edit was ambiguous. Read settings.txt and change only the second section value from false to true. Keep the first section false and all other bytes unchanged.',files:{'/work/settings.txt':'[first]\nenabled=false\n[second]\nenabled=false\n'},inject:{type:'function',function:{name:'edit',arguments:{path:'settings.txt',oldText:'enabled=false',newText:'enabled=true'}}}},
  ];
  result.trials=[];
  for(const task of tasks)for(let trial=1;trial<=3;trial++){
   const initial=task.files??files;
   const r=await call('agent',{prompt:task.prompt,options:{files:initial,inject:task.inject}});
   const expected={...initial};if(['edit','feature','missing'].includes(task.name))expected['/work/src/convert.js']=files['/work/src/convert.js'].replace('+ 30','+ 32');
   if(task.name==='feature'){expected['/work/src/ui.js']+='export const unit = "F";\n';expected['/work/docs/unit.txt']='Fahrenheit\n';}
   if(task.name==='ambiguous')expected['/work/settings.txt']='[first]\nenabled=false\n[second]\nenabled=true\n';
   const exact=JSON.stringify(Object.entries(r.files).sort())===JSON.stringify(Object.entries(expected).sort());
   const answer=r.trace.filter(x=>x.text).at(-1)?.text??'';
   const tree=task.name!=='tree'||(r.trace.some(x=>x.call?.function.name==='bash')&&r.trace.filter(x=>x.call?.function.name==='read').length>=3&&/convert|temperature|celsius/i.test(answer));
   const item={task:task.name,trial,pass:exact&&tree&&r.status==='final',expected,...r};result.trials.push(item);await save();console.log(task.name,trial,item.pass,r.status,Math.round(r.duration_ms));
  }
 }else if(phase==='offline'){
  result.prime=await page.evaluate(()=>window.prime());
  result.beforeOfflineInventory=await call('inventory');
  await call('dispose');
  // Browser-level offline plus request event instrumentation. Browser HTTP cache
  // is disabled for the reload: Cache Storage must provide the complete app.
  const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  await context.setOffline(true);const start=network.length;
  await page.reload();await page.waitForFunction(()=>window.ready);
  result.offlineLoad=await call('load');
  result.offlineGeneration=await call('generate',{messages:[{role:'user',content:'What is the capital of France? Answer briefly.'}],options:{max_new_tokens:32}});
  result.offlineAgent=await call('agent',{prompt:'Read note.txt and change exactly red to blue, preserving the newline. Use edit. Change nothing else.',options:{files:{'/work/note.txt':'red\n'}}});
  result.offlineAgentPass=result.offlineAgent.files['/work/note.txt']==='blue\n'&&result.offlineAgent.status==='final';
  result.offlineRequests=network.slice(start);result.offlineExternalAttempts=result.offlineRequests.filter(x=>!x.url.startsWith('http://127.0.0.1:8768/'));
  result.offlineInventory=await call('inventory');result.csp=await page.evaluate(()=>window.cspViolations);
 }else if(phase==='resources'){
  result.turns=[];let messages=null,files={'/work/facts.txt':'project=Lantern\ncolor=violet\ncount=0\n'};
  const prompts=[
   'Read facts.txt. Remember the project name and color for this conversation. Reply briefly.',
   'Change count=0 to count=1 in facts.txt. Preserve every other byte.',
   'Without reading a file, what project name and color did I ask you to remember?',
   'Create marker.txt containing exactly READY followed by a newline.',
   'Read facts.txt and change count=1 to count=2. Preserve everything else.',
   'Without tools, recall what marker.txt contains and the original color.',
   'Read marker.txt and append exactly DONE followed by a newline, preserving READY.',
   'Read facts.txt and change color=violet to color=amber. Preserve everything else.',
   'Without tools, state the original color, current color, project name and count.',
   'Read marker.txt and facts.txt. Summarize both in one sentence. Make no changes.',
  ];
  for(const prompt of prompts){const r=await call('agent',{prompt,options:{messages,files}});messages=r.messages;files=r.files;result.turns.push({prompt,...r});await save();console.log('turn',result.turns.length,r.status,Math.round(r.duration_ms));if(r.status!=='final')break;}
  result.finalFiles=files;result.finalBytesPass=files['/work/facts.txt']==='project=Lantern\ncolor=amber\ncount=2\n'&&files['/work/marker.txt']==='READY\nDONE\n';
  const sustained=[{role:'user',content:'Write a clear 350-word explanation of how a browser can run a language model locally with WebGPU. Discuss privacy boundaries, assets, storage and limitations. Do not use tools.'}];
  result.sustained=[];for(let i=0;i<3;i++)result.sustained.push(await call('generate',{messages:sustained,options:{max_new_tokens:384,includePrompt:false}}));
  result.interrupt=await call('generate',{messages:[{role:'user',content:'Write a long detailed essay about forests.'}],options:{max_new_tokens:512,interrupt_ms:500}});
  result.afterInterrupt=await call('generate',{messages:[{role:'user',content:'Say OK.'}],options:{max_new_tokens:16}});
  result.contextProbe=await call('generate',{messages:[{role:'user',content:('This is a context capacity probe with repeated neutral filler. ').repeat(300)+'\nReply READY.'}],options:{max_new_tokens:16,includePrompt:false}});
  try{await call('generate',{messages:[{role:'user',content:('filler ').repeat(9000)}],options:{max_new_tokens:16}})}catch(e){result.contextGuard=String(e)}
  result.inventory=await call('inventory');result.memory=await page.evaluate(()=>({jsHeap:performance.memory?{used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize,limit:performance.memory.jsHeapSizeLimit}:null,measureMemoryAvailable:typeof performance.measureUserAgentSpecificMemory==='function'}));result.csp=await page.evaluate(()=>window.cspViolations);
 }else throw Error('Unknown phase');
 await call('dispose');
}catch(e){result.fatal=String(e);console.error(String(e));}
finally{await save();await context.close();}
console.log(JSON.stringify({phase,fatal:result.fatal,load_ms:result.load?.load_ms,output:result.generation?.text,dispatches:result.generation?.dispatches,trials:result.trials?.map(x=>({task:x.task,pass:x.pass,status:x.status}))}));
