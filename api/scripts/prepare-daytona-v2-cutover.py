#!/usr/bin/env python3
"""Audit, prepare, and finalize a quiesced Daytona migration.

Default: read-only fleet audit. --prepare --state-dir DIR starts imports and
records their provenance; repeat with the same DIR until all are ready.
Inspect the imported filesystems and launchers, then leave the destinations
paused or stopped. --finalize --state-dir DIR captures the final activity
baseline and generates D1 SQL. Keep both fleets closed to activity throughout.
This script never writes D1 or replaces an unproven import.
"""

import argparse
import datetime
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
V0 = "https://app.daytona.io/api/sandbox"
V2 = "https://api.daytona.com/sandboxes"
IMPORT = "https://api.daytona.com/migration/v0/sandboxes"
LABEL = "chat.bayleaf.dev"
MIGRATED_TO = "daytona.io/migrated-to"
DEFAULT_QUALIFIED_REGION = "us-east-ash-1"
POLICY = {"idle_expiry_seconds": 3600, "on_idle_timeout": "pause",
          "timeout_seconds": 86400, "on_timeout": "pause"}
SLEEPING = {"stopped", "paused"}
PENDING = {"queued", "pending", "assigned", "booting", "pausing", "stopping"}
V0_RESOURCES = ("cpu", "memory", "disk")
V2_RESOURCES = ("cpu", "cores_max", "memory_mib", "memory_max_mib", "disk_max_mib")
UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")
V2_ID = re.compile(r"sbx_[A-Za-z0-9_-]+")
STAMP = re.compile(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})")
EPOCH = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def provider_client(key):
    opener = urllib.request.build_opener(NoRedirect())

    def provider(url, method="GET", body=None):
        request = urllib.request.Request(
            url, method=method,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            data=None if body is None else json.dumps(body).encode(),
        )
        try:
            with opener.open(request, timeout=45) as reply:
                return json.load(reply)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"Daytona {method} failed: HTTP {error.code}") from None

    return provider


def inventory(provider, endpoint, items_key, cursor_key):
    query = {"limit": 100}
    seen = set()
    for _ in range(100):
        page = provider(f"{endpoint}?{urllib.parse.urlencode(query)}")
        if not isinstance(page.get(items_key), list) or cursor_key not in page:
            raise RuntimeError("Invalid Daytona inventory page or missing terminal cursor")
        yield from page[items_key]
        cursor = page[cursor_key]
        if cursor is None:
            return
        if not isinstance(cursor, str) or not cursor or cursor in seen:
            break
        seen.add(cursor)
        query["cursor"] = cursor
    raise RuntimeError("Daytona inventory pagination did not complete")


def by_owner(records, id_field, pattern):
    owned = {}
    ids = set()
    for row in records:
        owner = (row.get("labels") or {}).get(LABEL)
        if owner is None:
            continue
        if not isinstance(owner, str) or not owner or "\x00" in owner or owner != owner.strip().lower() or owner in owned:
            raise RuntimeError("Noncanonical or duplicate owner identity")
        ident = row.get(id_field)
        if not isinstance(ident, str) or not pattern.fullmatch(ident) or ident in ids:
            raise RuntimeError("Daytona inventory returned an invalid or duplicate owned ID")
        owned[owner] = row
        ids.add(ident)
    return owned


def nanoseconds(stamp):
    match = STAMP.fullmatch(stamp) if isinstance(stamp, str) else None
    if not match:
        raise RuntimeError("Invalid or missing Daytona timestamp")
    clock, fraction, zone = match.groups()
    delta = datetime.datetime.fromisoformat(clock + ("+00:00" if zone == "Z" else zone)) - EPOCH
    return (delta.days * 86400 + delta.seconds) * 10**9 + int((fraction or "").ljust(9, "0"))


def resources(machine, fields):
    values = {field: machine.get(field) for field in fields}
    if any(type(value) not in (int, float) or not math.isfinite(value) or value <= 0 for value in values.values()):
        raise RuntimeError("Daytona detail omitted valid resource sizing")
    return values


def d1_bindings():
    # Capture private output without logging owner or ID data.
    d1 = subprocess.run([str(ROOT / "node_modules/.bin/wrangler"), "d1", "execute", "bayleaf-keys",
        "--remote", "--json", "--command",
        "SELECT u.email,u.daytona_sandbox_id,EXISTS(SELECT 1 FROM sandbox_credentials c "
        "WHERE c.email=u.email AND c.sandbox_id=u.daytona_sandbox_id AND c.state='active') AS managed "
        "FROM user_keys u WHERE u.daytona_sandbox_id IS NOT NULL"],
        cwd=ROOT, check=True, capture_output=True, text=True, timeout=45)
    response = json.loads(d1.stdout)
    if len(response) != 1 or response[0].get("success") is not True:
        raise RuntimeError("D1 inventory did not return one successful result")
    return response[0]["results"]


