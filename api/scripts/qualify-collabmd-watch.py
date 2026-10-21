#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["websockets>=15,<16"]
# ///
"""Local CDP-only room instrumentation and bounded two-browser soak.

Does not fetch the sandbox or poke activity. Reload only in explicit instrument
mode, before opening the document. watch reads counters over local CDP.
"""
import argparse
import json
import os
from pathlib import Path
import time
from urllib.parse import urlsplit
from urllib.request import urlopen
from websockets.sync.client import connect

ROOT=Path(os.environ.get('TMPDIR','/tmp'))/'opencode/collabmd-qualification-profiles'
PRELOAD="""(() => {
  const stats=window.__bayleafRoomProbe={created:0,open:0,closed:0,errors:0,frames:0,maxFrame:0,paths:{}};
  const Native=window.WebSocket;
  window.WebSocket=class extends Native {
    constructor(...args){
      super(...args);stats.created++;
      const path=new URL(args[0],location.href).pathname;stats.paths[path]=(stats.paths[path]||0)+1;
      let opened=false;
      this.addEventListener('open',()=>{opened=true;stats.open++;});
      this.addEventListener('close',()=>{stats.closed++;if(opened)stats.open--;});
      this.addEventListener('error',()=>stats.errors++);
      this.addEventListener('message',event=>{stats.frames++;const d=event.data;
        const n=typeof d==='string'?new TextEncoder().encode(d).length:d.byteLength??d.size??0;
        stats.maxFrame=Math.max(stats.maxFrame,n);});
    }
  };
})();"""


class Page:
    def __init__(self,name):
        state=json.loads((ROOT/name/'state.json').read_text())
        u=urlsplit(state['debug_url'])
        ledger=json.loads(Path(os.environ.get('BAYLEAF_COLLABMD_LEDGER',str(Path.home()/'.tokens/bayleaf-collabmd-qualification.json'))).read_text())
        host=urlsplit(ledger['url']).hostname
        with urlopen('http://'+u.netloc+'/json/list',timeout=10) as response:
            targets=json.load(response)
        matching=[t for t in targets if t.get('type')=='page' and urlsplit(t.get('url','')).hostname==host]
        if len(matching)!=1:
            raise RuntimeError('expected_one_qualification_page')
        self.socket=connect(matching[0]['webSocketDebuggerUrl'],max_size=4*1024**2)
        self.sequence=0
    def call(self,method,params=None):
        self.sequence+=1
        self.socket.send(json.dumps({'id':self.sequence,'method':method,'params':params or {}}))
        while True:
            message=json.loads(self.socket.recv(timeout=15))
            if message.get('id')==self.sequence:
                if 'error' in message:
                    raise RuntimeError('cdp_command_failed')
                return message.get('result',{})
    def sample(self):
        result=self.call('Runtime.evaluate',{'expression':"JSON.stringify({probe:window.__bayleafRoomProbe,editor:document.querySelector('.cm-content')?.textContent?.slice(0,1000),body:document.body.innerText.slice(0,180),heapBytes:performance.memory?.usedJSHeapSize})",'returnByValue':True})
        return json.loads(result['result']['value'])


parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('action',choices=('instrument','sample','watch'))
parser.add_argument('--seconds',type=int,default=7200)
parser.add_argument('--live',action='store_true')
args=parser.parse_args()
if not args.live:
    parser.error('--live required')
if not 1<=args.seconds<=7500:
    parser.error('watch duration must be 1–7500 seconds')
pages={name:Page(name) for name in ('a','b')}
try:
    if args.action=='instrument':
        for name,page in pages.items():
            page.call('Page.enable')
            page.call('Page.addScriptToEvaluateOnNewDocument',{'source':PRELOAD,'runImmediately':True})
            page.call('Page.reload',{'ignoreCache':True})
            for _ in range(50):
                try:
                    if page.sample().get('probe',{}).get('created',0)>=1:
                        break
                except (KeyError,ValueError):
                    pass
                time.sleep(.2)
            else:
                raise RuntimeError('websocket_instrumentation_not_observed')
        print(json.dumps({'instrumented_profiles':['a','b']}),flush=True)
    elif args.action=='sample':
        print(json.dumps({name:page.sample() for name,page in pages.items()}),flush=True)
    else:
        for _ in range(120):
            if all(page.sample().get('probe',{}).get('open')==3 for page in pages.values()):
                break
            time.sleep(.25)
        else:
            raise RuntimeError('both_profiles_must_have_three_live_sockets_before_soak')
        start=time.time();end=start+args.seconds;out=ROOT/'soak.jsonl'
        with out.open('w') as log:
            while True:
                record={'elapsed_seconds':round(time.time()-start),'profiles':{name:page.sample() for name,page in pages.items()}}
                log.write(json.dumps(record)+'\n');log.flush()
                print(json.dumps({'elapsed_seconds':record['elapsed_seconds'],
                    'profiles':{name:data.get('probe') for name,data in record['profiles'].items()}}),flush=True)
                if time.time()>=end:
                    break
                time.sleep(min(60,max(0,end-time.time())))
        print(json.dumps({'soak_completed':True,'seconds':args.seconds,'evidence':str(out)}),flush=True)
finally:
    for page in pages.values():
        page.socket.close()
