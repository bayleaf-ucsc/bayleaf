"""Fixed-folder CollabMD adapter, executed in browser-setup.py's namespace.

No inference path or owner key. Room credentials remain outside the served vault.
Pinned Node is service-local: other managed apps keep their existing runtime.
"""

COLLABMD_VERSION = '0.1.55'
COLLABMD_INTEGRITY = 'd/ew53e/IyLi7MNLv47Bu7jluUu7ytj/SJ5+x1+4h89hc7qd9mg0JFf2+GPrskG0cokBAWFIIyez9zwJtnRYDA=='
COLLABMD_NODE_SHA256 = 'd9f88af72ad34f7ddf8e67289829f1698f54b6254f7d4f54b7453117ff1a3d2c'
COLLABMD_ORIGIN_OLD = 'const expectedOrigin = authConfig.oidc?.publicBaseUrl'


def collabmd_patch_auth(source):
    if source.count(COLLABMD_ORIGIN_OLD) != 1:
        raise Failure('release_verification_failed')
    return source.replace(COLLABMD_ORIGIN_OLD,
        'const publicOrigin = process.env.COLLABMD_PUBLIC_ORIGIN || authConfig.oidc?.publicBaseUrl;\n'
        '          const expectedOrigin = publicOrigin').replace(
        'new URL(authConfig.oidc.publicBaseUrl).origin', 'new URL(publicOrigin).origin')


def collabmd_patch_http(source):
    old = 'return originUrl.host === requestUrl.host;'
    if source.count(old) != 1:
        raise Failure('release_verification_failed')
    return source.replace(old, 'return process.env.COLLABMD_PUBLIC_ORIGIN\n'
        '      ? originUrl.origin === new URL(process.env.COLLABMD_PUBLIC_ORIGIN).origin\n'
        '      : originUrl.host === requestUrl.host;')


def collabmd_directory():
    workspace = Path.home() / 'workspace'
    folder = workspace / 'public-collaborative-docs'
    # The fixed sharing boundary cannot itself redirect to another directory.
    if workspace.is_symlink() or folder.is_symlink():
        raise Failure('sharing_directory_invalid')
    folder.mkdir(parents=True, exist_ok=True)
    if not folder.is_dir():
        raise Failure('sharing_directory_invalid')
    return folder


def collabmd_download(url, target, digest, algorithm):
    actual = hashlib.new(algorithm)
    size, end = 0, time.monotonic() + 180
    with urllib.request.urlopen(url, timeout=30) as source, target.open('xb') as output:
        while chunk := source.read(1024*1024):
            size += len(chunk)
            if size > 128*1024**2 or time.monotonic() > end:
                raise Failure('release_verification_failed')
            actual.update(chunk)
            output.write(chunk)
    if actual.digest() != digest:
        raise Failure('release_verification_failed')


