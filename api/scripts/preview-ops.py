#!/usr/bin/env python3
"""Operator helpers for issue #71. Never print credentials or upstream URLs."""
import argparse
import base64
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import shlex
import subprocess
import tomllib
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ACCOUNT = "1a49fb69291d42e23c4ed4dcffce5bbc"
TOKEN_FILE = Path.home() / ".tokens/bayleaf-previews"


def cloudflare(path, body=None, method=None, refreshed=False):
    config = Path.home() / "Library/Preferences/.wrangler/config/default.toml"
    token = tomllib.loads(config.read_text())["oauth_token"]
    request = urllib.request.Request("https://api.cloudflare.com/client/v4" + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 401 and not refreshed:
            # Long qualification sessions can outlast Wrangler's access token.
            # Let Wrangler refresh its own OAuth credentials, then retry once.
            refresh = subprocess.run(['npx','wrangler','whoami'],cwd=ROOT,capture_output=True,text=True,timeout=60)
            if refresh.returncode == 0:
                return cloudflare(path,body,method,refreshed=True)
        raise SystemExit(f"Cloudflare request failed: HTTP {error.code}") from None
    if not result.get("success"):
        raise SystemExit("Cloudflare request unsuccessful")
    return result["result"]


def bootstrap():
    if not TOKEN_FILE.exists():
        values = {"PREVIEWS_INSTALLATION_KEY": secrets.token_urlsafe(32),
                  "PREVIEWS_SECRET": base64.b64encode(secrets.token_bytes(32)).decode()}
        fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write("".join(f"{key}={value}\n" for key, value in values.items()))
    else:
        values = dict(line.split("=", 1) for line in TOKEN_FILE.read_text().splitlines() if line)
        if set(values) != {"PREVIEWS_INSTALLATION_KEY", "PREVIEWS_SECRET"}:
            raise SystemExit("Unexpected credential file format; refusing to overwrite")
    os.chmod(TOKEN_FILE, 0o600)
    result = subprocess.run(["npx", "wrangler", "secret", "bulk"], cwd=ROOT,
        input=json.dumps(values), text=True, capture_output=True)
    if result.returncode:
        raise SystemExit("Worker secret upload failed; credentials retained locally")
    print("Preview secrets uploaded; recovery copy stored mode 0600 in ~/.tokens/bayleaf-previews")


def inspect():
    zones = cloudflare("/zones?name=bayleaf-proxies.dev")
    for zone in zones:
        print(json.dumps({"zone_id": zone["id"], "status": zone["status"], "nameservers": zone["name_servers"]}))
        try:
            records = cloudflare(f'/zones/{zone["id"]}/dns_records')
            print(json.dumps({"dns": [{k: r[k] for k in ["id", "name", "type", "content", "proxied"]} for r in records]}))
        except SystemExit:
            print("DNS inventory unavailable to Wrangler OAuth; use the authenticated dashboard")
        print(json.dumps({"routes": cloudflare(f'/zones/{zone["id"]}/workers/routes')}))


def user_key():
    text = (Path.home() / ".tokens/bayleaf-api").read_text()
    for item in shlex.split(text, comments=True):
        value = item.split("=", 1)[-1]
        if value.startswith("sk-bayleaf-"):
            return value
    raise SystemExit("No BayLeaf user key found")


def api(path, body=None, method=None):
    request = urllib.request.Request("https://api.bayleaf.dev" + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + user_key(), "Content-Type": "application/json", "User-Agent": "BayLeaf-Preview-Qualification/1.0"}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            if response.status == 204:
                return {"status": 204}
            return json.load(response)
    except urllib.error.HTTPError as error:
        print("BayLeaf response type:", error.headers.get("Content-Type"))
        if "json" in error.headers.get("Content-Type", ""):
            detail = json.load(error).get("error", {})
            print("API error:", detail.get("code"), detail.get("message"))
        raise SystemExit(f"BayLeaf request failed: HTTP {error.code}") from None


def fixture():
    source = base64.b64encode((ROOT / "scripts/preview-fixture.py").read_bytes()).decode()
    # Unique filename and port-bind check protect unrelated sandbox work.
    name = "/tmp/bayleaf-preview-poc-" + secrets.token_hex(8) + ".py"
    record = TOKEN_FILE.with_name("bayleaf-preview-fixture.json")
    previous = json.loads(record.read_text()) if record.exists() else None
    # A repeat invocation replaces only this exact marked synthetic fixture.
    cleanup = ""
    if previous:
        old_path = previous["path"]
        assert old_path.startswith("/tmp/bayleaf-preview-poc-")
        cleanup = f"""import os, signal
for proc in pathlib.Path('/proc').glob('[0-9]*'):
    try:
        argv = (proc / 'cmdline').read_bytes().split(b'\\0')
        if {old_path!r}.encode() in argv:
            os.kill(int(proc.name), signal.SIGTERM)
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        pass
time.sleep(1)
pathlib.Path({old_path!r}).unlink(missing_ok=True)
"""
    command = f"""python3 - <<'PY'
import base64, pathlib, socket, subprocess, time
{cleanup}
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('0.0.0.0', 8787))
s.close()
path = {name!r}
pathlib.Path(path).write_bytes(base64.b64decode({source!r}))
p = subprocess.Popen(['python3', path, '8787'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
time.sleep(1)
assert p.poll() is None, 'Fixture failed to start'
print('synthetic fixture ready; pid=' + str(p.pid))
PY"""
    result = api("/sandbox/exec", {"command": command})
    print(json.dumps(result))
    if result.get("exitCode") == 0:
        fd = os.open(record, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump({"path": name, "port": 8787, "output": result.get("output", "")}, handle)


def expose():
    result = api("/sandbox/expose", {"port": 8787})
    record = TOKEN_FILE.with_name("bayleaf-preview-fixture.json")
    if record.exists():
        state = json.loads(record.read_text()); state['url'] = result['url']
        record.write_text(json.dumps(state))
    print(json.dumps(result))


def signed_destination():
    entries = dict(item.split("=", 1) for item in shlex.split((Path.home() / ".tokens/owui/chat-bayleaf-dev").read_text(), comments=True) if "=" in item)
    result = subprocess.run(["uvx", "owui-cli", "--json", "tools", "valves", "lathe"],
        env={**os.environ, **entries}, capture_output=True, text=True)
    if result.returncode:
        raise SystemExit("Could not read Lathe valves through owui-cli")
    valves = json.loads(result.stdout)
    key = valves["daytona_api_key"]
    sandbox = api("/sandbox")
    request = urllib.request.Request(f'https://app.daytona.io/api/sandbox/{sandbox["id"]}/ports/8787/signed-preview-url?expiresInSeconds=3600',
        headers={"Authorization": "Bearer " + key, "User-Agent": "BayLeaf-Preview-Qualification/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
    return result["url"]


def destination():
    from urllib.parse import urlsplit
    result = {"url": signed_destination()}
    url = urlsplit(result["url"])
    print(json.dumps({"scheme": url.scheme, "host_suffix": url.hostname.split(".", 1)[1],
        "root_path": url.path in ["", "/"], "has_query": bool(url.query), "port": url.port}))


def identity():
    result = cloudflare(f"/accounts/{ACCOUNT}/d1/database/e249d6a6-41cf-4ab7-93d6-b677ac95b524/query",
        {"sql": "SELECT email FROM user_keys WHERE bayleaf_token=?", "params": [user_key()]})
    print(json.dumps(result[0]["results"]))


def nonowner():
    from datetime import datetime, timedelta, timezone
    values = dict(line.split("=", 1) for line in TOKEN_FILE.read_text().splitlines())
    body = {"owner": {"subject": "issue71-synthetic-nonowner", "email": "preview-qualification-nonowner@ucsc.edu"},
        "slot": "8787", "upstream_url": signed_destination(),
        "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()}
    request = urllib.request.Request("https://api.bayleaf.dev/previews/registrations", data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + values["PREVIEWS_INSTALLATION_KEY"],
            "Content-Type": "application/json", "User-Agent": "BayLeaf-Preview-Qualification/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        print(json.dumps(json.load(response)))


def copy_start():
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPCookieProcessor(jar))
    state=json.loads(TOKEN_FILE.with_name('bayleaf-preview-fixture.json').read_text())
    request = urllib.request.Request(state['url'] + "__preview/start",
        headers={"User-Agent": "BayLeaf-Preview-Qualification/1.0"})
    try:
        opener.open(request, timeout=30)
    except urllib.error.HTTPError as error:
        if error.code != 302:
            raise SystemExit(f"Start failed: HTTP {error.code}") from None
        print("Copy-test authorization URL:", error.headers["Location"])


def cleanup():
    record = TOKEN_FILE.with_name("bayleaf-preview-fixture.json")
    previous = json.loads(record.read_text())
    registered = cloudflare(f"/accounts/{ACCOUNT}/d1/database/e249d6a6-41cf-4ab7-93d6-b677ac95b524/query",
        {"sql":"SELECT hostname,email FROM preview_registrations WHERE slot='8787' AND email IN (?,?)",
         "params":['amsmith@ucsc.edu','preview-qualification-nonowner@ucsc.edu']})[0]['results']
    old_path = previous["path"]
    assert old_path.startswith("/tmp/bayleaf-preview-poc-")
    command = f"""python3 - <<'PY'
import pathlib, os, signal
count = 0
for proc in pathlib.Path('/proc').glob('[0-9]*'):
    try:
        if {old_path!r}.encode() in (proc / 'cmdline').read_bytes().split(b'\\0'):
            os.kill(int(proc.name), signal.SIGTERM)
            count += 1
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        pass
pathlib.Path({old_path!r}).unlink(missing_ok=True)
print('synthetic fixture processes stopped:', count)
PY"""
    result = api("/sandbox/exec", {"command": command})
    print(json.dumps(result))
    if result.get("exitCode") != 0:
        raise SystemExit("Fixture cleanup failed")
    print("Owner preview revocation:", api("/sandbox/expose/8787", method="DELETE")["status"])
    values = dict(line.split("=", 1) for line in TOKEN_FILE.read_text().splitlines())
    for registration in registered:
        if registration['email'] != 'preview-qualification-nonowner@ucsc.edu': continue
        label = registration['hostname'].split('.')[0]
        request = urllib.request.Request("https://api.bayleaf.dev/previews/registrations/" + label, method="DELETE",
            headers={"Authorization": "Bearer " + values["PREVIEWS_INSTALLATION_KEY"], "User-Agent": "BayLeaf-Preview-Qualification/1.0"})
        with urllib.request.urlopen(request, timeout=30) as response:
            print("Non-owner preview revocation:", response.status)
    hosts = [r['hostname'] for r in registered]
    if previous.get('url'):
        from urllib.parse import urlsplit
        hosts.append(urlsplit(previous['url']).hostname)
    hosts = list(set(hosts))
    placeholders = ','.join('?' for _ in hosts) or "NULL"
    result = cloudflare(f"/accounts/{ACCOUNT}/d1/database/e249d6a6-41cf-4ab7-93d6-b677ac95b524/query",
        {"sql": f"DELETE FROM preview_flows WHERE hostname IN ({placeholders})", "params": hosts})
    result = cloudflare(f"/accounts/{ACCOUNT}/d1/database/e249d6a6-41cf-4ab7-93d6-b677ac95b524/query",
        {"sql": f"SELECT COUNT(*) AS remaining FROM preview_registrations WHERE hostname IN ({placeholders})", "params": hosts})
    print("Synthetic registrations remaining:", result[0]["results"][0]["remaining"])
    record.unlink()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["bootstrap", "inspect", "fixture", "expose", "destination", "identity", "nonowner", "copy-start", "cleanup"])
    args = parser.parse_args()
    {"bootstrap": bootstrap, "inspect": inspect, "fixture": fixture, "expose": expose, "destination": destination,
        "identity": identity, "nonowner": nonowner, "copy-start": copy_start, "cleanup": cleanup}[args.action]()
