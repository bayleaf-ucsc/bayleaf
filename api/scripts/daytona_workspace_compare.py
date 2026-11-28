"""Request and validate content-free home digests through Daytona Toolbox."""

import base64
import http.client
import json
import os
from pathlib import Path
import re
import shlex
import stat
import tempfile
import time
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlsplit

# The whole home, including owner app state outside the default project.
SCAN_ROOT = "/home/daytona"
EXEC_MS = 115_000
READ_ATTEMPTS = 4
SETTLE_S = 120
RESTORE_S = 900  # A v0 archive restore can take many minutes.
V0 = "https://app.daytona.io/api/sandbox"
V2 = "https://api.daytona.com/sandboxes"
IMPORT = "https://api.daytona.com/migration/v0/sandboxes"
OWNER_LABEL = "chat.bayleaf.dev"
MIGRATION_LABEL = "daytona.io/migrated-to"
LEDGER = "archive-equivalence.json"
PENDING = "archive-comparison-pending.json"


def read(provider, url):
    """GET with bounded retry. Lifecycle and process POSTs are never retried."""
    for attempt in range(READ_ATTEMPTS):
        try:
            return provider(url)
        except (OSError, http.client.HTTPException, RuntimeError) as error:
            transient = (isinstance(error, (OSError, http.client.HTTPException))
                         and not isinstance(error, HTTPError)) or (
                isinstance(error, RuntimeError) and re.search(r"HTTP (408|429|5\d\d)$", str(error)))
            if not transient or attempt == READ_ATTEMPTS - 1:
                raise
        time.sleep(2 ** attempt)


def read_digest(output):
    try:
        result = json.loads(output)
    except (TypeError, ValueError):
        raise RuntimeError("Workspace digest process did not return valid JSON") from None
    if (not isinstance(result, dict) or result.keys() != {"version", "sha256", "entries"}
            or type(result["version"]) is not int or result["version"] != 2
            or not isinstance(result["sha256"], str)
            or not re.fullmatch(r"[0-9a-f]{64}", result["sha256"])
            or type(result["entries"]) is not int or result["entries"] < 1):
        raise RuntimeError("Workspace digest process returned an invalid summary")
    return result


def v2_logs(result):
    """Split one complete v2 log page; the small digest summary never paginates."""
    logs = result.get("logs")
    if (result.get("truncatedHead") or not isinstance(logs, dict) or logs.get("truncatedHead")
            or logs.get("eof") is not True or not isinstance(logs.get("frames"), list)
            or any(not isinstance(frame, dict) or not isinstance(frame.get("data"), str)
                   for frame in logs["frames"])):
        raise RuntimeError("v2 workspace digest output is incomplete")
    frames = logs["frames"]
    return ("".join(frame["data"] for frame in frames if frame.get("channel") == "stdout"),
            "".join(frame["data"] for frame in frames if frame.get("channel") == "stderr"))


def toolbox_digest(provider, url, *, legacy, root=SCAN_ROOT):
    probe = Path(__file__).with_name("daytona-workspace-digest.py").read_bytes()
    # Keep the script on one shell line for the legacy command transport.
    encoded = base64.b64encode(probe)
    loader = f"import base64; exec(base64.b64decode({encoded!r}))"
    argv = ["python3", "-I", "-S", "-c", loader, root]
    if legacy:
        result = provider(url + "/process/execute", "POST", {
            "command": shlex.join(argv), "timeout": EXEC_MS,
        }, timeout=135)
        output = result.get("result")
        diagnostic = output
    else:
        result = provider(url + f"/processes?waitMs={EXEC_MS + 5000}&logs=text", "POST", {
            "argv": argv, "timeoutMs": EXEC_MS,
        }, timeout=135)
        output, diagnostic = v2_logs(result)
    if result.get("exitCode") != 0:
        tier = "v0" if legacy else "v2"
        reason = re.search(
            r"^workspace digest failed: (tree changed|nested filesystem|invalid mount information|depth limit|entry limit|"
            r"byte limit|unsupported entry type|unexpected entrypoint runtime entry|"
            r"scan root is not a directory|time limit|scan error|invalid scope)$",
            diagnostic or "", re.MULTILINE,
        )
        if reason:
            raise RuntimeError(f"{tier} workspace digest failed: {reason[1]}")
        exit_code = result.get("exitCode")
        status = f"exit {exit_code}" if type(exit_code) is int else "no exit status"
        raise RuntimeError(f"{tier} workspace digest process failed ({status})")
    return read_digest(output)


