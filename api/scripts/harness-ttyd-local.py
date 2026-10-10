#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["aiohttp>=3.12,<4", "psutil>=7,<8"]
# ///
"""Real ttyd 1.7.7 HTTP/WS against an isolated HOME and gateway-contract fixture.

TTYD_BINARY=/absolute/path/to/ttyd uv run api/scripts/harness-ttyd-local.py
On Linux amd64, omit TTYD_BINARY to exercise the real verified installer too.
The separate workerd harness qualifies the actual owner-private gateway.
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import tempfile

import aiohttp
from aiohttp import web
import psutil


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0))
        return sock.getsockname()[1]


async def qualify(home):
    spec = importlib.util.spec_from_file_location('setup',Path(__file__).with_name('browser-setup.py'))
    s = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(s)
    s.select_service('ttyd')
    s.PORT = port()
    (s.ROOT/'credentials').mkdir(parents=True)
    (s.ROOT/'credentials/app-secret').write_text(secrets.token_hex(32))
    binary = os.environ.get('TTYD_BINARY')
    if binary:
        release = s.ROOT/'releases'/s.RELEASE
        release.mkdir(parents=True)
        (release/'ttyd').symlink_to(Path(binary).resolve())
    else:
        class Progress:
            def update(self,*args,**kwargs): pass
        s.install_ttyd(Progress())
    s.configure_ttyd()
    argv, env = s.start_ttyd(None)
    assert '1.7.7' in subprocess.check_output([argv[0],'--version'],text=True)
    backend = f'http://127.0.0.1:{s.PORT}'
    proxy_port = port()
    origin = f'http://127.0.0.1:{proxy_port}'
    basic = 'Basic '+s.ttyd_token()
    owner = secrets.token_hex(16)
    forwarded = 0
    async with aiohttp.ClientSession(cookie_jar=aiohttp.DummyCookieJar()) as client:
        async def proxy(request):
            nonlocal forwarded
            if request.headers.get('X-Test-Owner') != owner: return web.Response(status=401)
            ws = request.headers.get('Upgrade','').lower() == 'websocket'
            supplied = request.headers.get('Origin')
            if (supplied and supplied != origin) or (ws and supplied != origin): return web.Response(status=403)
            headers = {'Authorization':basic,'Host':'8794-signed.synthetic.proxy.daytona.work',
                       'Origin':origin,'X-Forwarded-Host':request.host,'X-Forwarded-Proto':'https'}
            forwarded += 1
            if ws:
                upstream = await client.ws_connect(backend+request.path_qs,headers=headers,protocols=['tty'])
                browser = web.WebSocketResponse(protocols=['tty'])
                await browser.prepare(request)
                async def relay(a,b):
                    async for msg in a:
                        if msg.type == aiohttp.WSMsgType.BINARY: await b.send_bytes(msg.data)
                        elif msg.type == aiohttp.WSMsgType.TEXT: await b.send_str(msg.data)
                tasks = [asyncio.create_task(relay(browser,upstream)),asyncio.create_task(relay(upstream,browser))]
                try: await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
                finally:
                    for task in tasks: task.cancel()
                    await asyncio.gather(*tasks,return_exceptions=True)
                    await upstream.close()
                    await browser.close()
                return browser
            async with client.get(backend+request.path_qs,headers=headers) as response:
                return web.Response(status=response.status,body=await response.read(),headers={'Content-Type':response.headers['Content-Type']})
        app = web.Application()
        app.router.add_route('*','/{path:.*}',proxy)
        runner = web.AppRunner(app)
        proc = subprocess.Popen(argv,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        try:
            for _ in range(100):
                assert proc.poll() is None, 'ttyd exited'
                try:
                    async with client.get(backend+'/token',headers={'Authorization':basic}) as response:
                        if response.status == 200: break
                except aiohttp.ClientError: pass
                await asyncio.sleep(.05)
            else: raise AssertionError('readiness timeout')
            await runner.setup()
            await web.TCPSite(runner,'127.0.0.1',proxy_port).start()
            headers = {'X-Test-Owner':owner,'Origin':origin}
            for path in ('/','/token'):
                async with client.get(backend+path) as response: assert response.status == 401
            async with client.get(origin+'/',headers=headers) as response:
                assert response.status == 200 and 'ttyd' in await response.text()
            async with client.get(origin+'/token',headers=headers) as response:
                token = (await response.json())['token']
                assert token == s.ttyd_token()
            before = forwarded
            async with client.get(origin+'/token',headers={'Authorization':basic}) as response: assert response.status == 401
            async with client.get(origin+'/token',headers={'X-Test-Owner':'other-owner','Authorization':basic}) as response: assert response.status == 401
            for url, hs in [(backend+'/ws',{'Origin':backend}),
                            (origin+'/ws',{'Origin':origin,'Authorization':basic}),
                            (origin+'/ws',{'Origin':origin,'X-Test-Owner':'other-owner','Authorization':basic}),
                            (origin+'/ws',dict(headers,Origin='https://evil.invalid'))]:
                try: await client.ws_connect(url,headers=hs,protocols=['tty'])
                except (aiohttp.WSServerHandshakeError, aiohttp.ServerDisconnectedError): pass
                else: raise AssertionError('unauthorized websocket accepted')
            assert before == forwarded
            async with client.ws_connect(origin+'/ws?arg=ignored',headers=headers,protocols=['tty']) as ws:
                await ws.send_json({'AuthToken':token,'columns':80,'rows':24})
                # Output marker uses separate printf arguments so echoed input
                # cannot falsely count as executed shell output.
                await ws.send_bytes(b'0printf "TTYD_%s\\n" SMOKE_OK; pwd; echo $$ > shell.pid\r')
                output = b''
                for _ in range(30):
                    msg = await ws.receive(timeout=10)
                    if msg.type == aiohttp.WSMsgType.BINARY: output += msg.data
                    if b'TTYD_SMOKE_OK' in output and str(home/'workspace').encode() in output: break
                else: raise AssertionError('no shell output')
                for _ in range(100):
                    if (home/'workspace/shell.pid').exists(): break
                    await asyncio.sleep(.02)
                pid = int((home/'workspace/shell.pid').read_text())
                assert psutil.Process(pid).uids().real == os.getuid()
            for _ in range(100):
                if not psutil.pid_exists(pid): break
                await asyncio.sleep(.05)
            assert not psutil.pid_exists(pid), 'disconnected shell survived'
            print('PASS real ttyd 1.7.7: authenticated HTTP, WS shell printf/cwd/user, direct denial, owner/origin fixture gates, disconnect cleanup')
        finally:
            await runner.cleanup()
            if proc.poll() is None:
                os.killpg(proc.pid,signal.SIGTERM)
                try: proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid,signal.SIGKILL)
                    proc.wait()


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='bayleaf-ttyd-') as directory:
        os.environ['HOME'] = directory
        asyncio.run(qualify(Path(directory).resolve()))
