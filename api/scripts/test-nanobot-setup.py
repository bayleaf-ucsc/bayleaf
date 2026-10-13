#!/usr/bin/env python3
"""No-network adapter/configuration regressions."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('browser-setup.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
NODE = shutil.which('node')


class NanobotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        m.select_service('nanobot'); m.ROOT = self.root
        (self.root/'credentials').mkdir()
        (self.root/'credentials/incoming').write_text('dtn_secret_synthetic_owner')
        (self.root/'credentials/app-secret').write_text('a'*64)
        m.atomic('assets.json', {'nanobot-mcp.mjs':'synthetic adapter','bayleaf-sandboxes.md':'synthetic guide',
            '_source':{'mode':'fixture','revision':None}})
        self.discovery = patch.object(m, 'nanobot_discovery', return_value=('live/model',128000)).start()
        self.addCleanup(patch.stopall)
        patch.object(m.Path,'home',return_value=self.root/'home').start()
        patch.dict(m.os.environ, {}, clear=True).start()

    def test_defaults_credentials_and_renewal(self):
        first = m.configure_nanobot()
        config = m.read('config/config.json')
        self.assertEqual(config['agents']['defaults']['model'],'live/model')
        self.assertFalse(config['agents']['defaults']['dream']['enabled'])
        self.assertEqual(config['agents']['defaults']['idleCompactAfterMinutes'],0)
        self.assertFalse(config['gateway']['heartbeat']['enabled'])
        self.assertNotIn('sk-bayleaf-synthetic-owner', json.dumps(config))
        self.assertNotIn('a'*64, json.dumps(config))
        self.assertEqual(config['tools']['mcpServers']['bayleaf']['env'],{})
        self.assertFalse((self.root/'adapter/index.mjs').exists())
        self.assertEqual(m.read('state/nanobot-package.json')['mode'],'fixture')
        config['agents']['defaults']['dream']['enabled'] = True
        config['agents']['defaults']['idleCompactAfterMinutes'] = 23
        config['gateway']['heartbeat']['enabled'] = True
        m.atomic('config/config.json',config)
        m.atomic('request.json',{'preview_url':'https://owner-private-renewed.bayleaf-proxies.dev/'})
        second = m.configure_nanobot();self.assertNotEqual(first,second)
        self.assertEqual(second,m.configure_nanobot())
        config = m.read('config/config.json')
        self.assertTrue(config['agents']['defaults']['dream']['enabled'])
        self.assertEqual(config['agents']['defaults']['idleCompactAfterMinutes'],23)
        self.assertTrue(config['gateway']['heartbeat']['enabled'])
        self.assertEqual(config['channels']['websocket']['publicWsUrl'],'wss://owner-private-renewed.bayleaf-proxies.dev/')
        self.assertFalse(m.health_nanobot({'token':'synthetic','ws_url':'wss://old.invalid/'}))
        self.assertTrue(m.health_nanobot({'token':'synthetic','ws_url':config['channels']['websocket']['publicWsUrl']}))
        argv, env = m.start_nanobot(43210)
        self.assertNotIn('sk-bayleaf-synthetic-owner',' '.join(argv))
        self.assertEqual(env['BAYLEAF_API_KEY'],'dtn_secret_synthetic_owner')

    def test_preserves_edited_managed_files_and_user_memory(self):
        m.configure_nanobot()
        memory = self.root/'workspace/MEMORY.md';memory.write_text('human notes')
        adapter = self.root/'adapter/nanobot-mcp.mjs';adapter.write_text('owner change')
        with self.assertRaisesRegex(m.Failure,'managed_file_changed'):m.configure_nanobot()
        self.assertEqual(adapter.read_text(),'owner change');self.assertEqual(memory.read_text(),'human notes')

    def test_mcp_proxy_and_tls_environment_is_allowlisted_and_refreshed(self):
        network = {'HTTP_PROXY':'http://proxy.test:8080', 'HTTPS_PROXY':'http://proxy.test:8080',
            'NO_PROXY':'localhost,127.0.0.1,::1', 'NODE_EXTRA_CA_CERTS':'/fixture/ca.crt',
            'http_proxy':'http://proxy.test:8080', 'https_proxy':'http://proxy.test:8080',
            'no_proxy':'localhost'}
        with patch.dict(m.os.environ, {**network, 'BAYLEAF_API_KEY':'sk-bayleaf-synthetic-secret',
                'BAYLEAF_NANOBOT_AUTH':'synthetic-app-secret', 'NODE_OPTIONS':'--inspect',
                'UNRELATED_SECRET':'synthetic-secret'}):
            first = m.configure_nanobot()
            server = m.read('config/config.json')['tools']['mcpServers']['bayleaf']
            self.assertEqual(server['env'],network)
            self.assertEqual(server['args'],['--use-env-proxy',str(self.root/'adapter/nanobot-mcp.mjs')])
            self.assertNotIn('synthetic-secret',json.dumps(server))
            self.assertEqual(first,m.configure_nanobot())
        # A deliberate setup must remove stale network settings, not merge them.
        self.assertNotEqual(first,m.configure_nanobot())
        server = m.read('config/config.json')['tools']['mcpServers']['bayleaf']
        self.assertEqual(server['env'],{})
        self.assertEqual(server['args'],[str(self.root/'adapter/nanobot-mcp.mjs')])

    def test_discovery_failure_is_not_a_stale_model_fallback(self):
        self.discovery.side_effect = m.Failure('provider_configuration_unavailable')
        with self.assertRaisesRegex(m.Failure,'provider_configuration_unavailable'):m.configure_nanobot()
        self.assertFalse((self.root/'config/config.json').exists())

    @unittest.skipUnless(NODE, 'Node required for proxy transport regression')
    def test_generated_mcp_launch_routes_node_fetch_through_proxy(self):
        seen = []
        class Proxy(BaseHTTPRequestHandler):
            def log_message(self, *args):pass
            def do_GET(self):
                seen.append(self.path)
                self.send_response(200);self.end_headers();self.wfile.write(b'fixture-proxy')
        server = ThreadingHTTPServer(('127.0.0.1',0),Proxy)
        thread = threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        assets = m.read('assets.json')
        assets['nanobot-mcp.mjs'] = (
            'const r = await fetch("http://bayleaf-proxy-fixture.invalid/usage");'
            'if(await r.text() !== "fixture-proxy") process.exit(1);'
        )
        m.atomic('assets.json',assets)
        with patch.object(m.shutil,'which',return_value=NODE), patch.dict(m.os.environ, {'HTTP_PROXY':f'http://127.0.0.1:{server.server_port}',
                'NO_PROXY':'localhost,127.0.0.1', 'UNRELATED_SECRET':'must-not-inherit'}):
            m.configure_nanobot()
        cfg = m.read('config/config.json')['tools']['mcpServers']['bayleaf']
        # Model the MCP SDK's minimal environment, not the gateway's environment.
        child = subprocess.run([cfg['command'],*cfg['args']],env=cfg['env'],
            capture_output=True,text=True,timeout=15)
        self.assertEqual(child.returncode,0,child.stderr)
        self.assertEqual(seen,['http://bayleaf-proxy-fixture.invalid/usage'])

    def test_invalid_user_config_and_manifest_crash_preserve_work(self):
        m.configure_nanobot()
        config = self.root/'config/config.json';config.write_text('user unfinished JSON')
        with self.assertRaisesRegex(m.Failure,'managed_file_changed'):m.configure_nanobot()
        self.assertEqual(config.read_text(),'user unfinished JSON')
        m.atomic('state/managed-files.json', {})
        m.managed_text('adapter/nanobot-mcp.mjs','synthetic adapter')
        self.assertIn('adapter/nanobot-mcp.mjs',m.read('state/managed-files.json'))

    def test_temporary_credential_and_invalid_preview_rejected(self):
        (self.root/'credentials/incoming').write_text('sk-bayleaf-grant-synthetic')
        with self.assertRaisesRegex(m.Failure,'credential_invalid'):m.configure_nanobot()
        (self.root/'credentials/incoming').write_text('dtn_secret_synthetic_owner')
        m.atomic('request.json',{'preview_url':'https://user:secret@example.test/'})
        with self.assertRaisesRegex(m.Failure,'preview_configuration_invalid'):m.configure_nanobot()


if __name__ == '__main__':unittest.main()
