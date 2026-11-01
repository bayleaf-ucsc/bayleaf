import {pipeline, PreTrainedTokenizer, TextStreamer, env, InterruptableStoppingCriteria} from './assets/runtime/transformers.js';
import {Bash, InMemoryFs} from './tools.bundle.js';
env.allowRemoteModels=false;env.allowLocalModels=true;env.localModelPath=new URL('./assets/',import.meta.url).href;
env.useBrowserCache=true;env.useWasmCache=false;
env.backends.onnx.wasm.wasmPaths={mjs:new URL('./assets/runtime/ort-wasm-simd-threaded.asyncify.mjs',import.meta.url).href,wasm:new URL('./assets/runtime/ort-wasm-simd-threaded.asyncify.wasm',import.meta.url).href};
env.backends.onnx.wasm.numThreads=1;
let generator, dispatches=0,submissions=0,fs;
const fetches=[]; const realFetch=globalThis.fetch;
globalThis.fetch=async (...a)=>{fetches.push(String(a[0]?.url??a[0]));return realFetch(...a)};
for(const name of ['dispatchWorkgroups','dispatchWorkgroupsIndirect']){
 const original=GPUComputePassEncoder.prototype[name];GPUComputePassEncoder.prototype[name]=function(...a){dispatches++;return original.apply(this,a)};
}
const submit=GPUQueue.prototype.submit;GPUQueue.prototype.submit=function(...a){submissions++;return submit.apply(this,a)};
const obj=properties=>({type:'object',properties,required:Object.keys(properties)}),str={type:'string'};
const tools=[
 {type:'function',function:{name:'read',description:'Read a UTF-8 text file. Paths relative to /work.',parameters:obj({path:str})}},
 {type:'function',function:{name:'write',description:'Create or overwrite a file with exact content. Parents created.',parameters:obj({path:str,content:str})}},
 {type:'function',function:{name:'edit',description:'Replace exact oldText with newText. oldText must occur exactly once. Read first; include neighboring lines if ambiguous.',parameters:obj({path:str,oldText:str,newText:str})}},
 {type:'function',function:{name:'bash',description:'Simulated bash over /work only. ls, find, cat, grep, sed, printf. No network, node, python, or processes.',parameters:obj({command:str})}},
];
const system='You are a concise coding assistant inside a browser. Use read, write, edit and bash tools for real file operations in /work. Never claim an edit without using a tool. Read files before editing. Tool errors are feedback: inspect and retry. No network, real processes, code execution or package installs. Finish with a concise summary.';
// v2 variants (agent options): pi-style multi-edit `edits`/replaceAll, as in Pouch's src/tools.js.
const editV2={type:'function',function:{name:'edit',description:'Replace exact text in a file. Each oldText must match exactly once (including whitespace and indentation) unless replaceAll is true. Read the file first. For several changes in one file, pass `edits` (applied in order, all or nothing) instead of oldText/newText.',parameters:{type:'object',properties:{path:str,oldText:{type:'string',description:'Exact text to find'},newText:{type:'string',description:'Replacement text'},replaceAll:{type:'boolean'},edits:{type:'array',description:'Several replacements, applied in order, as a JSON array of {"oldText","newText","replaceAll"?}',items:{type:'object',properties:{oldText:str,newText:str,replaceAll:{type:'boolean'}},required:['oldText','newText']}}},required:['path']}}};
const toolsV2=[tools[0],tools[1],editV2,tools[3]];
const systems={
 base:system,
 grounded:null,
 fidelity:system+' Make exactly the requested change and nothing more: never add blank lines, reformat, reorder or tidy surrounding text. To append a line to a file, use edit with oldText set to the current last line and newText set to that same line plus a newline plus the new line (no blank line in between) unless asked otherwise.',
};
// Grounding: name the cwd (the model's prior is /workspace) and the files' exact location.
systems.grounded=systems.fidelity+' The workspace root and current directory is /work (there is no /workspace). Use relative paths like src/a.js.';
let explainEmpty=false,normalizeNl=false;
// Tool-side poka-yoke for the XML encoding's trailing-newline ambiguity (disclosed variant):
// an edit's newText inherits oldText's trailing-newline status; write ends text with one newline.
function nl(name,a){if(!normalizeNl)return a;a={...a};const fix=e=>{if(typeof e.oldText!=='string'||typeof e.newText!=='string')return e;const o=e.oldText.endsWith('\n'),n=e.newText.endsWith('\n');return o===n?e:{...e,newText:o?e.newText+'\n':e.newText.replace(/\n+$/,'')}};
 if(name==='edit'){Object.assign(a,fix(a));if(Array.isArray(a.edits))a.edits=a.edits.map(fix);}
 if(name==='write'&&typeof a.content==='string'&&a.content&&!a.content.endsWith('\n'))a.content+='\n';return a;}
