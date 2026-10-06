#!/usr/bin/env python3
"""Installer failure-injection tests. No network, packages, or real user files."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('browser-setup.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class InstallerTests(unittest.TestCase):
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
        with self.assertRaisesRegex(m.Failure, 'work_period_expired'):
            m.request(op)
        m.atomic('request.json', {'operation': op, 'deadline': int(m.time.time())+300})
        self.assertEqual(m.request(op)['operation'], op)
        with self.assertRaisesRegex(m.Failure, 'invalid_operation'):
            m.request('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
        m.atomic('state/cancelled.json', {'operation': op})
        with self.assertRaisesRegex(m.Failure, 'operation_cancelled'):
            m.request(op)

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

    def test_reserved_port_recovery_signals_only_its_listener(self):
        listener, unrelated = Mock(), Mock()
        listener.name, unrelated.name = '123', '124'
        for process in (listener, unrelated):
            process.stat.return_value = Mock(st_uid=os.getuid())
        listener.__truediv__ = Mock(return_value=Mock(iterdir=lambda: ['listener-fd']))
        unrelated.__truediv__ = Mock(return_value=Mock(iterdir=lambda: ['other-fd']))
        table = 'header\n0: 00000000:0C1C 00000000:0000 0A 0 0 0 0 0 777\n'
        def path(name):
            return Mock(iterdir=lambda: [listener, unrelated]) if name == '/proc' else Mock(read_text=lambda: table)
        marker = {'pid':123, 'start':'100', 'boot':'same'}
        with patch.object(m, 'Path', side_effect=path), \
             patch.object(m, 'identity', side_effect=lambda pid: marker if pid == 123 else {'pid':pid}), \
             patch.object(m.os, 'readlink', side_effect=lambda fd: 'socket:[777]' if fd == 'listener-fd' else 'socket:[888]'), \
             patch.object(m, 'alive', side_effect=[True, False, False]), \
             patch.object(m.os, 'kill') as kill:
            m.clear_browser_port()
        kill.assert_called_once_with(123, m.signal.SIGTERM)

    def test_retry_waits_for_living_runtime_without_killing_it(self):
        m.atomic('state/runtime.json', {'process':{'pid':123}, 'release':m.RELEASE, 'credential_hash':'same'})
        req={'operation':'test', 'deadline':int(m.time.time())+300}
        with patch.object(m, 'request', return_value=req), patch.object(m, 'Progress'), \
             patch.object(m, 'install'), patch.object(m, 'ensure_opencode'), patch.object(m, 'configure', return_value='same'), \
             patch.object(m, 'alive', return_value=True), patch.object(m, 'health', side_effect=[False,False,True]), \
             patch.object(m.time, 'sleep'), patch.object(m, 'terminate') as stop, \
             patch.object(m, 'clear_browser_port') as reclaim, patch.object(m.subprocess, 'Popen') as spawn:
            m.setup('test')
        stop.assert_not_called();reclaim.assert_not_called();spawn.assert_not_called()

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
