import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import browser_assets as assets


class BrowserAssetsTest(unittest.TestCase):
    def test_guarded_default_enable_disable_and_foreign_loader(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'build/static'
            source.mkdir(parents=True)
            loader = source / 'loader.js'
            loader.write_bytes(b'')
            guard = root / 'guard'
            guard.write_bytes(b'synthetic')
            fixture = root / 'browser'
            fixture.mkdir()
            (fixture / 'chat-gate.js').write_text("import('__BAYLEAF_CHAT_CLIENT__')")
            (fixture / 'chat-client.mjs').write_text('export const synthetic=true;')
            hashes = {'guard': hashlib.sha256(guard.read_bytes()).hexdigest()}
            with patch.object(assets, 'HASHES', hashes), patch.object(assets, 'HERE', root), patch.dict(os.environ, {}, clear=True):
                assets.install(root)
                self.assertEqual(loader.read_bytes(), b'')
                self.assertEqual(len(list(source.glob('*.mjs'))), 0)
                with patch.dict(os.environ, {'STATIC_DIR': ''}):
                    with self.assertRaises(ValueError):
                        assets.install(root)
                assets.install(root, 'true')
                active = loader.read_bytes()
                self.assertIn(b'/static/bayleaf-chat-', active)
                assets.install(root, 'true')
                self.assertEqual(loader.read_bytes(), active)
                assets.install(root, 'false')
                self.assertEqual(loader.read_bytes(), b'')
                self.assertEqual(len(list(source.glob('*.mjs'))), 0)
                with self.assertRaises(ValueError):
                    assets.install(root, 'TRUE')
                loader.write_text('unrelated customization')
                with self.assertRaises(ValueError):
                    assets.install(root, 'false')
                self.assertEqual(loader.read_text(), 'unrelated customization')
                loader.write_bytes(b'')
                guard.write_bytes(b'drift')
                with self.assertRaises(ValueError):
                    assets.install(root, 'true')
                self.assertEqual(loader.read_bytes(), b'')


if __name__ == '__main__':
    unittest.main()
