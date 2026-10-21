#!/usr/bin/env python3
"""Stage the operator-only Inbox API pilot using published adapter commits.

Creates an isolated copy; never edits the source checkout or deploys by itself.
Normal Wrangler build hooks produce real, published adapter assets, never fixtures.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

API = Path(__file__).resolve().parents[1]
REPO = API.parent
ACCOUNT = '1a49fb69291d42e23c4ed4dcffce5bbc'
env = dict(os.environ, CLOUDFLARE_ACCOUNT_ID=ACCOUNT)
sql = "SELECT account_generation FROM user_keys WHERE email='amsmith@ucsc.edu' AND revoked=0"
reply = json.loads(subprocess.check_output(['cf', 'd1', 'query',
    'e249d6a6-41cf-4ab7-93d6-b677ac95b524', '--sql', sql, '--profile', 'ucsc'], env=env))
rows = reply[0]['results']
if len(rows) != 1 or not rows[0]['account_generation']:
    raise SystemExit('Operator account identity unavailable; refusing staging')
owner = rows[0]['account_generation']
temp_root = Path(os.environ.get('TMPDIR', tempfile.gettempdir())) / 'opencode'
temp_root.mkdir(exist_ok=True)
base = Path(tempfile.mkdtemp(prefix='inbox-api-deploy-', dir=temp_root))
stage = base / 'api'
shutil.copytree(API, stage, ignore=shutil.ignore_patterns(
    'node_modules', 'sandbox-plugin', 'nanobot-sandbox', '.wrangler', '.dev.vars',
    '.dev.vars.*', '.env', '.env.*', 'reports', '__pycache__'))
(stage / 'node_modules').symlink_to(API / 'node_modules', target_is_directory=True)
(base / 'telemetry').symlink_to(REPO / 'telemetry', target_is_directory=True)
for name, url in [('sandbox-plugin', 'https://github.com/bayleaf-ucsc/opencode-sandbox.git'),
                  ('nanobot-sandbox', 'https://github.com/bayleaf-ucsc/nanobot-sandbox.git')]:
    # Local clones contain committed HEAD only, never uncommitted adapter edits.
    subprocess.run(['git', 'clone', '--quiet', '--no-hardlinks', str(API / name), str(stage / name)], check=True)
    subprocess.run(['git', '-C', str(stage / name), 'remote', 'set-url', 'origin', url], check=True)
config = stage / 'wrangler.jsonc'
text = config.read_text()
text = text.replace('"name": "bayleaf-api",', '"name": "bayleaf-api",\n  "account_id": "' + ACCOUNT + '",', 1)
text = text.replace('"INBOXES_ENABLED": "false"', '"INBOXES_ENABLED": "true",\n    "INBOXES_PILOT_OWNER": "' + owner + '"', 1)
config.write_text(text)
print(stage)
