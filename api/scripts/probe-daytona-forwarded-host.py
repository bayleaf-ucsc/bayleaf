#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.28,<0.29"]
# ///
"""Does Daytona honor X-Daytona-Trust-Forwarded-Host on SIGNED preview URLs?
Prints only booleans/counts, never hostnames or tokens."""
import os, json, httpx

API = "https://api.bayleaf.dev"
H = {"Authorization": f"Bearer {os.environ['BAYLEAF_API_KEY']}"}
D = {"Authorization": f"Bearer {os.environ['DAYTONA_API_KEY']}"}
PORT = 5077
ECHO = ("import http.server,json\nclass H(http.server.BaseHTTPRequestHandler):\n"
        "    def do_GET(self):\n"
        "        b=json.dumps({k.lower(): self.headers.get_all(k) for k in set(self.headers.keys())}).encode()\n"
        "        self.send_response(200);self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)\n"
        "    def log_message(self,*a): pass\n"
        f"http.server.ThreadingHTTPServer(('0.0.0.0',{PORT}),H).serve_forever()\n")
PUBLIC = "example-public-host.bayleaf-proxies.dev"
with httpx.Client(timeout=60) as c:
    sid = c.get(f"{API}/sandbox", headers=H).json()
    sid = sid.get("id") or sid.get("sandbox", {}).get("id")
    c.post(f"{API}/sandbox/exec", headers=H, json={"command":
        f"mkdir -p /tmp/qual && cat > /tmp/qual/h.py <<'EOF'\n{ECHO}EOF\n(pkill -f /tmp/qual/ || true); nohup python3 /tmp/qual/h.py >/dev/null 2>&1 & sleep 1"})
    signed = c.get(f"https://app.daytona.io/api/sandbox/{sid}/ports/{PORT}/signed-preview-url?expiresInSeconds=120", headers=D).json()["url"]
    s_host = httpx.URL(signed).host
    s_label = s_host.split(".")[0]; token = s_label.split("-", 1)[1]
    def probe(name, headers):
        r = c.get(signed, headers={"X-Daytona-Skip-Preview-Warning": "true", **headers})
        seen = r.json() if r.status_code == 200 else {}
        blob = json.dumps(seen).lower()
        xfh = seen.get("x-forwarded-host", [])
        print(f"{name}: status {r.status_code} | xfh values {len(xfh)} | ours present {any(PUBLIC in v for v in xfh)} "
              f"| capability anywhere in app-visible headers {token.lower() in blob} "
              f"| headers carrying it {[k for k, v in seen.items() if token.lower() in json.dumps(v).lower()]} "
              f"| trust header forwarded {'x-daytona-trust-forwarded-host' in seen}")
    probe("baseline", {"X-Forwarded-Host": PUBLIC})
    probe("trust header", {"X-Forwarded-Host": PUBLIC, "X-Daytona-Trust-Forwarded-Host": "true"})
    c.post(f"{API}/sandbox/exec", headers=H, json={"command": "pkill -f /tmp/qual/ || true; rm -rf /tmp/qual"})
