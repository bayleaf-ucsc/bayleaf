#!/usr/bin/env python3
"""Two clean Rodney profiles for this run's synthetic public room.

No BayLeaf logins, no default/personal browser profile. Commands capture Rodney
output privately; stdout contains only bounded DOM/status evidence. End with stop.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

LEDGER=Path(os.environ.get('BAYLEAF_COLLABMD_LEDGER',str(Path.home()/'.tokens/bayleaf-collabmd-qualification.json')))
PROFILE_ROOT=Path(os.environ.get('TMPDIR','/tmp'))/'opencode/collabmd-qualification-profiles'


def rodney(profile,*args):
    env={**os.environ,'RODNEY_HOME':str(PROFILE_ROOT/profile)}
    result=subprocess.run(['rodney',*args],env=env,capture_output=True,text=True,timeout=45)
    if result.returncode:
        raise RuntimeError('rodney_'+args[0]+'_failed')
    return result.stdout.strip()


def js(profile,expression):
    result=rodney(profile,'js',expression)
    try:
        return json.loads(result)
    except ValueError:
        return result


def snapshot(profile):
    return js(profile,"""JSON.stringify({title:document.title,inputs:[...document.querySelectorAll('input')].map(e=>({type:e.type,id:e.id,placeholder:e.placeholder})),buttons:[...document.querySelectorAll('button')].filter(e=>e.checkVisibility()).map(e=>({text:e.textContent.trim().slice(0,80),id:e.id,title:e.title})).slice(0,25),editors:[...document.querySelectorAll('[contenteditable=true]')].map(e=>({class:e.className,role:e.getAttribute('role'),length:e.textContent.length})),errors:document.querySelector('[role=alert]')?.textContent.slice(0,200)})""")


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('open','snapshot','login','wrong-password','old-password','document','edit','soak-edit','comment','security','fidelity','failed-save','large','status','stop','screenshot','navigate'))
    parser.add_argument('--profile',choices=('a','b'),default='a')
    parser.add_argument('--marker',help='Synthetic text to insert in the selected fixture document')
    parser.add_argument('--live',action='store_true')
    args=parser.parse_args()
    if not args.live:
        parser.error('--live required')
    state=json.loads(LEDGER.read_text())
    if state['owner']!='amsmith@ucsc.edu':
        raise RuntimeError('owner_mismatch')
    profile=args.profile
    if args.action=='open':
        for name in ('a','b'):
            (PROFILE_ROOT/name).mkdir(parents=True,exist_ok=True)
            rodney(name,'start')
            rodney(name,'open',state['url'])
            print(json.dumps({'profile':name,'dom':snapshot(name)}),flush=True)
    elif args.action=='snapshot':
        print(json.dumps({'profile':profile,'dom':snapshot(profile)}),flush=True)
    elif args.action=='navigate':
        for name in ('a','b'):
            rodney(name,'open',state['url'])
        print(json.dumps({'profiles_navigated':['a','b']}),flush=True)
    elif args.action in ('login','wrong-password','old-password'):
        value=state['password'] if args.action=='login' else state['previous_password'] if args.action=='old-password' else 'synthetic-wrong-password'
        rodney(profile,'input','input[type=password]',value)
        result=js(profile,"""(() => {const form=document.querySelector('input[type=password]').closest('form');if(form){form.requestSubmit();return true;}const b=[...document.querySelectorAll('button')].find(b=>/unlock|join|sign in|continue/i.test(b.textContent));b.click();return true;})()""")
        print(json.dumps({'profile':profile,'submitted':result,'correct_password':args.action=='login'}),flush=True)
    elif args.action=='document':
        rodney(profile,'wait','.file-tree-file[data-path="qualification.md"]')
        result=js(profile,"""(() => {const b=[...document.querySelectorAll('button')].find(b=>b.checkVisibility()&&/skip for now/i.test(b.textContent));if(b)b.click();const f=document.querySelector('.file-tree-file[data-path="qualification.md"]');if(f)f.click();return {selected:!!f};})()""")
        print(json.dumps({'profile':profile,**result}),flush=True)
    elif args.action in ('edit','soak-edit'):
        marker='\nPost-soak live co-edit confirmation.\n' if args.action=='soak-edit' else '\nSynthetic profile '+profile.upper()+' co-edit.\n'
        marker=args.marker or marker
        guard="if((window.__bayleafRoomProbe?.open||0)<3)return {edited:false,disconnected:true};" if args.action=='soak-edit' else ''
        result=js(profile,"(() => {"+guard+"const e=document.querySelector('.cm-content[contenteditable=true]');if(!e)return {edited:false};e.focus();const s=getSelection();s.selectAllChildren(e);s.collapseToEnd();return {edited:document.execCommand('insertText',false,"+json.dumps(marker)+")};})()")
        print(json.dumps({'profile':profile,**result}),flush=True)
    elif args.action=='comment':
        rodney(profile,'click','#commentSelectionBtn')
        rodney(profile,'wait','.comment-card-input')
        rodney(profile,'input','.comment-card-input','Synthetic qualification comment: preserve across room restart.')
        result=js(profile,"""(() => {const b=[...document.querySelectorAll('.comment-card button')].find(b=>b.textContent.trim()==='Post comment');b.click();return {comment_submitted:true};})()""")
        print(json.dumps(result),flush=True)
    elif args.action=='security':
        result=js(profile,"""(async()=>{const results=[];for(const path of ['../outside.md','escape.md','outside-dir/qualification.md']){const r=await fetch('/api/file?path='+encodeURIComponent(path));const text=await r.text();results.push({path,status:r.status,outside_disclosed:text.includes('SYNTHETIC OUTSIDE ROOT MUST NOT BE DISCLOSED')});}const normal=await fetch('/api/file?path=qualification.md');const anonymous=await fetch('/api/file?path=qualification.md',{credentials:'omit'});const wrong=await fetch('/api/auth/session',{credentials:'omit',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'wrong'})});return JSON.stringify({authenticated_document_status:normal.status,cookie_roundtrip:normal.ok,anonymous_document_status:anonymous.status,wrong_password_status:wrong.status,denials:results});})()""")
        print(json.dumps({'profile':profile,'security':result}),flush=True)
    elif args.action=='fidelity':
        rodney(profile,'click','.file-tree-file[data-path="source-fidelity.md"]')
        rodney(profile,'wait','.cm-content')
        print(json.dumps({'opened_source_fidelity_document':True}),flush=True)
    elif args.action=='large':
        rodney(profile,'click','.file-tree-file[data-path="large-initial-sync.md"]')
        rodney(profile,'wait','.cm-content')
        print(json.dumps({'opened_large_initial_sync_document':True}),flush=True)
    elif args.action=='failed-save':
        result=js(profile,"""(() => {const folder=document.querySelector('.file-tree-dir[data-path="readonly-qualification"]');if(folder&&!document.querySelector('.file-tree-file[data-path="readonly-qualification/blocked.md"]'))folder.click();return {opened_directory:!!folder};})()""")
        rodney(profile,'wait','.file-tree-file[data-path="readonly-qualification/blocked.md"]')
        rodney(profile,'click','.file-tree-file[data-path="readonly-qualification/blocked.md"]')
        rodney(profile,'wait','.cm-content')
        print(json.dumps({'opened_readonly_document':True}),flush=True)
    elif args.action=='status':
        for name in ('a','b'):
            result=js(name,"""JSON.stringify({editor:document.querySelector('.cm-content')?.textContent?.slice(0,1000),passwordVisible:!!document.querySelector('input[type=password]')?.checkVisibility(),body:document.body.innerText.slice(0,1800)})""")
            print(json.dumps({'profile':name,'status':result}),flush=True)
    elif args.action=='screenshot':
        path=PROFILE_ROOT/('profile-'+profile+'.png')
        rodney(profile,'screenshot',str(path))
        print(json.dumps({'profile':profile,'screenshot':str(path)}),flush=True)
    elif args.action=='stop':
        for name in ('a','b'):
            rodney(name,'stop')
        print(json.dumps({'own_browser_profiles_stopped':True}),flush=True)


if __name__=='__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error':str(error) if isinstance(error,RuntimeError) else type(error).__name__}),flush=True)
        sys.exit(1)
