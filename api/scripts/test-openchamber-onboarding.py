#!/usr/bin/env python3
"""Real upstream first-install/discovery check in an isolated HOME, no BayLeaf key."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request

parser=argparse.ArgumentParser()
parser.add_argument('--prefix',required=True,help='Global npm prefix containing current OpenChamber')
args=parser.parse_args()
prefix=Path(args.prefix).resolve()
spec=importlib.util.spec_from_file_location('installer',Path(__file__).with_name('browser-setup.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
base=os.environ.get('OPENCODE_TEST_TMP',tempfile.gettempdir())
with tempfile.TemporaryDirectory(prefix='bayleaf-onboarding-',dir=base) as temporary:
    home=Path(temporary);os.environ['HOME']=str(home)
    m.ROOT=home/'managed';(m.ROOT/'releases').mkdir(parents=True)
    (m.ROOT/'releases'/m.RELEASE).symlink_to(prefix)
    (m.ROOT/'credentials').mkdir();(m.ROOT/'credentials/incoming').write_text('sk-bayleaf-synthetic')
    operation='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    m.atomic('request.json',{'operation':operation,'deadline':int(time.time())+900})
    m.configure()
    # Capture failures in a private file, never print installer environments.
    def command(argv,timeout=30,env=None):
        subprocess.run(argv,env=env,timeout=timeout,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    m.command=command
    m.ensure_opencode(operation)
    binary=home/'.opencode/bin/opencode'
    assert binary.is_file()
    m.command=lambda *a,**k: (_ for _ in ()).throw(AssertionError('reinstalled'))
    m.ensure_opencode(operation)
    print('PASS upstream first install and reuse, without a BayLeaf-owned OpenCode package',flush=True)
    def port():
        with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
    frontend,backend=port(),port()
    env=m.environment(backend)
    # Test package-manager ownership without performing a self-update.
    module=prefix/'lib/node_modules/@openchamber/web/server/lib/package-manager.js'
    code='const m=await import('+json.dumps(module.as_uri())+');console.log(JSON.stringify(m.detectPackageManagerDetails()));'
    details=json.loads(subprocess.check_output(['node','--input-type=module','-e',code],env=env,text=True))
    assert details['packageManager']=='npm'
    assert Path(details['globalNodeModulesRoot']).resolve()==prefix/'lib/node_modules'
    print('PASS self-updater package-manager prefix owns the running installation',flush=True)
    process=subprocess.Popen([str(prefix/'bin/openchamber'),'serve','--foreground','--host','127.0.0.1','--port',str(frontend)],
        env=env,cwd=home/'workspace',stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        for _ in range(120):
            if process.poll() is not None:raise RuntimeError('OpenChamber exited before readiness')
            try:
                with opener.open(f'http://127.0.0.1:{frontend}/api/opencode/compatibility',timeout=3) as response:
                    data=json.load(response)
                if data.get('state')=='compatible':break
            except OSError:pass
            time.sleep(1)
        else:raise RuntimeError('OpenChamber readiness timed out')
        assert Path(data['binary']).resolve()==binary.resolve(),data
        m.PORT=frontend
        m.atomic('state/runtime.json',{'release':m.RELEASE,'configured':True,'process':{}})
        # Process identity is Linux-specific; exercise the actual health contract here.
        m.alive=lambda _:process.poll() is None
        assert m.health(),'BayLeaf readiness rejected a healthy current OpenChamber'
        print('PASS OpenChamber discovers and runs its installed OpenCode '+data['version'],flush=True)
    finally:
        os.killpg(process.pid,signal.SIGTERM)
        try:process.wait(timeout=15)
        except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait()
