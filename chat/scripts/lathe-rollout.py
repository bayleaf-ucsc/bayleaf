#!/usr/bin/env python3
"""Coordinated upstream Lathe rollout. Secret-bearing snapshots stay outside git."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = ROOT.parent / 'lathe'
BACKUP = Path.home() / '.tokens/bayleaf-lathe-rollout-20260917'
APP = 'f1a1e758-62e9-4e99-90cb-212cab12958d'


def environment():
    entries = shlex.split((Path.home()/'.tokens/owui/chat-bayleaf-dev').read_text(), comments=True)
    return {**os.environ, **dict(item.split('=',1) for item in entries if '=' in item)}


def cli(*args):
    result = subprocess.run(['uvx','owui-cli',*map(str,args)],env=environment(),capture_output=True,text=True)
    if result.returncode:
        raise SystemExit('OWUI operation failed: '+' '.join(map(str,args[:2])))
    return result.stdout


def private_write(path, value):
    fd = os.open(path, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
    with os.fdopen(fd,'w') as handle: handle.write(value)


def backup():
    if BACKUP.exists(): raise SystemExit('Rollback snapshot already exists; refusing to overwrite it')
    BACKUP.mkdir(mode=0o700)
    source = cli('tools','pull','lathe')
    private_write(BACKUP/'lathe.py',source)
    private_write(BACKUP/'valves.json',cli('--json','tools','valves','lathe'))
    private_write(BACKUP/'tool.json',cli('--json','tools','show','lathe'))
    app = subprocess.run(['doctl','apps','get',APP,'--context','bayleaf','--output','json'],capture_output=True,text=True,check=True)
    private_write(BACKUP/'app.json',app.stdout)
    for resource in ['tools','functions','skills','models']:
        cli(resource,'pull-all',BACKUP/resource)
    for path in BACKUP.rglob('*'):
        path.chmod(0o700 if path.is_dir() else 0o600)
    spec=json.loads(app.stdout)[0]['spec']
    requirements=[]
    for resource in ['tools','functions']:
        for path in (BACKUP/resource).rglob('*.py'):
            line=re.search(r'^requirements:\s*(.*)$',path.read_text(),re.MULTILINE)
            if line and 'pydantic-ai' in line.group(1):
                requirements.append({'resource':str(path.relative_to(BACKUP)),'requirements':line.group(1)})
    print(json.dumps({'backup':str(BACKUP),'lathe_version':re.search(r'^version:\s*(.*)$',source,re.MULTILINE).group(1),
        'matches_repo_backup':source==(ROOT/'chat/tools/lathe/tool.py').read_text(),
        'pydantic_ai_consumers':requirements,
        'services':[{'name':s['name'],'size':s.get('instance_size_slug'),'instances':s.get('instance_count'),'image':s.get('image',{}).get('tag')} for s in spec['services']]}))


def promote():
    before = (BACKUP/'lathe.py').read_text()
    live = cli('tools','pull','lathe')
    if live != before: raise SystemExit('Live Lathe changed since the rollback snapshot; inspect before continuing')
    valves=json.loads((BACKUP/'valves.json').read_text())
    credentials=dict(line.split('=',1) for line in (Path.home()/'.tokens/bayleaf-previews').read_text().splitlines())
    valves.update({'preview_wrapper_url':'https://api.bayleaf.dev/previews/registrations',
        'preview_wrapper_key':credentials['PREVIEWS_INSTALLATION_KEY'],'preview_expiry_seconds':86400})
    private_write(BACKUP/'new-valves.json',json.dumps(valves))
    cli('tools','deploy',UPSTREAM/'lathe.py','lathe')
    cli('tools','valves-set','lathe',BACKUP/'new-valves.json')
    verify()


def verify():
    source=cli('tools','pull','lathe')
    if source != (UPSTREAM/'lathe.py').read_text(): raise SystemExit('Deployed source does not match upstream checkout')
    valves=json.loads(cli('--json','tools','valves','lathe'))
    expected=json.loads((BACKUP/'new-valves.json').read_text())
    if any(valves.get(k)!=v for k,v in expected.items() if k in valves):
        raise SystemExit('Unexpected valve drift after deployment')
    for field in ['preview_wrapper_url','preview_wrapper_key','preview_expiry_seconds','daytona_api_key','deployment_label']:
        if valves.get(field)!=expected[field]: raise SystemExit('Required configuration readback mismatch')
    for path in [ROOT/'chat/tools/lathe/tool.py',ROOT/'chat/tools/lathe/meta.json']:
        content=path.read_text()
        for field in ['daytona_api_key','preview_wrapper_key']:
            if expected[field] and expected[field] in content:
                raise SystemExit('Credential unexpectedly present in a repository backup artifact')
    old=json.loads((BACKUP/'tool.json').read_text())
    new=json.loads(cli('--json','tools','show','lathe'))
    # Grant identifiers/timestamps may rotate; principals and permissions must not.
    grants=lambda obj: sorted((g.get('principal_type'),g.get('principal_id'),g.get('permission')) for g in obj.get('access_grants',[]))
    if grants(old)!=grants(new): raise SystemExit('Tool access grants changed')
    print(json.dumps({'version':re.search(r'^version:\s*(.*)$',source,re.MULTILINE).group(1),
        'source_sha256':hashlib.sha256(source.encode()).hexdigest(),
        'wrapping_configured':True,'upstream_lifetime_seconds':valves['preview_expiry_seconds'],'access_grants_preserved':True}))


def reconcile():
    destination=BACKUP/'after'
    if destination.exists(): raise SystemExit('After snapshot already exists; inspect it before replacing')
    destination.mkdir(mode=0o700)
    for resource in ['tools','functions','skills','models']:
        cli(resource,'pull-all',destination/resource)
    for path in destination.rglob('*'):
        path.chmod(0o700 if path.is_dir() else 0o600)
    print('Full post-rollout snapshot saved for drift review:',destination)


def deploy_skill():
    source=ROOT/'chat/skills/code-sandbox/skill.md'
    cli('skills','deploy',source,'code-sandbox')
    live=cli('skills','pull','code-sandbox')
    body=source.read_text().split('\n---\n',1)[1].strip()
    if body not in live: raise SystemExit('Skill content readback mismatch')
    print('Code Sandbox skill updated and verified')


def reconcile_repo():
    for resource in ['tools','functions','skills','models']:
        cli(resource,'pull-all',ROOT/'chat'/resource)
    if (ROOT/'chat/tools/lathe/tool.py').read_text() != (UPSTREAM/'lathe.py').read_text():
        raise SystemExit('Vendored Lathe differs from upstream after full pull')
    print('All four resource types pulled; vendored Lathe matches upstream exactly')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['backup','promote','verify','reconcile','deploy-skill','reconcile-repo'])
    args=parser.parse_args()
    {'backup':backup,'promote':promote,'verify':verify,'reconcile':reconcile,'deploy-skill':deploy_skill,'reconcile-repo':reconcile_repo}[args.action]()