def fleet(provider):
    sources = by_owner(inventory(provider, V0, "items", "nextCursor"), "id", UUID)
    imports = by_owner(inventory(provider, IMPORT, "sandboxes", "next_cursor"), "v0_id", UUID)
    search = inventory(provider, f"{V2}/search", "sandboxes", "next_cursor")
    targets = by_owner((m for m in search if m.get("status") != "deleted"), "id", V2_ID)
    if not sources or set(sources) != set(imports):
        raise RuntimeError("Daytona v0 and import inventories are empty or disagree")
    pointers = {}
    for owner, entry in imports.items():
        dest = entry.get("imported_sandbox_id")
        if dest is not None and (not isinstance(dest, str) or not V2_ID.fullmatch(dest)):
            raise RuntimeError("Migration inventory returned an invalid destination")
        if dest is not None:
            pointers[owner] = dest
    if len(set(pointers.values())) != len(pointers) or any(
            m["id"] != pointers.get(owner) for owner, m in targets.items()):
        raise RuntimeError("A labeled v2 workspace is not the unique known import")

    snapshot, labels = {}, {}
    for owner, source in sorted(sources.items()):
        entry = imports[owner]
        if source["id"] != entry["v0_id"] or source.get("state") != "archived" or entry.get("importable") is not True:
            raise RuntimeError("At least one owned workspace is not ready for import")
        activity = source.get("lastActivityAt")
        backup = entry.get("last_backup_at")
        if nanoseconds(backup) < nanoseconds(activity):
            raise RuntimeError("A backup predates the recorded source activity; establish a fresh archive before importing")
        expected = {"v0_id": source["id"], "source_activity": activity, "last_backup_at": backup}
        detail = source_detail(provider, owner, expected)
        snapshot[owner] = {**expected, "v0_resources": resources(detail, V0_RESOURCES)}
        labels[owner] = detail["labels"].get(MIGRATED_TO)
    return snapshot, pointers, targets, labels


def check_bindings(snapshot, rows):
    cached = {row["email"]: row["daytona_sandbox_id"] for row in rows}
    if len(cached) != len(rows) or cached != {owner: m["v0_id"] for owner, m in snapshot.items()}:
        raise RuntimeError("D1 and the Daytona v0 bindings do not agree exactly")
    return sorted(row["email"] for row in rows if row["managed"])


def source_detail(provider, owner, source):
    machine = provider(f"{V0}/{source['v0_id']}")
    labels = machine.get("labels") or {}
    if (machine.get("id") != source["v0_id"] or machine.get("state") != "archived" or
            machine.get("lastActivityAt") != source["source_activity"] or labels.get(LABEL) != owner):
        raise RuntimeError("A source changed after inventory; keep writes closed and reconcile")
    if "v0_resources" in source and resources(machine, V0_RESOURCES) != source["v0_resources"]:
        raise RuntimeError("Source sizing changed after inventory; reconcile before continuing")
    return machine


def check_receipts(snapshot, pointers, receipts):
    if receipts.keys() - snapshot.keys() or any(
            owner not in receipts or receipts[owner]["v2_id"] != dest for owner, dest in pointers.items()):
        raise RuntimeError("An existing import has no matching backup receipt; reconcile it before proceeding")
    if len({m["v2_id"] for m in receipts.values()}) != len(receipts):
        raise RuntimeError("Import receipts contain duplicate destinations")


def import_workspace(provider, owner, source, pointer, receipt, save):
    label = source_detail(provider, owner, source)["labels"].get(MIGRATED_TO)
    if receipt is not None:
        if pointer != receipt["v2_id"] or label not in (None, pointer):
            raise RuntimeError("A recorded import no longer matches the provider; reconcile it before proceeding")
        if receipt["v0_labeled"] and label == pointer:
            return receipt
    elif pointer is not None or label is not None:
        raise RuntimeError("Refusing to reuse an import without exact backup provenance")

    result = provider(f"{IMPORT}/{source['v0_id']}/import", "POST", {"force": False})
    dest = result.get("sandbox_id")
    if (not isinstance(dest, str) or not V2_ID.fullmatch(dest) or
            result.get("existing") is not (receipt is not None) or
            (receipt is not None and dest != pointer) or type(result.get("v0_labeled")) is not bool):
        raise RuntimeError("Import response did not prove the expected destination and reuse status")
    if receipt is None:
        missing = result["secret_env_vars"]
        warnings = result["warnings"]
        if not isinstance(missing, list) or not isinstance(warnings, list):
            raise RuntimeError("Import response did not report warnings and omitted secrets")
        receipt = {"v2_id": dest, "import_warnings": warnings, "omitted_secrets": missing}
    receipt["v0_labeled"] = result["v0_labeled"]
    save(receipt)
    # Save even a false label result: a retry may repair this exact import.
    if not receipt["v0_labeled"] or source_detail(provider, owner, source)["labels"].get(MIGRATED_TO) != dest:
        raise RuntimeError("Daytona did not confirm the v0 migration label; retry preparation with the same state")
    return receipt


