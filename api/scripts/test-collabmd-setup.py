#!/usr/bin/env python3
"""Offline adapter and stop regressions, never uses operator files or credentials."""
import importlib.util
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('browser-setup.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class CollabMDTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        m.select_service('collabmd')
        self.addCleanup(m.select_service, 'openchamber')
        m.ROOT = self.home / 'runtime'
        m.ROOT.mkdir()
        (m.ROOT / 'credentials').mkdir()
        (m.ROOT / 'credentials/app-secret').write_text('a'*64)
        self.home_patch = patch.object(m.Path, 'home', return_value=self.home)
        self.home_patch.start()
        self.addCleanup(self.home_patch.stop)

    def test_fixed_folder_preserves_files_and_rejects_symlink_root(self):
        folder = m.collabmd_directory()
        (folder / 'notes.md').write_text('# Existing\n')
        m.configure_collabmd()
        self.assertEqual((folder / 'notes.md').read_text(), '# Existing\n')
        folder.rename(folder.with_name('outside'))
        folder.symlink_to(folder.with_name('outside'))
        with self.assertRaisesRegex(m.Failure, 'sharing_directory_invalid'):
            m.configure_collabmd()

    def test_only_room_credentials_and_fixed_configuration_reach_child(self):
        with patch.dict(m.os.environ, {'BAYLEAF_API_KEY':'dtn_secret_inherited',
                'AUTH_STRATEGY':'none', 'COLLABMD_VAULTS':'/outside', 'COLLABMD_AGENT_ACCESS_ENABLED':'true'}):
            first = m.configure_collabmd()
            m.atomic('request.json', {'preview_url':'https://room.example.test/'})
            self.assertNotEqual(m.configure_collabmd(), first)
            argv, env = m.start_collabmd(12345)
        self.assertIn(str(self.home/'workspace/public-collaborative-docs'), argv)
        self.assertIn('--no-tunnel', argv)
        self.assertNotIn('a'*64, argv)
        self.assertNotIn('BAYLEAF_API_KEY', env)
        self.assertNotIn('COLLABMD_VAULTS', env)
        self.assertEqual(env['AUTH_STRATEGY'], 'password')
        self.assertEqual(env['COLLABMD_AGENT_ACCESS_ENABLED'], 'false')
        self.assertEqual(env['COLLABMD_GIT_ENABLED'], 'false')
        self.assertEqual(env['COLLABMD_PUBLIC_ORIGIN'], 'https://room.example.test')
        self.assertNotIn('plantuml.com', json.dumps(env))
        self.assertNotIn('diagrams.net', json.dumps(env))

    def test_health_requires_password_challenge(self):
        self.assertTrue(m.health_collabmd({'auth':{'strategy':'password'},'authenticated':False}))
        for data in ({}, {'auth':None}, {'auth':{'strategy':'none'},'authenticated':False},
                {'auth':{'strategy':'password'},'authenticated':True}):
            self.assertFalse(m.health_collabmd(data))

    def test_patch_fails_closed_if_upstream_changes(self):
        with self.assertRaises(m.Failure):
            m.collabmd_patch_auth('changed upstream')
        with self.assertRaises(m.Failure):
            m.collabmd_patch_auth(m.COLLABMD_ORIGIN_OLD*2)

    def test_stop_cancels_before_signalling_and_is_idempotent(self):
        operation = 'a'*8+'-'+ 'b'*4+'-'+ 'c'*4+'-'+ 'd'*4+'-'+ 'e'*12
        m.atomic('request.json', {'operation':operation,'deadline':int(time.time())+60})
        events=[]
        def terminate(process):
            events.append(process)
            self.assertEqual(m.read('state/cancelled.json')['operation'], operation)
            self.assertEqual(m.read('request.json')['deadline'], 0)
        with patch.object(m, 'terminate', side_effect=terminate):
            self.assertEqual(m.stop(operation), {'stopped':True,'operation':operation})
            self.assertEqual(m.stop(operation)['stopped'], True)
        self.assertEqual(len(events), 6)
        self.assertEqual(m.stop('new-controller-attempt')['stopped'], True)
        with patch.object(m.subprocess, 'Popen', side_effect=AssertionError('resurrected')):
            with self.assertRaisesRegex(m.Failure, 'operation_cancelled'):
                m.supervise(operation)
            with self.assertRaisesRegex(m.Failure, 'operation_cancelled'):
                m.command(['never'])

    def test_download_digest_mismatch_never_executes(self):
        import io
        with patch.object(m.urllib.request, 'urlopen', return_value=io.BytesIO(b'bad')):
            with self.assertRaisesRegex(m.Failure, 'release_verification_failed'):
                m.collabmd_download('https://example.test/archive', self.home/'download', bytes(32), 'sha256')

    def test_stop_does_not_signal_reused_pid_or_arbitrary_port_occupant(self):
        recorded = {'pid':12345,'start':'before','boot':'before'}
        m.atomic('state/runtime.json', {'process':recorded})
        with patch.object(m, 'identity', return_value={'pid':12345,'start':'after','boot':'after'}), \
                patch.object(m.os, 'killpg') as kill, patch.object(m, 'check_browser_port') as port:
            self.assertTrue(m.stop('synthetic-controller-generation')['stopped'])
        kill.assert_not_called()
        port.assert_not_called()


if __name__ == '__main__':
    unittest.main()
