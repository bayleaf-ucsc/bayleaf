#!/usr/bin/env python3
"""BayLeaf browser environment, Linux/Python 3.10+. No third-party Python deps.

The edge owns authorization and deadlines. These owner-editable breadcrumbs are
diagnostics only. Credentials arrive as files, never setup argv or output.
ttyd's native Basic-auth option requires its app-only secret in child argv.
"""
import argparse
import base64
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import secrets
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import platform
import tarfile
import gzip

SCHEMA = 1
RELEASE = 'openchamber-managed-v2'
PACKAGES = ['@openchamber/web@latest']
PORT = 3100
ROOT = Path.home() / '.local/share/bayleaf/browser'
SERVICE = 'openchamber'
MAX_ARCHIVE_BYTES = 512*1024*1024
MAX_UNPACKED_BYTES = 2*1024**3
MAX_ARCHIVE_MEMBERS = 100000
SERVICES = {
    'ttyd': {'release': 'ttyd-1.7.7-managed-v1', 'port': 8794, 'directory': 'ttyd',
        'install': 'install_ttyd', 'configure': 'configure_ttyd', 'prepare': 'prepare_plain_service',
        'start': 'start_ttyd', 'bootstrap': 'bootstrap_plain_service', 'health': 'health_ttyd',
        'health_path': '/token', 'starting': 'starting_ttyd'},
    'jupyter': {'release': 'jupyterlab-4.6.4-managed-v1', 'port': 8793, 'directory': 'jupyter',
        'install': 'install_jupyter', 'configure': 'configure_jupyter', 'prepare': 'prepare_plain_service',
        'start': 'start_jupyter', 'bootstrap': 'bootstrap_plain_service', 'health': 'health_jupyter',
        'health_path': '/api/status', 'starting': 'starting_jupyter'},
    'nanobot': {'release': 'nanobot-0.3.5-managed-v1', 'port': 8792, 'directory': 'nanobot',
        'install': 'install_nanobot', 'configure': 'configure_nanobot', 'prepare': 'prepare_plain_service',
        'start': 'start_nanobot', 'bootstrap': 'bootstrap_plain_service', 'health': 'health_nanobot',
        'health_path': '/webui/bootstrap', 'starting': 'starting_nanobot'},
    'openchamber': {'release': RELEASE, 'port': PORT, 'directory': 'browser',
        'install': 'install', 'configure': 'configure', 'prepare': 'prepare_openchamber',
        'start': 'start_openchamber', 'bootstrap': 'bootstrap', 'health': 'health_openchamber',
        'health_path': '/health', 'starting': 'starting_openchamber'},
    'code-server': {'release': 'code-server-managed-v1', 'port': 8791, 'directory': 'code-server',
        'install': 'install_code_server', 'configure': 'configure_code_server', 'prepare': 'prepare_plain_service',
        'start': 'start_code_server', 'bootstrap': 'bootstrap_plain_service', 'health': 'health_code_server',
        'health_path': '/healthz', 'starting': 'starting_code_server'},
    'dufs': {'release': 'dufs-managed-v1', 'port': 8790, 'directory': 'dufs',
        'install': 'install_dufs', 'configure': 'configure_dufs', 'prepare': 'prepare_plain_service',
        'start': 'start_dufs', 'bootstrap': 'bootstrap_plain_service', 'health': 'health_dufs',
        'health_path': '/__dufs__/health', 'starting': 'starting_dufs'},
}


def adapter(name, *args, **kwargs):
    return globals()[SERVICES[SERVICE][name]](*args, **kwargs)


def select_service(service):
    global SERVICE, RELEASE, PORT, ROOT
    SERVICE = service
    definition = SERVICES[service]
    RELEASE, PORT = definition['release'], definition['port']
    ROOT = Path.home() / '.local/share/bayleaf' / definition['directory']
    if service == 'jupyter' and 'install_jupyter' not in globals():
        # Worker transfers this fixed, canonical adapter beside the installer.
        # One source serves installation and isolated upstream qualification.
        exec(compile(Path(__file__).with_name('jupyter-adapter.py').read_text(), 'jupyter-adapter.py', 'exec'), globals())
PHASES = {'checking', 'installing', 'configuring', 'starting', 'ready', 'failed', 'stopped'}


class Failure(Exception):
    pass


def read(name, default=None):
    try:
        return json.loads((ROOT / name).read_text())
    except (FileNotFoundError, ValueError):
        return default


