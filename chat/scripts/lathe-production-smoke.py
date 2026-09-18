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
    try:
        await client.connect()
        output=await client.send('A synthetic HTTP service is already running on port 8787. '
            'Call expose with target http:8787 exactly once and return its protected URL. '
            'Do not launch services, inspect files, or change the sandbox.')
        values='\n'.join(tool_outputs(output))
        if not any(c.get('name')=='expose' for c in tool_calls(output)):
            raise RuntimeError('Production expose was not invoked')
        if not re.search(r'https://amsmith-[a-f0-9]{24}\.bayleaf-proxies\.dev/', values) or 'Owner-authenticated preview' not in values:
            raise RuntimeError('Production expose did not return the expected protected URL/access mode')
        if 'daytonaproxy' in values or '.proxy.daytona.work' in values:
            raise RuntimeError('Production result exposed an upstream hostname')
        print('PASS: production lathe returned an owner-authenticated CruzID URL with no upstream hostname')

        output=await client.send(
            'Call expose with target ssh exactly once. Return the tool result without trying another target.'
        )
        values='\n'.join(tool_outputs(output))
        if not any(c.get('name')=='expose' for c in tool_calls(output)):
            raise RuntimeError('Production expose(ssh) was not invoked')
        if 'target must be "dufs", "code-server", or "http:<port>"' not in values:
            raise RuntimeError('Production Lathe did not reject SSH exposure')
        if 'ssh.app.daytona.io' in values or 'SSH command' in values:
            raise RuntimeError('Production result contained SSH access material')
        print('PASS: production lathe refused SSH exposure without returning access material')
    finally:
        await client.close()
        subprocess.run([sys.executable,str(helper),'cleanup'],check=True)


if __name__=='__main__': asyncio.run(main())