def toolbox_url(machine, *, legacy):
    if legacy:
        host = r"proxy\.app\.daytona\.io"
        target = machine.get("toolboxProxyUrl") or "https://proxy.app.daytona.io/toolbox"
    else:
        host = r"proxy\.[a-z0-9.-]+\.daytona\.app"
        target = machine.get("toolbox_proxy_url") or ""
    url = urlsplit(target)
    if (url.scheme != "https" or not re.fullmatch(host, url.netloc)
            or url.path.rstrip("/") != "/toolbox" or url.query or url.fragment):
        raise RuntimeError("Unexpected Daytona Toolbox origin")
    return f"https://{url.netloc}/toolbox/{quote(machine['id'], safe='')}"


def migration_rows(provider):
    rows = {}
    seen = set()
    params = {"limit": 100}
    while len(seen) < 100:
        page = read(provider, f"{IMPORT}?{urlencode(params)}")
        for row in page["sandboxes"]:
            ident = row["v0_id"]
            if ident in rows:
                raise RuntimeError("Duplicate migration source during archive comparison")
            rows[ident] = row
        cursor = page["next_cursor"]
        if cursor is None:
            return rows
        if not isinstance(cursor, str) or not cursor or cursor in seen:
            break
        seen.add(cursor)
        params["cursor"] = cursor
    raise RuntimeError("Migration inventory did not finish")


def unique_object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise RuntimeError("Archive comparison JSON contains duplicate keys")
    return result