def destination(provider, owner, dest, regions, states):
    machine = provider(f"{V2}/{dest}")
    if (machine.get("id") != dest or (machine.get("labels") or {}).get(LABEL) != owner or
            machine.get("persistent") is not True or machine.get("status") not in states):
        raise RuntimeError("Destination failed ownership, state, or persistence checks")
    if machine.get("region_id") not in regions:
        raise RuntimeError("An import landed outside the qualified preview regions")
    return machine


def check_omissions(receipt, managed):
    if set(receipt["omitted_secrets"]) - ({"BAYLEAF_API_KEY"} if managed else set()):
        raise RuntimeError("An import needs explicit migration of existing sandbox secrets")


def policy_matches(policy):
    return isinstance(policy, dict) and all(policy.get(key) == value for key, value in POLICY.items())


def correlated_fleet(provider, state):
    snapshot, pointers, targets, labels = fleet(provider)
    receipts = state["imports"]
    if snapshot != state["source"] or pointers != {owner: m["v2_id"] for owner, m in receipts.items()} or set(targets) != set(snapshot):
        raise RuntimeError("Source backup or destination inventory changed; do not rebind")
    for owner in snapshot:
        if not receipts[owner]["v0_labeled"] or labels[owner] != pointers[owner]:
            raise RuntimeError("The v0 migration label did not confirm the prepared destination")


def prepare_imports(provider, directory, state, pointers, regions):
    receipts = state["imports"]
    check_receipts(state["source"], pointers, receipts)
    if state["prepared"]:
        correlated_fleet(provider, state)
        print("Imports are already prepared. Complete inspection, then run --finalize.")
        return
    pending = 0
    for owner, source in state["source"].items():
        def save(receipt):
            receipts[owner] = receipt
            write_state(directory, state)

        managed = owner in state["managed"]
        receipt = import_workspace(provider, owner, source, pointers.get(owner), receipts.get(owner), save)
        check_omissions(receipt, managed)
        dest = receipt["v2_id"]
        machine = destination(provider, owner, dest, regions, SLEEPING | PENDING | {"running"})
        if machine["status"] in PENDING:
            pending += 1
            continue
        if not policy_matches(machine.get("lifecycle_policy")):
            result = provider(f"{V2}/{dest}/lifecycle-policy", "PATCH", POLICY)
            if not policy_matches(result.get("lifecycle_policy")):
                raise RuntimeError("Destination did not accept the lifecycle policy")
    if pending:
        print(f"{pending} imports are still pending. Repeat --prepare with the same state directory.")
        return
    correlated_fleet(provider, state)
    state["prepared"] = True
    write_state(directory, state)
    print(f"{len(receipts)} imports are ready for inspection. No binding SQL has been generated.")


def finalize(provider, directory, state, regions):
    if not state["prepared"]:
        raise RuntimeError("Preparation has not finished")
    correlated_fleet(provider, state)
    manifest = []
    for owner, source in state["source"].items():
        receipt = state["imports"][owner]
        dest = receipt["v2_id"]
        machine = destination(provider, owner, dest, regions, SLEEPING)
        policy = machine.get("lifecycle_policy")
        if not policy_matches(policy):
            raise RuntimeError("The inspected destination no longer has the qualified lifecycle policy")
        manifest.append({
            "email": owner, **source, "v2_id": dest, "region": machine["region_id"],
            "v2_resources": resources(machine, V2_RESOURCES),
            "source_activity_ms": nanoseconds(source["source_activity"]) // 10**6,
            "baseline_activity": policy.get("last_activity_at"),
            "baseline_activity_ms": nanoseconds(policy.get("last_activity_at")) // 10**6,
            "reissue_managed_access": owner in state["managed"],
            "import_warnings": receipt["import_warnings"],
        })
    correlated_fleet(provider, state)
    for row in manifest:
        machine = destination(provider, row["email"], row["v2_id"], regions, SLEEPING)
        policy = machine.get("lifecycle_policy")
        if (machine["region_id"] != row["region"] or not policy_matches(policy) or
                resources(machine, V2_RESOURCES) != row["v2_resources"] or
                policy.get("last_activity_at") != row["baseline_activity"]):
            raise RuntimeError("Destination changed while capturing the final baseline; keep traffic closed")
    if check_bindings(state["source"], d1_bindings()) != state["managed"]:
        raise RuntimeError("Managed credential inventory changed")
    write_handoff(directory, manifest)
    print(f"Wrote a private handoff for {len(manifest)} imports in state-dir/handoff. No D1 changes made.")


