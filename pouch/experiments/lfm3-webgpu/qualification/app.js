const worker = new Worker('./worker.js', {type:'module'});
const pending = new Map(); let id = 0;
window.cspViolations = [];
document.addEventListener('securitypolicyviolation',e=>window.cspViolations.push({directive:e.violatedDirective,blocked:e.blockedURI}));
worker.onmessage = ({data}) => {
 if(data.progress){document.querySelector('#status').textContent=JSON.stringify(data.progress);return;}
 const p=pending.get(data.id); if(!p)return;pending.delete(data.id);data.error?p.reject(Error(data.error)):p.resolve(data.result);
};
worker.onerror = e => {document.querySelector('#status').textContent=e.message;for(const p of pending.values())p.reject(Error(e.message));};
window.call = (action,args={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});worker.postMessage({id:n,action,...args});});
window.prime = async()=>{
 const reg=await navigator.serviceWorker.register('./sw.js'); await navigator.serviceWorker.ready;
 if(!navigator.serviceWorker.controller) await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));
 const manifest=await (await fetch('./assets-manifest.json')).json();
 const cache=await caches.open('lfm3-qualification-v1');
 const paths=['./','index.html','app.js','worker.js','tools.bundle.js','sw.js','assets-manifest.json',...manifest.assets.map(x=>x.path)];
 for(const path of paths){if(!await cache.match(new URL(path,location.href))) await cache.put(new URL(path,location.href),await fetch(path));}
 return {paths,estimate:await navigator.storage.estimate(),persisted:await navigator.storage.persisted(),cacheKeys:await caches.keys()};
};
window.ready=true;document.querySelector('#status').textContent='Ready';
