# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright>=1.62,<2"]
# ///
"""Real pinned OWUI frontend/backend via loopback, synthetic account only.

Start the qualification image on 127.0.0.1:18880 with arrivals enabled and all
four native OTEL flags false. All browser requests are intercepted: Chat assets
and APIs go only to that local container; collector traffic stays in memory.
No production services, accounts or inference. No identity-bearing payload output.
"""
import json
import sys
import ssl
import subprocess
import tempfile
import threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from playwright.sync_api import sync_playwright

LOCAL = 'http://127.0.0.1:18881' if sys.argv[1:] == ['source-disabled'] else 'http://127.0.0.1:18880'
HOST = 'https://chat.bayleaf.dev'

class LocalProxy(BaseHTTPRequestHandler):
    arrivals = []
    mode = None

    def do_GET(self):
        self.forward()

    def do_POST(self):
        self.forward()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', HOST)
        self.send_header('Access-Control-Allow-Headers', 'content-type')
        self.send_header('Access-Control-Allow-Methods', 'POST')
        self.end_headers()

    def forward(self):
        if self.headers.get('Upgrade'):
            self.send_error(400)
            return
        data = self.rfile.read(int(self.headers.get('Content-Length', 0))) or None
        if self.headers.get('Host') == 'telemetry.bayleaf.dev':
            assert self.path == '/v1/browser'
            self.arrivals.append((json.loads(data), {k.lower(): v for k, v in self.headers.items()}))
            self.send_response(503 if self.mode == 'collector-down' else 204)
            self.send_header('Access-Control-Allow-Origin', HOST)
            self.end_headers()
            return
        headers = {k: v for k, v in self.headers.items() if k.lower() not in ('host', 'accept-encoding', 'content-length', 'connection')}
        try:
            response = urlopen(Request(LOCAL + self.path, data=data, headers=headers, method=self.command), timeout=5)
        except HTTPError as error:
            response = error
        with response:
            body = response.read()
            self.send_response(response.status)
            for key, value in response.headers.items():
                if key.lower() not in ('content-length', 'connection', 'transfer-encoding'):
                    self.send_header(key, value)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, *args):
        pass


