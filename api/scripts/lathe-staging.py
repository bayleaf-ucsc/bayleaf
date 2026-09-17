#!/usr/bin/env python3
"""Run the upstream preview loader/dispatch test on an isolated BayLeaf toolkit.
Synthetic prompts use Basic's approved OpenRouter ZDR path. No credentials print.
"""
import json
import os
from pathlib import Path
import shlex
import subprocess
import argparse

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--full', action='store_true', help='Full regression, including installation of upstream requirements; use after the coordinated production upgrade')
args = parser.parse_args()

env = dict(os.environ)
for filename in ['owui/chat-bayleaf-dev', 'bayleaf-previews']:
    for item in shlex.split((Path.home() / '.tokens' / filename).read_text(), comments=True):
        if '=' in item:
            key, value = item.split('=', 1)
            env[key] = value
result = subprocess.run(['uvx','owui-cli','--json','tools','valves','lathe'], env=env, text=True, capture_output=True)
if result.returncode:
    raise SystemExit('Could not acquire the existing Daytona configuration')
env.update({
    'DAYTONA_API_KEY': json.loads(result.stdout)['daytona_api_key'],
    'OWUI_MODEL': 'basic',
    'LATHE_TEST_TOOL_ID': 'lathe_preview_test',
    'LATHE_PREVIEW_WRAPPER_URL': 'https://api.bayleaf.dev/previews/registrations',
    'LATHE_PREVIEW_WRAPPER_KEY': env['PREVIEWS_INSTALLATION_KEY'],
    'LATHE_PREVIEW_EXPECTED_PATTERN': r'https://amsmith-[a-f0-9]{24}\.bayleaf-proxies\.dev/',
    'LATHE_PREVIEW_REVOKE_URL': 'https://api.bayleaf.dev/previews/registrations/{label}',
})
root = Path(__file__).resolve().parents[3] / 'lathe'
command=['uv','run','--directory',str(root),'python','test_deployment.py']
if not args.full: command.append('--preview-only')
raise SystemExit(subprocess.run(command,env=env).returncode)
