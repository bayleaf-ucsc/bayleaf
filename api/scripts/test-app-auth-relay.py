#!/usr/bin/env python3
"""Daytona v2 app-credential relay: rewrite contract and real-socket behaviour.

The fixture app enforces Basic auth itself, so every pass proves the relay
restored a credential the app verified, never that the relay granted access.
"""
import base64
import socket
import threading
import unittest
from pathlib import Path

relay = {}
exec(compile(Path(__file__).with_name('app-auth-relay.py').read_text(), 'app-auth-relay.py', 'exec'), relay)
GOOD = b'Basic ' + base64.b64encode(b'bayleaf:' + b'a' * 64)


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class App:
    """Minimal HTTP/1.1 + upgrade app with native Basic auth. Records heads."""
    def __init__(self):
        self.heads = []
        self.listener = socket.socket()
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.listener.bind(('127.0.0.1', 0))
        self.listener.listen(16)
        self.port = self.listener.getsockname()[1]
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        while True:
            try:
                conn, _ = self.listener.accept()
            except OSError:
                return
            threading.Thread(target=self.handle, args=(conn,), daemon=True).start()

    def handle(self, conn):
        with conn:
            data = b''
            while b'\r\n\r\n' not in data:
                chunk = conn.recv(65536)
                if not chunk:
                    return
                data += chunk
            head, _, rest = data.partition(b'\r\n\r\n')
            self.heads.append(head)
            headers = {}
            for line in head.split(b'\r\n')[1:]:
                name, _, value = line.partition(b':')
                headers.setdefault(name.strip().lower(), []).append(value.strip())
            if headers.get(b'authorization') != [GOOD]:
                conn.sendall(b'HTTP/1.1 401 Unauthorized\r\nContent-Length: 3\r\n\r\napp')
                return
            if headers.get(b'upgrade') == [b'websocket']:
                conn.sendall(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
                buffered = rest
                while True:  # Echo frames until the client half-closes.
                    if buffered:
                        conn.sendall(buffered)
                    buffered = conn.recv(65536)
                    if not buffered:
                        return
            length = int((headers.get(b'content-length') or [b'0'])[0])
            while len(rest) < length:
                rest += conn.recv(65536)
            body = b'ok:' + rest[:length]
            conn.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n' % len(body) + body)


def exchange(port, raw, half_close=True):
    with socket.create_connection(('127.0.0.1', port), timeout=5) as s:
        s.sendall(raw)
        if half_close:
            s.shutdown(socket.SHUT_WR)
        out = b''
        while True:
            chunk = s.recv(65536)
            if not chunk:
                return out
            out += chunk


class Rewrite(unittest.TestCase):
    rewrite = staticmethod(relay['app_auth_rewrite'])

    def test_relayed_header_replaces_authorization_and_is_removed(self):
        out = self.rewrite(b'GET / HTTP/1.1\r\nHost: localhost:8784\r\nAuthorization: Basic forged\r\n'
                           b'X-BayLeaf-App-Authorization: ' + GOOD + b'\r\nConnection: keep-alive\r\nKeep-Alive: 5')
        lower = out.lower()
        self.assertNotIn(b'x-bayleaf-app-authorization', lower)
        self.assertNotIn(b'forged', out)
        self.assertEqual(lower.count(b'authorization:'), 1)
        self.assertIn(b'Authorization: ' + GOOD, out)
        self.assertIn(b'\r\nConnection: close\r\n\r\n', out)
        self.assertNotIn(b'keep-alive', lower)

    def test_absent_header_passes_through_without_credential(self):
        out = self.rewrite(b'GET /token HTTP/1.1\r\nHost: x')
        self.assertNotIn(b'authorization', out.lower())
        self.assertTrue(out.endswith(b'Connection: close\r\n\r\n'))

    def test_websocket_keeps_upgrade(self):
        out = self.rewrite(b'GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                           b'x-bayleaf-app-authorization: token ' + b'b' * 64)
        self.assertIn(b'Authorization: token ' + b'b' * 64, out)
        self.assertIn(b'Connection: Upgrade', out)
        self.assertNotIn(b'close', out)

    def test_non_websocket_upgrade_is_dropped(self):
        out = self.rewrite(b'GET / HTTP/1.1\r\nUpgrade: h2c\r\nConnection: Upgrade, HTTP2-Settings')
        self.assertNotIn(b'upgrade', out.lower().replace(b'get', b''))
        self.assertIn(b'Connection: close', out)

    def test_ambiguous_heads_rejected(self):
        for head in [
            b'GET / HTTP/1.1\r\nX-BayLeaf-App-Authorization: a\r\nX-BayLeaf-App-Authorization: b',
            b'GET / HTTP/1.1\r\nX-BayLeaf-App-Authorization:',
            b'GET / HTTP/1.1\r\nX-BayLeaf-App-Authorization : ' + GOOD,
            b'GET / HTTP/1.1\r\nHost: x\r\n folded',
            b'GET / HTTP/1.1\r\nNoColon',
            b'GET / HTTP/1.1\r\nBad\nName: x',
            b'GET /a\nb HTTP/1.1\r\nHost: x',
            b'GET / HTTP/2.0\r\nHost: x',
            b'G\x00T / HTTP/1.1',
            b'GET  / HTTP/1.1',
            b'GET / HTTP/1.1' + b'\r\nA: b' * 200,
        ]:
            with self.subTest(head=head[:60]):
                self.assertIsNone(self.rewrite(head))


class Sockets(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = App()
        cls.port = free_port()
        cls.listener = relay['serve_app_auth_relay'](cls.port, cls.app.port, host='127.0.0.1')

    @classmethod
    def tearDownClass(cls):
        cls.listener.close()
        cls.app.listener.close()

    def test_app_verifies_relayed_credential(self):
        ok = exchange(self.port, b'POST /x HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\n'
                      b'X-BayLeaf-App-Authorization: ' + GOOD + b'\r\n\r\nhello')
        self.assertTrue(ok.startswith(b'HTTP/1.1 200'))
        self.assertTrue(ok.endswith(b'ok:hello'))
        self.assertNotIn(b'x-bayleaf-app-authorization', self.app.heads[-1].lower())

    def test_missing_or_wrong_credential_rejected_by_app(self):
        for extra in [b'', b'X-BayLeaf-App-Authorization: Basic d3Jvbmc6d3Jvbmc=\r\n',
                      b'Authorization: Basic d3Jvbmc6d3Jvbmc=\r\n']:
            with self.subTest(extra=extra):
                out = exchange(self.port, b'GET / HTTP/1.1\r\nHost: x\r\n' + extra + b'\r\n')
                self.assertTrue(out.startswith(b'HTTP/1.1 401'))
                self.assertTrue(out.endswith(b'app'))  # The app's own rejection.

    def test_keepalive_second_request_never_reaches_app_unrewritten(self):
        before = len(self.app.heads)
        out = exchange(self.port, b'GET /1 HTTP/1.1\r\nHost: x\r\nX-BayLeaf-App-Authorization: ' + GOOD +
                       b'\r\n\r\nGET /2 HTTP/1.1\r\nHost: x\r\nAuthorization: ' + GOOD + b'\r\n\r\n')
        self.assertEqual(out.count(b'HTTP/1.1 '), 1)
        self.assertEqual(len(self.app.heads), before + 1)
        self.assertIn(b'Connection: close', self.app.heads[-1])

    def test_websocket_relays_frames_both_ways(self):
        with socket.create_connection(('127.0.0.1', self.port), timeout=5) as s:
            s.sendall(b'GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                      b'X-BayLeaf-App-Authorization: ' + GOOD + b'\r\n\r\n')
            head = b''
            while b'\r\n\r\n' not in head:
                head += s.recv(65536)
            self.assertTrue(head.startswith(b'HTTP/1.1 101'))
            for frame in [b'\x82\x03abc', b'\x81\x02hi' * 1000]:
                s.sendall(frame)
                echoed = b''
                while len(echoed) < len(frame):
                    echoed += s.recv(65536)
                self.assertEqual(echoed, frame)

    def test_websocket_without_credential_rejected_by_app(self):
        out = exchange(self.port, b'GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
        self.assertTrue(out.startswith(b'HTTP/1.1 401'))

    def test_malformed_and_oversized_heads_answered_by_relay(self):
        before = len(self.app.heads)
        for raw in [b'GET / HTTP/1.1\r\n folded\r\n\r\n', b'GET / HTTP/1.1\r\nA: ' + b'x' * 70000 + b'\r\n\r\n']:
            out = exchange(self.port, raw)
            self.assertTrue(out.startswith(b'HTTP/1.1 400'))
        self.assertEqual(len(self.app.heads), before)

    def test_bind_conflict_raises(self):
        with self.assertRaises(OSError):
            relay['serve_app_auth_relay'](self.port, self.app.port, host='127.0.0.1')


if __name__ == '__main__':
    unittest.main()
