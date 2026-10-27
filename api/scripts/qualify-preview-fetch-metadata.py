#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.28,<0.29"]
# ///
"""Does Go's http.CrossOriginProtection accept same-origin POSTs behind the
BayLeaf preview gateway? It needs Sec-Fetch-Site forwarded: without it, Go
compares Origin with Host, which Daytona rewrites to localhost, and returns 403.
Requires a local Go >= 1.25 toolchain (the sandbox cannot download Go); the app
is cross-compiled here and uploaded. Prints statuses and short app text only."""
import os, subprocess, tempfile, httpx

API = "https://api.bayleaf.dev"
H = {"Authorization": f"Bearer {os.environ['BAYLEAF_API_KEY']}"}
PORT = 5078
GO_APP = r'''package main
import ("fmt"; "net/http")
func main() {
  mux := http.NewServeMux()
  mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
    fmt.Fprintf(w, "ok %s sfs=%q", r.Method, r.Header.Get("Sec-Fetch-Site"))
  })
  http.ListenAndServe(":PORT", http.NewCrossOriginProtection().Handler(mux))
}
'''.replace("PORT", str(PORT))
BUILD = tempfile.mkdtemp(prefix="gocsrf-")
open(f"{BUILD}/main.go", "w").write(GO_APP)
subprocess.run(["go", "mod", "init", "gocsrf"], cwd=BUILD, check=True, capture_output=True)
subprocess.run(["go", "build", "-o", "app", "."], cwd=BUILD, check=True,
               env={**os.environ, "CGO_ENABLED": "0", "GOOS": "linux", "GOARCH": "amd64"})
SETUP = f"""chmod +x /tmp/gocsrf/app; (pkill -f /tmp/gocsrf/app || true); cd /tmp/gocsrf; nohup ./app >/dev/null 2>&1 &
sleep 1; curl -s -o /dev/null -w '%{{http_code}}' localhost:{PORT}/"""
with httpx.Client(timeout=120) as c:
    c.post(f"{API}/sandbox/exec", headers=H, json={"command": "mkdir -p /tmp/gocsrf"})
    up = c.put(f"{API}/sandbox/files/tmp/gocsrf/app", headers=H, content=open(f"{BUILD}/app", "rb").read())
    print("upload:", up.status_code)
    r = c.post(f"{API}/sandbox/exec", headers=H, json={"command": SETUP})
    out = r.json().get("output", "")
    print("setup:", r.json().get("exitCode"), out.strip().splitlines()[0] if out else "", "| local:", out.strip()[-3:])
    reg = c.post(f"{API}/sandbox/expose", headers=H, json={"port": PORT, "access": "public"})
    url = reg.json()["url"]; origin = url.rstrip("/")
    try:
        for name, hdrs in [
            ("browser-like same-origin fetch POST", {"Origin": origin, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty"}),
            ("same-origin form POST (navigate)", {"Origin": origin, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}),
        ]:
            p = c.post(url, headers=hdrs, content="x")
            print(f"{name}: {p.status_code} | {p.text.strip()[:110]}")
        g = c.get(url, headers={"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Origin": origin})
        print("GET:", g.status_code, "|", g.text.strip()[:110])
    finally:
        c.delete(f"{API}/sandbox/expose/{PORT}", headers=H)
        c.post(f"{API}/sandbox/exec", headers=H, json={"command": "pkill -f /tmp/gocsrf/app || true; rm -rf /tmp/gocsrf"})
