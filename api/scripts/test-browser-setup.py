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
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.root_patch = patch.object(m, 'ROOT', self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.progress = m.Progress('test')
        m.atomic('skills.bundle.json', {'version':'test', 'files':{}})

    def test_bundled_skills_regrow_without_removing_personal_skills(self):
        m.atomic('skills.bundle.json', {'files':{'example/SKILL.md':'canonical skill'}})
        m.restore_skills()
        installed=self.root/'config/opencode/skills/example/SKILL.md'
        installed.unlink();m.restore_skills();self.assertEqual(installed.read_text(),'canonical skill')
        installed.write_text('modified');m.restore_skills();self.assertEqual(installed.read_text(),'canonical skill')
        personal=installed.parent.parent/'personal';personal.mkdir();(personal/'SKILL.md').write_text('keep')
        m.restore_skills();self.assertEqual((personal/'SKILL.md').read_text(),'keep')

    def test_atomic_breadcrumb_permissions_and_readers(self):
        m.atomic('state/operation.json', {'phase': 'installing'})
        m.atomic('state/operation.json', {'phase': 'ready'})
        self.assertEqual(m.read('state/operation.json'), {'phase': 'ready'})
        self.assertEqual((self.root/'state/operation.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.root.glob('state/*.tmp')), [])

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
                stage = Path(argv[argv.index('--prefix')+1])/'node_modules/.bin'
                stage.mkdir(parents=True)
                for name in ['openchamber','opencode']:
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
        remote = Mock()
        remote.__enter__ = Mock(return_value=remote)
        remote.__exit__ = Mock(return_value=False)
        remote.read.return_value = json.dumps({'config':{'model':'bayleaf-remote/test'}}).encode()
        with patch.object(m.urllib.request,'urlopen',return_value=remote), \
             patch.object(m.Path,'home',return_value=self.root/'home'):
            m.configure()
        self.assertTrue((self.root/'home/workspace').is_dir())
        self.assertTrue(m.read('openchamber/settings.json')['custom'])
        self.assertEqual((self.root/'credentials/owner-key').stat().st_mode & 0o777,0o600)
        self.assertNotIn('sk-bayleaf', (self.root/'config/opencode/opencode.json').read_text())
        self.assertEqual(m.read('config/opencode/opencode.json')['model'],'bayleaf-remote/test')

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
             patch.object(m, 'install'), patch.object(m, 'configure', return_value='same'), \
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

    def test_breadcrumb_ready_does_not_prove_live_application(self):
        m.atomic('state/operation.json',{'phase':'ready','operation':'old'})
        m.atomic('state/runtime.json',{'release':m.RELEASE,'process':{'pid':123,'start':'100','boot':'old'}})
        with patch.object(m,'identity',return_value=None), patch.object(m.urllib.request,'build_opener') as network:
            self.assertFalse(m.inspect()['ready'])
            network.assert_not_called()


if __name__ == '__main__':
    unittest.main()
