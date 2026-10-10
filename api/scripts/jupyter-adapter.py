"""Jupyter functions for embedding before browser-setup.py in its global namespace.

No top-level side effects. The shared installer supplies ROOT/RELEASE/PORT,
atomic, read, lock, command, managed_text, Failure and non_inference_environment.
"""

JUPYTER_PACKAGES = ['jupyterlab==4.6.4', 'jupyter-server==2.21.1', 'ipykernel==7.4.0']


def install_jupyter(progress):
    release = ROOT / 'releases' / RELEASE
    python = release / 'bin/python'
    with lock('install.lock'):
        if read('state/installation.json', {}).get('release') == RELEASE and python.is_file():
            return release
        if sys.version_info < (3, 11):
            raise Failure('python_311_required')
        if shutil.disk_usage(ROOT).free < 1024**3:
            raise Failure('insufficient_disk')
        progress.update('installing', step='installing_jupyter')
        stage = release.with_name(RELEASE + '.staging')
        if stage.exists():
            shutil.rmtree(stage)
        stage.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        command([sys.executable, '-m', 'venv', str(stage)], timeout=120)
        command([str(stage/'bin/python'), '-m', 'pip', 'install', '--disable-pip-version-check',
                 *JUPYTER_PACKAGES], timeout=900)
        command([str(stage/'bin/python'), '-c',
                 'from importlib.metadata import version; '
                 'assert version("jupyterlab") == "4.6.4"; '
                 'assert version("jupyter-server") == "2.21.1"; '
                 'assert version("ipykernel") == "7.4.0"'])
        if release.exists():
            release.rename(release.with_name(RELEASE + '.retired-' + str(time.time_ns())))
        stage.rename(release)
        # Avoid stale pip shebangs and kernelspec argv after moving the venv.
        command([str(python), '-m', 'ipykernel', 'install', '--sys-prefix',
                 '--name', 'python3', '--display-name', 'Python 3'])
        command([str(python), '-c',
                 'import importlib.metadata,json,pathlib; '
                 'pathlib.Path(' + repr(str(release/'packages.json')) + ').write_text('
                 'json.dumps({d.metadata["Name"]:d.version for d in importlib.metadata.distributions()},sort_keys=True))'])
        atomic('state/installation.json', {'schema':SCHEMA, 'release':RELEASE,
            'packages':JUPYTER_PACKAGES, 'resolved_packages':str(release/'packages.json')})
        return release


def configure_jupyter():
    secret_path = ROOT / 'credentials/app-secret'
    try:
        secret_path.chmod(0o600)
        secret = secret_path.read_text().strip()
    except OSError:
        raise Failure('credential_missing') from None
    if not re.fullmatch('[a-f0-9]{64}', secret):
        raise Failure('credential_invalid')
    workspace = Path.home() / 'workspace'
    workspace.mkdir(parents=True, exist_ok=True)
    # JupyterLab otherwise embeds its server token in bootstrap HTML. The native
    # page hook masks only browser disclosure, not IdentityProvider authentication.
    content = '\n'.join([
        'from pathlib import Path',
        'c = get_config()',
        'def bayleaf_page_config(handler, page_config):',
        '    return dict(page_config, token="", wsUrl="")',
        'c.ServerApp.tornado_settings = {"page_config_hook": bayleaf_page_config}',
        'c.IdentityProvider.token = Path(' + repr(str(secret_path)) + ').read_text().strip()',
        'c.IdentityProvider.cookie_options = {"secure": True, "httponly": True}',
        'c.ServerApp.root_dir = ' + repr(str(workspace)),
        'c.ServerApp.ip = "0.0.0.0"',
        'c.ServerApp.port = ' + str(PORT),
        'c.ServerApp.port_retries = 0',
        'c.ServerApp.open_browser = False',
        'c.ServerApp.default_url = "/lab"',
        # Daytona forwards a non-local Host. Native token auth remains mandatory;
        # the owner/origin gate is enforced by the private BayLeaf gateway.
        'c.ServerApp.allow_remote_access = True',
        'c.ServerApp.allow_origin = ""',
        'c.ServerApp.allow_origin_pat = ""',
        'c.ServerApp.disable_check_xsrf = False',
        'c.ServerApp.trust_xheaders = False',
        'c.ServerApp.use_redirect_file = False',
        'c.ServerApp.show_banner = False',
        'c.ServerApp.log_level = "ERROR"',
        '',
    ])
    managed_text('config/jupyter_server_config.py', content)
    return hashlib.sha256((secret + content).encode()).hexdigest()


def start_jupyter(backend_port):
    env = {name:value for name,value in non_inference_environment().items()
           if not name.startswith(('JUPYTER', 'IPYTHON'))}
    for name, directory in {'JUPYTER_CONFIG_DIR':'config', 'JUPYTER_DATA_DIR':'data',
                            'JUPYTER_RUNTIME_DIR':'runtime', 'IPYTHONDIR':'ipython',
                            'JUPYTERLAB_SETTINGS_DIR':'lab-settings',
                            'JUPYTERLAB_WORKSPACES_DIR':'lab-workspaces'}.items():
        path = ROOT / directory
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        env[name] = str(path)
    env['JUPYTER_PREFER_ENV_PATH'] = '1'
    return [str(ROOT/'releases'/RELEASE/'bin/python'), '-m', 'jupyterlab',
            '--config', str(ROOT/'config/jupyter_server_config.py')], env


def health_jupyter(data):
    return (isinstance(data, dict) and isinstance(data.get('kernels'), int)
            and isinstance(data.get('connections'), int)
            and isinstance(data.get('started'), str))