def atomic(name, value):
    path = ROOT / name
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(path.name + f'.{os.getpid()}.{threading.get_ident()}.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(value, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)


@contextlib.contextmanager
def lock(name, wait=0):
    with (ROOT / name).open('a') as handle:
        end = time.monotonic() + wait
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= end:
                    raise Failure('operation_in_progress') from None
                time.sleep(.1)
        yield


def identity(pid, include_zombie=False):
    """PID alone is unsafe after sleep, reboot, or PID reuse."""
    try:
        stat = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        if stat[0] == 'Z' and not include_zombie:
            return None
        return {'pid': pid, 'start': stat[19],
                'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
    except (OSError, IndexError):
        return None


def alive(process):
    return isinstance(process, dict) and identity(process.get('pid', -1)) == process


def terminate(process):
    if not isinstance(process, dict) or identity(process.get('pid', -1), include_zombie=True) != process:
        return
    pid = process['pid']
    # Only a verified session/process-group leader created by this script.
    if os.getpgid(pid) != pid:
        raise Failure('process_identity_mismatch')
    # The supervisor leaves its exited leader unreaped until group cleanup.
    # That zombie pins the PID/PGID, so descendants remain provably ours even
    # after their launcher exits. Never infer ownership from the listening port.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        if identity(pid, include_zombie=True) != process:
            return
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            return
        for _ in range(50):
            if not group_running(pid):
                return
            time.sleep(.1)
    raise Failure('process_cleanup_failed')


def group_running(pgid):
    for path in Path('/proc').glob('[0-9]*/stat'):
        try:
            stat = path.read_text().rsplit(')', 1)[1].split()
            if stat[0] != 'Z' and int(stat[2]) == pgid:
                return True
        except (OSError, ValueError, IndexError):
            continue
    return False


def wait_for_exit(child, timeout=None):
    """Linux wait without reaping: keep the verified group leader as an anchor."""
    end = time.monotonic() + timeout if timeout is not None else None
    while True:
        result = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOWAIT | (os.WNOHANG if end else 0))
        if result is not None:
            return result.si_status if result.si_code == os.CLD_EXITED else -result.si_status
        if end is not None and time.monotonic() >= end:
            raise subprocess.TimeoutExpired(child.args, timeout)
        time.sleep(.1)


def command(argv, timeout=30, env=None):
    process = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    marker = identity(process.pid, include_zombie=True)
    atomic('state/task.json', {'process': marker})
    try:
        if wait_for_exit(process, timeout=timeout) != 0:
            raise Failure('command_failed')
    except subprocess.TimeoutExpired:
        raise Failure('command_timeout') from None
    finally:
        terminate(marker)
        process.wait(timeout=10)
        atomic('state/task.json', {})


class Progress:
    def __init__(self, operation):
        self.record = {'schema': SCHEMA, 'operation': operation, 'release': RELEASE,
                       'phase': 'checking', 'started_at': int(time.time()), 'process': identity(os.getpid())}
        self.mutex = threading.Lock()
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.pulse, daemon=True)

    def update(self, phase, error=None, step=None):
        assert phase in PHASES
        with self.mutex:
            self.record.update(phase=phase, updated_at=int(time.time()))
            self.record['progress'] = step or phase
            history = self.record.setdefault('timeline', [])
            event = {'step': step or phase, 'at': int(time.time())}
            if error:
                event['error'] = error
            if not history or history[-1]['step'] != event['step']:
                history.append(event)
            self.record['timeline'] = history[-32:]
            if error:
                self.record['error'] = error
            atomic('state/operation.json', self.record)
        # Content-free bounded log. Never copy package-manager or application output.
        log = ROOT / 'state/setup.log'
        if log.exists() and log.stat().st_size > 128 * 1024:
            os.replace(log, log.with_suffix('.previous.log'))
        with log.open('a') as handle:
            handle.write(json.dumps(self.record) + '\n')

    def pulse(self):
        while not self.done.wait(5):
            with self.mutex:
                self.record['updated_at'] = int(time.time())
                atomic('state/operation.json', self.record)


def request(operation):
    value = read('request.json', {})
    if value.get('operation') != operation or not re.fullmatch(r'[a-f0-9-]{36}', operation):
        raise Failure('invalid_operation')
    if read('state/cancelled.json', {}).get('operation') == operation:
        raise Failure('operation_cancelled')
    deadline = value.get('deadline')
    if not isinstance(deadline, int) or not time.time() < deadline <= time.time() + 20*60 + 60:
        raise Failure('setup_timeout')
    return value


def health():
    runtime = read('state/runtime.json', {})
    if runtime.get('release') != RELEASE or not runtime.get('configured') or not alive(runtime.get('process')):
        return False
    try:
        # Ignore proxy environment variables for the loopback readiness check.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        target = f'http://127.0.0.1:{PORT}' + SERVICES[SERVICE]['health_path']
        if SERVICE == 'nanobot':
            target = urllib.request.Request(target, headers={'X-Nanobot-Auth':(ROOT / 'credentials/app-secret').read_text().strip()})
        if SERVICE == 'jupyter':
            target = urllib.request.Request(target, headers={'Authorization':'token '+(ROOT / 'credentials/app-secret').read_text().strip()})
        if SERVICE == 'ttyd':
            target = urllib.request.Request(target, headers={'Authorization':'Basic '+ttyd_token()})
        with opener.open(target, timeout=3) as response:
            data = json.loads(response.read(65536))
        return adapter('health', data)
    except (OSError, ValueError):
        return False


def health_openchamber(data):
    return isinstance(data, dict) and isinstance(data.get('openchamberVersion'), str) and data.get('isOpenCodeReady') is True


def health_code_server(data):
    # code-server /healthz reports browser activity, not server readiness.
    # A fresh server has lastHeartbeat=0 and status=expired; health probes are
    # deliberately excluded from heart.beat(). The runtime gates in health()
    # still require our configured, identity-verified live process.
    return isinstance(data, dict) and data.get('status') in ('alive', 'expired')


def health_dufs(data):
    return isinstance(data, dict) and data.get('status') == 'OK'


def health_nanobot(data):
    expected = read('request.json', {}).get('preview_url', 'https://pending.invalid/')
    return isinstance(data, dict) and data.get('ws_url') == 'wss://' + expected.removeprefix('https://') and bool(data.get('token'))


def inspect():
    operation = read('state/operation.json', {})
    runtime = read('state/runtime.json', {})
    runtime_events = runtime.get('timeline', []) if runtime.get('operation') == operation.get('operation') else []
    events = sorted(operation.get('timeline', []) + runtime_events,
                    key=lambda e:(e['at'], e['step'] in ('ready', 'failed')))[-40:]
    return {'schema': SCHEMA, 'service': SERVICE, 'operation': operation.get('operation'),
        'phase': operation.get('phase', 'unchecked'), 'error': operation.get('error'),
        'progress': events[-1]['step'] if events else operation.get('phase','unchecked'),
        'timeline': events, 'started_at': operation.get('started_at'),
        'updated_at': operation.get('updated_at'), 'release': RELEASE,
        'installed': read('state/installation.json', {}).get('release') == RELEASE,
        'ready': health(), 'running': alive(runtime.get('process')), 'port': PORT,
        **({'preview_url': runtime.get('preview_url')} if SERVICE == 'nanobot' else {})}


