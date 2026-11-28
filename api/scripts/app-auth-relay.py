"""Daytona v2 application-credential relay, embedded in browser-setup.py's globals.

Daytona v2 signed previews strip Authorization before the request reaches the
sandbox (live, 2026-11-27). The BayLeaf gateway therefore sends the managed
app's own credential as X-BayLeaf-App-Authorization, and this relay moves it
back to Authorization on loopback. The relay holds no secret and grants nothing:
the application still verifies the credential natively (ttyd --credential,
Jupyter IdentityProvider token, OpenCode server password). A request without
the header passes through unchanged and the application rejects it.

Owner authorization stays at the private gateway. Each connection carries one
rewritten request: Connection: close upstream, or an upgraded WebSocket, so a
kept-alive or pipelined request can never pass unrewritten. No top-level side
effects; stdlib only. Never log heads, which carry credentials.
"""
import socket as _relay_socket
import threading as _relay_threading

APP_AUTH_HEADER = b'x-bayleaf-app-authorization'
APP_AUTH_HEAD_LIMIT = 64 * 1024
APP_AUTH_HEADER_COUNT = 128
APP_AUTH_CONNECTIONS = 128
_APP_AUTH_TOKEN = frozenset(b"!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
_APP_AUTH_HOP = {b'connection', b'keep-alive', b'proxy-connection'}


def app_auth_rewrite(head):
    """Rewritten request head bytes, or None to answer 400. `head` excludes CRLFCRLF."""
    lines = head.split(b'\r\n')
    request_line = lines[0].split(b' ')
    if len(request_line) != 3 or request_line[2] not in (b'HTTP/1.1', b'HTTP/1.0') or not request_line[0] \
            or any(c not in _APP_AUTH_TOKEN for c in request_line[0]) or not request_line[1] \
            or any(c < 0x21 or c == 0x7f for c in request_line[1]) or len(lines) - 1 > APP_AUTH_HEADER_COUNT:
        return None
    headers, relayed, upgrade = [], [], False
    framing = set()
    for line in lines[1:]:
        name, colon, value = line.partition(b':')
        # No obs-fold, no whitespace before the colon, no bare or empty names:
        # the app must parse exactly the head this relay inspected.
        if (not colon or not name or any(c not in _APP_AUTH_TOKEN for c in name)
                or any((c < 32 and c != 9) or c == 127 for c in value)):
            return None
        lower = name.lower()
        value = value.strip(b' \t')
        if lower in (b'host', b'content-length', b'transfer-encoding', b'upgrade', b'authorization'):
            if lower in framing:
                return None
            framing.add(lower)
            if lower == b'content-length' and not value.isdigit():
                return None
            if lower == b'transfer-encoding' and value.lower() != b'chunked':
                return None
        if lower == APP_AUTH_HEADER:
            relayed.append(value)
        elif lower == b'upgrade':
            upgrade = value.lower() == b'websocket'
            headers.append((name, value))
        elif lower not in _APP_AUTH_HOP:
            headers.append((name, value))
    if (len(relayed) > 1 or (relayed and not relayed[0])
            or {b'content-length', b'transfer-encoding'} <= framing
            or (upgrade and ({b'content-length', b'transfer-encoding'} & framing))):
        return None
    if relayed:
        # The relayed value replaces, never accompanies, any Authorization.
        headers = [(n, v) for n, v in headers if n.lower() != b'authorization']
        headers.append((b'Authorization', relayed[0]))
    if upgrade:
        headers.append((b'Connection', b'Upgrade'))
    else:
        headers = [(n, v) for n, v in headers if n.lower() != b'upgrade']
        headers.append((b'Connection', b'close'))
    return b'\r\n'.join([lines[0], *(n + b': ' + v for n, v in headers)]) + b'\r\n\r\n'


def _app_auth_pump(source, sink):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            sink.sendall(data)
    except OSError:
        pass
    finally:
        try:
            sink.shutdown(_relay_socket.SHUT_WR)
        except OSError:
            pass


def _app_auth_connection(client, upstream_port, slots):
    upstream = None
    try:
        client.settimeout(30)
        buffer = b''
        while b'\r\n\r\n' not in buffer:
            if len(buffer) > APP_AUTH_HEAD_LIMIT:
                buffer = None
                break
            data = client.recv(65536)
            if not data:
                return
            buffer += data
        rewritten = None
        if buffer is not None:
            head, _, rest = buffer.partition(b'\r\n\r\n')
            if len(head) <= APP_AUTH_HEAD_LIMIT:
                rewritten = app_auth_rewrite(head)
        if rewritten is None:
            client.sendall(b'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            return
        upstream = _relay_socket.create_connection(('127.0.0.1', upstream_port), timeout=10)
        # WebSockets and long responses are open-ended; the gateway owns lifetime.
        client.settimeout(None)
        upstream.settimeout(None)
        upstream.sendall(rewritten + rest)
        back = _relay_threading.Thread(target=_app_auth_pump, args=(upstream, client), daemon=True)
        back.start()
        _app_auth_pump(client, upstream)
        back.join()
    except OSError:
        pass
    finally:
        for sock in (client, upstream):
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass
        slots.release()


def serve_app_auth_relay(listen_port, upstream_port, host='0.0.0.0'):
    """Bind now (OSError on conflict), then serve on a daemon thread.

    Daytona v2 reaches services on the sandbox interface, not loopback, so the
    relay binds every IPv4 interface like the applications it fronts.
    """
    listener = _relay_socket.socket()
    listener.setsockopt(_relay_socket.SOL_SOCKET, _relay_socket.SO_REUSEADDR, 1)
    try:
        listener.bind((host, listen_port))
        listener.listen(64)
    except OSError:
        listener.close()
        raise
    slots = _relay_threading.BoundedSemaphore(APP_AUTH_CONNECTIONS)

    def accept():
        while True:
            try:
                client, _ = listener.accept()
            except OSError:
                return
            if not slots.acquire(blocking=False):
                client.close()
                continue
            _relay_threading.Thread(target=_app_auth_connection, args=(client, upstream_port, slots), daemon=True).start()
    _relay_threading.Thread(target=accept, daemon=True).start()
    return listener
