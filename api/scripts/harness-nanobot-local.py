#!/usr/bin/env python3
"""Real Nanobot 0.3.5 on ephemeral loopback ports, synthetic credentials/provider.

Run with an isolated venv containing nanobot-ai==0.3.5 and websockets.
No sandbox/production access. HOME/config/state and mock inference are temporary.
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import nanobot
import websockets

assert nanobot.__version__ == '0.3.5'
spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('browser-setup.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
KEY = 'sk-bayleaf-isolated-qualification-key'
AUTH = 'a'*64
calls = []
tool_seen = False


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):pass

    def do_POST(self):
        global tool_seen
        assert self.headers.get('Authorization') == 'Bearer '+KEY
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        calls.append(body)
        available={tool['function']['name'] for tool in body.get('tools',[])}
        if 'mcp_bayleaf_usage' not in available:
            self.send_response(400);self.end_headers();self.wfile.write(b'MCP tool missing');return
        use_tool = not any(message.get('role') == 'tool' for message in body['messages'])
        if not use_tool:tool_seen=True
        data = {'id':'synthetic', 'object':'chat.completion', 'model':'synthetic/model',
            'choices':[{'index':0,'message':{'role':'assistant','content':'Synthetic BayLeaf reply'},'finish_reason':'stop'}],
            'usage':{'prompt_tokens':10,'completion_tokens':5,'total_tokens':15}}
        if use_tool:
            data['choices'][0].update(message={'role':'assistant','content':None,'tool_calls':[
                {'id':'synthetic_usage','type':'function','function':{'name':'mcp_bayleaf_usage','arguments':'{}'}}]},finish_reason='tool_calls')
        if body.get('stream'):
            events = [dict(id='synthetic',object='chat.completion.chunk',model='synthetic/model',
                choices=[dict(index=0,delta={'content':'Synthetic BayLeaf reply'},finish_reason=None)]),
                dict(id='synthetic',object='chat.completion.chunk',model='synthetic/model',
                choices=[dict(index=0,delta={},finish_reason='stop')])]
            if use_tool:
                events[0]['choices'][0]['delta']={'tool_calls':[{'index':0,**data['choices'][0]['message']['tool_calls'][0]}]}
                events[1]['choices'][0]['finish_reason']='tool_calls'
            payload = ''.join('data: '+json.dumps(event)+'\n\n' for event in events)+'data: [DONE]\n\n'
            kind='text/event-stream'
        else:payload=json.dumps(data);kind='application/json'
        raw=payload.encode();self.send_response(200);self.send_header('Content-Type',kind)
        self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)


def port():
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));return sock.getsockname()[1]


def get(base, path, headers=None):
    req=urllib.request.Request(base+path,headers=headers or {})
    with urllib.request.urlopen(req,timeout=3) as response:return json.loads(response.read())


async def websocket_check(ws_port, bootstrap):
    # Missing token must not provide an authenticated socket.
    try:
        async with websockets.connect(f'ws://127.0.0.1:{ws_port}/') as ws:
            await asyncio.wait_for(ws.recv(),timeout=3)
            raise AssertionError('unauthenticated WebSocket accepted')
    except (websockets.exceptions.InvalidStatus, websockets.exceptions.ConnectionClosed):pass
    async with websockets.connect(f'ws://127.0.0.1:{ws_port}/?token={bootstrap["token"]}&client_id=qualification') as ws:
        first=json.loads(await asyncio.wait_for(ws.recv(),timeout=10))
        assert first.get('event') == 'ready', first
        await ws.send(json.dumps({'type':'message','chat_id':'qualification','content':'Reply with a short greeting','webui':True}))
        events=[]
        for _ in range(80):
            event=json.loads(await asyncio.wait_for(ws.recv(),timeout=30));events.append(event)
            if 'Synthetic BayLeaf reply' in json.dumps(event):break
        else:raise AssertionError('No synthetic reply')
        assert KEY not in json.dumps(events) and AUTH not in json.dumps(events)


def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),Provider)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='bayleaf-nanobot-qualification-') as folder:
            root=Path(folder);home=root/'home';home.mkdir()
            m.select_service('nanobot');m.ROOT=root/'managed';m.ROOT.mkdir()
            (m.ROOT/'credentials').mkdir();(m.ROOT/'credentials/incoming').write_text(KEY)
            (m.ROOT/'credentials/app-secret').write_text(AUTH)
            m.atomic('assets.json',json.loads((Path(__file__).resolve().parents[1]/'.nanobot-assets.json').read_text()))
            m.atomic('request.json',{'preview_url':'https://owner-private-generation.bayleaf-proxies.dev/'})
            with patch.object(m.Path,'home',return_value=home),patch.object(m,'nanobot_discovery',return_value=('synthetic/model',128000)):
                m.configure_nanobot()
            config=m.read('config/config.json');ws_port=port();health_port=port()
            config['channels']['websocket'].update(host='127.0.0.1',port=ws_port)
            config['providers']['custom']['apiBase']=f'http://127.0.0.1:{server.server_port}/v1'
            config['tools']['ssrfWhitelist']=['127.0.0.0/8']
            mock = root/'mock-tools.mjs'
            marker = root/'usage-called'
            mock.write_text('import {writeFileSync} from "node:fs"; globalThis.fetch=async(url,init)=>{'
                'if(url!=="https://api.bayleaf.dev/usage" || init.headers.Authorization!=="Bearer '+KEY+'")throw Error("Unexpected fixture request");'
                'writeFileSync('+json.dumps(str(marker))+',"called");return Response.json({observed_at:"fixture",budgets:{standard:{remaining:3}}});};')
            config['tools']['mcpServers']['bayleaf']['args'][:0]=['--import',str(mock)]
            m.atomic('config/config.json',config)
            env={**os.environ,'HOME':str(home),'BAYLEAF_API_KEY':KEY,'BAYLEAF_NANOBOT_AUTH':AUTH,
                'XDG_CONFIG_HOME':str(home/'.config'),'XDG_DATA_HOME':str(home/'.local/share')}
            base=f'http://127.0.0.1:{ws_port}'
            # Capture output privately only to debug synthetic fixture failures.
            with (root/'gateway.log').open('w+') as log:
                child=subprocess.Popen([sys.executable,'-m','nanobot','gateway','--foreground','--config',str(m.ROOT/'config/config.json'),
                    '--port',str(health_port)],env=env,cwd=home,stdin=subprocess.DEVNULL,stdout=log,stderr=log)
                try:
                    for _ in range(160):
                        try:bootstrap=get(base,'/webui/bootstrap',{'X-Nanobot-Auth':AUTH});break
                        except (OSError,ValueError):
                            if child.poll() is not None:raise RuntimeError('Gateway exited during startup')
                            time.sleep(.25)
                    else:raise RuntimeError('Gateway startup timed out')
                    assert bootstrap['ws_url']=='wss://owner-private-generation.bayleaf-proxies.dev/'
                    for headers in ({},{'X-Nanobot-Auth':'wrong'},{'X-Authenticated-Owner':'true'}):
                        try:get(base,'/webui/bootstrap',headers);raise AssertionError('bootstrap bypass')
                        except urllib.error.HTTPError as error:assert error.code==401
                    settings=get(base,'/api/settings',{'Authorization':'Bearer '+bootstrap['api_token']})
                    assert KEY not in json.dumps(settings) and AUTH not in json.dumps(settings)
                    assert KEY not in (m.ROOT/'config/config.json').read_text()
                    asyncio.run(websocket_check(ws_port,bootstrap))
                    assert calls and calls[0]['model']=='synthetic/model'
                    assert marker.exists() and tool_seen, 'Real Nanobot did not execute the mocked BayLeaf MCP tool'
                    assert KEY not in (m.ROOT/'config/config.json').read_text()
                    assert AUTH not in (m.ROOT/'config/config.json').read_text()
                    log.flush();log.seek(0);logged=log.read()
                    assert KEY not in logged and AUTH not in logged, 'Credential appeared in gateway output'
                    print('PASS real Nanobot bootstrap, loopback/wrong-secret denial, token-gated WebSocket greeting, settings secret containment, MCP usage tool and mocked inference reply')
                except Exception:
                    log.flush();log.seek(0)
                    # All fixture credentials are synthetic, still keep output sanitized.
                    print(log.read()[-8000:].replace(KEY,'[owner-key]').replace(AUTH,'[app-secret]'),file=sys.stderr)
                    raise
                finally:
                    child.terminate()
                    try:child.wait(timeout=15)
                    except subprocess.TimeoutExpired:child.kill();child.wait()
    finally:server.shutdown();server.server_close()


if __name__=='__main__':main()