def install(progress):
    release = ROOT / 'releases' / RELEASE
    manifest = read('state/installation.json', {})
    bins = release / 'bin'
    if manifest.get('release') == RELEASE and (bins / 'openchamber').is_file():
        return release
    if not shutil.which('node') or not shutil.which('npm'):
        raise Failure('node_22_required')
    try:
        version = subprocess.check_output(['node', '--version'], timeout=10, text=True).strip()
        if int(version.lstrip('v').split('.')[0]) < 22:
            raise Failure('node_22_required')
    except (ValueError, subprocess.SubprocessError):
        raise Failure('node_22_required') from None
    if shutil.disk_usage(ROOT).free < 1536 * 1024**2:
        raise Failure('insufficient_disk')
    limit = Path('/sys/fs/cgroup/memory.max')
    if limit.exists() and limit.read_text().strip() != 'max' and int(limit.read_text()) < 2*1024**3:
        raise Failure('requires_2_gib')
    progress.update('installing', step='installing_openchamber')
    stage = ROOT / 'releases' / (RELEASE + '.staging')
    # Only this installer-owned staging directory is disposable.
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True, mode=0o700)
    try:
        command(['npm', 'install', '--global', '--prefix', str(stage), '--no-audit', '--no-fund', *PACKAGES], timeout=900)
        command([str(stage / 'bin/openchamber'), '--version'])
    except Failure:
        raise Failure('installation_failed') from None
    # Preserve a damaged prior release for inspection rather than deleting it.
    if release.exists():
        release.rename(release.with_name(RELEASE + '.retired-' + str(time.time_ns())))
    stage.rename(release)
    link = ROOT / 'current.next'
    link.unlink(missing_ok=True)
    link.symlink_to(release)
    os.replace(link, ROOT / 'current')
    atomic('state/installation.json', {'schema': SCHEMA, 'release': RELEASE,
        'packages': PACKAGES, 'completed_at': int(time.time())})
    return release


class BoundedArchiveReader:
    def __init__(self, stream):
        self.stream, self.total = stream, 0

    def read(self, size):
        data = self.stream.read(min(size, MAX_UNPACKED_BYTES - self.total + 1))
        self.total += len(data)
        if self.total > MAX_UNPACKED_BYTES:
            raise ValueError('expanded archive size')
        return data


def code_server_asset(tag):
    return f'code-server-{tag[1:]}-linux-amd64.tar.gz'


def dufs_asset(tag):
    return f'dufs-{tag}-x86_64-unknown-linux-musl.tar.gz'


def verified_archive(repo, asset_name, stage):
    """Lathe's release/asset/digest contract, with checked extraction on Linux amd64."""
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'amd64'):
        raise Failure('unsupported_architecture')
    try:
        req = urllib.request.Request(f'https://api.github.com/repos/{repo}/releases/latest',
            headers={'User-Agent': 'BayLeaf-managed-services'})
        with urllib.request.urlopen(req, timeout=30) as response:
            release = json.loads(response.read(4*1024*1024))
        tag = release.get('tag_name', '')
        if not re.fullmatch(r'v[A-Za-z0-9._-]+', tag) or not re.fullmatch(
                rf'https://api\.github\.com/repos/{re.escape(repo)}/releases/[1-9][0-9]*', release.get('url', '')):
            raise ValueError('release')
        name = asset_name(tag)
        assets = [asset for asset in release.get('assets', []) if asset.get('name') == name]
        if len(assets) != 1:
            raise ValueError('asset')
        asset = assets[0]
        url = f'https://github.com/{repo}/releases/download/{tag}/{name}'
        digest = asset.get('digest', '')
        if asset.get('browser_download_url') != url or not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
            raise ValueError('digest')
        archive = stage / 'archive.tar.gz'
        actual = hashlib.sha256()
        deadline = time.monotonic() + 600
        size = 0
        with urllib.request.urlopen(url, timeout=30) as response, archive.open('wb') as output:
            while chunk := response.read(1024*1024):
                size += len(chunk)
                if size > MAX_ARCHIVE_BYTES or time.monotonic() > deadline:
                    raise ValueError('download limit')
                actual.update(chunk)
                output.write(chunk)
        if actual.hexdigest() != digest[7:]:
            raise ValueError('checksum')
        unpack = stage / 'unpack'
        unpack.mkdir()
        members = []
        expanded = 0
        with gzip.open(archive, 'rb') as compressed, tarfile.open(fileobj=BoundedArchiveReader(compressed), mode='r|') as tar:
            for member in tar:
                expanded += member.size
                if expanded > MAX_UNPACKED_BYTES or len(members) >= MAX_ARCHIVE_MEMBERS:
                    raise ValueError('archive size')
                members.append(member)
                member.mode &= 0o755
                path = Path(member.name)
                if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir() or member.issym()):
                    raise ValueError('archive path')
                if member.issym():
                    target = Path(member.linkname)
                    resolved = (unpack / path.parent / target).resolve()
                    if target.is_absolute() or not resolved.is_relative_to(unpack.resolve()):
                        raise ValueError('archive link')
                if not (unpack / member.name).resolve().is_relative_to(unpack.resolve()):
                    raise ValueError('archive destination')
                destination = unpack / member.name
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    if member.issym():
                        destination.symlink_to(member.linkname)
                    else:
                        # Exclusive creation rejects duplicate files and writes
                        # through symlinks. No version-dependent tarfile filters.
                        with tar.extractfile(member) as source, destination.open('xb') as output:
                            shutil.copyfileobj(source, output)
                        destination.chmod(member.mode)
        # Resolve the final graph too: forward symlink chains can change the
        # meaning of a link validated before its target existed.
        for member in members:
            if not (unpack / member.name).resolve().is_relative_to(unpack.resolve()):
                raise ValueError('archive link graph')
        return unpack, {'tag': tag, 'asset': name, 'sha256': digest[7:]}
    except Failure:
        raise
    except Exception:
        raise Failure('release_verification_failed') from None