// Synthetic prior turn showing a byte-exact append, a create and a replacement in one round.
const fewshot=[
 {role:'user',content:'Append the exact line b = 2 to the end of x.txt and create y.txt containing exactly ok followed by a newline. Read first; change nothing else.'},
 {role:'assistant',content:'',tool_calls:[{type:'function',function:{name:'read',arguments:{path:'x.txt'}}}]},
 {role:'tool',content:'a = 1\n'},
 {role:'assistant',content:'',tool_calls:[{type:'function',function:{name:'edit',arguments:{path:'x.txt',oldText:'a = 1\n',newText:'a = 1\nb = 2\n'}}},{type:'function',function:{name:'write',arguments:{path:'y.txt',content:'ok\n'}}}]},
 {role:'tool',content:'Applied 1 edit to /work/x.txt\na = 1\nb = 2\n'},
 {role:'tool',content:'Wrote 3 characters to /work/y.txt'},
 {role:'assistant',content:'Appended b = 2 to x.txt and created y.txt.'},
];
function abs(p){if(typeof p!=='string')throw Error('path must be string');const a=[];for(const x of (p.startsWith('/')?p:'/work/'+p).split('/')){if(x==='..')a.pop();else if(x&&x!=='.')a.push(x)}const n='/'+a.join('/');if(n!=='/work'&&!n.startsWith('/work/'))throw Error('Only synthetic /work permitted');return n;}
async function execute(name,a){a=nl(name,a);
 if(name==='bash'){
  const b=new Bash({fs,cwd:'/work',commands:['ls','find','cat','grep','rg','sed','awk','printf','echo','head','tail','wc','sort','mkdir','touch','pwd','test'],executionLimits:{maxCommandCount:1000,maxLoopIterations:1000}});
  const r=await b.exec(a.command,{signal:AbortSignal.timeout(3000)});if(r.exitCode)throw Error((r.stderr||(explainEmpty?'no output (for grep: no matches or path missing; workspace is /work)':''))+' [exit code '+r.exitCode+']');return (r.stdout+r.stderr).slice(0,10000)||'(no output)';
 }
 const p=abs(a.path);
 if(name==='read')return await fs.readFile(p).catch(()=>{throw Error(p+' does not exist. List /work with bash ls or find.');});
 if(name==='write'){if(typeof a.content!=='string')throw Error('content must be string');await fs.mkdir(p.slice(0,p.lastIndexOf('/')),{recursive:true});await fs.writeFile(p,a.content);return 'Wrote '+a.content.length+' characters to '+p;}
 if(name==='edit'&&(Array.isArray(a.edits)&&a.edits.length||a.replaceAll===true)){
  let text=await fs.readFile(p);const list=a.edits?.length?a.edits:[a];
  for(const[n,e]of list.entries()){const which=list.length>1?' (edit '+(n+1)+' of '+list.length+'; nothing written)':'';
   if(!e.oldText)throw Error('oldText is empty'+which);if(typeof e.newText!=='string')throw Error('newText missing'+which);
   const count=text.split(e.oldText).length-1;if(!count)throw Error('oldText not found in '+p+which+'. Read the file again and copy the text exactly.');
   if(count>1&&e.replaceAll!==true)throw Error('oldText matches '+count+' times in '+p+which+'; include neighboring lines or set replaceAll.');
   text=e.replaceAll===true?text.split(e.oldText).join(e.newText):text.replace(e.oldText,()=>e.newText);}
  await fs.writeFile(p,text);return 'Applied '+list.length+' edit(s) to '+p+'\n'+text;
 }
 if(name==='edit'){
  let text=await fs.readFile(p);if(!a.oldText)throw Error('oldText is empty; use write to create a file');if(typeof a.newText!=='string')throw Error('newText missing');
  const count=text.split(a.oldText).length-1;if(count!==1)throw Error('oldText matches '+count+' times in '+p+'; read the file and include neighboring lines to make it unique. Nothing written.');
  text=text.replace(a.oldText,()=>a.newText);await fs.writeFile(p,text);return 'Applied 1 edit to '+p+'\n'+text;
 }throw Error('Unknown tool '+name);
}
// The chat template renders non-string values with tojson, so coerce declared non-string
// parameters back (JSON.parse); a value that fails to parse stays a string and the tool errors.
function coerce(name,key,v,set){const t=set.find(x=>x.function.name===name)?.function.parameters.properties?.[key]?.type;if(!t||t==='string')return v;try{return JSON.parse(v)}catch{return v}}
function parse(text,set=tools){
 const calls=[];const matches=[...text.matchAll(/<tool_call>\s*<function=([^>\n]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g)];
 for(const m of matches){const args={};for(const p of m[2].matchAll(/<parameter=([^>\n]+)>\n?([\s\S]*?)\n?<\/parameter>/g))args[p[1]]=coerce(m[1],p[1],p[2],set);calls.push({type:'function',function:{name:m[1],arguments:args}});}
 if(text.includes('<tool_call>')&&!calls.length)throw Error('Malformed/incomplete native XML tool call');return calls;
}
async function generate(messages,{max_new_tokens=384,withTools=false,interrupt_ms=null,includePrompt=true,toolSet=tools,sampling=null,min_new_tokens=0}={}){
 const prompt=generator.tokenizer.apply_chat_template(messages,{tokenize:false,add_generation_prompt:true,enable_thinking:false,...(withTools?{tools:toolSet}:{})});
 const sample=sampling?{do_sample:true,temperature:sampling.temperature,top_p:sampling.top_p??1,top_k:sampling.top_k??0}:{do_sample:false};
 if(min_new_tokens)sample.min_new_tokens=min_new_tokens;
 const inputTokens=generator.tokenizer.encode(prompt,{add_special_tokens:false}).length;
 if(inputTokens+max_new_tokens>8192)throw Error('Qualification context cap 8192 exceeded: '+inputTokens);
 const stopping=new InterruptableStoppingCriteria();let timer;if(interrupt_ms)timer=setTimeout(()=>stopping.interrupt(),interrupt_ms);
 const d=dispatches,s=submissions,start=performance.now();let first=null,last=null,tokens=0,text='';
 try{
  const out=await generator(prompt,{max_new_tokens,...sample,return_full_text:false,add_special_tokens:false,stopping_criteria:stopping,streamer:new TextStreamer(generator.tokenizer,{skip_prompt:true,skip_special_tokens:false,callback_function:t=>text+=t,token_callback_function:()=>{tokens++;first??=performance.now();last=performance.now();}})});
  return {text:out[0].generated_text,stream_text:text,input_tokens:inputTokens,output_token_callbacks:tokens,generation_ms:performance.now()-start,ttft_ms:first===null?null:first-start,decode_ms:first===null?null:last-first,dispatches:dispatches-d,submissions:submissions-s,interrupted:stopping.interrupted??null,...(includePrompt?{prompt}:{})};
 }finally{clearTimeout(timer)}
}
async function snapshot(){const out={};async function walk(p){for(const n of await fs.readdir(p)){const q=p+'/'+n;if((await fs.stat(q)).isDirectory)await walk(q);else out[q]=await fs.readFile(q);}}await walk('/work');return out;}
async function agent(prompt,{files={},messages=null,inject=null,variant={}}={}){
 const {system:sys='base',multiEdit=false,fewshot:shots=false,sampling=null,maxRounds=8}=variant,toolSet=multiEdit?toolsV2:tools;explainEmpty=!!variant.explainEmpty;normalizeNl=!!variant.normalizeNl;
 fs=new InMemoryFs(files);await fs.mkdir('/work',{recursive:true});const history=messages??[{role:'system',content:systems[sys]},...(shots?structuredClone(fewshot):[])];history.push({role:'user',content:prompt});const trace=[];
 if(inject){history.push({role:'assistant',content:'',tool_calls:[inject]});let result;try{result=await execute(inject.function.name,inject.function.arguments)}catch(e){result='ERROR: '+e.message}history.push({role:'tool',content:result});trace.push({injected:true,call:inject,result});}
 const start=performance.now();let status='round_limit';
 let rounds=0;for(let round=0;round<maxRounds;round++){rounds=round+1;
  if(performance.now()-start>120000){status='timeout';break;}
  let g;try{g=await generate(history,{withTools:true,toolSet,sampling});}catch(e){trace.push({error:String(e)});status='generation_error';break;}
  let calls;try{calls=parse(g.text,toolSet)}catch(e){trace.push({...g,error:String(e)});status='parse_error';break;}
  trace.push({...g,calls});history.push({role:'assistant',content:calls.length?'':g.text, ...(calls.length?{tool_calls:calls}:{})});
  if(!calls.length){status=g.output_token_callbacks>=384?'token_limit':'final';break;}
  if(calls.length>8){status='call_limit';break;}
  for(const c of calls){let result;try{result=await execute(c.function.name,c.function.arguments)}catch(e){result='ERROR: '+e.message}trace.push({call:c,result});history.push({role:'tool',content:result});}
 }
 return {status,rounds,duration_ms:performance.now()-start,trace,files:await snapshot(),messages:history};
}
self.onmessage=async ({data})=>{const {id,action}=data;try{let result;
 if(action==='load'){
  const adapter=await navigator.gpu.requestAdapter();const start=performance.now();
  generator=await pipeline('text-generation','model',{dtype:'q4f16',device:'webgpu',progress_callback:progress=>postMessage({progress})});
  // The pipeline registry does not discover tokenizer files for a local alias.
  generator.tokenizer ??= new PreTrainedTokenizer(...await Promise.all(['tokenizer.json','tokenizer_config.json'].map(async f=>(await fetch(new URL('./assets/model/'+f,import.meta.url))).json())));
  result={load_ms:performance.now()-start,userAgent:navigator.userAgent,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,description:adapter.info.description},features:[...adapter.features],limits:{maxBufferSize:adapter.limits.maxBufferSize,maxStorageBufferBindingSize:adapter.limits.maxStorageBufferBindingSize},ort:env.backends.onnx.versions,fetches:[...fetches]};
 }else if(action==='generate')result=await generate(data.messages,data.options);
 else if(action==='agent')result=await agent(data.prompt,data.options);
 else if(action==='inventory')result={fetches,estimate:await navigator.storage.estimate(),persisted:await navigator.storage.persisted(),caches:await caches.keys(),indexedDB:await indexedDB.databases(),template:generator.tokenizer.chat_template};
 else if(action==='dispose'){await generator?.dispose();result='disposed'}
 else throw Error('Unknown action');postMessage({id,result});
 }catch(e){postMessage({id,error:String(e)+'\n'+e.stack})}};
