#!/usr/bin/env python3
"""Disposable issue86 control plane. Never prints credentials or remote output."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shlex
import sys
import time
import urllib.request
import urllib.error
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
STATE = Path.home() / '.tokens/bayleaf-issue86-qualification.json'
MANIFEST = STATE.with_name('bayleaf-issue86-manifest.json')
UA = 'BayLeaf-Preview-Qualification/1.0'

def values(path):
    return dict(x.split('=', 1) for x in shlex.split(path.read_text(), comments=True) if '=' in x)

def save(state):
    fd = os.open(STATE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(state, f)

def load():
    return json.loads(STATE.read_text())

def request(url, key=None, body=None, method=None):
    headers = {'User-Agent': UA, 'Content-Type': 'application/json'}
    if key:
        headers['Authorization'] = 'Bearer ' + key
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            return r.status, json.load(r) if r.status != 204 else {}
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return 404, None
        raise RuntimeError('Control request HTTP ' + str(e.code)) from None

def daytona(path, body=None, method=None, toolbox=False):
    key = values(ROOT / '.dev.vars')['DAYTONA_API_KEY']
    base = 'https://proxy.app.daytona.io/toolbox' if toolbox else 'https://app.daytona.io/api'
    return request(base + path, key, body, method)

def exec_remote(command, envs=None, timeout=120):
    s = load()
    if time.time() > s['created_at'] + 27 * 60:
        raise RuntimeError('Execution budget reached; clean up now')
    _, out = daytona('/' + s['id'] + '/process/execute',
                     {'command': command, 'envs': envs or {}, 'timeout': timeout}, toolbox=True)
    if out.get('exitCode') != 0:
        # Remote text is intentionally retained only in memory, never surfaced.
        raise RuntimeError('Remote execution failed with exit code ' + str(out.get('exitCode')))
    return out.get('result', '')

def create():
    if STATE.exists():
        raise RuntimeError('Existing ledger must be cleaned first')
    # Confirm this development credential reaches the BayLeaf owner's sandbox,
    # using read-only status calls. Never start or execute on that sandbox.
    spec = importlib.util.spec_from_file_location('ops', ROOT / 'scripts/preview-ops.py')
    ops = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ops)
    owner = ops.api('/sandbox')
    if owner.get('id'):
        status, detail = daytona('/sandbox/' + owner['id'])
    else:
        status, inventory = daytona('/sandbox')
        items = inventory.get('items', []) if isinstance(inventory, dict) else inventory
        matches = [x for x in items if 'chat.bayleaf.dev' in x.get('labels', {})]
        if not matches:
            raise RuntimeError('BayLeaf account binding unverified')
        detail = matches[0]
    if status != 200:
        raise RuntimeError('BayLeaf account binding unverified')
    print('BayLeaf Daytona account binding verified by read-only sandbox lookup')
    s = {'tag': 'bayleaf-issue86-' + secrets.token_hex(8), 'created_at': time.time(),
         'registrations': [], 'signed': {}, 'organization_id': detail['organizationId']}
    save(s)
    _, vm = daytona('/sandbox', {'name': s['tag'], 'cpu': 2, 'memory': 4, 'disk': 10,
        'buildInfo': {'dockerfileContent': 'FROM python:3.12-slim\nRUN apt-get update && apt-get install -y bash curl ca-certificates iproute2 procps && rm -rf /var/lib/apt/lists/*\nWORKDIR /work\n'},
        'labels': {'bayleaf-issue86-qualification': s['tag']}, 'autoStopInterval': 10,
        'autoArchiveInterval': 15, 'autoDeleteInterval': 30})
    s['id'] = vm['id']; save(s)
    for _ in range(90):
        _, vm = daytona('/sandbox/' + s['id'])
        if vm['state'] == 'started':
            if vm['organizationId'] != s['organization_id']:
                raise RuntimeError('Created sandbox organization mismatch')
            print('Disposable 2-vCPU/4-GiB sandbox started; exact ID tracked')
            return
        if vm['state'] in ('error', 'build_failed'):
            raise RuntimeError('Sandbox startup failed; cleanup required')
        time.sleep(2)
    raise RuntimeError('Sandbox startup deadline; cleanup required')

def install():
    exec_remote('python -m pip install --quiet nanobot-ai==0.3.5 "websockets>=15,<16" httpx', timeout=180)
    exec_remote('curl -fsSL https://github.com/sigoden/dufs/releases/download/v0.46.0/dufs-v0.46.0-x86_64-unknown-linux-musl.tar.gz -o /work/dufs.tar.gz && tar xzf /work/dufs.tar.gz -C /work', timeout=60)
    source = base64.b64encode((ROOT / 'scripts/qualify-preview-app-boundary.py').read_bytes()).decode()
    exec_remote("python - <<'PY'\nimport base64,pathlib\npathlib.Path('/work/peer.py').write_bytes(base64.b64decode(" + repr(source) + "))\nPY")
    # Secrets are delivered in the toolbox envs object, not command arguments.
    s = load(); s['password'] = secrets.token_urlsafe(24)
    s['basic'] = 'Basic ' + base64.b64encode(('qualification:' + s['password']).encode()).decode()
    save(s)
    exec_remote("""python - <<'PY'
