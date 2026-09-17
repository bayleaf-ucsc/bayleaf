#!/usr/bin/env python3
"""Synthetic HTTP fixture for live preview qualification. No request logging."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import sys

CHECK = b'''<!doctype html><title>BayLeaf preview qualification</title>
<h1>Preview qualification</h1><pre id="result">Running synthetic checks...</pre>
<script>
(async () => {
  await fetch('/cookie');
  const echo = await (await fetch('/echo')).json();
  const entries = Object.entries(echo);
  const hidden = /daytonaproxy[0-9]+\\.net|proxy\\.daytona\\.work/i;
  const redirect = await fetch('/redirect');
  const error = await fetch('/error');
  const errorBody = await error.text();
  const upload = await fetch('/upload', {method:'POST', body:'synthetic-upload'});
  const report = {
    upstreamHostnameReflected: entries.some(([k,v]) => hidden.test(v)),
    reflectingHeaderNames: entries.filter(([k,v]) => hidden.test(v)).map(([k]) => k),
    gatewayCookieForwarded: entries.some(([k,v]) => k.toLowerCase() === 'cookie' && v.includes('__Host-bl-preview')),
    applicationCookieRoundTrip: entries.some(([k,v]) => k.toLowerCase() === 'cookie' && v.includes('fixture-cookie=present')),
    applicationCookieVisibleToScript: document.cookie.includes('fixture-cookie'),
    forwardedHostMatchesGateway: entries.some(([k,v]) => k.toLowerCase() === 'x-forwarded-host' && v === location.host),
    redirectStayedWrapped: redirect.url === location.origin + '/target',
    errorStatus: error.status,
    upstreamHostnameInError: hidden.test(errorBody),
    upload: await upload.json()
  };
  document.getElementById('result').textContent = JSON.stringify(report, null, 2);
})().catch(() => {document.getElementById('result').textContent='Qualification request failed';});
</script>'''

SW = b'''self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{
 if(new URL(e.request.url).pathname==='/sw-marker') e.respondWith(new Response('worker-intercepted'));
});'''
SW_CHECK = b'''<!doctype html><title>Service worker qualification</title><pre id="result">Running...</pre>
<script>(async()=>{
 const before=!!navigator.serviceWorker.controller;
 await navigator.serviceWorker.register('/assets/sw.js',{scope:'/'});
 await navigator.serviceWorker.ready;
 if(!navigator.serviceWorker.controller) await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));
 const marker=await(await fetch('/sw-marker')).text();
 const network=await fetch('/echo');
 document.querySelector('#result').textContent=JSON.stringify({controlledBefore:before,controlledNow:!!navigator.serviceWorker.controller,interceptionWorks:marker==='worker-intercepted',authenticatedNetworkStatus:network.status},null,2);
})().catch(e=>document.querySelector('#result').textContent='Service worker check failed: '+e.name);</script>'''
SW_STATE = b'''<!doctype html><title>Origin isolation check</title><pre id="result"></pre><script>
navigator.serviceWorker.getRegistrations().then(r=>document.querySelector('#result').textContent=JSON.stringify({controller:!!navigator.serviceWorker.controller,registrations:r.length}));</script>'''


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path in ['/assets/sw.js','/sw-check','/sw-state']:
            content={'/assets/sw.js':SW,'/sw-check':SW_CHECK,'/sw-state':SW_STATE}[self.path]
            self.send_response(200)
            self.send_header('Content-Type','application/javascript' if self.path.endswith('.js') else 'text/html')
            if self.path.endswith('.js'): self.send_header('Service-Worker-Allowed','/')
            self.end_headers(); self.wfile.write(content); return
        if self.path == "/cookie":
            self.send_response(204)
            self.send_header("Set-Cookie", "fixture-cookie=present; Domain=.bayleaf-proxies.dev; Path=/; Max-Age=600")
            self.end_headers()
            return
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "https://" + self.headers.get("X-Forwarded-Host", self.headers["Host"]) + "/target")
            self.end_headers()
            return
        if self.path == "/error":
            self.send_response(500)
            self.end_headers()
            self.wfile.write(self.headers["Host"].encode())
            return
        body = (CHECK if self.path == "/check" else json.dumps(dict(self.headers)).encode() if self.path == "/echo" else
                b"<!doctype html><title>BayLeaf preview test</title><h1>Owner-authenticated preview</h1><p>Synthetic HTTP service for issue #71.</p>")
        self.send_response(200)
        self.send_header("Content-Type", "application/json" if self.path == "/echo" else "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        result = json.dumps({"received_bytes": len(body)}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(result)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1])), Handler).serve_forever()
