#!/usr/bin/env python3
"""Pin remote sandbox configuration to the checked-out plugin submodule."""
import json
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parents[1]
plugin = root / 'sandbox-plugin'
revision = subprocess.check_output(['git', '-C', str(plugin), 'rev-parse', 'HEAD'], text=True).strip()
if not re.fullmatch(r'[0-9a-f]{40}', revision):
    raise RuntimeError('Plugin requires a full Git commit')
if subprocess.check_output(['git', '-C', str(plugin), 'status', '--porcelain'], text=True).strip():
    raise RuntimeError('Commit plugin changes before building the remote configuration')
target = f'github:bayleaf-ucsc/opencode-sandbox#{revision}'
(root / '.sandbox-plugin-ref.json').write_text(json.dumps({'package': target}) + '\n')
print(f'Sandbox plugin pinned to {revision}')