import os,pathlib,subprocess,time,json
os.umask(0o077)
root=pathlib.Path('/work'); (root/'files').mkdir(exist_ok=True)
(root/'files/proof.txt').write_text('synthetic issue86 proof\\n')
env={**os.environ,'DUFS_AUTH':'qualification:'+os.environ['TEST_PASSWORD']+'@/:ro'}
procs=[subprocess.Popen(['/work/dufs','/work/files','--port','18866'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL),
subprocess.Popen(['python','/work/peer.py','--serve-peer','18867'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)]
time.sleep(2)
assert all(p.poll() is None for p in procs)
(root/'pids.json').write_text(json.dumps([p.pid for p in procs]))
PY""", {'TEST_PASSWORD': s['password'], 'QUALIFICATION_AUTHORIZATION': s['basic']})
    print('Pinned real applications installed; dufs and peer fixture running')

def signed(port, seconds=1800, name=None):
    s = load()
    _, r = daytona(f'/sandbox/{s["id"]}/ports/{port}/signed-preview-url?expiresInSeconds={seconds}')
    s['signed'][name or str(port)] = {'url': r['url'], 'requested_seconds': seconds, 'issued_at': time.time()}
    save(s)
    return r['url']

def register(name, upstream, headers=None, access='public'):
    key = values(Path.home() / '.tokens/bayleaf-previews')['PREVIEWS_INSTALLATION_KEY']
    body = {'owner': {'subject': 'bayleaf-issue86-disposable-qualification', 'email': 'amsmith@ucsc.edu'},
            'upstream_url': upstream, 'access': access}
    if headers:
        body['upstream_headers'] = headers
    _, r = request('https://api.bayleaf.dev/previews/registrations', key, body)
    s = load(); s['registrations'].append({'name': name, **r}); save(s)
    if headers and r.get('upstream_headers_applied') is not True:
        raise RuntimeError('Missing exact header acknowledgement; tracked lease needs cleanup')
    return r['url']

def expose():
    s = load()
    for port in (18865, 18866, 18867):
        signed(port)
    s = load()
    nb = register('nanobot-public', s['signed']['18865']['url'], {'X-Authenticated-Owner': 'true'})
    df = register('dufs-public', s['signed']['18866']['url'], {'Authorization': s['basic']})
    register('fixture-public', s['signed']['18867']['url'], {'Authorization': s['basic'], 'X-Authenticated-Owner': 'true'})
    register('nanobot-private', s['signed']['18865']['url'], {'X-Authenticated-Owner': 'true'}, 'private')
    register('dufs-private', s['signed']['18866']['url'], {'Authorization': s['basic']}, 'private')
    alt = signed(18865, name='nanobot-alternate')
    m = {'nanobot': {'wrapped': nb, 'direct': s['signed']['18865']['url'], 'alternate': alt,
                    'assertion_header': 'X-Authenticated-Owner', 'assertion_value': 'true'},
         'dufs': {'wrapped': df, 'direct': s['signed']['18866']['url'], 'authorization': s['basic'],
                  'proof_path': '/proof.txt', 'proof_text': 'synthetic issue86 proof\n'},
         'forbidden_body_values': [s['password']]}
    fd = os.open(MANIFEST, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f: json.dump(m, f)
    print('Five installation leases tracked; all nonempty-header acknowledgements exact true')

def cleanup():
    s = load()
    key = values(Path.home() / '.tokens/bayleaf-previews')['PREVIEWS_INSTALLATION_KEY']
    for r in s['registrations']:
        label = urlsplit(r['url']).hostname.split('.')[0]
        request('https://api.bayleaf.dev/previews/registrations/' + label, key, method='DELETE')
        status, _ = request(r['url'])
        if status != 404:
            raise RuntimeError('Revoked lease did not return 404')
    print('All tracked installation leases revoked; independent HTTP 404 confirmed')
    if s.get('id'):
        status, vm = daytona('/sandbox/' + s['id'])
        if status != 404:
            if vm.get('labels', {}).get('bayleaf-issue86-qualification') != s['tag']:
                raise RuntimeError('Deletion ownership mismatch')
            if vm['state'] != 'destroying':
                daytona('/sandbox/' + s['id'] + '?force=true', method='DELETE')
            for _ in range(120):
                status, _ = daytona('/sandbox/' + s['id'])
                if status == 404: break
                time.sleep(2)
            if status != 404:
                raise RuntimeError('Deletion not yet confirmed; retain ledger')
        print('Disposable sandbox deletion independently confirmed HTTP 404')
    s['cleanup_confirmed'] = True
    save(s)

if __name__ == '__main__':
    try:
        {'create': create, 'install': install, 'expose': expose, 'cleanup': cleanup}[sys.argv[1]]()
    except Exception as e:
        # These helpers generate only fixed sanitized errors; no provider body.
        print('Operation failed:', type(e).__name__)
        if isinstance(e, RuntimeError): print(str(e))
        raise SystemExit(1) from None
