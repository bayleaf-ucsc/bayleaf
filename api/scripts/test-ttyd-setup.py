#!/usr/bin/env python3
"""Managed ttyd verification, credential and readiness failure contracts."""
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('setup', Path(__file__).with_name('browser-setup.py'))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


class Ttyd(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        env = patch.dict(os.environ, HOME=temp.name, OPENAI_API_KEY='forbidden', BAYLEAF_API_KEY='forbidden')
        env.start()
        self.addCleanup(env.stop)
        s.select_service('ttyd')
        (s.ROOT/'credentials').mkdir(parents=True)
        (s.ROOT/'credentials/app-secret').write_text('a'*64)

    def test_launcher_and_auth(self):
        s.configure_ttyd()
        args, env = s.start_ttyd(None)
        self.assertIn('--writable', args)
        self.assertEqual(args[-1], '/bin/bash')
        self.assertEqual(args[args.index('--cwd')+1], str(Path.home()/'workspace'))
        self.assertNotIn('--url-arg', args)
        self.assertNotIn('--auth-header', args)
        self.assertNotIn('OPENAI_API_KEY', env)
        self.assertNotIn('BAYLEAF_API_KEY', env)
        self.assertTrue(s.health_ttyd({'token':s.ttyd_token()}))
        self.assertFalse(s.health_ttyd({'token':'wrong'}))
        self.assertFalse(s.health_ttyd({}))
        (s.ROOT/'credentials/app-secret').write_text('bad; shell input')
        with self.assertRaisesRegex(s.Failure, 'credential_invalid'): s.start_ttyd(None)

    def test_bad_download_never_executes(self):
        with patch.object(s.platform,'system',return_value='Linux'), patch.object(s.platform,'machine',return_value='x86_64'), \
             patch.object(s.urllib.request,'urlopen',return_value=io.BytesIO(b'wrong binary')), patch.object(s,'command') as command:
            with self.assertRaisesRegex(s.Failure,'release_verification_failed'): s.install_ttyd(Mock())
            command.assert_not_called()
        self.assertFalse((s.ROOT/'current').exists())

    def test_verified_install_atomic_reuse(self):
        content = b'verified fixture'
        with patch.object(s.platform,'system',return_value='Linux'), patch.object(s.platform,'machine',return_value='x86_64'), \
             patch.object(s,'TTYD_SHA256',s.hashlib.sha256(content).hexdigest()), \
             patch.object(s.urllib.request,'urlopen',return_value=io.BytesIO(content)) as download, patch.object(s,'command') as command:
            release = s.install_ttyd(Mock())
            self.assertEqual((release/'ttyd').read_bytes(), content)
            self.assertEqual(s.read('state/installation.json')['asset'],'ttyd.x86_64')
            self.assertEqual((s.ROOT/'current').resolve(),release.resolve())
            s.install_ttyd(Mock())
            self.assertEqual(download.call_count,1)
            command.assert_called_once_with([str(release.parent/(s.RELEASE+'.staging')/'unpack/ttyd'),'--version'])

    def test_readiness_requires_managed_live_identity(self):
        s.atomic('state/runtime.json',{'release':s.RELEASE,'configured':True,'process':{'pid':123}})
        with patch.object(s,'alive',return_value=False), patch.object(s.urllib.request,'build_opener') as opener:
            self.assertFalse(s.health())
            opener.assert_not_called()


if __name__ == '__main__': unittest.main()
