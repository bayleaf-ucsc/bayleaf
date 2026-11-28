#!/usr/bin/env python3
"""Import a disposable Daytona v0 archive and independently verify its file.

Run with --live and a BayLeaf-project DAYTONA_API_KEY. This script never accepts
an existing workspace ID. It deletes only resources with its random owner label.
"""

import argparse
from datetime import datetime
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

V0 = "https://app.daytona.io/api/sandbox"
V2 = "https://api.daytona.com/sandboxes"
MIGRATION = "https://api.daytona.com/migration/v0/sandboxes"
OWNER = "import-pilot@bayleaf-migration.test"
CANARY_PATH = "/home/daytona/workspace/bayleaf-v2-import-canary"
PROBE_RUNTIME = """\
import json, os, pathlib, shutil, subprocess, sys
node = shutil.which('node')
version = subprocess.run([node, '--version'], capture_output=True, text=True, check=True).stdout.strip() if node else None
print(json.dumps({
    'home_is_daytona': pathlib.Path.home() == pathlib.Path('/home/daytona'),
    'workspace_writable': os.access('/home/daytona/workspace', os.W_OK),
    'python': f'{sys.version_info.major}.{sys.version_info.minor}',
    'node': version,
    'npm': bool(shutil.which('npm')),
    'sudo': bool(shutil.which('sudo')) and subprocess.run(
        ['sudo','-n','true'], capture_output=True, check=False).returncode == 0,
    'apt': bool(shutil.which('apt-get')),
    'chromium': any(shutil.which(name) for name in ('chromium', 'chromium-browser', 'google-chrome')),
    'websockify': bool(shutil.which('websockify')),
    'lathe_novnc': pathlib.Path('/opt/novnc/vnc.html').is_file(),
    'distro_novnc': pathlib.Path('/usr/share/novnc/vnc.html').is_file(),
}, sort_keys=True))
"""
QUALIFY_NOVNC_ALIAS = """\
set -eu
if ! test -f /opt/novnc/vnc.html; then
    test -f /usr/share/novnc/vnc.html
    sudo -n ln -sT -- /usr/share/novnc /opt/novnc
fi
test -r /opt/novnc/vnc.html
"""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class TransientReadError(RuntimeError):
    pass