def install_code_server(progress):
    return install_archive(progress, 'coder/code-server', code_server_asset, 'bin/code-server',
        lambda evidence: evidence['asset'].removesuffix('.tar.gz'), 'installing_code_server',
        free_bytes=1536*1024**2, memory_bytes=2*1024**3)


def install_dufs(progress):
    return install_archive(progress, 'sigoden/dufs', dufs_asset, 'dufs',
        lambda evidence: '.', 'installing_dufs')


# 1.7.7 predates GitHub asset digests. Pin the publisher's SHA256SUMS instead:
# https://github.com/tsl0922/ttyd/releases/download/1.7.7/SHA256SUMS
TTYD_SHA256 = '8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55'
TTYD_URL = 'https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64'


def verified_ttyd(repo, asset_name, stage):
    """Direct static ELF asset, not a tar archive. Fail closed before execution."""
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'amd64'):
        raise Failure('unsupported_architecture')
    try:
        unpack = stage / 'unpack'
        unpack.mkdir()
        binary = unpack / 'ttyd'
        req = urllib.request.Request(TTYD_URL, headers={'User-Agent':'BayLeaf-managed-services'})
        with urllib.request.urlopen(req, timeout=30) as response:
            content = response.read(2*1024*1024 + 1)
        if len(content) > 2*1024*1024 or hashlib.sha256(content).hexdigest() != TTYD_SHA256:
            raise ValueError('checksum')
        binary.write_bytes(content)
        binary.chmod(0o700)
        return unpack, {'tag':'1.7.7', 'asset':'ttyd.x86_64', 'sha256':TTYD_SHA256}
    except Exception:
        raise Failure('release_verification_failed') from None


def install_ttyd(progress):
    return install_archive(progress, 'tsl0922/ttyd', None, 'ttyd', lambda evidence: '.',
        'installing_ttyd', free_bytes=16*1024**2, download=verified_ttyd)


def ttyd_secret():
    path = ROOT / 'credentials/app-secret'
    try:
        path.chmod(0o600)
        secret = path.read_text().strip()
    except OSError:
        raise Failure('credential_missing') from None
    if not re.fullmatch('[a-f0-9]{64}', secret):
        raise Failure('credential_invalid')
    return secret


def ttyd_token():
    return base64.b64encode(('bayleaf:' + ttyd_secret()).encode()).decode()


def configure_ttyd():
    (Path.home() / 'workspace').mkdir(parents=True, exist_ok=True)
    return hashlib.sha256(ttyd_secret().encode()).hexdigest()


def start_ttyd(backend_port):
    # -H accepts ANY nonempty header: use actual native credentials instead.
    # -O compares Origin to Host, not X-Forwarded-Host: Daytona changes Host.
    # The owner-private gateway checks HTTP/WS origins before injecting auth.
    # /token intentionally gives the authenticated owner the WS AuthToken.
    # Credentials stay out of setup commands/logs, but ttyd requires local argv.
    return [str(ROOT/'releases'/RELEASE/'ttyd'), '--port', str(PORT),
        '--interface', '0.0.0.0', '--writable', '--credential', 'bayleaf:'+ttyd_secret(),
        '--cwd', str(Path.home()/'workspace'), '--debug', '1', '/bin/bash'], non_inference_environment()


def health_ttyd(data):
    return isinstance(data, dict) and data.get('token') == ttyd_token()


def install_archive(progress, repo, asset_name, binary, directory, step, *, free_bytes=128*1024**2, memory_bytes=0, download=None):
    release = ROOT / 'releases' / RELEASE
    with lock('install.lock'):
        if read('state/installation.json', {}).get('release') == RELEASE and os.access(release / binary, os.X_OK):
            return release
        if shutil.disk_usage(ROOT).free < free_bytes:
            raise Failure('insufficient_disk')
        limit = Path('/sys/fs/cgroup/memory.max')
        if memory_bytes and limit.exists() and limit.read_text().strip() != 'max' and int(limit.read_text()) < memory_bytes:
            raise Failure('requires_2_gib')
        progress.update('installing', step=step)
        stage = ROOT / 'releases' / (RELEASE + '.staging')
        if stage.exists():
            shutil.rmtree(stage)
        stage.mkdir(parents=True, mode=0o700)
        unpack, evidence = (download or verified_archive)(repo, asset_name, stage)
        staged = unpack / directory(evidence)
        if not os.access(staged / binary, os.X_OK):
            raise Failure('installation_failed')
        command([str(staged / binary), '--version'])
        if release.exists():
            release.rename(release.with_name(RELEASE + '.retired-' + str(time.time_ns())))
        staged.rename(release)
        link = ROOT / 'current.next'
        link.unlink(missing_ok=True)
        link.symlink_to(release)
        os.replace(link, ROOT / 'current')
        atomic('state/installation.json', {'schema': SCHEMA, 'release': RELEASE, **evidence,
            'completed_at': int(time.time())})
        shutil.rmtree(stage)
        return release


