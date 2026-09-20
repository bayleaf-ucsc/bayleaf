#!/usr/bin/env python3
"""Live synthetic dufs/code-server qualification, isolated from user workspace."""
import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import importlib.util
import shlex
import subprocess
import time
import urllib.request
import urllib.error

spec = importlib.util.spec_from_file_location('preview_ops', Path(__file__).with_name('preview-ops.py'))
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)
RECORD = Path.home() / '.tokens/bayleaf-preview-apps.json'
VM_RECORD = Path.home() / '.tokens/bayleaf-preview-apps-vm.json'
CHECK = '''<!doctype html><title>dufs qualification</title><h1>dufs upload/download test</h1><pre id="result">Running...</pre>
<script>(async()=>{
const text='Synthetic BayLeaf upload';
const put=await fetch('/uploaded.txt',{method:'PUT',body:text});
const get=await fetch('/uploaded.txt');
const matches=(await get.text())===text;
const del=await fetch('/uploaded.txt',{method:'DELETE'});
document.querySelector('#result').textContent=JSON.stringify({upload:put.status,download:get.status,contentsMatch:matches,delete:del.status},null,2);
})().catch(()=>{document.querySelector('#result').textContent='Qualification failed';});</script>'''


def daytona(path, body=None, method=None, toolbox=False):
    env = {**os.environ, **dict(item.split('=',1) for item in shlex.split(
        (Path.home()/'.tokens/owui/chat-bayleaf-dev').read_text(),comments=True) if '=' in item)}
    result = subprocess.run(['uvx','owui-cli','--json','tools','valves','lathe'],env=env,text=True,capture_output=True,check=True)
    key = json.loads(result.stdout)['daytona_api_key']
    base = 'https://proxy.app.daytona.io/toolbox' if toolbox else 'https://app.daytona.io/api'
    request = urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization':'Bearer '+key,'Content-Type':'application/json','User-Agent':'BayLeaf-Preview-Qualification/1.0'},method=method)
    try:
        with urllib.request.urlopen(request,timeout=180) as response:
            return json.load(response) if response.status != 204 else {}
    except urllib.error.HTTPError as error:
        if error.code == 404: return None
        if path == '/sandbox' and body is not None:
            detail=json.load(error)
            print('Sandbox creation:', detail.get('message', 'request rejected'))
        raise SystemExit(f'Daytona request failed: HTTP {error.code}') from None