scratch = Path(tempfile.gettempdir()) / 'opencode'
scratch.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(dir=scratch) as temporary, sync_playwright() as p:
    key, certificate = Path(temporary) / 'key.pem', Path(temporary) / 'cert.pem'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=chat.bayleaf.dev', '-keyout', str(key), '-out', str(certificate)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    proxy = ThreadingHTTPServer(('127.0.0.1', 0), LocalProxy)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(certificate, key)
    proxy.socket = tls.wrap_socket(proxy.socket, server_side=True)
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    browser = p.chromium.launch(headless=True, channel='chrome', args=['--no-proxy-server',
        f'--host-resolver-rules=MAP chat.bayleaf.dev:443 127.0.0.1:{proxy.server_port}, MAP telemetry.bayleaf.dev:443 127.0.0.1:{proxy.server_port}'])
    setup = browser.new_context()
    response = setup.request.post(LOCAL + '/api/v1/auths/signup', data={
        'name': 'Synthetic qualification', 'email': 'arrivals@example.invalid',
        'password': 'synthetic-local-only-qualification-password'})
    if response.ok:
        token = response.json()['token']
    else:
        response = setup.request.post(LOCAL + '/api/v1/auths/signin', data={
            'email': 'arrivals@example.invalid', 'password': 'synthetic-local-only-qualification-password'})
        assert response.ok, 'local synthetic sign-in unavailable'
        token = response.json()['token']
    setup.close()

    cases = [
        ('anonymous-root', HOST + '/', None, 1),
        ('http-https-auth', 'http://chat.bayleaf.dev/', None, 1),
        ('query-root', HOST + '/?private-query=not-exported', None, 1),
        ('direct-auth', HOST + '/auth', None, 0),
        ('direct-logout', HOST + '/auth?state=logout', None, 0),
        ('direct-mfa', HOST + '/auth?mfa=1', None, 0),
        ('direct-pending', HOST + '/auth?pending=1', None, 0),
        ('private-deep-link', HOST + '/c/synthetic-private-path', None, 0),
        ('authenticated-root', HOST + '/', 'local', 0),
        ('authenticated-auth', HOST + '/auth', 'local', 0),
        ('oauth-cookie-root', HOST + '/', 'cookie', 0),
        ('expired-marker-root', HOST + '/', 'expired', 0),
        ('collector-down', HOST + '/', None, 1),
        ('delayed-client', HOST + '/', None, 0),
        ('unresolved-session', HOST + '/', 'delayed', 0),
    ]
    if sys.argv[1:] == ['source-disabled']:
        cases = [('source-disabled', HOST + '/', None, 0)]
    for name, url, session, expected in cases:
        if len(sys.argv) > 1 and name != sys.argv[1]:
            continue
        print('START', name, flush=True)
        context = browser.new_context(service_workers='block', ignore_https_errors=True)
        if session in ('local', 'expired'):
            value = token if session == 'local' else 'synthetic-invalid-token'
            context.add_init_script('localStorage.setItem("token", ' + json.dumps(value) + ')')
        if session == 'cookie':
            context.add_cookies([{'name': 'token', 'value': token, 'url': HOST, 'secure': True}])
        context.add_cookies([{'name': 'must-not-travel', 'value': 'synthetic', 'url': 'https://telemetry.bayleaf.dev', 'secure': True}])
        arrivals, clients, config_requests, client_requests = [], [], [], []
        LocalProxy.arrivals = arrivals
        LocalProxy.mode = name

        def intercept(route):
            request = route.request
            parts = urlsplit(request.url)
            if parts.netloc == 'telemetry.bayleaf.dev':
                route.continue_()
            elif parts.netloc == 'chat.bayleaf.dev':
                if parts.scheme == 'http':
                    route.fulfill(status=301, headers={'Location': HOST + parts.path})
                elif session == 'delayed' and parts.path == '/api/config':
                    config_requests.append(route)
                else:
                    if '/bayleaf-chat-' in parts.path:
                        clients.append(request.url)
                        if name == 'delayed-client':
                            client_requests.append(route)
                            return
                    route.continue_()
            else:
                route.abort()

        context.route('**/*', intercept)
        page = context.new_page()
        page.set_default_timeout(15000)
        page.goto(url, wait_until='commit')
        if expected or name in ('source-disabled', 'delayed-client'):
            try:
                page.wait_for_function("location.pathname === '/auth' && !!document.getElementById('auth-login-card')")
            except Exception:
                print('FAIL resolved-card', name, urlsplit(page.url).path,
                      page.locator('#auth-page').count(), page.locator('#splash-screen').count(), flush=True)
                raise
            page.wait_for_timeout(500)
        else:
            page.wait_for_timeout(1800)
        assert len(arrivals) == expected, (name, 'arrival count', len(arrivals))
        assert len(clients) == (1 if name == 'delayed-client' else expected), (name, 'client asset count', len(clients))
        for event, headers in arrivals:
            assert event == {'schema_version': 1, 'destination': 'chat', 'referring_hostname': None}
            assert not any(k in headers for k in ('cookie', 'authorization', 'referer'))
        # The same document never emits on repeated SPA mutations or after login.
        if expected:
            page.evaluate("history.pushState({}, '', '/auth?private=not-exported'); document.body.append(document.createElement('span'))")
            page.wait_for_timeout(50)
            assert len(arrivals) == 1
            if name == 'anonymous-root':
                page.locator('#email').fill('arrivals@example.invalid')
                page.locator('#password').fill('synthetic-local-only-qualification-password')
                page.get_by_role('button', name='Sign in', exact=True).click()
                page.wait_for_function("!!localStorage.token && location.pathname === '/'")
                page.wait_for_timeout(250)
                assert len(arrivals) == 1 and len(clients) == 1, 'arrival after real local login'
            page.evaluate('localStorage.setItem("token", ' + json.dumps(token) + ')')
            page.evaluate("history.pushState({}, '', '/c/synthetic-private-path'); document.body.append(document.createElement('span'))")
            page.wait_for_timeout(50)
            assert len(arrivals) == 1 and len(clients) == 1
        if session == 'delayed':
            assert config_requests, 'root config was not actually held unresolved'
            page.wait_for_timeout(16000)
            for route in config_requests:
                route.continue_()
            page.wait_for_function("location.pathname === '/auth' && !!document.getElementById('auth-login-card')")
            page.wait_for_timeout(100)
            assert not arrivals and not clients, 'late auth resolution survived the gate deadline'
        if name == 'delayed-client':
            assert client_requests
            page.wait_for_timeout(1000)
            for route in client_requests:
                route.continue_()
            page.wait_for_timeout(250)
            assert not arrivals, 'late module delivery created an unbounded arrival'
        context.close()
        print('PASS', name)
    browser.close()
    proxy.shutdown()
    proxy.server_close()
print('PASS real pinned frontend: credential-free fixed schema, resolved sign-out, redirect/SPA once-only, no production traffic')
