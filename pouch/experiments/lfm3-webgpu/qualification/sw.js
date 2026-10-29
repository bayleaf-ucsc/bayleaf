// No external network and no inference endpoint exists in this experimental app.
self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{
 if(new URL(e.request.url).origin!==self.location.origin){e.respondWith(Promise.reject(Error('External request forbidden')));return;}
 e.respondWith(caches.open('lfm3-qualification-v1').then(async c=>(await c.match(e.request))||fetch(e.request)));
});