def handoff_sql(manifest):
    """Each operation is one INSERT. SQLite ABORT backs out the entire statement,
    including writes by its trigger (https://sqlite.org/lang_conflict.html).
    Guard setup and removal are separate DDL, outside that atomic operation.
    """
    columns = ("email", "v0_id", "v2_id", "source_activity_ms", "baseline_activity_ms")
    payload = json.dumps([{key: m[key] for key in columns} for m in manifest], separators=(",", ":"))
    digest = hashlib.sha256(payload.encode()).hexdigest()[:24]
    guard = f"bayleaf_cutover_{digest}"
    records = f"{guard}_manifest"
    projection = "SELECT " + ", ".join(
        f"json_extract(value, '$.{key}') AS {key}" for key in columns
    ) + " FROM json_each('" + payload.replace("'", "''") + "')"
    count = len(manifest)

    def matching_activity(table):
        return f"""{table}.sandbox_id=m.v2_id AND {table}.source_id=m.v0_id
      AND {table}.source_activity_ms=m.source_activity_ms AND {table}.baseline_activity_ms=m.baseline_activity_ms"""

    related_activity = "a.sandbox_id=m.v2_id OR a.source_id=m.v0_id"

    def counts(binding):
        return f"""SELECT
  (SELECT COUNT(*) FROM user_keys WHERE daytona_sandbox_id IS NOT NULL) AS total_bound,
  (SELECT COUNT(*) FROM user_keys u JOIN {records} m
    ON u.email=m.email AND u.daytona_sandbox_id=m.{binding}) AS exact_bindings,
  (SELECT COUNT(*) FROM sandbox_import_activity a WHERE EXISTS
    (SELECT 1 FROM {records} m WHERE {related_activity})) AS related_activity,
  (SELECT COUNT(*) FROM sandbox_import_activity a JOIN {records} m
    ON {matching_activity('a')}) AS exact_activity"""

    def verified(count_query, activity):
        return f"""SELECT total_bound={count} AND exact_bindings={count}
      AND related_activity={activity} AND exact_activity={activity} FROM ({count_query})"""

    before = counts("v0_id")
    after = counts("v2_id")
    is_before, is_after = verified(before, 0), verified(after, count)
    insert_activity = f"""INSERT INTO sandbox_import_activity
      (sandbox_id,source_id,source_activity_ms,baseline_activity_ms)
    SELECT m.v2_id,m.v0_id,m.source_activity_ms,m.baseline_activity_ms FROM {records} m
    WHERE NOT EXISTS (SELECT 1 FROM sandbox_import_activity a WHERE a.sandbox_id=m.v2_id);"""
    delete_activity = f"""DELETE FROM sandbox_import_activity WHERE EXISTS
      (SELECT 1 FROM {records} m WHERE {matching_activity('sandbox_import_activity')});"""
    setup = [f"CREATE VIEW IF NOT EXISTS {records} AS {projection};"]
    for name, old, new, check_old, check_new, change_activity in (
        ("forward", "v0_id", "v2_id", is_before, is_after, insert_activity),
        ("rollback", "v2_id", "v0_id", is_after, is_before, delete_activity),
    ):
        # A view is unwritable if its trigger was not installed.
        setup.append(f"""CREATE VIEW IF NOT EXISTS {guard}_{name} AS SELECT 1 AS apply;
CREATE TRIGGER IF NOT EXISTS {guard}_{name}_apply
INSTEAD OF INSERT ON {guard}_{name}
BEGIN
  SELECT CASE WHEN NOT (({check_old}) OR ({check_new}))
    THEN RAISE(ABORT, 'Unexpected fleet state; no bindings changed') END;
  {change_activity}
  UPDATE user_keys SET daytona_sandbox_id=(
    SELECT m.{new} FROM {records} m WHERE m.email=user_keys.email
  ) WHERE EXISTS (SELECT 1 FROM {records} m
    WHERE m.email=user_keys.email AND m.{old}=user_keys.daytona_sandbox_id);
  SELECT CASE WHEN NOT ({check_new})
    THEN RAISE(ABORT, 'Fleet verification failed; all binding changes rolled back') END;
END;""")
    return {
        "install-guard.sql": "\n\n".join(setup) + "\n",
        "cutover.sql": f"INSERT INTO {guard}_forward(apply) VALUES (1);\n",
        "verify.sql": f"SELECT *, ({is_after}) AS verified FROM ({after});\n",
        "rollback.sql": f"-- Only before v2 writes, or after offline reconciliation.\n"
                        f"INSERT INTO {guard}_rollback(apply) VALUES (1);\n",
        "verify-rollback.sql": f"SELECT *, ({is_before}) AS verified FROM ({before});\n",
        "remove-guard.sql": f"DROP VIEW IF EXISTS {guard}_forward;\nDROP VIEW IF EXISTS {guard}_rollback;\n"
                            f"DROP VIEW IF EXISTS {records};\n",
    }


