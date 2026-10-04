#!/usr/bin/env python3
"""Bundle sandbox-specific skills for transport, without installer per-skill wiring."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = root / 'sandbox-skills'
files = {str(p.relative_to(source)): p.read_text() for p in sorted(source.rglob('*'))
         if p.is_file() and not p.is_symlink() and '__pycache__' not in p.parts
         and p.suffix in ('.md', '.py')}
serialized = json.dumps(files, sort_keys=True)
bundle = {'version': hashlib.sha256(serialized.encode()).hexdigest(), 'files': files}
(root / '.sandbox-skills.json').write_text(json.dumps(bundle))
print(f'Bundled {len(files)} sandbox skill files ({bundle["version"][:12]})')