def configure_code_server():
    for folder in ('user-data', 'extensions'):
        (ROOT / folder).mkdir(parents=True, exist_ok=True, mode=0o700)
    # Quiet editor defaults, not policy: preserve existing user JSONC verbatim.
    # VS Code 1.141's primary sidebar visibility is workspace state, not a setting.
    settings = ROOT / 'user-data/User/settings.json'
    settings.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        with settings.open('x') as output:
            json.dump({'chat.disableAIFeatures': True,
                'workbench.secondarySideBar.defaultVisibility': 'hidden'}, output, indent=2)
            output.write('\n')
    except FileExistsError:
        pass
    (Path.home() / 'workspace').mkdir(parents=True, exist_ok=True)
    config = ROOT / 'config.yaml'
    if not config.exists():
        config.write_text('{}\n')
    # No inference credential is needed by the editor. The gateway binds its
    # preview generation to the owner key without transferring that key here.
    return None


def configure_dufs():
    (Path.home() / 'workspace').mkdir(parents=True, exist_ok=True)
    return None


def install_nanobot(progress):
    release = ROOT / 'releases' / RELEASE
    python = release / 'bin/python'
    with lock('install.lock'):
        if read('state/installation.json', {}).get('release') == RELEASE and python.is_file():
            return release
        if sys.version_info < (3, 11):
            raise Failure('python_311_required')
        if not shutil.which('node'):
            raise Failure('node_22_required')
        try:
            version = subprocess.check_output(['node','--version'], text=True, timeout=10).strip()
            if int(version.lstrip('v').split('.')[0]) < 22:
                raise Failure('node_22_required')
        except (ValueError, subprocess.SubprocessError):
            raise Failure('node_22_required') from None
        if shutil.disk_usage(ROOT).free < 1024**3:
            raise Failure('insufficient_disk')
        progress.update('installing', step='installing_nanobot')
        stage = release.with_name(RELEASE + '.staging')
        if stage.exists():
            shutil.rmtree(stage)
        stage.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        command([sys.executable, '-m', 'venv', str(stage)], timeout=120)
        command([str(stage/'bin/python'), '-m', 'pip', 'install', '--disable-pip-version-check',
                 'nanobot-ai==0.3.5'], timeout=900)
        command([str(stage/'bin/python'), '-c', 'import nanobot; assert nanobot.__version__ == "0.3.5"'])
        if release.exists():
            release.rename(release.with_name(RELEASE + '.retired-' + str(time.time_ns())))
        stage.rename(release)
        # Invoke the venv Python module, not pip-generated absolute shebangs.
        atomic('state/installation.json', {'schema':SCHEMA, 'release':RELEASE, 'version':'0.3.5'})
        return release


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def nanobot_discovery(key):
    opener = urllib.request.build_opener(NoRedirect())
    def get(path):
        req = urllib.request.Request('https://api.bayleaf.dev'+path,
            headers={'Authorization':'Bearer '+key, 'User-Agent':'BayLeaf-managed-services'})
        with opener.open(req, timeout=30) as response:
            body = response.read(4*1024*1024+1)
            if len(body) > 4*1024*1024:
                raise ValueError('size')
            return json.loads(body)
    try:
        model = get('/recommended-model')['model']
        catalog = get('/v1/models')['data']
        row = next(row for row in catalog if row.get('id') == model)
        if not isinstance(model, str) or len(model) > 256:
            raise ValueError('model')
        context = row.get('context_length')
        if not isinstance(context, int) or context < 8192:
            raise ValueError('context')
        return model, context
    except Exception:
        raise Failure('provider_configuration_unavailable') from None


def managed_text(name, content):
    """Update generated files only if their previous managed hash still matches."""
    path = ROOT / name
    hashes = read('state/managed-files.json', {})
    digest = hashlib.sha256(content.encode()).hexdigest()
    if path.exists():
        prior = hashlib.sha256(path.read_bytes()).hexdigest()
        if prior == digest:
            # Reconcile a crash after replacing the file but before its manifest.
            if hashes.get(name) != digest:
                hashes[name] = digest
                atomic('state/managed-files.json', hashes)
            return
        if prior != hashes.get(name):
            raise Failure('managed_file_changed')
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(path.name + '.next')
    temp.write_text(content); temp.chmod(0o600); os.replace(temp, path)
    hashes[name] = digest
    atomic('state/managed-files.json', hashes)


