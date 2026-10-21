#!/usr/bin/env python3
"""Owner-approved CollabMD qualification, no deployment or inference.

Requires --live and a local --daytona-vars file. Credentials/URLs/passwords stay
in a mode-0600 ledger outside the repo. Uses only amsmith@ucsc.edu's confirmed
BayLeaf sandbox, never creates a VM. Cleanup retires only this run's previews
and app, not the owner machine or unrelated services. Synthetic documents only.
"""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shlex
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
LEDGER = Path.home()/'.tokens/bayleaf-collabmd-qualification.json'
REMOTE = '/home/daytona/.local/share/bayleaf/collabmd'
OWNER = 'amsmith@ucsc.edu'
LABEL = 'chat.bayleaf.dev'


def values(path):
    return dict(x.split('=', 1) for x in shlex.split(path.read_text(), comments=True) if '=' in x)


def save(state):
    fd = os.open(LEDGER, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(state, out)


def load():
    state = json.loads(LEDGER.read_text())
    if state['owner'] != OWNER:
        raise RuntimeError('ledger_owner_mismatch')
    return state


def request(url, key=None, body=None, method=None, envs=None):
    headers = {'User-Agent':'BayLeaf-CollabMD-Qualification/1.0', 'Content-Type':'application/json'}
    if key:
        headers['Authorization'] = 'Bearer '+key
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
        headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            if response.status == 204:
                return 204, None
            content = response.read(2*1024**2)
            try:
                content = json.loads(content)
            except ValueError:
                content = None
            return response.status, content
    except urllib.error.HTTPError as error:
        return error.code, None  # Never echo provider bodies or signed URLs.


def bayleaf(path, body=None, method=None):
    key = next(v for v in values(Path.home()/'.tokens/bayleaf-api').values() if v.startswith('sk-bayleaf-'))
    status, data = request('https://api.bayleaf.dev'+path, key, body, method)
    if status >= 400:
        raise RuntimeError('bayleaf_http_'+str(status))
    return data


def daytona(path, body=None, method=None, toolbox=False):
    base = 'https://proxy.app.daytona.io/toolbox' if toolbox else 'https://app.daytona.io/api'
    status, data = request(base+path, values(ARGS.daytona_vars)['DAYTONA_API_KEY'], body, method)
    if status >= 400:
        raise RuntimeError('daytona_http_'+str(status))
    return data


def machine():
    state = load()
    vm = daytona('/sandbox/'+state['id'])
    if vm.get('labels', {}).get(LABEL) != OWNER or vm['id'] != state['id']:
        raise RuntimeError('machine_ownership_mismatch')
    return vm


def execute(command, envs=None, budget=True):
    state = load()
    if budget and time.time() > state['ends_at']:
        raise RuntimeError('time_budget_reached_cleanup_required')
    machine()  # Exact ownership before each remote mutation.
    data = daytona('/'+state['id']+'/process/execute',
        {'command':command, 'envs':envs or {}, 'timeout':10000}, toolbox=True)
    # Bounded, private diagnostics for operator debugging, never stdout.
    state = load()
    state['last_execution'] = data
    save(state)
    if data.get('exitCode') != 0:
        raise RuntimeError('remote_command_failed')
    return data.get('result','')


def python(code, envs=None, budget=True):
    return execute("python3 - <<'PY'\n"+code+"\nPY", envs, budget)


def begin():
    if LEDGER.exists() and not load().get('cleanup_confirmed'):
        raise RuntimeError('unfinished_qualification_exists')
    owner = bayleaf('/sandbox')
    if not owner.get('id'):
        raise RuntimeError('owner_has_no_machine')
    vm = daytona('/sandbox/'+owner['id'])
    if vm.get('labels', {}).get(LABEL) != OWNER:
        raise RuntimeError('owner_binding_unverified')
    state = {'owner':OWNER, 'id':vm['id'], 'operation':str(uuid.uuid4()),
        'created_at':time.time(), 'ends_at':time.time()+3*3600, 'initial_state':vm['state'],
        'password':secrets.token_hex(32), 'registrations':[], 'cleanup_confirmed':False}
    save(state)
    if vm['state'] in ('archived','stopped'):
        daytona('/sandbox/'+state['id']+'/start', {}, 'POST')
    print(json.dumps({'owner':OWNER,'id':vm['id'],'initial_state':vm['state'],
        'cpu':vm.get('cpu'),'memory_gib':vm.get('memory'),'disk_gib':vm.get('disk'),
        'budget_hours':3,'budget_usd':0.60}), flush=True)


def install():
    vm = machine()
    if vm['state'] != 'started':
        raise RuntimeError('machine_not_started')
    state = load()
    files = {name:base64.b64encode((ROOT/'scripts'/name).read_bytes()).decode()
        for name in ('browser-setup.py','collabmd-adapter.py')}
    result = python(f'''import os,pathlib,json,base64,time,subprocess
os.umask(0o077)
root=pathlib.Path({REMOTE!r}); folder=pathlib.Path.home()/'workspace/public-collaborative-docs'
if root.exists() or folder.exists():
 raise SystemExit('Existing CollabMD state requires explicit reconciliation')
(root/'credentials').mkdir(parents=True)
folder.mkdir(parents=True)
(folder/'qualification.md').write_text('# BayLeaf room qualification\\n\\nSynthetic documents only.\\n')
for name,source in {files!r}.items():
 (root/('setup.py' if name=='browser-setup.py' else name)).write_bytes(base64.b64decode(source))
(root/'credentials/app-secret').write_text(os.environ['QUALIFICATION_PASSWORD'])
(root/'request.json').write_text(json.dumps({{'operation':{state['operation']!r},'deadline':int(time.time())+1200,'restart':True}}))
subprocess.Popen(['python3',str(root/'setup.py'),'--service','collabmd','setup','--operation',{state['operation']!r}],
 stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
print(json.dumps({{'launched':True}}))''', {'QUALIFICATION_PASSWORD':state['password']})
    print(result.strip(), flush=True)


def inspect():
    result = json.loads(execute('python3 '+REMOTE+'/setup.py --service collabmd inspect'))
    print(json.dumps({k:result.get(k) for k in ('phase','progress','ready','running','error','updated_at','port')}), flush=True)


def checks():
    result=python(f'''import importlib.util,json,pathlib,subprocess,sys,time,uuid,os,tempfile
root=pathlib.Path({REMOTE!r})
spec=importlib.util.spec_from_file_location('installer',root/'setup.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
runtime=m.read('state/runtime.json',{{}}) if False else json.loads((root/'state/runtime.json').read_text())
pid=runtime['process']['pid']; status=pathlib.Path('/proc/'+str(pid)+'/status').read_text()
rss=next(int(line.split()[1]) for line in status.splitlines() if line.startswith('VmRSS:'))
folder=pathlib.Path.home()/'workspace/public-collaborative-docs'
text=(folder/'qualification.md').read_text()
before={{'persisted_a':'Synthetic profile A co-edit.' in text,'persisted_b':'Synthetic profile B co-edit.' in text,
 'rss_kib':rss,'runtime_identity_verified':m.alive(runtime['process'])}}
before['coordinated_external_edit_persisted']='Coordinated external filesystem edit.' in text
blocked=folder/'readonly-qualification/blocked.md'
before['readonly_fixture_contains_browser_edit']=blocked.exists() and 'Synthetic profile B co-edit.' in blocked.read_text()
comment_files=[p for p in (folder/'.collabmd/comments').rglob('*') if p.is_file()]
before['comment_persisted']=any(b'Synthetic qualification comment' in p.read_bytes() for p in comment_files)
fidelity=folder/'source-fidelity.md'
before['crlf_source_unchanged']=fidelity.exists() and fidelity.read_bytes()==b'# Fidelity\\r\\n\\r\\n  Indented text.\\r\\n'
with tempfile.TemporaryDirectory(prefix='bayleaf-stop-qualification-') as temp:
 m.ROOT=pathlib.Path(temp);m.SERVICE='collabmd'
 operation=str(uuid.uuid4());m.atomic('request.json',{{'operation':operation,'deadline':int(time.time())+600}})
 owned=subprocess.Popen([sys.executable,'-c','import time;time.sleep(120)'],start_new_session=True)
 sibling=subprocess.Popen([sys.executable,'-c','import time;time.sleep(120)'],start_new_session=True)
 try:
  marker=m.identity(owned.pid);sibling_marker=m.identity(sibling.pid)
  m.atomic('state/runtime.json',{{'process':marker}})
  assert m.stop(operation)['stopped'];owned.wait(timeout=5)
  assert m.alive(sibling_marker)
  m.atomic('state/runtime.json',{{'process':{{**sibling_marker,'start':'not-the-recorded-start'}}}})
  assert m.stop(operation)['stopped'];assert m.alive(sibling_marker)
  assert m.alive(runtime['process'])
  before.update(owned_group_stopped=True,sibling_survives=True,reused_pid_ignored=True,port_occupant_survives=True)
  operation=str(uuid.uuid4());m.atomic('request.json',{{'operation':operation,'deadline':int(time.time())+600}})
  runner=m.ROOT/'slow-setup.py'
  runner.write_text("import importlib.util,pathlib,sys\\ns=importlib.util.spec_from_file_location('installer',"+repr(str(root/'setup.py'))+");m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\\nm.ROOT=pathlib.Path("+repr(str(m.ROOT))+")\\nm.adapter=lambda name,*args,**kw:m.command([sys.executable,'-c','import time;time.sleep(120)']) if name=='install' else None\\nm.setup("+repr(operation)+")\\n")
  setup_process=subprocess.Popen([sys.executable,str(runner)],start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  try:
   for _ in range(30):
    task=m.read('state/task.json',{{}}).get('process')
    if task:break
    time.sleep(.1)
   assert task and m.alive(task)
   assert m.stop(operation)['stopped'];setup_process.wait(timeout=5)
   assert not m.alive(task) and m.alive(sibling_marker) and m.alive(runtime['process'])
   before['stop_during_install_cancelled_task_and_setup']=True
  finally:
   if setup_process.poll() is None:
    m.terminate(m.identity(setup_process.pid));setup_process.wait(timeout=5)
 finally:
  for p in (owned,sibling):
   if p.poll() is None:p.terminate()
   p.wait(timeout=5)
print(json.dumps(before))''')
    print(result.strip(),flush=True)


def fixtures():
    state=load()
    result=python(f'''import pathlib,json
folder=pathlib.Path.home()/'workspace/public-collaborative-docs'
outside=pathlib.Path.home()/'workspace'/('collabmd-outside-'+{state['operation']!r}+'.md')
with outside.open('x') as f:f.write('SYNTHETIC OUTSIDE ROOT MUST NOT BE DISCLOSED')
(folder/'escape.md').symlink_to(outside)
(folder/'outside-dir').symlink_to(outside.parent)
(folder/'source-fidelity.md').write_bytes(b'# Fidelity\\r\\n\\r\\n  Indented text.\\r\\n')
print(json.dumps({{'synthetic_fixtures_created':True}}))''')
    print(result.strip(),flush=True)


def fresh():
    state=load()
    if not state.get('cleanup_confirmed'):
        raise RuntimeError('stop_previous_room_first')
    state['previous_url']=state.get('url');state['previous_password']=state['password']
    state['operation']=str(uuid.uuid4());state['password']=secrets.token_hex(32)
    state['cleanup_confirmed']=False;save(state)
    result=python(f'''import os,pathlib,json,time,subprocess
root=pathlib.Path({REMOTE!r})
(root/'credentials/app-secret').write_text(os.environ['QUALIFICATION_PASSWORD'])
(root/'request.json').write_text(json.dumps({{'operation':{state['operation']!r},'deadline':int(time.time())+1200,'restart':True}}))
subprocess.Popen(['python3',str(root/'setup.py'),'--service','collabmd','setup','--operation',{state['operation']!r}],
 stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
print(json.dumps({{'fresh_generation_launched':True}}))''',{'QUALIFICATION_PASSWORD':state['password']})
    print(result.strip(),flush=True)


def large():
    print(python('''import pathlib,json
folder=pathlib.Path.home()/'workspace/public-collaborative-docs'
text='# Large initial sync qualification\\n\\n'+('x'*80+'\\n')*12000
with (folder/'large-initial-sync.md').open('x') as f:f.write(text)
print(json.dumps({'large_fixture_bytes':len(text.encode())}))''').strip(),flush=True)


def fail_save():
    print(python('''import pathlib,json
folder=pathlib.Path.home()/'workspace/public-collaborative-docs/readonly-qualification'
folder.mkdir()
file=folder/'blocked.md';file.write_text('# Failed-save qualification\\n\\nOriginal persisted text.\\n')
file.chmod(0o444);folder.chmod(0o555)
print(json.dumps({'synthetic_readonly_document_created':True}))''').strip(),flush=True)


def restore_save():
    print(python('''import pathlib,json
folder=pathlib.Path.home()/'workspace/public-collaborative-docs/readonly-qualification'
folder.chmod(0o755);(folder/'blocked.md').chmod(0o644)
print(json.dumps({'synthetic_document_writes_restored':True}))''').strip(),flush=True)


def external():
    print(python('''import pathlib,json
file=pathlib.Path.home()/'workspace/public-collaborative-docs/qualification.md'
with file.open('a') as f:f.write('\\nCoordinated external filesystem edit.\\n')
print(json.dumps({'external_edit_appended_while_browser_typing_paused':True}))''').strip(),flush=True)


def expose():
    state = load()
    signed = daytona(f'/sandbox/{state["id"]}/ports/8795/signed-preview-url?expiresInSeconds=10800')
    state['direct'] = signed['url']; save(state)
    key = values(Path.home()/'.tokens/bayleaf-previews')['PREVIEWS_INSTALLATION_KEY']
    status, result = request('https://api.bayleaf.dev/previews/registrations',key,{
        'owner':{'subject':'bayleaf-collabmd-qualification-'+state['operation'],'email':OWNER},
        'upstream_url':signed['url'],'access':'public'})
    if status >= 400 or not result:
        raise RuntimeError('preview_registration_failed_'+str(status))
    state['registrations'].append(result);state['url']=result['url'];save(state)
    # Configure the actual public hostname with canonical setup, not a custom server.
    result = python(f'''import pathlib,json,time,subprocess
root=pathlib.Path({REMOTE!r})
req=json.loads((root/'request.json').read_text());req.update(deadline=int(time.time())+1200,restart=False,preview_url={state['url']!r})
(root/'request.json').write_text(json.dumps(req))
subprocess.Popen(['python3',str(root/'setup.py'),'--service','collabmd','setup','--operation',{state['operation']!r}],
 stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
print(json.dumps({{'registered':True,'finalizing':True}}))''')
    print(result.strip(), flush=True)


def stop():
    state = load()
    key = values(Path.home()/'.tokens/bayleaf-previews')['PREVIEWS_INSTALLATION_KEY']
    for registration in state['registrations']:
        label = urllib.parse.urlsplit(registration['url']).hostname.split('.')[0]
        status, _ = request('https://api.bayleaf.dev/previews/registrations/'+label,key,method='DELETE')
        if status != 204:
            raise RuntimeError('preview_revocation_failed_'+str(status))
        status, _ = request(registration['url'])
        if status != 404:
            raise RuntimeError('preview_revocation_not_confirmed')
    vm=machine()
    if vm['state']=='started':
        result = json.loads(execute('python3 '+REMOTE+'/setup.py --service collabmd stop --operation '+state['operation'],budget=False))
        if result.get('stopped') is not True:
            raise RuntimeError('process_cleanup_unconfirmed')
    elif vm['state'] not in ('stopped','archived'):
        raise RuntimeError('machine_transition_cleanup_pending')
    state=load();state['cleanup_confirmed']=True;save(state)
    print(json.dumps({'access_revoked':True,'owned_app_stopped':True,'owner_machine_deleted':False}),flush=True)


def disk():
    print(python('''import pathlib,json
folder=pathlib.Path.home()/'workspace/public-collaborative-docs'
text=(folder/'qualification.md').read_text()
blocked=(folder/'readonly-qualification/blocked.md').read_text()
comments=[p for p in (folder/'.collabmd/comments').rglob('*') if p.is_file()]
print(json.dumps({'saved_coedit_a':'Synthetic profile A co-edit.' in text,
 'saved_coedit_b':'Synthetic profile B co-edit.' in text,
 'saved_external_edit':'Coordinated external filesystem edit.' in text,
 'readonly_edit_recovered_after_permission_restore':'Synthetic profile B co-edit.' in blocked,
 'comment_retained':any(b'Synthetic qualification comment' in p.read_bytes() for p in comments),
 'crlf_source_unchanged':(folder/'source-fidelity.md').read_bytes()==b'# Fidelity\\r\\n\\r\\n  Indented text.\\r\\n'}))''',budget=False).strip(),flush=True)


def sleep():
    if not load().get('cleanup_confirmed'):
        raise RuntimeError('end_sharing_before_stopping_compute')
    vm=machine()
    if vm['state']=='started':
        daytona('/sandbox/'+vm['id']+'/stop',{},'POST')
    for _ in range(30):
        vm=machine()
        if vm['state'] in ('stopped','archived'):
            print(json.dumps({'owner_machine_state':vm['state'],'destroyed':False}),flush=True)
            return
        time.sleep(1)
    raise RuntimeError('machine_stop_not_yet_confirmed')


def resume():
    if not load().get('cleanup_confirmed'):
        raise RuntimeError('previous_room_cleanup_required')
    vm=machine()
    if vm['state'] in ('stopped','archived'):
        daytona('/sandbox/'+vm['id']+'/start',{},'POST')
    for _ in range(45):
        vm=machine()
        if vm['state']=='started':
            print(json.dumps({'verified_owner_machine_started':True}),flush=True)
            return
        time.sleep(1)
    raise RuntimeError('machine_start_pending')


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('begin','machine','install','inspect','checks','fixtures','fresh','large','fail_save','restore_save','external','expose','stop','disk','sleep','resume'))
    parser.add_argument('--live',action='store_true')
    parser.add_argument('--daytona-vars',type=Path,required=True)
    ARGS=parser.parse_args()
    if not ARGS.live:
        parser.error('Live operator approval required: --live')
    try:
        if ARGS.action=='machine':
            vm=machine(); print(json.dumps({k:vm.get(k) for k in ('id','state','cpu','memory','disk')}))
        else:
            globals()[ARGS.action]()
    except Exception as error:
        # Failures never surface upstream content, credentials or private URLs.
        print(json.dumps({'error':str(error) if isinstance(error,RuntimeError) else type(error).__name__}),flush=True)
        sys.exit(1)
