#!/usr/bin/env python3
"""Test a separately installed CollabMD package on localhost, synthetic files only.

Usage: python3 scripts/qualify-collabmd-local.py /path/to/node_modules/collabmd
Requires local Node 26. Copies the supplied package, applies the exact production
compatibility functions, and deletes only its own temporary fixture afterward.
This is not Daytona or browser qualification.
"""
import importlib.util
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('browser-setup.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.select_service('collabmd')
package = Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix='collabmd-local-', dir=__import__('os').environ.get('TMPDIR')) as temp:
    root = Path(temp)
    target = root/'app'
    shutil.copytree(package, target)
    (root/'node_modules').symlink_to(package.parent)
    auth = target/'src/server/auth/create-auth-service.js'
    auth.write_text(m.collabmd_patch_auth(auth.read_text()))
    http = target/'src/server/infrastructure/http/http-response.js'
    http.write_text(m.collabmd_patch_http(http.read_text()))
    subprocess.run(['node', str(Path(__file__).with_name('qualify-collabmd-local.mjs')),
        str(target), str(root)], check=True, timeout=90)