def configure_nanobot():
    incoming = ROOT / 'credentials/incoming'
    credential = ROOT / 'credentials/owner-key'
    if incoming.exists():
        incoming.chmod(0o600); os.replace(incoming, credential)
    if not credential.exists():
        raise Failure('credential_missing')
    key = credential.read_text().strip()
    if not re.fullmatch(r'dtn_secret_[A-Za-z0-9_-]+', key):
        raise Failure('credential_invalid')
    secret_path = ROOT / 'credentials/app-secret'
    secret_path.chmod(0o600)
    secret = secret_path.read_text().strip()
    if not re.fullmatch('[a-f0-9]{64}', secret):
        raise Failure('credential_invalid')
    req = read('request.json', {})
    preview = req.get('preview_url', 'https://pending.invalid/')
    if not isinstance(preview, str) or not re.fullmatch(r'https://[a-z0-9.-]+/', preview):
        raise Failure('preview_configuration_invalid')
    assets = read('assets.json', {})
    managed_text('adapter/nanobot-mcp.mjs', assets['nanobot-mcp.mjs'])
    managed_text('workspace/skills/bayleaf-sandboxes/SKILL.md', assets['bayleaf-sandboxes.md'])
    if '_source' in assets:
        atomic('state/nanobot-package.json', assets['_source'])
    model, context = nanobot_discovery(key)
    try:
        config_path = ROOT / 'config/config.json'
        config = json.loads(config_path.read_text()) if config_path.exists() else {}
        if not isinstance(config, dict):
            raise ValueError('config')
    except (ValueError, OSError):
        raise Failure('managed_file_changed') from None
    defaults = config.setdefault('agents', {}).setdefault('defaults', {})
    defaults.update(workspace=str(ROOT/'workspace'), model=model, provider='custom', contextWindowTokens=context)
    defaults.setdefault('dream', {'enabled':False})
    defaults.setdefault('idleCompactAfterMinutes', 0)
    defaults.setdefault('botIcon', '')
    config.setdefault('gateway', {}).setdefault('heartbeat', {'enabled':False})
    config['gateway'].update(host='127.0.0.1', restartMode='exit')
    config.setdefault('providers', {})['custom'] = {'apiBase':'https://api.bayleaf.dev/v1', 'apiKey':'${BAYLEAF_API_KEY}'}
    config.setdefault('channels', {})['websocket'] = {'enabled':True, 'host':'0.0.0.0', 'port':PORT,
        'path':'/', 'publicWsUrl':'wss://'+preview.removeprefix('https://'),
        'tokenIssueSecret':'${BAYLEAF_NANOBOT_AUTH}', 'websocketRequiresToken':True}
    tools = config.setdefault('tools', {})
    tools.setdefault('web', {})['enable'] = False
    tools.setdefault('mcpServers', {})['bayleaf'] = {'command':shutil.which('node') or 'node',
        'args':[str(ROOT/'adapter/nanobot-mcp.mjs')],
        'enabledTools':['search','fetch','usage','expose','unexpose']}
    atomic('config/config.json', config)
    (Path.home() / 'workspace').mkdir(parents=True, exist_ok=True)
    # Origin/credential/config changes restart only this managed process. User
    # histories, skills, memory and schedules are neither replaced nor deleted.
    return hashlib.sha256((key+secret+json.dumps(config, sort_keys=True)).encode()).hexdigest()


def start_nanobot(backend_port):
    env = non_inference_environment()
    env = {name:value for name,value in env.items() if not name.startswith('NANOBOT_')}
    env.update(BAYLEAF_API_KEY=(ROOT/'credentials/owner-key').read_text().strip(),
        BAYLEAF_NANOBOT_AUTH=(ROOT/'credentials/app-secret').read_text().strip())
    return [str(ROOT/'releases'/RELEASE/'bin/python'), '-m', 'nanobot', 'gateway', '--foreground',
        '--config', str(ROOT/'config/config.json'), '--port', str(backend_port)], env


def start_dufs(backend_port):
    env = non_inference_environment()
    # DUFS_ALLOW_ALL / DUFS_ALLOW_SYMLINK inherited from a shell must not widen
    # the managed file root. CLI flags alone cannot negate every env setting.
    env = {name: value for name, value in env.items() if not name.startswith('DUFS_')}
    return [str(ROOT / 'releases' / RELEASE / 'dufs'), str(Path.home() / 'workspace'),
        '--bind', '0.0.0.0', '--port', str(PORT), '--allow-upload', '--allow-delete',
        '--allow-search', '--allow-archive', '--allow-hash'], env


def prepare_plain_service(operation, progress):
    pass


def prepare_openchamber(operation, progress):
    progress.update('configuring', step='installing_opencode')
    ensure_opencode(operation)


def start_code_server(backend_port):
    executable = ROOT / 'releases' / RELEASE / 'bin/code-server'
    return [str(executable), '--config', str(ROOT / 'config.yaml'), '--bind-addr', f'0.0.0.0:{PORT}', '--auth', 'none',
        '--disable-telemetry', '--disable-update-check', '--user-data-dir', str(ROOT / 'user-data'),
        '--extensions-dir', str(ROOT / 'extensions'), str(Path.home() / 'workspace')], non_inference_environment()


def non_inference_environment():
    env = dict(os.environ)
    for name in list(env):
        if re.match(r'^(BAYLEAF|OPENROUTER|TINFOIL|OPENAI|ANTHROPIC)_.*(KEY|TOKEN|SECRET|PASSWORD|AUTH)$', name):
            env.pop(name)
    return env


def start_openchamber(backend_port):
    executable = ROOT / 'releases' / RELEASE / 'bin/openchamber'
    return [str(executable), 'serve', '--foreground', '--host', '0.0.0.0', '--port', str(PORT)], environment(backend_port)


def bootstrap_plain_service(backend_port, operation, report):
    pass