def qualify(key, *, double_cycle=False, compare_restored_source=False):
    label = f"bayleaf-172-import-{uuid.uuid4().hex[:12]}"
    labels = {label: OWNER}
    source = None
    destination = None
    import_attempted = False
    opener = urllib.request.build_opener(NoRedirect())

    def request(url, method="GET", body=None, *, missing_ok=False, binary=False):
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode() if body is not None else None,
            method=method,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "User-Agent": "BayLeaf-Daytona-Import-Qualification/1",
            },
        )
        try:
            with opener.open(req, timeout=35) as response:
                content = response.read()
        except urllib.error.HTTPError as error:
            if missing_ok and error.code == 404:
                return None
            if method == "GET" and error.code in (429, 502, 503, 504):
                raise TransientReadError(f"Transient Daytona read: HTTP {error.code}") from None
            code = ""
            try:
                code = json.load(error).get("code") or ""
            except (ValueError, AttributeError):
                pass
            raise RuntimeError(f"{method} failed: HTTP {error.code} {code}") from None
        if binary:
            return content
        return json.loads(content) if content else {}

    def wait_for(callback, description, seconds=180):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                result = callback()
            except TransientReadError:
                result = None
            if result:
                return result
            time.sleep(3)
        raise RuntimeError(f"Timed out waiting for {description}")

    def state(url, field, expected):
        machine = request(url)
        if machine[field] in {"error", "failed", "lost"}:
            raise RuntimeError(f"Fixture entered {machine[field]}")
        return machine if machine[field] in expected else None

    def migration_source():
        cursor = None
        for _ in range(100):
            params = {"limit": 100}
            if cursor:
                params["cursor"] = cursor
            page = request(f"{MIGRATION}?{urllib.parse.urlencode(params)}")
            for entry in page["sandboxes"]:
                if entry["v0_id"] == source:
                    if entry["labels"].get(label) != OWNER:
                        raise RuntimeError("Migration source lost its fixture label")
                    return entry
            next_cursor = page.get("next_cursor")
            if not next_cursor:
                return None
            if next_cursor == cursor:
                break
            cursor = next_cursor
        raise RuntimeError("Migration listing did not finish pagination")

    last_archive_status = None

    def importable():
        nonlocal last_archive_status
        machine = request(f"{V0}/{source}")
        entry = migration_source() if machine["state"] == "archived" else None
        status = (machine["state"], machine.get("backupState"), (entry or {}).get("reason"))
        if status != last_archive_status:
            print(f"Archive / backup / import reason: {status}", flush=True)
            last_archive_status = status
        if entry and entry["importable"] and entry.get("last_backup_at") and machine.get("lastActivityAt"):
            gap = datetime.fromisoformat(machine["lastActivityAt"]) - datetime.fromisoformat(entry["last_backup_at"])
            print(f"Archive activity minus backup timestamp: {gap.total_seconds():.3f} seconds", flush=True)
        return entry if entry and entry["importable"] else None

    def toolbox(machine, key_name, host_suffix):
        url = urllib.parse.urlsplit(machine[key_name])
        if (url.scheme != "https" or not url.hostname or
                not url.hostname.endswith(host_suffix) or url.username or url.password or
                url.port is not None or url.path.rstrip("/") != "/toolbox" or
                url.query or url.fragment):
            raise RuntimeError("Unexpected Toolbox origin for fixture")
        return f"{url.geturl().rstrip('/')}/{machine['id']}"

    def cleanup(root, ident, status_field, *, legacy=False):
        if not ident:
            return
        url = f"{root}/{ident}"
        machine = wait_for(lambda: (request(url, missing_ok=True),), "fixture cleanup lookup")[0]
        if machine is None or machine.get(status_field) in {"destroyed", "deleted"}:
            return
        if machine.get("labels", {}).get(label) != OWNER:
            raise RuntimeError("Refusing to delete a machine without its fixture label")
        request(url + ("?force=true" if legacy else ""), "DELETE", missing_ok=True)

        def deleted():
            current = request(url, missing_ok=True)
            return current is None or current.get(status_field) in {"destroyed", "deleted"}

        wait_for(deleted, "fixture deletion")
        print(f"Verified {'v0' if legacy else 'v2'} fixture deletion", flush=True)

    try:
        machine = request(V0, "POST", {
            "name": label, "snapshot": "daytona-medium", "public": False,
            "labels": labels, "autoStopInterval": 60,
            "autoArchiveInterval": 1440, "autoDeleteInterval": -1,
        })
        source = machine["id"]
        src_url = f"{V0}/{source}"
        print("Created v0 fixture", source, flush=True)
        backups = []
        for cycle in range(2 if double_cycle else 1):
            if cycle:
                request(src_url + "/start", "POST")
            marker = uuid.uuid4().hex
            machine = wait_for(lambda: state(src_url, "state", {"started"}), "v0 start")
            if not machine.get("toolboxProxyUrl"):
                machine["toolboxProxyUrl"] = "https://proxy.app.daytona.io/toolbox"
            result = request(toolbox(machine, "toolboxProxyUrl", ".daytona.io") + "/process/execute", "POST", {
                "command": f"bash -c 'mkdir -p /home/daytona/workspace && printf {marker} > {CANARY_PATH}'",
                "timeout": 5000,
            })
            if result["exitCode"] != 0:
                raise RuntimeError("Could not write the synthetic canary")
            request(src_url + "/stop", "POST")
            wait_for(lambda: state(src_url, "state", {"stopped"}), "v0 stop")
            request(src_url + "/archive", "POST")
            archived = wait_for(importable, "Daytona declaring the v0 fixture importable", seconds=900)
            backups.append(datetime.fromisoformat(archived["last_backup_at"]))
        if double_cycle and backups[1] <= backups[0]:
            raise RuntimeError("Second archive did not advance the completed-backup timestamp")
        import_attempted = True
        imported = request(f"{MIGRATION}/{source}/import", "POST", {"force": False})
        destination = imported["sandbox_id"]
        print("Imported v2 fixture; warnings:", len(imported.get("warnings") or []), flush=True)
        dest_url = f"{V2}/{destination}"
        machine = wait_for(lambda: state(dest_url, "status", {"running", "stopped", "paused"}), "v2 import")
        if machine.get("labels", {}).get(label) != OWNER or not machine.get("persistent"):
            raise RuntimeError("Import did not preserve ownership and persistence")
        policy = request(dest_url + "/lifecycle-policy", "PATCH", {
            "idle_expiry_seconds": 3600, "on_idle_timeout": "pause",
            "timeout_seconds": 86400, "on_timeout": "pause",
        })["lifecycle_policy"]
        if policy.get("idle_expiry_seconds") != 3600 or policy.get("on_idle_timeout") != "pause":
            raise RuntimeError("v2 lifecycle policy did not take")
        if machine["status"] != "running":
            action = "resume" if machine["status"] == "paused" else "start"
            request(f"{dest_url}/{action}", "POST")
            machine = wait_for(lambda: state(dest_url, "status", {"running"}), "v2 start")
        url = toolbox(machine, "toolbox_proxy_url", ".daytona.app")
        path = urllib.parse.urlencode({"path": CANARY_PATH})
        actual = request(f"{url}/files/download?{path}", binary=True)
        if actual != marker.encode():
            raise RuntimeError("Imported canary did not match")
        print("Verified imported filesystem, exact owner label, and one-hour pause policy", flush=True)
        if compare_restored_source:
            # Restore only after the importer has consumed the archived source.
            # This establishes what reopening v0 would return from that archive.
            source_record = request(src_url)
            if source_record.get("state") != "archived" or source_record.get("labels", {}).get(label) != OWNER:
                raise RuntimeError("Original fixture is no longer the expected archive")
            request(src_url + "/start", "POST")
            source_record = wait_for(lambda: state(src_url, "state", {"started"}), "v0 archive restore")
            source_record["toolboxProxyUrl"] = source_record.get("toolboxProxyUrl") or "https://proxy.app.daytona.io/toolbox"
            restored_toolbox = toolbox(source_record, "toolboxProxyUrl", ".daytona.io")
            restored = wait_for(
                lambda: (request(f"{restored_toolbox}/files/download?{path}", binary=True),),
                "restored v0 Toolbox",
            )[0]
            if restored != actual:
                raise RuntimeError("The restored v0 and imported v2 canaries differed")
            print("Verified the restored v0 archive and imported v2 copy serve the same final canary", flush=True)
        runtime = request(f"{url}/processes?waitMs=8000&logs=text", "POST", {
            "argv": ["python3", "-c", PROBE_RUNTIME], "timeoutMs": 7000,
        })
        if runtime.get("exitCode") != 0:
            raise RuntimeError("Imported launcher runtime probe failed")
        frames = runtime["logs"]["frames"]
        print("Imported launcher runtime:", json.loads("".join(
            frame["data"] for frame in frames if frame.get("channel") == "stdout")), flush=True)
        alias = request(f"{url}/processes?waitMs=8000&logs=text", "POST", {
            "argv": ["bash", "-c", QUALIFY_NOVNC_ALIAS], "timeoutMs": 7000,
        })
        if alias.get("exitCode") != 0:
            raise RuntimeError("Could not qualify Lathe's noVNC path on the disposable import")
        print("Verified Lathe's /opt/novnc path on the imported workspace", flush=True)
    finally:
        try:
            # Recover an import whose response was lost before we recorded its ID.
            if import_attempted and not destination:
                destination = (migration_source() or {}).get("imported_sandbox_id")
            cleanup(V2, destination, "status")
        finally:
            cleanup(V0, source, "state", legacy=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--double-cycle", action="store_true", help="Prove the importer selects the second of two archives")
    parser.add_argument("--compare-restored-source", action="store_true",
        help="After import, restore the original fixture and compare its canary with the v2 copy")
    args = parser.parse_args()
    if not args.live:
        parser.error("--live is required to create and delete disposable resources")
    key = os.environ.get("DAYTONA_API_KEY")
    if not key:
        parser.error("DAYTONA_API_KEY is required")
    try:
        qualify(key, double_cycle=args.double_cycle, compare_restored_source=args.compare_restored_source)
    except (RuntimeError, OSError) as error:
        parser.exit(1, f"Fixture qualification failed: {error}\n")


if __name__ == "__main__":
    main()
