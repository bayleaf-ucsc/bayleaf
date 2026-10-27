#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.28,<0.29"]
# ///
"""Live check of Daytona preview-proxy behaviours against a signed URL directly
(no gateway): default credentialed any-origin CORS and self-answered preflights,
the X-Daytona-Disable-CORS opt-out, and auth cookies on signed responses.
Daytona's public source is archived (v0.190.0), so treat source findings as
hypotheses and this probe as evidence. Prints header names/booleans only."""
import os, json, httpx

API = "https://api.bayleaf.dev"
H = {"Authorization": f"Bearer {os.environ['BAYLEAF_API_KEY']}"}
D = {"Authorization": f"Bearer {os.environ['DAYTONA_API_KEY']}"}
PORT = 5077
ECHO = ("import http.server,json\nclass H(http.server.BaseHTTPRequestHandler):\n"
        "    def _r(self):\n"
        "        b=json.dumps({k.lower(): self.headers.get_all(k) for k in set(self.headers.keys())}).encode()\n"
        "        self.send_response(200);self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)\n"
        "    do_GET=do_POST=do_OPTIONS=_r\n"
        "    def log_message(self,*a): pass\n"
        f"http.server.ThreadingHTTPServer(('0.0.0.0',{PORT}),H).serve_forever()\n")
EVIL = "https://evil.example"
with httpx.Client(timeout=60) as c:
    sid = c.get(f"{API}/sandbox", headers=H).json()
    sid = sid.get("id") or sid.get("sandbox", {}).get("id")
    c.post(f"{API}/sandbox/exec", headers=H, json={"command":
        f"mkdir -p /tmp/qual && cat > /tmp/qual/h.py <<'EOF'\n{ECHO}EOF\n(pkill -f /tmp/qual/ || true); nohup python3 /tmp/qual/h.py >/dev/null 2>&1 & sleep 1"})
    signed = c.get(f"https://app.daytona.io/api/sandbox/{sid}/ports/{PORT}/signed-preview-url?expiresInSeconds=120", headers=D).json()["url"]
    base = {"X-Daytona-Skip-Preview-Warning": "true"}
    def show(name, method="GET", headers={}):
        r = c.request(method, signed, headers={**base, **headers})
        acao = r.headers.get_list("access-control-allow-origin"); acac = r.headers.get("access-control-allow-credentials")
        seen = r.json() if r.status_code == 200 and r.headers.get("content-length") not in (None, "0") and r.text.startswith("{") else {}
        print(f"{name}: {r.status_code} | ACAO evil={EVIL in acao} n={len(acao)} | ACAC={acac} | "
              f"app saw request={bool(seen)} | app got disable-cors={'x-daytona-disable-cors' in seen} "
              f"skip-warning={'x-daytona-skip-preview-warning' in seen} | ACAH={r.headers.get('access-control-allow-headers','')[:40]!r}")
    show("GET Origin=evil", headers={"Origin": EVIL})
    show("GET Origin=evil + Disable-CORS", headers={"Origin": EVIL, "X-Daytona-Disable-CORS": "true"})
    show("OPTIONS preflight", "OPTIONS", {"Origin": EVIL, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-custom"})
    show("OPTIONS preflight + Disable-CORS", "OPTIONS", {"Origin": EVIL, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-custom", "X-Daytona-Disable-CORS": "true"})
    r = c.get(signed, headers={"User-Agent": "Mozilla/5.0 Chrome/142.0.0.0"})
    print("Chrome UA without skip header:", r.status_code, "| looks like warning page:", "preview" in r.text.lower() and "daytona" in r.text.lower())
    tok = httpx.URL(signed).host.split(".")[0].split("-", 1)[1].lower()
    for ua in ["python-httpx", "Mozilla/5.0 Chrome/142.0.0.0"]:
        r = c.get(signed, headers={**base, "User-Agent": ua})
        names = [sc.split("=", 1)[0] for sc in r.headers.get_list("set-cookie")]
        print(f"Set-Cookie ({ua[:12]}): n={len(names)} names-with-token={sum(tok in n.lower() for n in names)} "
              f"prefixes={sorted({n.rsplit('-', 1)[0] if tok in n.lower() else n for n in names})} "
              f"httponly={[('httponly' in sc.lower()) for sc in r.headers.get_list('set-cookie')]}")
    c.post(f"{API}/sandbox/exec", headers=H, json={"command": "pkill -f /tmp/qual/ || true; rm -rf /tmp/qual"})