def configure():
    incoming = ROOT / 'credentials/incoming'
    credential = ROOT / 'credentials/owner-key'
    if incoming.exists():
        os.chmod(incoming, 0o600)
        os.replace(incoming, credential)
    if not credential.exists():
        raise Failure('credential_missing')
    key = credential.read_text().strip()
    if not re.fullmatch(r'dtn_secret_[A-Za-z0-9_-]+', key):
        raise Failure('credential_invalid')
    config = read('config/opencode/opencode.json', {})
    config.setdefault('websearch', {'provider':'bayleaf'})
    plugins = config.setdefault('plugins', [])
    if '-opencode.tool.webfetch' not in plugins:
        plugins.append('-opencode.tool.webfetch')
    atomic('config/opencode/opencode.json', config)
    # Fresh Daytona snapshots need not contain the shared working directory.
    # The exec API creates it too, but browser-first setup must be independent.
    (Path.home() / 'workspace').mkdir(parents=True, exist_ok=True)
    # Custom themes are supported upstream, so the pinned application stays intact.
    if not (ROOT / 'openchamber/themes/bayleaf-light.json').exists():
        atomic('openchamber/themes/bayleaf-light.json', {
            'metadata': {'id': 'bayleaf-light', 'name': 'BayLeaf', 'variant': 'light',
                'version': '1.0.0', 'description': 'Cool leaf-green workspace for BayLeaf sandboxes',
                'tags': ['light', 'green', 'bayleaf']},
            'colors': {
                'primary': {'base': '#246341', 'foreground': '#ffffff',
                    'hover': '#1c5235', 'active': '#143f29', 'muted': '#24634130'},
                'surface': {'background': '#f2faf4', 'foreground': '#182d21',
                    'muted': '#e3f0e7', 'mutedForeground': '#4c6354',
                    'elevated': '#fbfefc', 'subtle': '#eaf5ed', 'overlay': '#182d2120'},
                'interactive': {'border': '#b7cebe', 'borderHover': '#799d87',
                    'focusRing': '#246341', 'selection': '#9bd5ae60',
                    'hover': '#24634112', 'active': '#24634122'},
                'status': {'error': '#a52d38', 'warning': '#805400',
                    'success': '#246341', 'info': '#225c91'},
                'syntax': {'base': {'background': '#eaf5ed', 'comment': '#506957',
                    'keyword': '#225c91', 'string': '#236449', 'number': '#704890',
                    'function': '#32603b', 'variable': '#182d21',
                    'type': '#76520b', 'operator': '#983447'}},
                'chat': {'userMessageBackground': '#e3f0e7', 'divider': '#b7cebe'},
                'markdown': {'link': '#225c91', 'linkHover': '#19456d',
                    'inlineCode': '#236449', 'inlineCodeBackground': '#e3f0e7',
                    'blockquote': '#4c6354', 'blockquoteBorder': '#799d87'}
            }})
    # Only seed our fresh application settings. Subsequent user choices survive.
    if not (ROOT / 'openchamber/settings.json').exists():
        workspace = str(Path.home() / 'workspace')
        atomic('openchamber/settings.json', {'lastDirectory': workspace,
            'projects': [{'id': 'bayleaf-workspace', 'path': workspace, 'label': 'workspace'}],
            'activeProjectId': 'bayleaf-workspace', 'themeId': 'bayleaf-light',
            'lightThemeId': 'bayleaf-light', 'themeVariant': 'light', 'useSystemTheme': False})
    return hashlib.sha256(key.encode()).hexdigest()


def environment(backend_port=None):
    env = dict(os.environ)
    # Never inherit an external-server attachment from unrelated sandbox work.
    for key in ['OPENCODE_HOST', 'OPENCODE_SKIP_START', 'OPENCHAMBER_SKIP_OPENCODE_START',
                'OPENCODE_BINARY', 'OPENCODE_PATH', 'OPENCHAMBER_OPENCODE_PATH', 'OPENCHAMBER_OPENCODE_BIN',
                'OPENCHAMBER_RUNTIME']:
        env.pop(key, None)
    for key, folder in [('XDG_CONFIG_HOME','config'), ('XDG_DATA_HOME','data'),
                        ('XDG_CACHE_HOME','cache'), ('XDG_STATE_HOME','state')]:
        env[key] = str(ROOT / folder)
    prefix = ROOT / 'releases' / RELEASE
    bins = prefix / 'bin'
    env.update(OPENCHAMBER_DATA_DIR=str(ROOT / 'openchamber'),
        OPENCHAMBER_RELAY_HOST='off',
        npm_config_prefix=str(prefix), OPENCHAMBER_PACKAGE_MANAGER='npm',
        OPENCHAMBER_OPENCODE_HOSTNAME='127.0.0.1',
        OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN='true',
        BAYLEAF_API_KEY=(ROOT / 'credentials/owner-key').read_text().strip(),
        PATH=str(bins)+':'+str(Path.home() / '.opencode/bin')+':'+env.get('PATH',''))
    if backend_port:
        password = secrets.token_urlsafe(32)
        # Credentials stay in the child environment and a protected file, not
        # argv, application logs, or content-free breadcrumbs.
        atomic('credentials/opencode-password.json', password)
        env.update(OPENCODE_PORT=str(backend_port), OPENCODE_PASSWORD=password,
            OPENCODE_SERVER_PASSWORD=password, BAYLEAF_OPENCODE_URL=f'http://127.0.0.1:{backend_port}')
    return env


def ensure_opencode(operation):
    """Delegate first installation to OpenChamber's installer and destination."""
    binary = Path.home() / '.opencode/bin/opencode'
    if binary.is_file() and os.access(binary, os.X_OK):
        return
    request(operation)
    installer = ROOT / 'releases' / RELEASE / 'lib/node_modules/@openchamber/web/server/lib/opencode/v2-install.js'
    try:
        # The web install API currently rejects a completely absent binary.
        # Invoke the same upstream implementation without reproducing it here.
        command(['node', '--input-type=module', '-e',
            'const {installOpenCodeV2}=await import('+json.dumps(installer.as_uri())+'); await installOpenCodeV2();'],
            env=environment(), timeout=420)
        request(operation)
    except Failure:
        raise
    except Exception:
        raise Failure('opencode_installation_failed') from None