def create_vm():
    if VM_RECORD.exists() or RECORD.exists(): raise SystemExit('Clean up the preceding application run first')
    tag = 'bayleaf-preview-apps-' + secrets.token_hex(8)
    data = daytona('/sandbox', {'name':tag,'cpu':2,'memory':4,'disk':10,
        'buildInfo':{'dockerfileContent':'FROM debian:trixie-slim\nRUN apt-get update && apt-get install -y python3 curl ca-certificates git procps iproute2 tar gzip && rm -rf /var/lib/apt/lists/*\nRUN useradd -m -s /bin/bash daytona && mkdir -p /home/daytona/workspace && chown daytona:daytona /home/daytona/workspace\nUSER daytona\nWORKDIR /home/daytona/workspace\n'},
        'labels':{'bayleaf-preview-qualification':tag},'autoStopInterval':15,'autoArchiveInterval':30,'autoDeleteInterval':30})
    fd = os.open(VM_RECORD,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(fd,'w') as f: json.dump({'id':data['id'],'tag':tag,'created_at':time.time()},f)
    for _ in range(60):
        data = daytona('/sandbox/'+data['id'])
        if data['state'] == 'started':
            print('Disposable 2-vCPU/4-GiB qualification sandbox ready; 30-minute test budget (~$0.09)')
            return
        time.sleep(2)
    raise SystemExit('Sandbox not ready; tracked ID retained for cleanup')


def execute(command):
    if not VM_RECORD.exists(): return ops.api('/sandbox/exec', {'command':command})
    vm = json.loads(VM_RECORD.read_text())
    result = daytona('/'+vm['id']+'/process/execute', {'command':command,'timeout':120000},toolbox=True)
    return {'exitCode':result.get('exitCode'), 'output':result.get('result','')}


def expose(port):
    if not VM_RECORD.exists(): return ops.api('/sandbox/expose', {'port':port})
    vm = json.loads(VM_RECORD.read_text())
    signed = daytona(f'/sandbox/{vm["id"]}/ports/{port}/signed-preview-url?expiresInSeconds=86400')
    values = dict(line.split('=',1) for line in ops.TOKEN_FILE.read_text().splitlines())
    request = urllib.request.Request('https://api.bayleaf.dev/previews/registrations',data=json.dumps({
        'owner':{'subject':'issue71-4gib-qualification','email':'amsmith@ucsc.edu'},
        'upstream_url':signed['url'],'access':'private','tag':'qualification',
    }).encode(),headers={'Authorization':'Bearer '+values['PREVIEWS_INSTALLATION_KEY'],
        'Content-Type':'application/json','User-Agent':'BayLeaf-Preview-Qualification/1.0'})
    with urllib.request.urlopen(request,timeout=30) as response: return json.load(response)


def start():
    if RECORD.exists():
        raise SystemExit('A qualification run already exists; inspect or clean it up first')
    root = '/tmp/bayleaf-preview-apps-' + secrets.token_hex(8)
    command = f'''set -e
python3 - <<'PY'
import socket, pathlib, base64
for port in [8790,8791]:
 s=socket.socket(); s.bind(('0.0.0.0',port)); s.close()
root=pathlib.Path({root!r}); (root/'workspace').mkdir(parents=True)
(root/'workspace'/'README.md').write_text('# BayLeaf preview qualification\\nSynthetic workspace for issue #71.\\n')
(root/'workspace'/'qualification.html').write_bytes(base64.b64decode({base64.b64encode(CHECK.encode()).decode()!r}))
PY
TAG=$(curl -fsSL https://api.github.com/repos/sigoden/dufs/releases/latest | python3 -c "import json,sys; print(json.load(sys.stdin)['tag_name'])")
curl -fsSL "https://github.com/sigoden/dufs/releases/download/${{TAG}}/dufs-${{TAG}}-x86_64-unknown-linux-musl.tar.gz" | tar xz -C {root}
curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone --prefix={root}/code-server
python3 - <<'PY'
import subprocess, pathlib, time, json
root=pathlib.Path({root!r})
commands=[
 [str(root/'dufs'),str(root/'workspace'),'--port','8790','--allow-all'],
 [str(root/'code-server/bin/code-server'),'--bind-addr','0.0.0.0:8791','--auth','none','--disable-telemetry','--disable-update-check','--user-data-dir',str(root/'user-data'),'--extensions-dir',str(root/'extensions'),str(root/'workspace')]
]
pids=[]
for i,command in enumerate(commands):
 with open(root/f'service-{{i}}.log','wb') as log:
  p=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
  pids.append(p.pid)
time.sleep(3)
(root/'pids.json').write_text(json.dumps(pids))
print('Synthetic application processes started')
PY
'''
    fd = os.open(RECORD, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump({'root': root, 'ports': [8790, 8791]}, f)
    result = execute(command)
    print(json.dumps(result))
    if result.get('exitCode') != 0:
        raise SystemExit('Application setup failed; tracked directory retained for diagnosis/cleanup')
    for port in [8790, 8791]:
        print(json.dumps(expose(port)))


def info():
    data = json.loads(RECORD.read_text())
    root = data['root']
    command = f'''python3 - <<'PY'
import pathlib, json, urllib.request
root=pathlib.Path({root!r})
for port in [8790,8791]:
 try:
  with urllib.request.urlopen(f'http://127.0.0.1:{{port}}/healthz' if port==8791 else f'http://127.0.0.1:{{port}}/',timeout=5) as r: print('port',port,'HTTP',r.status)
 except Exception as e: print('port',port,'check failed',type(e).__name__,str(e))
for name in ['memory.events','memory.current','memory.max']:
 p=pathlib.Path('/sys/fs/cgroup')/name
 if p.exists(): print(name,p.read_text().strip())
for proc in pathlib.Path('/proc').glob('[0-9]*'):
 try:
  if any(arg.startswith(str(root).encode()+b'/') for arg in (proc/'cmdline').read_bytes().split(b'\\0')):
   status=(proc/'status').read_text().splitlines()
   print('process',proc.name,[line for line in status if line.startswith(('Name:','State:','VmRSS:'))])
 except (FileNotFoundError,PermissionError,ProcessLookupError): pass
for name in ['service-0.log','service-1.log']:
 p=root/name
 if p.exists(): print(name, p.read_text()[-6000:])
PY'''
    print(json.dumps(execute(command)))


def terminal_task():
    root = json.loads(RECORD.read_text())['root']
    task = {'version':'2.0.0','tasks':[{'label':'BayLeaf proxy terminal check','type':'shell',
        'command':"printf 'BAYLEAF_PROXY_TERMINAL_OK\\n' | tee terminal-proof.txt",'problemMatcher':[],
        'presentation':{'reveal':'always'}}]}
    command = f'''python3 - <<'PY'
import pathlib, json
root=pathlib.Path({root!r})/'workspace'
(root/'.vscode').mkdir(exist_ok=True)
(root/'.vscode/tasks.json').write_text({json.dumps(task)!r})
print('Synthetic terminal task installed')
PY'''
    print(json.dumps(execute(command)))


def terminal_result():
    root = json.loads(RECORD.read_text())['root']
    command = f'''python3 - <<'PY'
import pathlib
p=pathlib.Path({root!r})/'workspace/terminal-proof.txt'
print('VS Code terminal round trip:', p.exists() and p.read_text()=='BAYLEAF_PROXY_TERMINAL_OK\\n')
PY'''
    print(json.dumps(execute(command)))


def cleanup():
    data = json.loads(RECORD.read_text())
    root = data['root']
    assert root.startswith('/tmp/bayleaf-preview-apps-')
    command = f'''python3 - <<'PY'
import pathlib, os, signal, shutil, time
root={root!r}
workspace=pathlib.Path(root)/'workspace'
allowed={{'README.md','qualification.html','.vscode/tasks.json','terminal-proof.txt'}}
unexpected=[str(p.relative_to(workspace)) for p in workspace.rglob('*') if p.is_file() and str(p.relative_to(workspace)) not in allowed]
if unexpected: raise SystemExit('Preserving unexpected workspace files: '+', '.join(unexpected))
if (workspace/'README.md').read_text() != '# BayLeaf preview qualification\\nSynthetic workspace for issue #71.\\n': raise SystemExit('Preserving modified README')
if (workspace/'qualification.html').read_text() != {CHECK!r}: raise SystemExit('Preserving modified qualification page')
for proc in pathlib.Path('/proc').glob('[0-9]*'):
 try:
  args=(proc/'cmdline').read_bytes().split(b'\\0')
  if any(arg.startswith(root.encode()+b'/') for arg in args): os.kill(int(proc.name),signal.SIGTERM)
 except (FileNotFoundError,ProcessLookupError,PermissionError): pass
time.sleep(1)
shutil.rmtree(root,ignore_errors=True)
print('Synthetic application directory removed')
PY'''
    result = execute(command)
    print(json.dumps(result))
    if result.get('exitCode') != 0:
        raise SystemExit('Cleanup failed')
    for port in data['ports']:
        print('Revoked', port, ops.api(f'/sandbox/expose/{port}', method='DELETE')['status'])
    RECORD.unlink()
    if VM_RECORD.exists(): delete_vm()


def delete_vm():
    vm=json.loads(VM_RECORD.read_text())
    data=daytona('/sandbox/'+vm['id'])
    if data is not None and data.get('labels',{}).get('bayleaf-preview-qualification') != vm['tag']:
        raise SystemExit('Sandbox identity mismatch; refusing deletion')
    if data is not None and data.get('state') not in ['destroying','destroyed']:
        daytona('/sandbox/'+vm['id']+'?force=true',method='DELETE')
    for _ in range(60):
        data=daytona('/sandbox/'+vm['id'])
        if data is None:
            VM_RECORD.unlink(); print('Disposable sandbox deletion independently confirmed'); return
        time.sleep(1)
    print('Sandbox deletion state:', data.get('state'))
    raise SystemExit('Sandbox deletion not yet confirmed; tracked ID retained')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start','info','cleanup','terminal-task','terminal-result','create-vm','delete-vm'])
    args = parser.parse_args()
    {'start':start,'info':info,'cleanup':cleanup,'terminal-task':terminal_task,'terminal-result':terminal_result,'create-vm':create_vm,'delete-vm':delete_vm}[args.action]()