def install_collabmd(progress):
    release = ROOT / 'releases' / RELEASE
    if (release / 'complete').exists():
        return release
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'amd64'):
        raise Failure('unsupported_architecture')
    if shutil.disk_usage(ROOT).free < 1024**3:
        raise Failure('insufficient_disk')
    progress.update('installing', step='installing_collabmd')
    stage = ROOT / 'releases' / (RELEASE + '.staging')
    if stage.exists():
        shutil.rmtree(stage)  # Only this adapter's disposable staging directory.
    stage.mkdir(parents=True, mode=0o700)
    try:
        archive = stage / 'node.tar.gz'
        collabmd_download('https://nodejs.org/dist/v26.12.0/node-v26.12.0-linux-x64.tar.gz',
            archive, bytes.fromhex(COLLABMD_NODE_SHA256), 'sha256')
        extract_checked_archive(archive, stage / 'unpack')
        node = stage / 'unpack/node-v26.12.0-linux-x64'
        node.rename(stage / 'node')
        package = stage / 'collabmd.tgz'
        collabmd_download(f'https://registry.npmjs.org/collabmd/-/collabmd-{COLLABMD_VERSION}.tgz',
            package, base64.b64decode(COLLABMD_INTEGRITY), 'sha512')
        env = {'PATH': str(stage / 'node/bin') + ':' + os.defpath,
            'HOME': str(Path.home()), 'npm_config_cache': str(ROOT / 'npm-cache')}
        command([str(stage / 'node/bin/node'), str(stage / 'node/lib/node_modules/npm/bin/npm-cli.js'),
            'install', '--prefix', str(stage / 'app'), '--omit=dev', '--ignore-scripts',
            '--no-audit', '--no-fund', str(package)], timeout=600, env=env)
        auth = stage / 'app/node_modules/collabmd/src/server/auth/create-auth-service.js'
        # Narrow compatibility patch: explicit operator-configured origin in
        # password mode, not trust in caller-supplied forwarded host headers.
        # Parenthesize the RHS so the conditional below uses the selected URL.
        auth.write_text(collabmd_patch_auth(auth.read_text()))
        http = stage / 'app/node_modules/collabmd/src/server/infrastructure/http/http-response.js'
        http.write_text(collabmd_patch_http(http.read_text()))
        (stage / 'complete').write_text(COLLABMD_VERSION)
        archive.unlink()
        package.unlink()
        if release.exists():
            release.rename(release.with_name(RELEASE + '.retired-' + str(time.time_ns())))
        stage.rename(release)
    except Failure:
        raise
    except Exception:
        raise Failure('installation_failed') from None
    return release


def configure_collabmd():
    collabmd_directory()
    secret = (ROOT / 'credentials/app-secret').read_text().strip()
    if not re.fullmatch(r'[a-f0-9]{64}', secret):
        raise Failure('credential_invalid')
    preview = read('request.json', {}).get('preview_url', 'https://pending.invalid/')
    if not re.fullmatch(r'https://[a-z0-9.-]+/', preview):
        raise Failure('preview_configuration_invalid')
    return hashlib.sha256((secret + preview).encode()).hexdigest()


def start_collabmd(backend_port):
    folder = collabmd_directory()
    release = ROOT / 'releases' / RELEASE
    secret = (ROOT / 'credentials/app-secret').read_text().strip()
    preview = read('request.json', {}).get('preview_url', 'https://pending.invalid/')
    # Allowlist instead of inheriting optional auth, vault discovery, agent,
    # hosted-mode, Git, tunnel or external-renderer environment configuration.
    env = {'HOME': str(Path.home()), 'PATH': str(release / 'node/bin') + ':' + os.defpath,
        'NODE_ENV': 'production', 'AUTH_STRATEGY': 'password', 'AUTH_PASSWORD': secret,
        'AUTH_SESSION_SECRET': hashlib.sha256(('collabmd-cookie:' + secret).encode()).hexdigest(),
        'COLLABMD_PUBLIC_ORIGIN': preview.removesuffix('/'), 'COLLABMD_GIT_ENABLED': 'false',
        'COLLABMD_HOSTED_ENABLED': 'false', 'COLLABMD_AGENT_ACCESS_ENABLED': 'false',
        'PLANTUML_SERVER_URL': 'http://127.0.0.1:9/disabled',
        'STRUCTURIZR_SERVER_URL': 'http://127.0.0.1:9/disabled',
        'COLLABMD_DRAWIO_BASE_URL': preview + '__disabled_diagrams__/',
        'COLLABMD_MAX_INITIAL_SYNC_BYTES': str(2*1024**2)}
    return [str(release / 'node/bin/node'), str(release / 'app/node_modules/collabmd/bin/collabmd.js'),
        str(folder), '--host', '0.0.0.0', '--port', str(PORT), '--auth', 'password', '--no-tunnel'], env


def health_collabmd(data):
    return isinstance(data, dict) and isinstance(data.get('auth'), dict) \
        and data['auth'].get('strategy') == 'password' and data.get('authenticated') is False
