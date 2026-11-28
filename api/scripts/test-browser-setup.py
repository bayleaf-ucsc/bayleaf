#!/usr/bin/env python3
"""Installer failure-injection tests. No network, packages, or real user files."""
import importlib.util
import contextlib
import json
import os
import io
import tarfile
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('browser-setup.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class InstallerTests(unittest.TestCase):
    def test_v2_import_egress_uses_readable_provider_ca_and_drops_only_legacy_proxy(self):
        (self.root / 'state').mkdir(exist_ok=True)
        pem = b'-----BEGIN CERTIFICATE-----\nfixture\n'
        with (patch.dict(os.environ, {'HTTPS_PROXY': 'http://172.20.0.1:18080/',
                                      'http_proxy': 'http://custom.test:8080', 'NO_PROXY': 'localhost'}, clear=True),
              patch.object(m.os, 'access', return_value=False),
              patch.object(m.subprocess, 'check_output', return_value=pem) as read_ca):
            m.prepare_v2_egress({'secret_env': 'BAYLEAF_SANDBOX_' + 'A' * 32})
            self.assertNotIn('HTTPS_PROXY', os.environ)
            self.assertEqual(os.environ['http_proxy'], 'http://custom.test:8080')
            self.assertEqual(os.environ['NO_PROXY'], 'localhost')
            for variable in ('SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'):
                path = Path(os.environ[variable])
                self.assertEqual(path.read_bytes(), pem)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual([call.args[0][-1] for call in read_ca.call_args_list],
                             ['/etc/rlp/ca-bundle.pem', '/etc/rlp/ca.pem'])

    def test_v2_secret_uses_named_env_and_replaces_only_managed_placeholder(self):
        directory = self.root / 'credentials'
        directory.mkdir()
        (directory / 'owner-key').write_text('dtn_secret_old')
        name = 'BAYLEAF_SANDBOX_' + 'A' * 32
        m.atomic('request.json', {'secret_env': name})
        with patch.dict(os.environ, {name: 'sk-bayleaf-sandbox-not-a-placeholder'}):
            with self.assertRaisesRegex(m.Failure, 'credential_missing'):
                m.accept_placeholder()
            self.assertEqual((directory / 'owner-key').read_text(), 'dtn_secret_old')
        with patch.dict(os.environ, {name: 'dtns_fixture'}):
            m.accept_placeholder()
            self.assertEqual((directory / 'owner-key').read_text(), 'dtns_fixture')
            self.assertEqual((directory / 'owner-key').stat().st_mode & 0o777, 0o600)
            self.assertEqual(m.service_environment()['BAYLEAF_API_KEY'], 'dtns_fixture')

    def test_opencode_web_has_isolated_state_and_native_auth(self):
        home = self.root / 'home'
        home.mkdir()
        secret = 'a' * 64
        (self.root / 'credentials').mkdir()
        (self.root / 'credentials/app-secret').write_text(secret)
        (self.root / 'credentials/incoming').write_text('dtn_secret_synthetic')
        origin = 'https://owner-private-' + 'a' * 24 + '.bayleaf-proxies.dev'
        m.atomic('request.json', {'preview_origin': origin})
        with patch.object(m.Path, 'home', return_value=home), \
                patch.object(m, 'RELEASE', m.SERVICES['opencode-web']['release']), \
                patch.object(m, 'PORT', 8795):
            fingerprint = m.configure_opencode_web()
            argv, env = m.start_opencode_web(None)
            self.assertEqual(argv[1:], ['serve', '--hostname', '0.0.0.0', '--port', '8795', '--cors', origin])
            self.assertNotIn(secret, ' '.join(argv))
            self.assertEqual(env['OPENCODE_PASSWORD'], secret)
            self.assertEqual(env['BAYLEAF_API_KEY'], 'dtn_secret_synthetic')
            self.assertEqual(env['XDG_DATA_HOME'], str(self.root / 'data'))
            self.assertEqual(env['BAYLEAF_OPENCODE_URL'], 'http://127.0.0.1:8795')
            self.assertTrue((home / 'workspace').is_dir())
            with patch.object(m, 'bootstrap') as bootstrap:
                m.bootstrap_opencode_web(None, 'test', None)
                bootstrap.assert_called_once_with(8795, 'test', secret, report=None)
            (self.root / 'credentials/app-secret').write_text('b' * 64)
            self.assertNotEqual(m.configure_opencode_web(), fingerprint)
            (self.root / 'credentials/app-secret').write_text(secret)
            fresh = origin.replace('a' * 24, 'b' * 24)
            m.atomic('request.json', {'preview_origin': fresh})
            self.assertNotEqual(m.configure_opencode_web(), fingerprint)
            self.assertEqual(m.start_opencode_web(None)[0][-2:], ['--cors', fresh])
            for invalid in (None, '*', origin + '/', origin + ':443', origin.replace('-private-', '-public-')):
                m.atomic('request.json', {'preview_origin': invalid})
                with self.assertRaisesRegex(m.Failure, 'preview_unavailable'):
                    m.configure_opencode_web()

    def test_opencode_web_health_requires_the_exact_preview_origin(self):
        origin = 'https://owner-private-' + 'a' * 24 + '.bayleaf-proxies.dev'
        m.atomic('request.json', {'preview_origin': origin})
        m.atomic('state/runtime.json', {'release': m.RELEASE, 'configured': True})
        opener = Mock()
        preflight, info = Mock(), Mock()
        info.read.return_value = json.dumps({'version': m.OPENCODE_WEB_VERSION}).encode()
        with patch.object(m, 'SERVICE', 'opencode-web'), patch.object(m, 'alive', return_value=True), \
                patch.object(m, 'managed_app_secret', return_value='a'*64), \
                patch.object(m.urllib.request, 'build_opener', return_value=opener):
            opener.open.side_effect = [contextlib.nullcontext(preflight)]
            preflight.headers = {'Access-Control-Allow-Origin': '*'}
            self.assertFalse(m.health())
            preflight.headers = {'Access-Control-Allow-Origin': origin}
            opener.open.side_effect = [contextlib.nullcontext(preflight), contextlib.nullcontext(info)]
            self.assertTrue(m.health())
            probe = opener.open.call_args_list[-2].args[0]
            self.assertEqual(probe.method, 'OPTIONS')
            self.assertEqual(probe.get_header('Origin'), origin)

    def test_agent_shared_mcp_config_and_owner_conflict(self):
        home = self.root/'home'
        executable = home/'.local/share/bayleaf/cli/bayleaf.mjs'
        executable.parent.mkdir(parents=True)
        executable.write_text('fixture')
        m.atomic('cli-assets.json', {'SKILL.md':'shared orientation'})
        (self.root/'credentials').mkdir()
        (self.root/'credentials/owner-key').write_text('dtn_secret_synthetic')
        with patch.object(m.Path, 'home', return_value=home), patch.object(m.shutil, 'which', return_value='/node/bin/node'), patch.dict(m.os.environ,
                {'HTTPS_PROXY':'http://proxy.test:8080','NODE_EXTRA_CA_CERTS':'/ca.pem','NODE_OPTIONS':'--inspect','UNRELATED_SECRET':'secret'}, clear=True):
            first = m.configure_agent()
            config = m.read('config/opencode/opencode.json')
            server = config['mcp']['servers']['sandbox']
            self.assertEqual(server['command'], ['/node/bin/node',str(executable),'mcp','--groups','computer,previews'])
            self.assertFalse(server['codemode'])
            self.assertEqual(server['environment'], {'HTTPS_PROXY':'http://proxy.test:8080','NODE_EXTRA_CA_CERTS':'/ca.pem'})
            self.assertEqual(first, m.configure_agent())
            self.assertEqual(m.service_environment()['BAYLEAF_SHARED_MCP'], 'true')
            self.assertNotIn('dtn_secret', json.dumps(config))
            self.assertIn({'action':'sandbox_*','resource':'*','effect':'ask'}, config['permissions'])
            self.assertNotIn({'action':'sandbox_click','resource':'*','effect':'allow'}, config['permissions'])
            config['mcp']['servers']['sandbox']['command'] = ['owner-command']
            m.atomic('config/opencode/opencode.json', config)
            with self.assertRaisesRegex(m.Failure,'managed_file_changed'):
                m.configure_agent()
            self.assertEqual(m.read('config/opencode/opencode.json'), config)

    def test_cli_path_falls_back_only_to_owned_safe_node_directory(self):
        node_bin = self.root / 'node-bin'
        node_bin.mkdir(mode=0o755)
        with patch.object(m.os, 'access', side_effect=lambda p, mode: p == node_bin), patch.object(m.shutil, 'which', return_value=str(node_bin / 'node')):
            self.assertEqual(m.platform_cli_link(), node_bin / 'bayleaf')
            node_bin.chmod(0o777)
            with self.assertRaisesRegex(m.Failure, 'cli_path_unavailable'):
                m.platform_cli_link()

    def test_shared_cli_installs_normal_path_without_changing_adapters(self):
        home = self.root / 'home'
        link = self.root / 'usr-local-bin/bayleaf'
        link.parent.mkdir()
        real_path = m.Path
        def path(value):
            return link if value == '/usr/local/bin/bayleaf' else real_path(value)
        source = '#!/usr/bin/env node\n// synthetic CLI'
        assets = {'bayleaf.mjs': source, 'sha256': hashlib.sha256(source.encode()).hexdigest(), 'SKILL.md': 'short orientation'}
        m.atomic('cli-assets.json', assets)
        with patch.object(m.Path, 'home', return_value=home), patch.object(m, 'Path', side_effect=path):
            # Mock's .home must be explicit after replacing the Path constructor.
            m.Path.home.return_value = home
            m.install_platform_cli()
            m.install_platform_cli()
            self.assertEqual(link.read_text(), source)
            self.assertEqual(link.stat().st_mode & 0o777, 0o700)
            link.write_text('owner edit')
            with self.assertRaisesRegex(m.Failure, 'managed_file_changed'):
                m.install_platform_cli()

    def test_inboxes_feature_flag_comes_only_from_server_request(self):
        with patch.dict(m.os.environ, {'BAYLEAF_INBOXES_ENABLED': 'true'}):
            self.assertEqual(m.service_environment()['BAYLEAF_INBOXES_ENABLED'], 'false')
        m.atomic('request.json', {'inboxes_enabled': True})
        self.assertEqual(m.service_environment()['BAYLEAF_INBOXES_ENABLED'], 'true')
        m.atomic('request.json', {'inboxes_enabled': 'true'})
        self.assertEqual(m.service_environment()['BAYLEAF_INBOXES_ENABLED'], 'false')

    def test_rooms_feature_flag_comes_only_from_server_request(self):
        with patch.dict(m.os.environ, {'BAYLEAF_ROOMS_ENABLED': 'true'}):
            self.assertEqual(m.service_environment()['BAYLEAF_ROOMS_ENABLED'], 'false')
        m.atomic('request.json', {'rooms_enabled': True})
        self.assertEqual(m.service_environment()['BAYLEAF_ROOMS_ENABLED'], 'true')
        m.atomic('request.json', {'rooms_enabled': 'true'})
        self.assertEqual(m.service_environment()['BAYLEAF_ROOMS_ENABLED'], 'false')

    def opencode_web_request(self, **flags):
        m.atomic('request.json', {'preview_origin': 'https://owner-private-' + 'a' * 24 + '.bayleaf-proxies.dev', **flags})

    def opencode_web_credentials(self):
        (self.root/'credentials').mkdir()
        (self.root/'credentials/owner-key').write_text('dtn_secret_synthetic')
        (self.root/'credentials/app-secret').write_text('a' * 64)

    def test_opencode_web_launch_and_fingerprint_use_server_rooms_flag(self):
        self.opencode_web_credentials()
        with patch.object(m.Path, 'home', return_value=self.root/'home'), patch.dict(m.os.environ,
                {'BAYLEAF_ROOMS_ENABLED': 'true'}):
            self.opencode_web_request(inboxes_enabled=True)
            before = m.configure_opencode_web()
            _, env = m.start_opencode_web(None)
            self.assertEqual(env['BAYLEAF_ROOMS_ENABLED'], 'false')
            self.opencode_web_request(inboxes_enabled=True, rooms_enabled=False)
            self.assertEqual(m.configure_opencode_web(), before, 'rooms off leaves earlier fingerprints unchanged')
            self.opencode_web_request(inboxes_enabled=True, rooms_enabled=True)
            after = m.configure_opencode_web()
            self.assertNotEqual(before, after)
            _, env = m.start_opencode_web(None)
            self.assertEqual(env['BAYLEAF_ROOMS_ENABLED'], 'true')

    def test_opencode_web_launch_and_fingerprint_use_server_inboxes_flag(self):
        self.opencode_web_credentials()
        with patch.object(m.Path, 'home', return_value=self.root/'home'), patch.dict(m.os.environ,
                {'BAYLEAF_INBOXES_ENABLED': 'true'}):
            self.opencode_web_request()
            before = m.configure_opencode_web()
            _, env = m.start_opencode_web(None)
            self.assertEqual(env['BAYLEAF_INBOXES_ENABLED'], 'false')
            self.opencode_web_request(inboxes_enabled=True)
            after = m.configure_opencode_web()
            self.assertNotEqual(before, after)
            _, env = m.start_opencode_web(None)
            self.assertEqual(env['BAYLEAF_INBOXES_ENABLED'], 'true')

    def test_openchamber_is_retired_and_service_selection_is_required(self):
        self.assertNotIn('openchamber', m.SERVICES)
        for argv in (['setup.py', 'inspect'], ['setup.py', '--service', 'openchamber', 'inspect']):
            with self.subTest(argv=argv), patch.object(m.sys, 'argv', argv), \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                m.main()

    def code_server(self):
        m.select_service('code-server')
        m.ROOT = self.root

    def test_code_server_receives_placeholder_but_not_inherited_keys(self):
        self.code_server()
        (self.root/'credentials').mkdir()
        (self.root/'credentials/incoming').write_text('dtn_secret_synthetic')
        with patch.object(m.Path, 'home', return_value=self.root/'home'), patch.dict(m.os.environ,
                {'BAYLEAF_API_KEY':'sk-bayleaf-inherited','OPENROUTER_API_KEY':'inherited-provider-key'}):
            self.assertIsNone(m.adapter('configure'))
            argv, env = m.adapter('start', 12345)
        self.assertTrue((self.root/'home/workspace').is_dir())
        self.assertEqual((self.root/'credentials/owner-key').read_text(), 'dtn_secret_synthetic')
        self.assertIn('0.0.0.0:8791', argv)
        self.assertEqual(argv[argv.index('--auth')+1], 'none')
        self.assertNotIn('--disable-workspace-trust', argv)
        self.assertEqual(env['BAYLEAF_API_KEY'], 'dtn_secret_synthetic')
        self.assertNotIn('OPENROUTER_API_KEY', env)
        m.adapter('prepare', 'test', self.progress)
        self.assertEqual(m.inspect()['service'], 'code-server')
        self.assertEqual(m.inspect()['port'], 8791)

    def test_code_server_health_is_not_opencode_web_health(self):
        self.code_server()
        self.assertTrue(m.adapter('health', {'status':'alive'}))
        for data in ({'status':'dead'}, {'version':m.OPENCODE_WEB_VERSION}, []):
            self.assertFalse(m.adapter('health', data))

    def test_code_server_quiet_defaults_seed_only_missing_settings(self):
        self.code_server()
        (self.root/'credentials').mkdir(exist_ok=True)
        (self.root/'credentials/incoming').write_text('dtn_secret_synthetic')
        with patch.object(m.Path, 'home', return_value=self.root/'home'):
            m.configure_code_server()
            settings = self.root/'user-data/User/settings.json'
            self.assertEqual(json.loads(settings.read_text()), {'chat.disableAIFeatures':True,
                'workbench.secondarySideBar.defaultVisibility':'hidden'})
            original = b'// Human JSONC remains byte-for-byte\n{"chat.disableAIFeatures": false, "editor.fontSize": 17,}\n'
            settings.write_bytes(original)
            m.configure_code_server()
            self.assertEqual(settings.read_bytes(), original)

    def test_fresh_editor_readiness_does_not_require_browser_activity(self):
        self.code_server()
        runtime={'release':m.RELEASE,'configured':True,'process':{}}
        response=Mock();response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
        opener=Mock(open=Mock(return_value=response))
        with patch.object(m,'read',return_value=runtime), patch.object(m,'alive',return_value=True) as alive, \
             patch.object(m.urllib.request,'build_opener',return_value=opener):
            # Exact production response before any browser has a private link.
            for payload in ({'status':'expired','lastHeartbeat':0},
                            {'status':'expired','lastHeartbeat':1},
                            {'status':'alive','lastHeartbeat':1791586531000}):
                response.read.return_value=json.dumps(payload).encode()
                self.assertTrue(m.health())
            opener.open.assert_called_with('http://127.0.0.1:8791/healthz',timeout=3)
            for payload in ({'status':'unknown'}, {}, [], {'status':'OK'}):
                response.read.return_value=json.dumps(payload).encode()
                self.assertFalse(m.health())
            response.read.return_value=b'{"status":"expired","lastHeartbeat":0}'
            for field,value in [('configured',False),('release','old-layout')]:
                original=runtime[field];runtime[field]=value;opener.open.reset_mock()
                self.assertFalse(m.health());opener.open.assert_not_called()
                runtime[field]=original
            alive.return_value=False;opener.open.reset_mock()
            self.assertFalse(m.health());opener.open.assert_not_called()
            alive.return_value=True;opener.open.side_effect=OSError('connection refused')
            self.assertFalse(m.health())

    def test_code_server_atomic_install_retry_reuses_verified_binary(self):
        self.code_server()
        old=self.root/'releases/old';old.mkdir(parents=True)
        (self.root/'current').symlink_to(old)
        def unpack(repo, product, stage):
            root=stage/'unpack';dest=root/'code-server-1.2.3-linux-amd64';(dest/'bin').mkdir(parents=True)
            binary=dest/'bin/code-server';binary.write_text('synthetic');binary.chmod(0o700)
            return root, {'tag':'v1.2.3','asset':'code-server-1.2.3-linux-amd64.tar.gz','sha256':'a'*64}
        with patch.object(m, 'verified_archive', side_effect=m.Failure('release_verification_failed')):
            with self.assertRaisesRegex(m.Failure, 'release_verification_failed'):
                m.install_code_server(self.progress)
        self.assertEqual((self.root/'current').resolve(), old)
        with patch.object(m, 'verified_archive', side_effect=unpack), patch.object(m, 'command'):
            release=m.install_code_server(self.progress)
        self.assertEqual((self.root/'current').resolve(), release)
        with patch.object(m, 'verified_archive', side_effect=AssertionError('reinstalled')):
            self.assertEqual(m.install_code_server(self.progress), release)

    def test_verified_archive_digest_and_path_confinement(self):
        for case in ('valid', 'digest', 'traversal', 'symlink', 'chain', 'forward-chain', 'download-size', 'expanded-size', 'members', 'url', 'architecture'):
            with self.subTest(case=case):
                stage=self.root/case;stage.mkdir()
                data=io.BytesIO()
                with tarfile.open(fileobj=data, mode='w:gz') as tar:
                    member=tarfile.TarInfo('../escape' if case=='traversal' else 'code-server-1.2.3-linux-amd64/bin/code-server')
                    if case=='symlink':
                        member.type=tarfile.SYMTYPE;member.linkname='/outside'
                    else:
                        member.size=2
                    tar.addfile(member, None if case=='symlink' else io.BytesIO(b'ok'))
                    if case in ('chain','forward-chain'):
                        # Both links are lexically confined in an empty tree,
                        # but the completed graph resolves b outside unpack.
                        links=[('a','.'),('b','a/../escape')]
                        for name,target in (reversed(links) if case=='forward-chain' else links):
                            link=tarfile.TarInfo(name);link.type=tarfile.SYMTYPE;link.linkname=target;tar.addfile(link)
                archive=data.getvalue()
                url='https://github.com/coder/code-server/releases/download/v1.2.3/code-server-1.2.3-linux-amd64.tar.gz'
                release={'tag_name':'v1.2.3','url':'https://api.github.com/repos/coder/code-server/releases/123',
                    'assets':[{'name':'code-server-1.2.3-linux-amd64.tar.gz','browser_download_url':url if case!='url' else 'https://wrong.example',
                        'digest':'sha256:'+('0'*64 if case=='digest' else hashlib.sha256(archive).hexdigest())}]}
                with patch.object(m.platform,'system',return_value='Linux'), \
                     patch.object(m.platform,'machine',return_value='arm64' if case=='architecture' else 'x86_64'), \
                     patch.object(m,'MAX_ARCHIVE_BYTES',1 if case=='download-size' else 512*1024*1024), \
                     patch.object(m,'MAX_UNPACKED_BYTES',1 if case=='expanded-size' else 2*1024**3), \
                     patch.object(m,'MAX_ARCHIVE_MEMBERS',0 if case=='members' else 100000), \
                     patch.object(m.urllib.request,'urlopen',side_effect=[io.BytesIO(json.dumps(release).encode()), io.BytesIO(archive)]):
                    if case=='valid':
                        dest,evidence=m.verified_archive('coder/code-server',m.code_server_asset,stage)
                        self.assertEqual((dest/'code-server-1.2.3-linux-amd64/bin/code-server').read_text(),'ok')
                        self.assertEqual(evidence['tag'],'v1.2.3')
                    else:
                        with self.assertRaises(m.Failure):
                            m.verified_archive('coder/code-server',m.code_server_asset,stage)

    def test_dufs_uses_common_verified_install_without_editor_resource_floor(self):
        m.select_service('dufs');m.ROOT=self.root
        data=io.BytesIO()
        with tarfile.open(fileobj=data,mode='w:gz') as tar:
            member=tarfile.TarInfo('dufs');member.size=2;member.mode=0o755
            tar.addfile(member,io.BytesIO(b'ok'))
        archive=data.getvalue();name='dufs-v0.46.0-x86_64-unknown-linux-musl.tar.gz'
        release={'tag_name':'v0.46.0','url':'https://api.github.com/repos/sigoden/dufs/releases/123',
            'assets':[{'name':name,'browser_download_url':'https://github.com/sigoden/dufs/releases/download/v0.46.0/'+name,
                'digest':'sha256:'+hashlib.sha256(archive).hexdigest()}]}
        with patch.object(m.platform,'system',return_value='Linux'),patch.object(m.platform,'machine',return_value='x86_64'), \
             patch.object(m.urllib.request,'urlopen',side_effect=[io.BytesIO(json.dumps(release).encode()),io.BytesIO(archive)]), \
             patch.object(m.shutil,'disk_usage',return_value=Mock(free=256*1024**2)),patch.object(m,'command') as run:
            installed=m.adapter('install',self.progress)
        self.assertEqual((installed/'dufs').read_text(),'ok')
        run.assert_called_once_with([str(self.root/'releases'/f'{m.RELEASE}.staging/unpack/dufs'),'--version'])
        with patch.object(m,'verified_archive',side_effect=AssertionError('downloaded twice')):
            self.assertEqual(m.adapter('install',self.progress),installed)
        (self.root/'credentials').mkdir(exist_ok=True)
        (self.root/'credentials/incoming').write_text('dtn_secret_synthetic')
        with patch.object(m.Path,'home',return_value=self.root/'home'),patch.dict(m.os.environ,
                {'BAYLEAF_API_KEY':'sk-bayleaf-inherited','TINFOIL_API_KEY':'tk_inherited',
                 'DUFS_ALLOW_SYMLINK':'true','DUFS_ALLOW_ALL':'true','DUFS_SERVE_PATH':'/home'}):
            self.assertIsNone(m.adapter('configure'))
            argv,env=m.adapter('start',None)
        self.assertEqual(argv[1],str(self.root/'home/workspace'))
        for flag in ['--allow-upload','--allow-delete','--allow-search','--allow-archive','--allow-hash']:
            self.assertIn(flag,argv)
        self.assertNotIn('--allow-all',argv);self.assertNotIn('--allow-symlink',argv)
        self.assertEqual(env['BAYLEAF_API_KEY'],'dtn_secret_synthetic')
        self.assertNotIn('TINFOIL_API_KEY',env)
        self.assertFalse(any(name.startswith('DUFS_') for name in env))
        self.assertTrue(m.adapter('health',{'status':'OK'}))
        self.assertFalse(m.adapter('health',{'status':'alive'}))
        self.assertEqual(m.inspect()['port'],8790)

    def test_collision_fails_without_signalling_unrelated_listener(self):
        self.code_server()
        m.atomic('state/runtime.json',{'release':m.RELEASE,'credential_hash':None})
        with patch.object(m, 'request', return_value={}), patch.object(m,'Progress'), \
             patch.object(m,'install_code_server'), patch.object(m,'configure_code_server',return_value=None), \
             patch.object(m,'alive',return_value=False), \
             patch.object(m,'check_browser_port',side_effect=m.Failure('port_in_use')), \
             patch.object(m.os,'kill') as kill, patch.object(m.os,'killpg') as killpg, \
             patch.object(m.subprocess,'Popen') as spawn:
            with self.assertRaisesRegex(m.Failure, 'port_in_use'):
                m.setup('test')
        kill.assert_not_called();killpg.assert_not_called();spawn.assert_not_called()

    def test_opencode_web_readiness_requires_the_pinned_version(self):
        self.assertTrue(m.health_opencode_web({'version':m.OPENCODE_WEB_VERSION}))
        for data in ({'version':'0.0.0'}, {'healthy':True}, {}, [], None):
            self.assertFalse(m.health_opencode_web(data))

    def setUp(self):
        # No default service exists: select one per test and restore the unset globals.
        saved = (m.SERVICE, m.RELEASE, m.PORT, m.ROOT)
        def restore():
            m.SERVICE, m.RELEASE, m.PORT, m.ROOT = saved
        self.addCleanup(restore)
        m.select_service('opencode-web')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.root_patch = patch.object(m, 'ROOT', self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.progress = m.Progress('test')

    def test_atomic_breadcrumb_permissions_and_readers(self):
        m.atomic('state/operation.json', {'phase': 'installing'})
        m.atomic('state/operation.json', {'phase': 'ready'})
        self.assertEqual(m.read('state/operation.json'), {'phase': 'ready'})
        self.assertEqual((self.root/'state/operation.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.root.glob('state/*.tmp')), [])

    def test_progress_preserves_fast_steps_and_inspect_merges_supervisor_steps(self):
        self.progress.update('installing',step='installing_opencode')
        self.progress.update('starting',step='starting_opencode_web')
        m.atomic('state/runtime.json',{'operation':'test','timeline':[
            {'step':'connecting_bayleaf','at':int(m.time.time())}]})
        with patch.object(m,'health',return_value=False),patch.object(m,'alive',return_value=False):
            result=m.inspect()
        self.assertEqual([e['step'] for e in result['timeline']],
            ['installing_opencode','starting_opencode_web','connecting_bayleaf'])
        self.assertEqual(result['progress'],'connecting_bayleaf')
        self.assertIn('started_at',result)
        m.atomic('state/runtime.json',{'operation':'old','timeline':[
            {'step':'loading_tools','at':int(m.time.time())}]})
        with patch.object(m,'health',return_value=False),patch.object(m,'alive',return_value=False):
            self.assertNotIn('loading_tools',[e['step'] for e in m.inspect()['timeline']])

    def test_exclusive_setup_lock(self):
        with m.lock('setup.lock'):
            with self.assertRaisesRegex(m.Failure, 'operation_in_progress'):
                with m.lock('setup.lock'):
                    self.fail('concurrent installer entered')
        with m.lock('setup.lock'):
            pass

    def test_expired_cancelled_and_wrong_operation_cannot_start(self):
        op = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        m.atomic('request.json', {'operation': op, 'deadline': int(m.time.time())-1})
        with self.assertRaisesRegex(m.Failure, 'setup_timeout'):
            m.request(op)
        m.atomic('request.json', {'operation': op, 'deadline': int(m.time.time())+300})
        self.assertEqual(m.request(op)['operation'], op)
        with self.assertRaisesRegex(m.Failure, 'invalid_operation'):
            m.request('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
        m.atomic('state/cancelled.json', {'operation': op})
        with self.assertRaisesRegex(m.Failure, 'operation_cancelled'):
            m.request(op)

    def test_supervisor_does_not_read_a_link_lease_or_kill_on_expiry(self):
        child = Mock()
        req = {'credential_hash': 'synthetic', 'deadline': int(m.time.time()) + 300}
        with patch.object(m, 'request', return_value=req), patch.object(m, 'check_browser_port'), \
             patch.object(m, 'start_opencode_web', return_value=(['opencode'], {})), patch.object(m, 'bootstrap_opencode_web'), \
             patch.object(m, 'atomic'), patch.object(m, 'identity', return_value={'pid':123}), \
             patch.object(m, 'read', side_effect=AssertionError('runtime consulted an expiry lease')), \
             patch.object(m.subprocess, 'Popen', return_value=child), patch.object(m, 'terminate') as terminate, \
             patch.object(m, 'wait_for_exit') as wait:
            child.wait.side_effect = lambda **kw: None
            m.supervise('test')
        wait.assert_called_once_with(child)  # No link deadline; leader stays unreaped through cleanup.
        child.wait.assert_called_once_with(timeout=15)
        terminate.assert_called_once_with({'pid':123})  # Final cleanup after process exit.

    def test_configuration_refresh_preserves_user_agent_settings(self):
        (self.root/'credentials').mkdir()
        (self.root/'credentials/incoming').write_text('dtn_secret_synthetic')
        m.atomic('config/opencode/opencode.json', {'model':'personal/test',
            'providers':{'personal':{'name':'Keep'}},
            'shell':'/bin/custom'})
        with patch.object(m.urllib.request,'urlopen',side_effect=AssertionError('snapshot downloaded')), \
             patch.object(m.Path,'home',return_value=self.root/'home'):
            m.configure_agent()
        self.assertTrue((self.root/'home/workspace').is_dir())
        self.assertEqual((self.root/'credentials/owner-key').stat().st_mode & 0o777,0o600)
        self.assertNotIn('sk-bayleaf', (self.root/'config/opencode/opencode.json').read_text())
        config=m.read('config/opencode/opencode.json')
        self.assertEqual(config['model'],'personal/test')
        self.assertEqual(config['providers'],{'personal':{'name':'Keep'}})
        self.assertEqual(config['shell'],'/bin/custom')
        self.assertIn('-opencode.tool.webfetch',config['plugins'])
        self.assertNotIn('update',config)

    def test_bootstrap_is_idempotent_and_keeps_credentials_out_of_requests_argv(self):
        (self.root/'credentials').mkdir()
        (self.root/'credentials/owner-key').write_text('sk-bayleaf-synthetic')
        calls=[]
        def response(req, **kwargs):
            calls.append(req)
            result={'data':[{'id':'managed','integrationID':'https://api.bayleaf.dev/sandbox',
                'active':True,'value':{'type':'key','key':'sk-bayleaf-synthetic'}}]} if req.full_url.endswith('/api/credential') else {}
            if req.full_url.endswith('/api/plugin'):
                result={'data':[{'id':'bayleaf.sandbox','state':{'status':'active'}}]}
            handle=Mock();handle.__enter__=Mock(return_value=handle);handle.__exit__=Mock(return_value=False)
            handle.read.return_value=json.dumps(result).encode();return handle
        with patch.object(m,'request'), patch.object(m.urllib.request,'build_opener',return_value=Mock(open=response)):
            m.bootstrap(45678,'test','synthetic-password')
        self.assertEqual([req.get_method() for req in calls],['GET','GET','POST','GET'])
        self.assertEqual(json.loads(calls[2].data),{'url':'https://api.bayleaf.dev/sandbox'})
        self.assertTrue(all('sk-bayleaf' not in req.full_url for req in calls))
        self.assertTrue(all(req.get_header('Authorization') == m.opencode_basic('synthetic-password') for req in calls))
        self.assertTrue(all(req.get_header('X-opencode-directory') == str(m.Path.home() / 'workspace')
            for req in calls), 'bootstrap must verify the browser project, not the server default')

    def test_managed_environment_cannot_attach_to_an_unrelated_backend(self):
        (self.root/'credentials').mkdir()
        (self.root/'credentials/owner-key').write_text('dtn_secret_synthetic')
        with patch.dict(m.os.environ,{'OPENCODE_HOST':'https://unrelated.example',
            'OPENCODE_SKIP_START':'true','OPENCHAMBER_SKIP_OPENCODE_START':'true',
            'OPENCODE_BINARY':'/unrelated/opencode'}):
            env=m.agent_environment()
        for name in ('OPENCODE_HOST','OPENCODE_SKIP_START','OPENCHAMBER_SKIP_OPENCODE_START','OPENCODE_BINARY'):
            self.assertNotIn(name,env)
        self.assertEqual(env['XDG_CONFIG_HOME'],str(self.root/'config'))
        self.assertEqual(env['BAYLEAF_API_KEY'],'dtn_secret_synthetic')

    def test_pid_reuse_never_signals_an_unrelated_process(self):
        original = {'pid':123,'start':'100','boot':'old'}
        with patch.object(m,'identity',return_value={'pid':123,'start':'200','boot':'new'}), \
             patch.object(m.os,'killpg') as kill:
            m.terminate(original)
            kill.assert_not_called()

    def test_exited_leader_anchors_cleanup_of_live_group_descendant(self):
        marker={'pid':123,'start':'100','boot':'same'}
        calls=[]
        with patch.object(m,'identity',return_value=marker), patch.object(m.os,'getpgid',return_value=123), \
             patch.object(m,'group_running',side_effect=[True,False]), patch.object(m.time,'sleep'), \
             patch.object(m.os,'killpg',side_effect=lambda pid,sig:calls.append((pid,sig))):
            m.terminate(marker)
        self.assertEqual(calls,[(123,m.signal.SIGTERM)])

    def test_supervisor_reaps_only_after_group_cleanup(self):
        calls=[]
        child=Mock();child.wait.side_effect=lambda **kw:calls.append('reap')
        with patch.object(m,'request',return_value={'credential_hash':'test'}),patch.object(m,'check_browser_port'), \
             patch.object(m,'start_opencode_web',return_value=(['opencode'],{})),patch.object(m,'bootstrap_opencode_web'),patch.object(m,'atomic'), \
             patch.object(m,'identity',return_value={'pid':123}),patch.object(m.subprocess,'Popen',return_value=child), \
             patch.object(m,'wait_for_exit',side_effect=lambda child:calls.append('exit-without-reaping')), \
             patch.object(m,'terminate',side_effect=lambda marker:calls.append('cleanup-group')):
            m.supervise('test')
        self.assertEqual(calls,['exit-without-reaping','cleanup-group','reap'])

    def test_retry_waits_for_living_runtime_without_killing_it(self):
        m.atomic('state/runtime.json', {'process':{'pid':123}, 'release':m.RELEASE, 'credential_hash':'same'})
        req={'operation':'test', 'deadline':int(m.time.time())+300}
        with patch.object(m, 'request', return_value=req), patch.object(m, 'Progress'), \
             patch.object(m, 'install_opencode_web'), patch.object(m, 'configure_opencode_web', return_value='same'), \
             patch.object(m, 'alive', return_value=True), patch.object(m, 'health', side_effect=[False,False,True]), \
             patch.object(m.time, 'sleep'), patch.object(m, 'terminate') as stop, \
             patch.object(m, 'check_browser_port') as check, patch.object(m.subprocess, 'Popen') as spawn:
            m.setup('test')
        stop.assert_not_called();check.assert_not_called();spawn.assert_not_called()

    def test_restart_probe_accepts_time_wait_but_rejects_live_listener(self):
        with m.socket.socket() as server:
            server.setsockopt(m.socket.SOL_SOCKET,m.socket.SO_REUSEADDR,1)
            server.bind(('0.0.0.0',0));server.listen()
            port=server.getsockname()[1]
            with patch.object(m,'PORT',port):
                with self.assertRaisesRegex(m.Failure,'port_in_use'):
                    m.check_browser_port()
            with m.socket.create_connection(('127.0.0.1',port)) as client:
                accepted,_=server.accept();accepted.close();client.recv(1)
        with patch.object(m,'PORT',port):
            m.check_browser_port()

    def test_port_probe_never_listens(self):
        with patch.object(m.socket, 'socket') as socket:
            probe = socket.return_value.__enter__.return_value
            m.check_browser_port()
        probe.bind.assert_called_once_with(('0.0.0.0', m.PORT))
        probe.listen.assert_not_called()
        probe.accept.assert_not_called()

    def test_breadcrumb_ready_does_not_prove_live_application(self):
        m.atomic('state/operation.json',{'phase':'ready','operation':'old'})
        m.atomic('state/runtime.json',{'release':m.RELEASE,'process':{'pid':123,'start':'100','boot':'old'}})
        with patch.object(m,'identity',return_value=None), patch.object(m.urllib.request,'build_opener') as network:
            self.assertFalse(m.inspect()['ready'])
            network.assert_not_called()


if __name__ == '__main__':
    unittest.main()
