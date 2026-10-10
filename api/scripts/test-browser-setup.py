#!/usr/bin/env python3
"""Installer failure-injection tests. No network, packages, or real user files."""
import importlib.util
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
    def code_server(self):
        m.select_service('code-server')
        m.ROOT = self.root
        self.addCleanup(m.select_service, 'openchamber')

    def test_code_server_configuration_and_launch_need_no_key_or_node(self):
        self.code_server()
        with patch.object(m.Path, 'home', return_value=self.root/'home'), patch.dict(m.os.environ,
                {'BAYLEAF_API_KEY':'sk-bayleaf-inherited','OPENROUTER_API_KEY':'inherited-provider-key'}):
            self.assertIsNone(m.adapter('configure'))
            argv, env = m.adapter('start', 12345)
        self.assertTrue((self.root/'home/workspace').is_dir())
        self.assertFalse((self.root/'credentials').exists())
        self.assertIn('0.0.0.0:8791', argv)
        self.assertEqual(argv[argv.index('--auth')+1], 'none')
        self.assertNotIn('--disable-workspace-trust', argv)
        self.assertNotIn('BAYLEAF_API_KEY', env)
        self.assertNotIn('OPENROUTER_API_KEY', env)
        with patch.object(m, 'ensure_opencode', side_effect=AssertionError('OpenCode requested')):
            m.adapter('prepare', 'test', self.progress)
        self.assertEqual(m.inspect()['service'], 'code-server')
        self.assertEqual(m.inspect()['port'], 8791)

    def test_code_server_health_is_not_openchamber_health(self):
        self.code_server()
        self.assertTrue(m.adapter('health', {'status':'alive'}))
        for data in ({'status':'dead'}, {'openchamberVersion':'3.0','isOpenCodeReady':True}, []):
            self.assertFalse(m.adapter('health', data))

    def test_code_server_quiet_defaults_seed_only_missing_settings(self):
        self.code_server()
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
        m.select_service('dufs');m.ROOT=self.root;self.addCleanup(m.select_service,'openchamber')
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
        with patch.object(m.Path,'home',return_value=self.root/'home'),patch.dict(m.os.environ,
                {'BAYLEAF_API_KEY':'sk-bayleaf-inherited','TINFOIL_API_KEY':'tk_inherited',
                 'DUFS_ALLOW_SYMLINK':'true','DUFS_ALLOW_ALL':'true','DUFS_SERVE_PATH':'/home'}):
            self.assertIsNone(m.adapter('configure'))
            argv,env=m.adapter('start',None)
        self.assertEqual(argv[1],str(self.root/'home/workspace'))
        for flag in ['--allow-upload','--allow-delete','--allow-search','--allow-archive','--allow-hash']:
            self.assertIn(flag,argv)
        self.assertNotIn('--allow-all',argv);self.assertNotIn('--allow-symlink',argv)
        self.assertNotIn('BAYLEAF_API_KEY',env);self.assertNotIn('TINFOIL_API_KEY',env)
        self.assertFalse(any(name.startswith('DUFS_') for name in env))
        self.assertFalse((self.root/'credentials').exists())
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

    def test_readiness_accepts_new_openchamber_versions_but_requires_ready_backend(self):
        with patch.object(m,'read',return_value={'release':m.RELEASE,'configured':True,'process':{}}), \
             patch.object(m,'alive',return_value=True):
            for ready in [True,False]:
                response=Mock();response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
                response.read.return_value=json.dumps({'openchamberVersion':'2.1.1','isOpenCodeReady':ready}).encode()
                with patch.object(m.urllib.request,'build_opener',return_value=Mock(open=Mock(return_value=response))):
                    self.assertEqual(m.health(),ready)

    def setUp(self):
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
        self.progress.update('installing',step='installing_openchamber')
        self.progress.update('configuring',step='installing_opencode')
        m.atomic('state/runtime.json',{'operation':'test','timeline':[
            {'step':'connecting_bayleaf','at':int(m.time.time())}]})
        with patch.object(m,'health',return_value=False),patch.object(m,'alive',return_value=False):
            result=m.inspect()
        self.assertEqual([e['step'] for e in result['timeline']],
            ['installing_openchamber','installing_opencode','connecting_bayleaf'])
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
             patch.object(m, 'environment', return_value={}), patch.object(m, 'bootstrap'), \
             patch.object(m, 'atomic'), patch.object(m, 'identity', return_value={'pid':123}), \
             patch.object(m, 'read', side_effect=AssertionError('runtime consulted an expiry lease')), \
             patch.object(m.subprocess, 'Popen', return_value=child), patch.object(m, 'terminate') as terminate, \
             patch.object(m, 'wait_for_exit') as wait:
            child.wait.side_effect = lambda **kw: None
            m.supervise('test')
        wait.assert_called_once_with(child)  # No link deadline; leader stays unreaped through cleanup.
        child.wait.assert_called_once_with(timeout=15)
        terminate.assert_called_once_with({'pid':123})  # Final cleanup after process exit.

    def test_failed_install_preserves_current_then_retry_is_idempotent(self):
        user = self.root/'unrelated-config.json'
        user.write_text('keep me')
        old = self.root/'releases/old'
        old.mkdir(parents=True)
        (self.root/'current').symlink_to(old)
        def npm(argv, **kwargs):
            if argv[0] == 'npm':
                self.assertIn('--global',argv)
                self.assertEqual(argv[-1],'@openchamber/web@latest')
                stage = Path(argv[argv.index('--prefix')+1])/'bin'
                stage.mkdir(parents=True)
                for name in ['openchamber']:
                    (stage/name).write_text('synthetic binary')
        with patch.object(m.shutil,'which',return_value='/bin/synthetic'), \
             patch.object(m.subprocess,'check_output',return_value='v25.9.0'), \
             patch.object(m.shutil,'disk_usage',return_value=Mock(free=10*1024**3)):
            with patch.object(m,'command',side_effect=m.Failure('command_timeout')):
                with self.assertRaisesRegex(m.Failure,'installation_failed'):
                    m.install(self.progress)
            self.assertEqual((self.root/'current').resolve(),old)
            self.assertFalse((self.root/'state/installation.json').exists())
            with patch.object(m,'command',side_effect=npm):
                release = m.install(self.progress)
            self.assertEqual((self.root/'current').resolve(),release)
            with patch.object(m,'command',side_effect=AssertionError('reinstalled')):
                self.assertEqual(m.install(self.progress),release)
        self.assertEqual(user.read_text(),'keep me')
        self.assertTrue(old.exists())

    def test_configuration_refresh_preserves_user_application_settings(self):
        (self.root/'credentials').mkdir()
        (self.root/'credentials/incoming').write_text('sk-bayleaf-synthetic')
        m.atomic('openchamber/settings.json', {'projects':[{'path':'/my/work'}], 'custom':True})
        m.atomic('config/opencode/opencode.json', {'model':'personal/test',
            'providers':{'personal':{'name':'Keep'}},
            'shell':'/bin/custom'})
        with patch.object(m.urllib.request,'urlopen',side_effect=AssertionError('snapshot downloaded')), \
             patch.object(m.Path,'home',return_value=self.root/'home'):
            m.configure()
        self.assertTrue((self.root/'home/workspace').is_dir())
        self.assertTrue(m.read('openchamber/settings.json')['custom'])
        self.assertEqual((self.root/'credentials/owner-key').stat().st_mode & 0o777,0o600)
        self.assertNotIn('sk-bayleaf', (self.root/'config/opencode/opencode.json').read_text())
        config=m.read('config/opencode/opencode.json')
        self.assertEqual(config['model'],'personal/test')
        self.assertEqual(config['providers'],{'personal':{'name':'Keep'}})
        self.assertEqual(config['shell'],'/bin/custom')
        self.assertIn('-opencode.tool.webfetch',config['plugins'])
        self.assertNotIn('update',config)

    def test_first_opencode_install_delegates_to_openchamber_and_reuses_binary(self):
        home=self.root/'home'
        with patch.object(m.Path,'home',return_value=home), patch.object(m,'request'), \
             patch.object(m,'environment',return_value={}), patch.object(m,'command') as command:
            m.ensure_opencode('test')
            argv=command.call_args.args[0]
            self.assertEqual(argv[:3],['node','--input-type=module','-e'])
            self.assertIn('openchamber/web/server/lib/opencode/v2-install.js',argv[3])
            self.assertIn('await installOpenCodeV2()',argv[3])
            binary=home/'.opencode/bin/opencode'
            binary.parent.mkdir(parents=True);binary.write_text('synthetic');binary.chmod(0o700)
            command.reset_mock();m.ensure_opencode('test');command.assert_not_called()

    def test_bootstrap_is_idempotent_and_keeps_credentials_out_of_requests_argv(self):
        m.atomic('credentials/opencode-password.json','synthetic-password')
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
            m.bootstrap(45678,'test')
        self.assertEqual([req.get_method() for req in calls],['GET','GET','POST','GET'])
        self.assertEqual(json.loads(calls[2].data),{'url':'https://api.bayleaf.dev/sandbox'})
        self.assertTrue(all('sk-bayleaf' not in req.full_url for req in calls))
        self.assertTrue(all(req.get_header('X-opencode-directory') == str(m.Path.home() / 'workspace')
            for req in calls), 'bootstrap must verify the browser project, not the server default')

    def test_managed_environment_cannot_attach_to_an_unrelated_backend(self):
        (self.root/'credentials').mkdir()
        (self.root/'credentials/owner-key').write_text('sk-bayleaf-synthetic')
        with patch.dict(m.os.environ,{'OPENCODE_HOST':'https://unrelated.example',
            'OPENCODE_SKIP_START':'true','OPENCHAMBER_SKIP_OPENCODE_START':'true',
            'OPENCODE_BINARY':'/unrelated/opencode'}):
            env=m.environment(45678)
        self.assertNotIn('OPENCODE_HOST',env)
        self.assertNotIn('OPENCODE_SKIP_START',env)
        self.assertNotIn('OPENCODE_BINARY',env)
        self.assertEqual(env['npm_config_prefix'],str(self.root/'releases'/m.RELEASE))
        self.assertEqual(env['BAYLEAF_OPENCODE_URL'],'http://127.0.0.1:45678')
        self.assertEqual(env['OPENCHAMBER_OPENCODE_HOSTNAME'],'127.0.0.1')
        self.assertEqual(env['OPENCODE_PORT'],'45678')
        self.assertEqual((self.root/'credentials/opencode-password.json').stat().st_mode & 0o777,0o600)

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
             patch.object(m,'environment',return_value={}),patch.object(m,'bootstrap'),patch.object(m,'atomic'), \
             patch.object(m,'identity',return_value={'pid':123}),patch.object(m.subprocess,'Popen',return_value=child), \
             patch.object(m,'wait_for_exit',side_effect=lambda child:calls.append('exit-without-reaping')), \
             patch.object(m,'terminate',side_effect=lambda marker:calls.append('cleanup-group')):
            m.supervise('test')
        self.assertEqual(calls,['exit-without-reaping','cleanup-group','reap'])

    def test_retry_waits_for_living_runtime_without_killing_it(self):
        m.atomic('state/runtime.json', {'process':{'pid':123}, 'release':m.RELEASE, 'credential_hash':'same'})
        req={'operation':'test', 'deadline':int(m.time.time())+300}
        with patch.object(m, 'request', return_value=req), patch.object(m, 'Progress'), \
             patch.object(m, 'install'), patch.object(m, 'ensure_opencode'), patch.object(m, 'configure', return_value='same'), \
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
