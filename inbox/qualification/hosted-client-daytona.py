#!/usr/bin/env python3
"""One disposable Linux VM, exact own-ID lifecycle, no user account/session edits.

Needs --live and HOSTED_ADAPTER_ROOT. Uses the repo's Daytona key only in memory.
20-minute wall budget; estimated medium VM cost < $0.10 at observed public rates.
No BayLeaf key or inference credential is uploaded. Synthetic HTTP runtime only.
"""
import base64, io, json, os, pathlib, shlex, subprocess, sys, tarfile, time
import urllib.request, urllib.error

REPO=pathlib.Path(__file__).resolve().parents[2]
if '--live' not in sys.argv or not os.environ.get('HOSTED_ADAPTER_ROOT'):
    raise SystemExit('Requires --live and HOSTED_ADAPTER_ROOT')
SOURCE=pathlib.Path(os.environ['HOSTED_ADAPTER_ROOT']).resolve()
key=None
for line in (REPO/'api/.dev.vars').read_text().splitlines():
    if line.startswith('DAYTONA_API_KEY='):
        key=shlex.split(line.split('=',1)[1])[0]
assert key
deadline=time.monotonic()+1200
sandbox=None
def request(path,method='GET',body=None,toolbox=False,timeout=60):
    origin='https://proxy.app.daytona.io/toolbox/' if toolbox else 'https://app.daytona.io/api/'
    req=urllib.request.Request(origin+path,data=None if body is None else json.dumps(body).encode(),method=method,
        headers={'Authorization':'Bearer '+key,'Content-Type':'application/json','User-Agent':'BayLeafHostedQualification/1.0'})
    with urllib.request.urlopen(req,timeout=timeout) as r:
        b=r.read();return json.loads(b) if b else None
def wait_state(state,seconds=120):
    end=min(deadline,time.monotonic()+seconds)
    while time.monotonic()<end:
        d=request('sandbox/'+sandbox)
        if d.get('state')==state:return d
        if d.get('state') in ['error','build_failed']:raise RuntimeError('Sandbox entered failure state')
        time.sleep(2)
    raise RuntimeError('State deadline exceeded: '+state)
def execute(command,timeout=120):
    remaining=int(deadline-time.monotonic())
    if remaining<10:raise RuntimeError('Qualification wall budget exhausted')
    r=request(sandbox+'/process/execute','POST',{'command':command,'timeout':min(timeout,remaining)},True,min(timeout,remaining)+15)
    # Uploaded commands contain no credentials; still emit only bounded diagnostics.
    out=r.get('result',r.get('output',''))
    print(str(out)[-12000:],flush=True)
    if r.get('exitCode',0)!=0:raise RuntimeError('Guest command failed')
    return r
try:
    sandbox=request('sandbox','POST',{'name':'inbox-hosted-qualification-'+str(int(time.time())),
        'snapshot':'daytona-medium','public':False,'autoStopInterval':10,'autoArchiveInterval':60,
        'autoDeleteInterval':60,'labels':{'qualification':'inbox-hosted-disposable'}})['id']
    (SOURCE/'daytona-owned-id.json').write_text(json.dumps({'id':sandbox,'created_at':int(time.time())}))
    print('Created one disposable medium VM; 20-minute cap, no owner sessions',flush=True)
    wait_state('started')
    archive=io.BytesIO()
    with tarfile.open(fileobj=archive,mode='w:gz') as tar:
        tar.add(REPO/'inbox/qualification/hosted-client-runtime.mjs',arcname='qualification/runtime.mjs')
        for name in ['sandbox-plugin','nanobot-sandbox']:
            for path in (SOURCE/name).rglob('*'):
                if path.is_file() and '.git' not in path.relative_to(SOURCE/name).parts:
                    tar.add(path,arcname='qualification/adapters/'+name+'/'+str(path.relative_to(SOURCE/name)))
    encoded=base64.b64encode(archive.getvalue()).decode()
    execute("python3 -c "+shlex.quote("import base64,io,tarfile;tarfile.open(fileobj=io.BytesIO(base64.b64decode('"+encoded+"')),mode='r:gz').extractall('/home/daytona',filter='data')"))
    execute('python3 --version && node --version && uname -m')
    execute('npm install --prefix /home/daytona/qualification/tools node@22 @openchamber/web@latest --no-audit --no-fund',420)
    prefix='export PATH=/home/daytona/qualification/tools/node_modules/.bin:$PATH; '
    execute(prefix+"node --input-type=module -e 'const {installOpenCodeV2}=await import(\"/home/daytona/qualification/tools/node_modules/@openchamber/web/server/lib/opencode/v2-install.js\"); await installOpenCodeV2();'",420)
    execute('python3 -m venv /home/daytona/qualification/nanobot && /home/daytona/qualification/nanobot/bin/pip install --disable-pip-version-check nanobot-ai==0.3.5',420)
    cmd=prefix+'HOSTED_ADAPTER_ROOT=/home/daytona/qualification/adapters HOSTED_QUALIFICATION_TMP=/home/daytona/qualification OPENCODE_TEST_BINARY=/home/daytona/.opencode/bin/opencode node /home/daytona/qualification/runtime.mjs'
    execute(cmd,180)
    execute("printf 'owned persistent marker' > /home/daytona/qualification/resume-marker")
    request('sandbox/'+sandbox+'/stop','POST',{})
    wait_state('stopped')
    first=request('sandbox/'+sandbox);time.sleep(3);second=request('sandbox/'+sandbox)
    assert first['state']==second['state']=='stopped'
    print('PASS actual disposable host stop; passive control-plane reads leave it stopped',flush=True)
    request('sandbox/'+sandbox+'/start','POST',{});wait_state('started')
    execute("test \"$(cat /home/daytona/qualification/resume-marker)\" = 'owned persistent marker' && echo 'PASS persistent file after actual host resume'")
    execute(cmd,180)
    print('PASS candidate runtime qualification on fresh and resumed Linux host; managed dashboard and real inbox delivery remain separate',flush=True)
finally:
    if sandbox:
        request('sandbox/'+sandbox,'DELETE')
        end=time.monotonic()+120
        while time.monotonic()<end:
            try:request('sandbox/'+sandbox)
            except urllib.error.HTTPError as e:
                if e.code==404:
                    print('CLEANUP exact owned VM absent (404)',flush=True);break
                raise
            time.sleep(2)
        else:raise RuntimeError('Owned VM deletion not confirmed')