def load_private(path):
    """Read an operator-private JSON file, or None if absent. Never follow links."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError:
        raise RuntimeError(f"Unsafe archive comparison file: {path.name}") from None
    with os.fdopen(fd) as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError(f"Unsafe archive comparison file: {path.name}")
        return json.load(handle, object_pairs_hook=unique_object)


def save_private(path, value):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        try:
            json.dump(value, handle)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
    sync_directory(path.parent)


def remove_private(path):
    path.unlink(missing_ok=True)
    sync_directory(path.parent)


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def compare_archives(provider, directory, state, regions):
    if not state.get("archive_equivalence") or not state.get("prepared"):
        raise RuntimeError("Prepare provisional imports before comparing archives")
    path = directory / LEDGER
    receipts = load_private(path)
    receipts = {} if receipts is None else receipts
    sources = state["source"]
    if not isinstance(receipts, dict) or receipts.keys() - sources.keys():
        raise RuntimeError("Comparison ledger disagrees with the import journal")

    # Written durably before any v0 start: proof that this tool, not an
    # unknown writer, moved the source out of its archive.
    pending_path = directory / PENDING
    pending = load_private(pending_path)
    if pending is not None:
        owner = pending.get("owner") if isinstance(pending, dict) else None
        if (not isinstance(pending, dict) or pending.keys() != {"owner", "v0_id", "v2_id"}
                or not isinstance(owner, str) or owner not in sources or pending["v0_id"] != sources[owner]["v0_id"]
                or pending["v2_id"] != state["imports"][owner]["v2_id"]):
            raise RuntimeError("Pending comparison marker disagrees with the import journal")
        if owner in receipts:
            remove_private(pending_path)  # The receipt landed; only cleanup was interrupted.
            pending = None

    # Recover an interrupted restore before touching any other workspace.
    order = sorted(sources, key=lambda owner: pending is None or owner != pending["owner"])
    for owner in order:
        if owner in receipts:
            continue  # Finalize independently verifies every receipt and live binding.
        pinned = sources[owner]
        imported = state["imports"][owner]
        v0_id, v2_id = pinned["v0_id"], imported["v2_id"]
        resuming = pending is not None and pending["owner"] == owner

        def exact(legacy):
            ident = v0_id if legacy else v2_id
            machine = read(provider, f"{V0 if legacy else V2}/{quote(ident, safe='')}")
            labels = machine.get("labels") or {}
            if machine.get("id") != ident or labels.get(OWNER_LABEL) != owner:
                raise RuntimeError("Workspace identity changed during comparison")
            if legacy and labels.get(MIGRATION_LABEL) != v2_id:
                raise RuntimeError("v0 migration label no longer matches the destination")
            if not legacy and (machine.get("persistent") is not True or machine.get("region_id") not in regions):
                raise RuntimeError("v2 destination region or persistence changed")
            return machine

        def linked_migration():
            row = migration_rows(provider).get(v0_id)
            if not row or row["imported_sandbox_id"] != v2_id or row["labels"].get(OWNER_LABEL) != owner:
                raise RuntimeError("Migration inventory no longer confirms the exact import")
            return row

        def wait(legacy, expected, seconds=SETTLE_S):
            field = "state" if legacy else "status"
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                machine = exact(legacy)
                if machine[field] in expected:
                    return machine
                if machine[field] in {"error", "build_failed", "failed", "lost", "deleted", "destroyed"}:
                    break
                time.sleep(2)
            raise RuntimeError("Workspace did not reach its expected lifecycle state")

        def stop_v0():
            # Outlast a restore still in flight, then stop exactly once. The
            # stopped disk stays bound for recovery; nothing is deleted.
            if wait(True, {"archived", "started", "stopped"}, RESTORE_S)["state"] == "started":
                provider(f"{V0}/{v0_id}/stop", "POST")
            return wait(True, {"archived", "stopped"}, RESTORE_S)

        def sleep_v2():
            if wait(False, {"running", "paused", "stopped"})["status"] == "running":
                provider(f"{V2}/{v2_id}/pause", "POST")
            return wait(False, {"paused", "stopped"})

        def v2_activity(machine):
            stamp = (machine.get("lifecycle_policy") or {}).get("last_activity_at")
            if not isinstance(stamp, str) or not stamp:
                raise RuntimeError("v2 destination did not report lifecycle activity")
            return stamp

        def check_archive():
            source = exact(True)
            migration = linked_migration()
            if migration.get("last_backup_at") != pinned["last_backup_at"] or imported.get("v0_labeled") is not True:
                raise RuntimeError("The original archive changed before comparison")
            if source.get("state") == "archived" and source.get("lastActivityAt") == pinned["source_activity"]:
                if migration.get("importable") is not True:
                    raise RuntimeError("The original archive changed before comparison")
            elif not (resuming and source.get("state") == "stopped"):
                # Only a durable marker from this tool explains a restored source.
                raise RuntimeError("The original archive changed before comparison")

        if resuming:
            stop_v0()
            sleep_v2()
        check_archive()
        dest = exact(False)
        if dest["status"] not in {"paused", "stopped", "running"}:
            raise RuntimeError("Destination is not ready for comparison")

        try:
            if dest["status"] != "running":
                action = "resume" if dest["status"] == "paused" else "start"
                provider(f"{V2}/{v2_id}/{action}", "POST")
            dest = wait(False, {"running"})
            target_digest = toolbox_digest(provider, toolbox_url(dest, legacy=False), legacy=False)
            # Sleep v2 before the long v0 restore so the compared state is the
            # one finalize will baseline.
            settled = v2_activity(sleep_v2())
            check_archive()
            if not resuming:
                save_private(pending_path, {"owner": owner, "v0_id": v0_id, "v2_id": v2_id})
                resuming = True
            # The v0 restore can change provider activity. Stop it even if the
            # comparison fails, keeping its binding and disk for recovery.
            try:
                provider(f"{V0}/{v0_id}/start", "POST")
                source = wait(True, {"started"}, RESTORE_S)
                source_digest = toolbox_digest(provider, toolbox_url(source, legacy=True), legacy=True)
            finally:
                source = stop_v0()
        finally:
            sleep_v2()
        if source_digest != target_digest:
            raise RuntimeError("Restored v0 and imported v2 workspace digests differ; do not rebind")
        if source["state"] != "stopped":
            raise RuntimeError("v0 source did not settle stopped after restore")
        if v2_activity(exact(False)) != settled:
            raise RuntimeError("v2 destination activity changed after its digest; compare again")
        migration = linked_migration()
        receipts[owner] = {
            "source": pinned, "v2_id": v2_id,
            "manifest_version": f"sha256-tree-v2:{SCAN_ROOT}",
            "manifest_sha256": source_digest["sha256"],
            "observed_v2_activity": settled,
            "observed_v0": {"state": source["state"], "source_activity": source["lastActivityAt"],
                            "last_backup_at": migration.get("last_backup_at")},
        }
        save_private(path, receipts)
        remove_private(pending_path)
        pending = None
        print(f"Verified archive comparison {len(receipts)}/{len(sources)}", flush=True)
