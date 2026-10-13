# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx"]
# ///
"""Live multi-model consent/PKCE check. Loopback only; credentials stay in memory.

Source ~/.tokens/bayleaf-api; run, then open http://127.0.0.1:18799/start.
The browser's signed-in account must match that ordinary key for exact cleanup.
"""
import base64
import hashlib
import html
import json
import os
import secrets
import time
import httpx
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit

BASE = "https://api.bayleaf.dev"
KEY = os.environ["BAYLEAF_API_KEY"]
CALLBACK = "http://127.0.0.1:18799/callback"
MODELS = ["openrouter:cloudflare/clef-flash", "openrouter:google/gemma-4-26b-a4b-it"]
verifier = secrets.token_urlsafe(32)
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
state = secrets.token_urlsafe(24)
checks = []
done = False
client = httpx.Client(base_url=BASE, timeout=90, follow_redirects=False)
descriptor_response = client.post("/grants/clients", json={
    "client_name": "BayLeaf deployment smoke (synthetic)", "redirect_uri": CALLBACK,
})
assert descriptor_response.status_code == 200
descriptor = descriptor_response.json()["client_id"]
authorize = BASE + "/grants/authorize?" + urlencode({
    "client_id": descriptor, "response_type": "code", "models": json.dumps(MODELS),
    "expires_in": 120, "state": state, "code_challenge": challenge, "code_challenge_method": "S256",
})
decision = {"model": MODELS[0], "state": "Synthetic: a service is unavailable right now.",
    "questions": {"outage": {"type": "noul", "instructions": "Is there a current outage?"}}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Never put callback codes in logs.

    def do_GET(self):
        global done
        url = urlsplit(self.path)
        if url.path == "/start":
            self.send_response(302)
            self.send_header("Location", authorize)
            self.end_headers()
            return
        if url.path != "/callback":
            self.send_response(404)
            self.end_headers()
            return
        query = parse_qs(url.query)
        grant_id = None
        token = None
        failure = None
        try:
            assert query.get("state") == [state], "Callback state mismatch"
            assert "error" not in query, "Authorization denied"
            exchanged = client.post("/grants/token", json={
                "grant_type": "authorization_code", "code": query["code"][0], "client_id": descriptor,
                "redirect_uri": CALLBACK, "code_verifier": verifier,
            })
            assert exchanged.status_code == 200, "PKCE exchange failed"
            value = exchanged.json()
            grant_id, token = value["grant_id"], value["access_token"]
            assert value["models"] == MODELS, "Consent model set changed"
            checks.append("explicit two-model consent and PKCE exchange")
            response = client.post("/v1/decisions", headers={"Authorization": f"Bearer {token}"}, json=decision)
            assert response.status_code == 200, "Decision inference failed"
            assert 0 <= response.json()["answers"]["outage"]["noul"] <= 1
            checks.append("visitor-funded decision inference")
            response = client.post("/v1/chat/completions", headers={"Authorization": f"Bearer {token}"}, json={
                "model": MODELS[1], "messages": [{"role": "user", "content": "Reply with exactly OK."}],
                "max_tokens": 512, "reasoning": {"enabled": False},
            })
            assert response.status_code == 200 and response.json()["choices"][0]["message"].get("content")
            checks.append("same visitor-funded token supports text inference")
        except Exception as error:
            failure = type(error).__name__ + ": " + str(error)
        finally:
            if grant_id:
                revoked = client.delete(f"/grants/{grant_id}", headers={"Authorization": f"Bearer {KEY}"})
                denied = client.post("/v1/decisions", headers={"Authorization": f"Bearer {token}"}, json=decision)
                if revoked.status_code != 200 or denied.status_code != 401:
                    failure = "Exact test-token revocation failed; revoke the deployment-smoke token in the dashboard."
                else:
                    checks.append("exact grant revoked and token immediately rejected")
            done = True
        report = {"ok": failure is None, "checks": checks, "error": failure}
        print(json.dumps(report), flush=True)
        self.send_response(200 if failure is None else 500)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(("<!doctype html><html lang=en><title>BayLeaf live consent check</title>"
            "<script>history.replaceState({}, '', '/done')</script><h1>BayLeaf live consent check</h1><pre>"
            + html.escape(json.dumps(report, indent=2)) + "</pre>").encode())


server = HTTPServer(("127.0.0.1", 18799), Handler)
server.timeout = 300
deadline = time.monotonic() + 300
print("Open http://127.0.0.1:18799/start for the live consent check.", flush=True)
try:
    while not done and time.monotonic() < deadline:
        server.handle_request()
finally:
    server.server_close()
    client.close()
if not done:
    raise SystemExit("Browser consent was not completed within five minutes; no token was exchanged.")
