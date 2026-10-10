#!/usr/bin/env python3
"""Real isolated Jupyter HTTP/WS qualification, no BayLeaf/Daytona credentials.

Run with a venv containing the three adapter pins plus aiohttp and psutil:
  <venv>/bin/python api/scripts/harness-jupyter-local.py
The small proxy models the documented gateway contract, not workerd itself.
"""
import asyncio
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid

import aiohttp
from aiohttp import web
import psutil


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


async def qualify(home):
    script = Path(__file__).with_name('browser-setup.py')
    spec = importlib.util.spec_from_file_location('setup', script)
    setup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(setup)
    exec(compile(script.with_name('jupyter-adapter.py').read_text(), 'jupyter-adapter.py', 'exec'), setup.__dict__)
    port, proxy_port = free_port(), free_port()
    origin = f'http://127.0.0.1:{proxy_port}'
    target = f'http://127.0.0.1:{port}'
    setup.ROOT = home / '.local/share/bayleaf/jupyter'
    setup.PORT = port
    setup.RELEASE = 'jupyterlab-4.6.4-managed-v1'
    root = setup.ROOT
    (root/'credentials').mkdir(parents=True)
    (root/'releases').mkdir()
    if os.environ.get('JUPYTER_QUALIFY_INSTALL') == '1':
        # Exercise the real installer commands on macOS. The shared Linux /proc
        # watchdog is separately tested by the managed-installer harness.
        def command(argv, timeout=30, env=None):
            subprocess.run(argv, env=env, timeout=timeout, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        setup.command = command
        class Progress:
            def update(self, *args, **kwargs): pass
        setup.install_jupyter(Progress())
        kernelspec = json.loads((root/'releases'/setup.RELEASE/'share/jupyter/kernels/python3/kernel.json').read_text())
        assert kernelspec['argv'][0] == str(root/'releases'/setup.RELEASE/'bin/python')
        assert (root/'releases'/setup.RELEASE/'packages.json').is_file()
    else:
        (root/'releases'/setup.RELEASE).symlink_to(Path(sys.prefix))
    secret = secrets.token_hex(32)
    (root/'credentials/app-secret').write_text(secret)
    setup.configure_jupyter()
    argv, env = setup.start_jupyter(None)
    argv += ['--ServerApp.ip=127.0.0.1']
    log = (home/'server.log').open('w')
    proc = subprocess.Popen(argv, env=env, stdout=log, stderr=log, start_new_session=True)
    checks = []
    def check(value, name):
        assert value, name
        checks.append(name)
    auth = {'Authorization':'token '+secret}
    owner = secrets.token_hex(16)
    forwarded = 0
    async with aiohttp.ClientSession(cookie_jar=aiohttp.DummyCookieJar()) as upstream:
        async def proxy(request):
            nonlocal forwarded
            # Deliberately independent of supplied app cookies / app tokens.
            if request.headers.get('X-Test-Owner') != owner:
                return web.Response(status=401)
            is_ws = request.headers.get('Upgrade', '').lower() == 'websocket'
            incoming_origin = request.headers.get('Origin')
            if ((incoming_origin and incoming_origin != origin) or
                ((is_ws or request.method not in ('GET','HEAD')) and incoming_origin != origin)):
                return web.Response(status=403)
            headers = dict(auth, Host='8793-signed.synthetic.proxy.daytona.work',
                           **{'X-Forwarded-Host':request.host, 'X-Forwarded-Proto':'https'})
            if incoming_origin:
                headers['Origin'] = incoming_origin
            if request.headers.get('Cookie'):
                headers['Cookie'] = request.headers['Cookie']
            forwarded += 1
            if is_ws:
                backend = await upstream.ws_connect(target+request.path_qs, headers=headers)
                client = web.WebSocketResponse()
                await client.prepare(request)
                async def relay(a,b):
                    async for message in a:
                        if message.type == aiohttp.WSMsgType.TEXT:
                            await b.send_str(message.data)
                        elif message.type == aiohttp.WSMsgType.BINARY:
                            await b.send_bytes(message.data)
                    await b.close()
                tasks = [asyncio.create_task(relay(client,backend)), asyncio.create_task(relay(backend,client))]
                try:
                    await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    for task in tasks: task.cancel()
                    await backend.close()
                return client
            async with upstream.request(request.method, target+request.path_qs, headers=headers,
                                        data=await request.read(), allow_redirects=False) as response:
                out = web.Response(status=response.status, body=await response.read())
                for name in ('Content-Type','Location'):
                    if name in response.headers: out.headers[name] = response.headers[name]
                for value in response.headers.getall('Set-Cookie', []): out.headers.add('Set-Cookie', value)
                return out
        app = web.Application()
        app.router.add_route('*','/{path:.*}',proxy)
        runner = web.AppRunner(app)
        try:
            for _ in range(150):
                if proc.poll() is not None: raise RuntimeError((home/'server.log').read_text())
                try:
                    async with upstream.get(target+'/api/status', headers=auth) as response:
                        if response.status == 200: break
                except aiohttp.ClientError: pass
                await asyncio.sleep(.2)
            else: raise RuntimeError('readiness timeout')
            await runner.setup()
            await web.TCPSite(runner, '127.0.0.1', proxy_port).start()
            browser_headers = {'X-Test-Owner':owner, 'Origin':origin}
            async with upstream.get(target+'/api/status') as response:
                check(response.status == 403, 'direct API without token denied')
            async with upstream.get(target+'/api/status', headers=dict(auth, Host='arbitrary.invalid')) as response:
                check(response.status == 200, 'native token accepts Daytona-shaped nonlocal Host')
            async with upstream.get(origin+'/lab', headers=browser_headers) as response:
                body = await response.text()
                check(response.status == 200, 'JupyterLab bootstrap through injecting proxy')
                check(secret not in body, 'app-only token absent from bootstrap HTML')
                config = json.loads(re.search(r'<script id="jupyter-config-data" type="application/json">(.*?)</script>',body,re.S)[1])
                check(config['token'] == '' and config.get('wsUrl','') == '', 'browser uses relative WS and no token')
                cookies = response.headers.getall('Set-Cookie', [])
                check(any('_xsrf=' in x for x in cookies), 'native XSRF cookie set')
                check(any('username-' in x for x in cookies), 'native login cookie set')
                cookie = '; '.join(x.split(';',1)[0] for x in cookies)
            before = forwarded
            async with upstream.get(origin+'/api/status',headers=dict(auth,Cookie=cookie)) as response:
                check(response.status == 401 and forwarded == before, 'app auth cannot bypass owner gate')
            async with upstream.post(origin+'/api/kernels',headers=dict(browser_headers,Origin='https://evil.invalid'),json={}) as response:
                check(response.status == 403 and forwarded == before, 'cross-origin mutation denied before injection')
            # Native token semantics intentionally bypass cookie-XSRF, without a
            # disable_check_xsrf setting. Cookie-only requests still require it.
            async with upstream.get(target+'/lab',headers=auth) as response:
                direct_cookies = response.headers.getall('Set-Cookie', [])
                direct_cookie = '; '.join(x.split(';',1)[0] for x in direct_cookies)
            async with upstream.post(target+'/api/kernels',headers={'Cookie':direct_cookie,'Origin':target},json={}) as response:
                check(response.status == 403, 'cookie-only mutation without XSRF rejected')
            async with upstream.post(origin+'/api/kernels',headers=browser_headers,json={'name':'python3'}) as response:
                check(response.status == 201, 'kernel creation without browser token or XSRF header')
                kernel = await response.json()
            session = uuid.uuid4().hex
            async with upstream.ws_connect(origin+f'/api/kernels/{kernel["id"]}/channels?session_id={session}',headers=browser_headers) as ws:
                msgid = uuid.uuid4().hex
                await ws.send_json({'header':{'msg_id':msgid,'username':'qualification','session':session,'msg_type':'execute_request','version':'5.3'},
                    'parent_header':{},'metadata':{},'channel':'shell','content':{'code':'print("JUPYTER_POC_OK")','silent':False,
                    'store_history':False,'user_expressions':{},'allow_stdin':False,'stop_on_error':True},'buffers':[]})
                for _ in range(50):
                    message = await ws.receive_json(timeout=30)
                    if message.get('msg_type') == 'stream' and 'JUPYTER_POC_OK' in message.get('content',{}).get('text',''): break
                else: raise AssertionError('kernel execute output')
                check(True,'kernel WebSocket executes Python through mismatched Host/origin proxy')
            async with upstream.put(origin+'/api/contents/proof.txt',headers=browser_headers,
                                    json={'type':'file','format':'text','content':'shared workspace proof'}) as response:
                check(response.status == 201 and (home/'workspace/proof.txt').read_text() == 'shared workspace proof', 'contents API writes shared workspace')
            async with upstream.post(origin+'/api/terminals',headers=browser_headers,json={}) as response:
                check(response.status == 200, 'terminal creation')
                terminal = await response.json()
            async with upstream.ws_connect(origin+'/terminals/websocket/'+terminal['name'],headers=browser_headers) as ws:
                await ws.send_json(['stdin','printf "TERMINAL_%s\\n" "POC_OK"\n'])
                text = ''
                for _ in range(30):
                    message = await ws.receive_json(timeout=15)
                    if message[0] == 'stdout': text += message[1]
                    if 'TERMINAL_POC_OK' in text: break
                check('TERMINAL_POC_OK' in text,'terminal WebSocket round trip')
            processes = [psutil.Process(proc.pid), *psutil.Process(proc.pid).children(recursive=True)]
            rss = sum(p.memory_info().rss for p in processes if p.is_running())
            async with upstream.get(origin+'/api/status',headers=browser_headers) as response:
                check(setup.health_jupyter(await response.json()),'adapter health matches real server')
            for path in (f'/api/kernels/{kernel["id"]}',f'/api/terminals/{terminal["name"]}'):
                async with upstream.delete(origin+path,headers=browser_headers) as response:
                    check(response.status == 204,'cleanup '+path.split('/')[2])
            print(json.dumps({'checks':checks,'rss_bytes_server_kernel_terminal':rss,
                'packages':setup.JUPYTER_PACKAGES,'fresh_install':os.environ.get('JUPYTER_QUALIFY_INSTALL') == '1',
                'scope':'isolated real Jupyter with modeled proxy; not live gateway/browser'},indent=2))
        finally:
            await runner.cleanup()
            with contextlib.suppress(ProcessLookupError): os.killpg(proc.pid, signal.SIGTERM)
            try: proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid,signal.SIGKILL); proc.wait()
            log.close()


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='bayleaf-jupyter-',dir=os.environ.get('TMPDIR')) as directory:
        home = Path(directory)
        os.environ.update(HOME=str(home), XDG_CONFIG_HOME=str(home/'xdg/config'),
                          XDG_DATA_HOME=str(home/'xdg/data'), XDG_CACHE_HOME=str(home/'xdg/cache'))
        asyncio.run(qualify(home))
