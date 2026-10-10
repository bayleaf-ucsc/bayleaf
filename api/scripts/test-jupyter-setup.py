#!/usr/bin/env python3
"""Credential-free adapter contract tests, independent of shared-file integration."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('setup', HERE/'browser-setup.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
exec(compile((HERE/'jupyter-adapter.py').read_text(), 'jupyter-adapter.py', 'exec'), setup.__dict__)


class JupyterAdapter(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = patch.dict(os.environ, {'HOME':self.temp.name,
            'JUPYTER_TOKEN':'untrusted', 'JUPYTERLAB_SETTINGS_DIR':'/untrusted',
            'BAYLEAF_NANOBOT_AUTH':'untrusted-app-auth', 'BAYLEAF_API_KEY':'do-not-pass',
            'OPENAI_API_KEY':'do-not-pass'})
        self.env.start()
        self.addCleanup(self.env.stop)
        setup.ROOT = Path(self.temp.name)/'.local/share/bayleaf/jupyter'
        setup.RELEASE = 'jupyterlab-4.6.4-managed-v1'
        setup.PORT = 8793
        (setup.ROOT/'credentials').mkdir(parents=True)
        self.secret = setup.ROOT/'credentials/app-secret'
        self.secret.write_text('a'*64)

    def test_secret_required_and_not_in_generated_config(self):
        digest = setup.configure_jupyter()
        self.assertEqual(len(digest), 64)
        config = (setup.ROOT/'config/jupyter_server_config.py').read_text()
        self.assertNotIn('a'*64, config)
        self.assertIn('disable_check_xsrf = False', config)
        self.assertNotIn('allow_origin = "*"', config)
        self.assertEqual(self.secret.stat().st_mode & 0o777, 0o600)
        self.secret.write_text('')
        with self.assertRaisesRegex(setup.Failure, 'credential_invalid'):
            setup.configure_jupyter()

    def test_preserves_owner_edited_config(self):
        setup.configure_jupyter()
        path = setup.ROOT/'config/jupyter_server_config.py'
        original = path.read_text() + '\n# owner edit\n'
        path.write_text(original)
        with self.assertRaisesRegex(setup.Failure, 'managed_file_changed'):
            setup.configure_jupyter()
        self.assertEqual(path.read_text(), original)

    def test_environment_and_module_launcher(self):
        argv, env = setup.start_jupyter(None)
        self.assertNotIn('JUPYTER_TOKEN', env)
        self.assertNotIn('OPENAI_API_KEY', env)
        self.assertNotIn('BAYLEAF_NANOBOT_AUTH', env)
        self.assertNotIn('BAYLEAF_API_KEY', env)
        self.assertEqual(env['JUPYTERLAB_SETTINGS_DIR'], str(setup.ROOT/'lab-settings'))
        self.assertEqual(argv[1:3], ['-m','jupyterlab'])
        self.assertNotIn('a'*64, repr((argv,env)))

    def test_runtime_shape_not_generic_200(self):
        self.assertTrue(setup.health_jupyter({'kernels':0,'connections':0,'started':'2026-10-09T00:00:00Z'}))
        for data in ({}, {'status':'ok'}, None, {'kernels':'0','connections':0,'started':'x'}):
            self.assertFalse(setup.health_jupyter(data))


if __name__ == '__main__':
    unittest.main()
