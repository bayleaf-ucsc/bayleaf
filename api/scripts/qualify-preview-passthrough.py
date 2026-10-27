#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.28,<0.29"]
# ///
"""Live qualification of BayLeaf preview header passthrough (bayleaf#118, lathe#111).

Runs a disposable echo app in the caller's sandbox, exposes it publicly through
/sandbox/expose, drives contract cases, then revokes and stops the app. Prints
only case names and booleans, never URLs, header values or bodies.
"""
import json, os, sys, time
import httpx

API = "https://api.bayleaf.dev"
KEY = os.environ["BAYLEAF_API_KEY"]
PORT = 5077
H = {"Authorization": f"Bearer {KEY}"}

ECHO = r'''
import json, http.server
class H(http.server.BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body.encode()
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def handle_one(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n: self.rfile.read(n)
        if self.path.startswith("/app-error"):
            return self._send(403, json.dumps({"error": "pocket: csrf header missing"}))
        if self.path.startswith("/leak-error"):
            return self._send(500, "upstream host was " + ",".join(self.headers.get_all("X-Forwarded-Host") or []), "text/plain")
        if self.path.startswith("/big-error"):
            return self._send(500, "x" * 70000, "text/plain")
        self._send(200, json.dumps({"method": self.command, "headers": {k.lower(): ",".join(self.headers.get_all(k)) for k in set(self.headers.keys())}}))
    do_GET = do_POST = handle_one
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
'''.replace("PORT", str(PORT))

results = []
def case(name, ok):
    results.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'} {name}")

with httpx.Client(timeout=60) as c:
    r = c.post(f"{API}/sandbox/exec", headers=H, json={"command":
        f"mkdir -p /tmp/qual && cat > /tmp/qual/echo.py <<'EOF'\n{ECHO}\nEOF\n"
        f"(pkill -f /tmp/qual/echo.py || true); nohup python3 /tmp/qual/echo.py >/dev/null 2>&1 &\n"
        f"sleep 1; curl -s -o /dev/null -w '%{{http_code}}' localhost:{PORT}/"})
    case("echo app started in sandbox", r.status_code == 200 and r.json().get("output", "").endswith("200"))
    r = c.post(f"{API}/sandbox/expose", headers=H, json={"port": PORT, "access": "public"})
    case("public expose registered", r.status_code == 200)
    if r.status_code != 200:
        sys.exit(1)
    url = r.json()["url"]
    origin = url.rstrip("/")
    app = {"Origin": origin, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty"}
    time.sleep(2)
    try:
        sent = {
            "X-Pocket": "1", "X-Unanticipated-App-Header": "v",
            "X-Daytona-Preview-Token": "forged", "Daytona-Anything": "x",
            "X-Lathe-Anything": "x", "True-Client-IP": "203.0.113.9", "X-Real-IP": "203.0.113.9",
            "Forwarded": "for=203.0.113.9", "Proxy-Authorization": "Basic eA==", "Referer": url + "secret",
            "X-Api-Key": KEY, "x-FORWARDED-host": "evil.example",
        }
        r = c.post(url + "echo", headers={**app, **sent, "Content-Type": "application/json"}, content="{}")
        case("POST through public preview succeeds", r.status_code == 200)
        seen = r.json()["headers"] if r.status_code == 200 else {}
        case("F1 X-Pocket forwarded", seen.get("x-pocket") == "1")
        case("F3 unanticipated app header forwarded", seen.get("x-unanticipated-app-header") == "v")
        case("F4 Origin forwarded unchanged", seen.get("origin") == origin)
        xfh = seen.get("x-forwarded-host", "")
        # Daytona's proxy overwrites X-Forwarded-Host with its own (capability) hostname.
        case("R2 forged X-Forwarded-Host never reaches app", "evil.example" not in xfh)
        # Daytona appends its own X-Forwarded-Host (the signed capability host) after ours.
        case("R2 BayLeaf X-Forwarded-Host is first", xfh.split(",")[0] == origin.split("//")[1])
        cf = c.post(url + "echo", headers={**app, "CF-Connecting-IP": "203.0.113.9"}, content="{}")
        case("R3 forged CF-Connecting-IP refused at edge or not forwarded",
             cf.status_code == 403 or cf.json()["headers"].get("cf-connecting-ip") != "203.0.113.9")
        for name in ["x-daytona-preview-token", "daytona-anything", "x-lathe-anything", "proxy-authorization", "referer"]:
            case(f"R absent: {name}", name not in seen)
        for name in ["true-client-ip", "x-real-ip", "forwarded"]:
            case(f"R7 not forged: {name}", "203.0.113.9" not in seen.get(name, ""))
        case("platform credential excluded under arbitrary name", "x-api-key" not in seen)
        nav = c.get(url + "echo", headers={"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate",
                                           "Sec-Fetch-Dest": "document", "X-Pocket": "1"})
        case("navigation carries no script-set headers", nav.status_code == 200 and "x-pocket" not in nav.json()["headers"])
        e1 = c.get(url + "app-error", headers=app)
        case("E1 app 403 body passes through", e1.status_code == 403 and "csrf header missing" in e1.text)
        case("E1 JSON content type kept", e1.headers.get("content-type", "").startswith("application/json"))
        e2 = c.get(url + "leak-error", headers=app)
        # The app learns the upstream hostname from Daytona's X-Forwarded-Host.
        case("E2 body naming upstream host is replaced", e2.status_code == 500 and "upstream host was" not in e2.text
             and "replaced by the BayLeaf preview gateway" in e2.text)
        e3 = c.get(url + "big-error", headers=app)
        case("large error body is replaced", e3.status_code == 500 and "replaced by the BayLeaf" in e3.text)
    finally:
        d = c.delete(f"{API}/sandbox/expose/{PORT}", headers=H)
        case("exposure revoked", d.status_code in (200, 204))
        c.post(f"{API}/sandbox/exec", headers=H, json={"command": "pkill -f /tmp/qual/echo.py || true; rm -rf /tmp/qual"})
        after = c.get(url + "echo", headers=app)
        case("revoked preview no longer reaches app", after.status_code != 200)

failed = [n for n, ok in results if not ok]
print(json.dumps({"passed": len(results) - len(failed), "failed": failed}))
sys.exit(1 if failed else 0)
