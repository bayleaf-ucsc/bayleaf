#!/usr/bin/env python3
"""Exercise production Lathe's protected expose with a tracked synthetic service.
Run using the adjacent Lathe project's uv environment. Never deploy/delete tools.
"""
import asyncio
import os
import re
from pathlib import Path
import shlex
import subprocess
import sys
import urllib.request

ROOT=Path(__file__).resolve().parents[2]
for item in shlex.split((Path.home()/'.tokens/owui/chat-bayleaf-dev').read_text(),comments=True):
    if '=' in item:
        key,value=item.split('=',1); os.environ[key]=value
os.environ['OWUI_MODEL']='basic'
sys.path.insert(0,str(ROOT.parent/'lathe'))
from test_deployment import OWUIClient, tool_calls, tool_outputs


async def main():
    helper=ROOT/'api/scripts/preview-ops.py'
    subprocess.run([sys.executable,str(helper),'fixture'],check=True)
    client=OWUIClient(tool_id='lathe')
    preview_urls=[]
    try:
        await client.connect()
        output=await client.send('A synthetic HTTP service is already running on port 8787. '
            'Call expose with target http:8787, access private, and tag production-smoke exactly once, then return its URL. '
            'Do not launch services, inspect files, or change the sandbox.')
        values='\n'.join(tool_outputs(output))
        if not any(c.get('name')=='expose' for c in tool_calls(output)):
            raise RuntimeError('Production expose was not invoked')
        private_match=re.search(r'https://amsmith-private-[a-f0-9]{24}\.bayleaf-proxies\.dev/', values)
        if not private_match or 'Owner-authenticated private preview' not in values:
            raise RuntimeError('Production private expose mismatch: '
                f'wrapped_url={bool(private_match)} '
                f'private_note={"Owner-authenticated private preview" in values} '
                f'upstream_leak={"daytonaproxy" in values or ".proxy.daytona.work" in values}')
        if 'daytonaproxy' in values or '.proxy.daytona.work' in values:
            raise RuntimeError('Production result exposed an upstream hostname')
        print('PASS: production lathe returned an owner-authenticated CruzID URL with no upstream hostname')

        private_url=private_match.group(0)
        preview_urls.append(private_url)
        output=await client.send('The same synthetic HTTP service is still running on port 8787. '
            'Call expose with target http:8787, access public, and tag production-smoke exactly once, then return its URL.')
        values='\n'.join(tool_outputs(output))
        match=re.search(r'https://amsmith-public-[a-f0-9]{24}\.bayleaf-proxies\.dev/', values)
        if not match or 'Public wrapped preview' not in values:
            raise RuntimeError('Production expose did not return the expected public wrapped URL')
        public_url=match.group(0); preview_urls.append(public_url)
        request=urllib.request.Request(public_url,headers={
            'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36',
            'Sec-Fetch-Site':'none','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'})
        with urllib.request.urlopen(request,timeout=30) as response:
            if response.status != 200 or 'Owner-authenticated preview' not in response.read().decode():
                raise RuntimeError('Public wrapped preview did not serve the synthetic fixture directly')
        print('PASS: production lathe returned a public wrapped URL that serves without login')

        output=await client.send(
            'Call expose with target ssh exactly once. Return the tool result without trying another target.'
        )
        values='\n'.join(tool_outputs(output))
        if not any(c.get('name')=='expose' for c in tool_calls(output)):
            raise RuntimeError('Production expose(ssh) was not invoked')
        if 'target must be "dufs", "site:/absolute/path", "ttyd", "code-server", or "http:<port>"' not in values:
            raise RuntimeError('Production Lathe did not reject SSH exposure')
        if 'ssh.app.daytona.io' in values or 'SSH command' in values:
            raise RuntimeError('Production result contained SSH access material')
        print('PASS: production lathe refused SSH exposure without returning access material')
    finally:
        await client.close()
        try:
            values=dict(line.split('=',1) for line in (Path.home()/'.tokens/bayleaf-previews').read_text().splitlines())
            for preview_url in preview_urls:
                label=preview_url.split('//',1)[1].split('.',1)[0]
                request=urllib.request.Request('https://api.bayleaf.dev/previews/registrations/'+label,method='DELETE',
                    headers={'Authorization':'Bearer '+values['PREVIEWS_INSTALLATION_KEY'],
                        'User-Agent':'BayLeaf-Preview-Qualification/1.0'})
                with urllib.request.urlopen(request,timeout=30): pass
        finally:
            subprocess.run([sys.executable,str(helper),'cleanup'],check=True)


if __name__=='__main__': asyncio.run(main())
