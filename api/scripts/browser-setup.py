#!/usr/bin/env python3
"""BayLeaf browser environment, Linux/Python 3.10+. No third-party Python deps.

The edge owns authorization and deadlines. These owner-editable breadcrumbs are
diagnostics only. Credentials arrive as files, never argv or setup output.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request

SCHEMA = 1
RELEASE = 'oc2.1.0-code2.0.22-v1'
PACKAGES = ['@openchamber/web@2.1.0', '@opencode/cli@2.0.22']
PORT = 3100
ROOT = Path.home() / '.local/share/bayleaf/browser'
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


def identity(pid):
    """PID alone is unsafe after sleep, reboot, or PID reuse."""
    try:
        stat = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        if stat[0] == 'Z':
            return None
        return {'pid': pid, 'start': stat[19],
                'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
    except (OSError, IndexError):
        return None


def alive(process):
    return isinstance(process, dict) and identity(process.get('pid', -1)) == process


def terminate(process):
    if not alive(process):
        return
    pid = process['pid']
    # Only a verified session/process-group leader created by this script.
    if os.getpgid(pid) != pid:
        raise Failure('process_identity_mismatch')
    os.killpg(pid, signal.SIGTERM)
    for _ in range(50):
        if not alive(process):
            return
        time.sleep(.1)
    if alive(process):
        os.killpg(pid, signal.SIGKILL)


def command(argv, timeout=30, env=None):
    process = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    marker = identity(process.pid)
    atomic('state/task.json', {'process': marker})
    try:
        if process.wait(timeout=timeout) != 0:
            raise Failure('command_failed')
    except subprocess.TimeoutExpired:
        terminate(marker)
        process.wait(timeout=10)
        raise Failure('command_timeout') from None
    finally:
        atomic('state/task.json', {})


class Progress:
    def __init__(self, operation):
        self.record = {'schema': SCHEMA, 'operation': operation, 'release': RELEASE,
                       'phase': 'checking', 'started_at': int(time.time()), 'process': identity(os.getpid())}
        self.mutex = threading.Lock()
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.pulse, daemon=True)

    def update(self, phase, error=None):
        assert phase in PHASES
        with self.mutex:
            self.record.update(phase=phase, updated_at=int(time.time()))
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
    if not isinstance(deadline, int) or not time.time() < deadline <= time.time() + 6*3600 + 60:
        raise Failure('work_period_expired')
    return value


def health():
    runtime = read('state/runtime.json', {})
    if runtime.get('release') != RELEASE or not alive(runtime.get('process')):
        return False
    try:
        # Ignore proxy environment variables for the loopback readiness check.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f'http://127.0.0.1:{PORT}/health', timeout=3) as response:
            data = json.loads(response.read(65536))
        return data.get('openchamberVersion') == '2.1.0' and data.get('isOpenCodeReady') is True
    except (OSError, ValueError):
        return False


def inspect():
    operation = read('state/operation.json', {})
    runtime = read('state/runtime.json', {})
    return {'schema': SCHEMA, 'operation': operation.get('operation'),
        'phase': operation.get('phase', 'unchecked'), 'error': operation.get('error'),
        'updated_at': operation.get('updated_at'), 'release': RELEASE,
        'installed': read('state/installation.json', {}).get('release') == RELEASE,
        'ready': health(), 'running': alive(runtime.get('process')), 'port': PORT}


def install(progress):
    release = ROOT / 'releases' / RELEASE
    manifest = read('state/installation.json', {})
    bins = release / 'node_modules/.bin'
    if manifest.get('release') == RELEASE and all((bins / x).is_file() for x in ['openchamber', 'opencode']):
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
    progress.update('installing')
    stage = ROOT / 'releases' / (RELEASE + '.staging')
    # Only this installer-owned staging directory is disposable.
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True, mode=0o700)
    try:
        command(['npm', 'install', '--prefix', str(stage), '--no-audit', '--no-fund', *PACKAGES], timeout=900)
        for executable in ['openchamber', 'opencode']:
            command([str(stage / 'node_modules/.bin' / executable), '--version'])
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


def restore_skills():
    """Restore only bundled files; never remove user-added skill directories."""
    bundle = read('skills.bundle.json')
    if not bundle or not isinstance(bundle.get('files'), dict):
        raise Failure('skill_bundle_missing')
    base = ROOT / 'config/opencode/skills'
    if any(p.is_symlink() for p in (ROOT / 'config', ROOT / 'config/opencode', base)):
        raise Failure('skill_bundle_invalid')
    base.mkdir(parents=True, exist_ok=True)
    for relative, content in bundle['files'].items():
        path = Path(relative)
        if path.is_absolute() or '..' in path.parts or not isinstance(content, str):
            raise Failure('skill_bundle_invalid')
        target = base / path
        # A modified bundled symlink must not redirect writes into user files.
        cursor = base
        for part in path.parts[:-1]:
            cursor = cursor / part
            if cursor.is_symlink():
                cursor.unlink()
            cursor.mkdir(exist_ok=True)
        temp = target.with_name(target.name + '.bayleaf-next')
        temp.unlink(missing_ok=True)
        temp.write_text(content)
        os.chmod(temp, 0o600)
        os.replace(temp, target)


def configure():
    restore_skills()
    incoming = ROOT / 'credentials/incoming'
    credential = ROOT / 'credentials/owner-key'
    if incoming.exists():
        os.chmod(incoming, 0o600)
        os.replace(incoming, credential)
    if not credential.exists():
        raise Failure('credential_missing')
    key = credential.read_text().strip()
    if not key.startswith('sk-bayleaf-') or key.startswith('sk-bayleaf-grant-'):
        raise Failure('credential_invalid')
    req = urllib.request.Request('https://api.bayleaf.dev/.well-known/opencode/config',
        headers={'Authorization': 'Bearer '+key, 'User-Agent': 'BayLeaf-Browser-Setup/1'})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            config = json.loads(response.read(1024*1024))['config']
    except Exception:
        raise Failure('provider_configuration_unavailable') from None
    config['update'] = 'disable'
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


def environment():
    env = dict(os.environ)
    for key, folder in [('XDG_CONFIG_HOME','config'), ('XDG_DATA_HOME','data'),
                        ('XDG_CACHE_HOME','cache'), ('XDG_STATE_HOME','state')]:
        env[key] = str(ROOT / folder)
    bins = ROOT / 'releases' / RELEASE / 'node_modules/.bin'
    env.update(OPENCHAMBER_DATA_DIR=str(ROOT / 'openchamber'),
        OPENCODE_BINARY=str(bins / 'opencode'), OPENCHAMBER_RELAY_HOST='off',
        OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN='true',
        BAYLEAF_API_KEY=(ROOT / 'credentials/owner-key').read_text().strip(),
        PATH=str(bins)+':'+env.get('PATH',''))
    return env


def clear_browser_port():
    """Port 3100 is reserved for BayLeaf; reclaim only its listening processes."""
    inodes = set()
    for family in ('tcp', 'tcp6'):
        for line in Path('/proc/net/' + family).read_text().splitlines()[1:]:
            fields = line.split()
            if fields[3] == '0A' and int(fields[1].rsplit(':', 1)[1], 16) == PORT:
                inodes.add('socket:[' + fields[9] + ']')
    victims = []
    for directory in Path('/proc').iterdir():
        if not directory.name.isdigit() or int(directory.name) in (1, os.getpid()):
            continue
        marker = identity(int(directory.name))
        try:
            if directory.stat().st_uid != os.getuid():
                continue
            for descriptor in (directory / 'fd').iterdir():
                try:
                    matches = os.readlink(descriptor) in inodes
                except OSError:
                    continue
                if matches and marker:
                    victims.append(marker)
                    break
        except (FileNotFoundError, PermissionError):
            continue
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for marker in victims:
            if alive(marker):
                try:
                    os.kill(marker['pid'], sig)
                except ProcessLookupError:
                    pass
        for _ in range(20):
            if not any(alive(marker) for marker in victims):
                return
            time.sleep(.1)


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
        restore_skills()
        check_browser_port()
        executable = ROOT / 'releases' / RELEASE / 'node_modules/.bin/openchamber'
        child = subprocess.Popen([str(executable), 'serve', '--foreground', '--host', '0.0.0.0',
            '--port', str(PORT)], env=environment(), cwd=Path.home() / 'workspace',
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True)
        marker = identity(child.pid)
        atomic('state/runtime.json', {'process': marker, 'release': RELEASE,
            'credential_hash': lease['credential_hash'], 'operation': operation})
        try:
            while child.poll() is None:
                lease = read('state/lease.json', {})
                cancelled = read('state/cancelled.json', {}).get('operation') == lease.get('operation')
                if cancelled or not isinstance(lease.get('deadline'), int) or time.time() >= lease['deadline']:
                    break
                time.sleep(2)
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
            install(progress)
            request(operation)  # A slow install may outlive its work period.
            progress.update('configuring')
            fingerprint = configure()
            request(operation)
            req['credential_hash'] = fingerprint
            atomic('request.json', req)
            runtime = read('state/runtime.json', {})
            if req.get('restart') or runtime.get('credential_hash') != fingerprint or runtime.get('release') != RELEASE:
                terminate(runtime.get('process'))
            atomic('state/lease.json', {'deadline': req['deadline'], 'operation': operation})
            progress.update('starting')
            # A slow health response is not proof of process death. Retry joins
            # a living runtime; only an explicit restart or config change kills it.
            if not alive(read('state/runtime.json', {}).get('process')):
                clear_browser_port()
                check_browser_port()
                subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--root', str(ROOT),
                    'supervise', '--operation', operation], stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            for _ in range(90):
                if health():
                    break
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
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('action', choices=['inspect', 'setup', 'supervise', 'stop'])
    parser.add_argument('--operation', default='')
    args = parser.parse_args()
    ROOT = args.root.resolve()
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
        atomic('state/lease.json', {'deadline': 0})
        terminate(read('state/task.json', {}).get('process'))
        terminate(read('state/operation.json', {}).get('process'))
        terminate(read('state/runtime.json', {}).get('process'))


if __name__ == '__main__':
    try:
        main()
    except Failure as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)
