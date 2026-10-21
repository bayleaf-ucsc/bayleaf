#!/usr/bin/env python3
"""Bounded approved soak with unconditional app/preview/browser cleanup.

Only CDP reads occur during the two-hour observation: no Toolbox or keepalive
calls. Provider checks and post-soak editing occur afterward. The owner machine
is stopped, never destroyed. Credentials remain in the existing private ledger.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

SCRIPTS=Path(__file__).resolve().parent
EVIDENCE=Path(os.environ.get('TMPDIR','/tmp'))/'opencode/collabmd-qualification-profiles'


def run(script,*args,timeout=120):
    result=subprocess.run([sys.executable,str(SCRIPTS/script),*args],capture_output=True,text=True,timeout=timeout)
    print(result.stdout.strip(),flush=True)
    if result.returncode:
        raise RuntimeError(script+'_failed')
    lines=[json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
    return lines[-1] if lines else None


parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--live',action='store_true')
parser.add_argument('--daytona-vars',type=Path,required=True)
args=parser.parse_args()
if not args.live:
    parser.error('--live required')
live=lambda action:run('qualify-collabmd-live.py',action,'--live','--daytona-vars',str(args.daytona_vars))
summary={'started_at':time.time(),'duration_seconds':7200,'completed':False,'cleanup_complete':False}
try:
    result=subprocess.run(['uv','run','--script',str(SCRIPTS/'qualify-collabmd-watch.py'),
        'watch','--seconds','7200','--live'],timeout=7350)
    if result.returncode:
        raise RuntimeError('watch_failed')
    observations=[json.loads(line) for line in (EVIDENCE/'soak.jsonl').read_text().splitlines()]
    summary['samples']=len(observations)
    summary['continuous_three_sockets_per_tab']=all(
        row['profiles'][name].get('probe',{}).get('open')==3 for row in observations for name in ('a','b'))
    summary['machine_after_soak']=live('machine')['state']
    if summary['machine_after_soak']=='started':
        edited=run('qualify-collabmd-browsers.py','soak-edit','--profile','a','--live')
        summary['post_soak_edit_submitted']=edited.get('edited') is True
        # Local CDP reads only while waiting for ordinary app propagation.
        for _ in range(20):
            status=run('qualify-collabmd-browsers.py','status','--live')
            if 'Post-soak live co-edit confirmation.' in status.get('status',{}).get('editor',''):
                summary['post_soak_edit_reached_other_profile']=True
                break
            time.sleep(.5)
        live('checks')
    summary['completed']=True
except Exception as error:
    summary['error']=type(error).__name__+':'+str(error)
finally:
    errors=[]
    for label,operation in [('end-sharing',lambda:live('stop')),
        ('close-browsers',lambda:run('qualify-collabmd-browsers.py','stop','--live')),
        ('stop-compute',lambda:live('sleep'))]:
        try:
            operation()
        except Exception as error:
            errors.append(label+':'+type(error).__name__)
    summary['cleanup_complete']=not errors
    summary['cleanup_errors']=errors
    summary['finished_at']=time.time()
    EVIDENCE.mkdir(parents=True,exist_ok=True)
    (EVIDENCE/'soak-summary.json').write_text(json.dumps(summary,indent=2))
    print(json.dumps(summary),flush=True)
    if errors:
        sys.exit(1)