def write_state(directory, state):
    with tempfile.NamedTemporaryFile(mode="w", dir=directory, delete=False) as output:
        try:
            json.dump(state, output, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
            os.replace(output.name, directory / "state.json")
        finally:
            Path(output.name).unlink(missing_ok=True)


def write_handoff(directory, manifest):
    handoff = directory / "handoff"
    if handoff.exists():
        raise RuntimeError("Refusing to replace a finalized handoff")
    with tempfile.TemporaryDirectory(dir=directory) as staging:
        output = Path(staging) / "handoff"
        output.mkdir(mode=0o700)
        for name, text in {"mapping.json": json.dumps(manifest, indent=2) + "\n", **handoff_sql(manifest)}.items():
            with os.fdopen(os.open(output / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
                file.write(text)
        output.rename(handoff)


def run(args, provider):
    if not (args.prepare or args.finalize):
        snapshot, _, targets, _ = fleet(provider)
        check_bindings(snapshot, d1_bindings())
        print(f"Exact v0 owner bindings verified: {len(snapshot)}; labeled v2 imports in search: {len(targets)}")
        return
    directory = args.state_dir.expanduser().resolve()
    if ROOT.parent in (directory, *directory.parents):
        raise RuntimeError("Keep the owner/ID manifest outside the repository")
    if args.prepare:
        directory.mkdir(mode=0o700, exist_ok=True)
    info = directory.stat()
    if not directory.is_dir() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError("The state directory must be private and owned by the operator")
    with os.fdopen(os.open(directory / ".lock", os.O_RDWR | os.O_CREAT, 0o600), "r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        snapshot, pointers, _, _ = fleet(provider)
        managed = check_bindings(snapshot, d1_bindings())
        state_file = directory / "state.json"
        if state_file.exists():
            state = json.loads(state_file.read_text())
            if state["source"] != snapshot or state["managed"] != managed:
                raise RuntimeError("Source backup, activity or credential inventory differs from preparation")
        elif args.prepare and not pointers:
            state = {"source": snapshot, "managed": managed, "imports": {}, "prepared": False}
            write_state(directory, state)
        else:
            raise RuntimeError("No preparation ledger for this fleet; reconcile any unproven imports first")
        if args.prepare:
            prepare_imports(provider, directory, state, pointers, args.qualified_region)
        else:
            finalize(provider, directory, state, args.qualified_region)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    stage = parser.add_mutually_exclusive_group()
    stage.add_argument("--prepare", action="store_true", help="Copy the quiesced v0 fleet; never deletes originals")
    stage.add_argument("--finalize", action="store_true", help="Assert inspection is complete; capture sleeping destination baselines")
    parser.add_argument("--state-dir", type=Path, help="Private state directory outside the repository")
    parser.add_argument("--qualified-region", action="append",
        help="Destination region already qualified by the gateway; repeat to list each (default: Ashburn only)")
    args = parser.parse_args()
    args.qualified_region = args.qualified_region or [DEFAULT_QUALIFIED_REGION]
    if (args.prepare or args.finalize) and not args.state_dir:
        parser.error("--prepare and --finalize require --state-dir, with both fleets quiesced")
    key = os.environ.get("DAYTONA_API_KEY")
    if not key:
        parser.error("DAYTONA_API_KEY is required")
    try:
        run(args, provider_client(key))
    except (OSError, RuntimeError, subprocess.SubprocessError, ValueError, KeyError, TypeError, AttributeError) as error:
        message = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        parser.exit(1, f"Cutover preparation failed: {message}\n")
