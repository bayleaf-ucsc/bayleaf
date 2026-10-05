#!/usr/bin/env python3
"""Offline redirect-header regression tests; no sandbox or credentials required."""
import importlib.util
import http.client
from pathlib import Path
import threading
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('fixture', Path(__file__).with_name('preview-fixture.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RedirectTests(unittest.TestCase):
    def redirect(self, headers):
        handler = m.Handler.__new__(m.Handler)
        handler.path = '/redirect'
        handler.headers = headers
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.do_GET()
        handler.end_headers.assert_called_once_with()
        return handler

    def test_proxy_aware_absolute_redirect(self):
        handler = self.redirect({'Host':'upstream.invalid', 'X-Forwarded-Host':'preview.bayleaf-proxies.dev'})
        handler.send_response.assert_called_once_with(302)
        handler.send_header.assert_called_once_with('Location', 'https://preview.bayleaf-proxies.dev/target')

    def test_direct_host_fallback(self):
        handler = self.redirect({'Host':'localhost:8787'})
        handler.send_response.assert_called_once_with(302)
        handler.send_header.assert_called_once_with('Location', 'https://localhost:8787/target')

    def test_rejects_line_breaks_in_either_header(self):
        for header in ('Host', 'X-Forwarded-Host'):
            for suffix in ('\rInjected: value', '\nInjected: value', '\r\n Injected: value'):
                with self.subTest(header=header, suffix=repr(suffix)):
                    handler = self.redirect({header:'preview.invalid' + suffix})
                    handler.send_response.assert_called_once_with(400)
                    handler.send_header.assert_not_called()

    def test_rejects_missing_or_empty_host(self):
        for headers in ({}, {'Host':''}, {'Host':'valid.invalid', 'X-Forwarded-Host':''}):
            with self.subTest(headers=headers):
                handler = self.redirect(headers)
                handler.send_response.assert_called_once_with(400)
                handler.send_header.assert_not_called()

    def test_real_http_parser_rejects_folded_host_before_header_output(self):
        # Python preserves obsolete folded request headers with embedded CRLF.
        # Exercise that real input path as well as the direct handler tests.
        server = m.ThreadingHTTPServer(('127.0.0.1', 0), m.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = http.client.HTTPConnection(*server.server_address, timeout=5)
            try:
                client.request('GET', '/redirect', headers={
                    'X-Forwarded-Host':'preview.invalid\r\n Injected: value'})
                response = client.getresponse()
                self.assertEqual(response.status, 400)
                self.assertIsNone(response.getheader('Location'))
                self.assertIsNone(response.getheader('Injected'))
                response.read()
            finally:
                client.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