def bootstrap(backend_port, operation, origin='https://api.bayleaf.dev/sandbox', report=lambda step: None):
    """Register the V2 integration and credential. No secrets in argv/output."""
    password = read('credentials/opencode-password.json')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    authorization = 'Basic ' + base64.b64encode(('opencode:'+password).encode()).decode()
    def api(path, body=None, method=None):
        # OpenChamber can open this location before discovery finishes. Connect
        # and wait here: the server default becoming ready is not workspace readiness.
        req = urllib.request.Request(f'http://127.0.0.1:{backend_port}'+path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization':authorization, 'Content-Type':'application/json',
                'X-Opencode-Directory':str(Path.home() / 'workspace')}, method=method)
        with opener.open(req, timeout=5) as response:
            data = response.read(4*1024*1024)
            return json.loads(data) if data else None
    try:
        report('waiting_for_opencode')
        for _ in range(90):
            request(operation)
            try:
                api('/api/info')
                break
            except OSError:
                time.sleep(1)
        else:
            raise Failure('provider_configuration_unavailable')
        report('connecting_bayleaf')
        key = (ROOT / 'credentials/owner-key').read_text().strip()
        entries = api('/api/credential')['data']
        matching = [entry for entry in entries if entry['integrationID'] == origin and
            entry.get('value', {}).get('type') == 'key' and entry['value']['key'] == key]
        if matching:
            if not matching[-1].get('active'):
                api('/api/credential/'+matching[-1]['id']+'/activate', {}, 'POST')
        else:
            api('/api/credential', {'integrationID':origin, 'label':'BayLeaf managed sandbox',
                'value':{'type':'key','key':key}, 'activate':True})
        api('/api/experimental/integration/wellknown', {'url':origin})
        for entry in entries:
            if entry['integrationID'] == origin and entry.get('label') == 'BayLeaf managed sandbox' and entry not in matching:
                api('/api/credential/'+entry['id'], method='DELETE')
        report('loading_tools')
        for _ in range(90):
            request(operation)
            plugins = api('/api/plugin')['data']
            if any(p['id'] == 'bayleaf.sandbox' and p.get('state', {}).get('status') == 'active' for p in plugins):
                break
            time.sleep(1)
        else:
            raise Failure('provider_configuration_unavailable')
    except Failure:
        raise
    except Exception:
        raise Failure('provider_configuration_unavailable') from None


def check_browser_port():
    # Match Node's listener semantics: closed connections in TIME_WAIT are not
    # live conflicts and must not block an immediate restart.
    # The production app must bind all IPv4 interfaces for private Daytona
    # transport. Loopback alone would miss conflicts on other interfaces.
    # This probe only binds and immediately closes; it never accepts traffic.
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(('0.0.0.0', PORT))
        except OSError:
            raise Failure('port_in_use') from None


def supervise(operation):
    with lock('runtime.lock', wait=10):
        lease = request(operation)
        check_browser_port()
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            backend_port = probe.getsockname()[1]
        argv, env = adapter('start', backend_port)
        child = subprocess.Popen(argv, env=env, cwd=Path.home() / 'workspace',
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True)
        marker = identity(child.pid, include_zombie=True)
        runtime = {'process': marker, 'release': RELEASE, 'configured': False,
            'credential_hash': lease['credential_hash'], 'operation': operation,
            **({'preview_url':lease.get('preview_url')} if SERVICE == 'nanobot' else {})}
        atomic('state/runtime.json', runtime)
        def report(step):
            runtime.setdefault('timeline', []).append({'step':step, 'at':int(time.time())})
            runtime['timeline'] = runtime['timeline'][-16:]
            atomic('state/runtime.json', runtime)
        try:
            adapter('bootstrap', backend_port, operation, report=report)
            runtime['configured'] = True
            report('checking_readiness')
            # Browser-link expiry is enforced at the gateway, not by killing
            # local applications. Daytona idle stop owns compute lifetime.
            wait_for_exit(child)
        except Exception as error:
            runtime['error'] = str(error) if isinstance(error, Failure) else 'setup_failed'
            atomic('state/runtime.json', runtime)
            raise
        finally:
            terminate(marker)
            child.wait(timeout=15)


def setup(operation):
    with lock('setup.lock'):
        req = request(operation)
        progress = Progress(operation)
        progress.update('checking')
        progress.thread.start()
        try:
            adapter('install', progress)
            request(operation)  # A slow install may outlive its setup deadline.
            progress.update('configuring')
            fingerprint = adapter('configure')
            adapter('prepare', operation, progress)
            request(operation)
            req['credential_hash'] = fingerprint
            atomic('request.json', req)
            runtime = read('state/runtime.json', {})
            if req.get('restart') or runtime.get('credential_hash') != fingerprint or runtime.get('release') != RELEASE:
                terminate(runtime.get('process'))
            progress.update('starting', step=SERVICES[SERVICE]['starting'])
            # A slow health response is not proof of process death. Retry joins
            # a living runtime; only an explicit restart or config change kills it.
            if not alive(read('state/runtime.json', {}).get('process')):
                check_browser_port()
                subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--root', str(ROOT),
                    '--service', SERVICE, 'supervise', '--operation', operation], stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            for _ in range(210):
                if health():
                    break
                runtime = read('state/runtime.json', {})
                if runtime.get('operation') == operation and runtime.get('error'):
                    raise Failure(runtime['error'])
                request(operation)
                time.sleep(1)
            else:
                raise Failure('application_not_ready')
            progress.update('ready')
        except Exception as error:
            code = str(error) if isinstance(error, Failure) else 'setup_failed'
            progress.update('failed', code)
            raise Failure(code) from None
        finally:
            progress.done.set()
            progress.thread.join(timeout=6)


def main():
    global ROOT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path)
    parser.add_argument('--service', choices=SERVICES, default='openchamber')
    parser.add_argument('action', choices=['inspect', 'setup', 'supervise', 'stop'])
    parser.add_argument('--operation', default='')
    args = parser.parse_args()
    select_service(args.service)
    ROOT = (args.root or ROOT).resolve()
    os.umask(0o077)
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(ROOT, 0o700)
    if args.action == 'inspect':
        print(json.dumps(inspect()))
    elif args.action == 'setup':
        setup(args.operation)
    elif args.action == 'supervise':
        supervise(args.operation)
    else:
        atomic('state/cancelled.json', {'operation': read('request.json', {}).get('operation')})
        atomic('request.json', {'deadline': 0})
        terminate(read('state/task.json', {}).get('process'))
        terminate(read('state/operation.json', {}).get('process'))
        terminate(read('state/runtime.json', {}).get('process'))


if __name__ == '__main__':
    try:
        main()
    except Failure as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)
