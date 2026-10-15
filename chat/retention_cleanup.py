# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx"]
# ///
"""
BayLeaf Chat — Retention Cleanup Job

Two-phase cleanup per RETENTION.md:

  Phase A: Delete conversations older than RETENTION_DAYS (default 90) with no
           recent activity. Users in any `hold:*` group are exempt.

  Phase B: Delete orphan files: file rows with no reference from any surviving
           chat or knowledge base, older than ORPHAN_GRACE_SECONDS (default
           86400 = 24h). The grace window protects in-flight uploads from
           temporary chats that have not yet been sent or saved.

Communicates exclusively through the OWUI admin API (no direct DB access).

Design principles:
  - Fails hard (non-zero exit) on ANY inconsistency or API error.
  - Logs are never sensitive: no user names, emails, chat titles, or IDs.
    Only aggregate counts appear in stdout.
  - DO App Platform captures stdout; configure "Failed job invocation" alert
    to get emailed on failures.
  - Phase B runs AFTER Phase A so that files attached to just-expired chats
    are correctly classified as orphans.

Usage:
    # Dry run (default): report what would be deleted
    uv run chat/retention_cleanup.py

    # Live run: actually delete
    DRY_RUN=false uv run chat/retention_cleanup.py

Environment:
    OWUI_URL              Base URL of the OWUI instance (required)
    OWUI_TOKEN            Admin bearer token (required)
    RETENTION_DAYS        Days of inactivity before chat deletion (default: 90)
    ORPHAN_GRACE_SECONDS  Min age for orphan file deletion (default: 86400)
    DRY_RUN               "true" (default) or "false"
"""

import argparse
from dataclasses import dataclass
import json
import math
import os
import re
import sys
import time
import httpx


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="BayLeaf Chat retention cleanup. Deletes conversations "
        "inactive for longer than RETENTION_DAYS. Users in hold:* groups are exempt.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
environment variables:
  OWUI_URL              Base URL of the OWUI instance (required)
  OWUI_TOKEN            Admin bearer token (required)
  RETENTION_DAYS        Days of inactivity before deletion (default: 90)
  RETENTION_SUNRISE     Policy announcement date, YYYY-MM-DD (optional).
                        Existing chats are treated as active until at least this
                        date, giving users a full RETENTION_DAYS grace period.
  ORPHAN_GRACE_SECONDS  Min age of an orphan file before deletion (default: 86400).
                        Protects in-flight uploads from temporary chats that have
                        not yet been sent or saved.
  DRY_RUN               "true" (default) or "false"

examples:
  # Dry run (default): report what would be deleted
  uv run chat/retention_cleanup.py

  # Live run: actually delete
  DRY_RUN=false uv run chat/retention_cleanup.py

  # Override retention period
  RETENTION_DAYS=30 uv run chat/retention_cleanup.py
""",
    )
    parser.add_argument(
        "--live", action="store_true",
        help="Run in live mode (actually delete). Overrides DRY_RUN env var.",
    )
    parser.add_argument(
        "--retention-days", type=int, default=None,
        help="Days of inactivity before deletion. Overrides RETENTION_DAYS env var.",
    )
    return parser.parse_args(argv)


@dataclass(frozen=True)
class Settings:
    retention_days: int = 90
    orphan_grace_seconds: int = 86400
    sunrise_ts: int | None = None
    dry_run: bool = True


def fail(msg: str):
    """Print error and exit non-zero. DO alerts trigger on this."""
    print(f"FATAL: {msg}", file=sys.stderr)
    sys.exit(1)


# --- API helpers (fail hard on any error) ---

def response_items(data, keys: tuple[str, ...], label: str) -> list[dict]:
    """Accept only known list envelopes, never interpret unknown data as empty."""
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict) and sum(key in data for key in keys) == 1:
        items = data[next(key for key in keys if key in data)]
    else:
        fail(f"Unexpected {label} response shape")
    if not isinstance(items, list) or any(
        not isinstance(item, dict)
        or not isinstance(item.get("id"), str)
        or not item["id"].strip()
        for item in items
    ):
        fail(f"Invalid {label} entries")
    return items


def page_finished(
    data, records: list[dict], batch: list[dict], label: str,
    page_size: int | None = None, expected_total: int | None = None,
) -> bool:
    """Require complete, non-repeating discovery before authorizing deletion.

    Users/chats also support lists or envelopes without totals, with OWUI's
    fixed 30-entry pages. Files/knowledge envelopes require an explicit total.
    """
    if len({item["id"] for item in records}) != len(records):
        fail(f"Duplicate {label} entries during pagination")
    if expected_total is not None and (
        not isinstance(data, dict) or data.get("total") != expected_total
    ):
        fail(f"Changed {label} pagination total")
    if isinstance(data, dict) and ("total" in data or page_size is None):
        total = data.get("total")
        if type(total) is not int or total < 0 or len(records) > total:
            fail(f"Invalid {label} pagination total")
        if len(records) == total:
            return True
        if not batch:
            fail(f"Incomplete {label} enumeration")
        return False
    return len(batch) < page_size


def require_timestamp(items: list[dict], field: str, label: str):
    if any(
        type(item.get(field)) not in (int, float)
        or not math.isfinite(item[field])
        for item in items
    ):
        fail(f"Invalid {label} timestamps")


def check_health(client: httpx.Client):
    """Verify OWUI is reachable and healthy before doing anything."""
    try:
        resp = client.get("/health")
    except httpx.RequestError as e:
        fail(f"Cannot reach OWUI: {e}")
    if resp.status_code != 200:
        fail(f"Health check returned HTTP {resp.status_code}")
    data = resp.json()
    if not data.get("status"):
        fail(f"Health check returned unhealthy: {data}")


def get_all_users(client: httpx.Client) -> list[dict]:
    """Paginate through all users.

    OWUI API quirk: page 1 (or no page param) returns a bare list;
    pages > 1 return {"users": [...], "total": N}.
    """
    users = []
    page = 1
    expected_total = None
    while True:
        try:
            resp = client.get("/api/v1/users/", params={"page": page})
        except httpx.RequestError:
            fail(f"Network error fetching users page {page}")
        if resp.status_code != 200:
            fail(f"Users endpoint returned HTTP {resp.status_code} on page {page}")
        data = resp.json()
        batch = response_items(data, ("users",), "users")
        users.extend(batch)
        if page_finished(data, users, batch, "users", page_size=30, expected_total=expected_total):
            break
        expected_total = data.get("total") if isinstance(data, dict) else None
        page += 1
        if page > 500:
            fail("Users pagination exceeded 500 pages; likely a bug")
    if not users:
        fail("Users list is empty (auth issue or misconfiguration?)")
    return users


def get_all_groups(client: httpx.Client) -> dict[str, str]:
    """Get all groups, return {group_id: group_name} mapping."""
    try:
        resp = client.get("/api/v1/groups/")
    except httpx.RequestError as e:
        fail(f"Network error fetching groups: {e}")
    if resp.status_code != 200:
        fail(f"Groups endpoint returned HTTP {resp.status_code}")
    groups = resp.json()
    if not isinstance(groups, list):
        fail(f"Unexpected groups response type: {type(groups).__name__}")
    return {g["id"]: g["name"] for g in groups}


def is_held(user: dict, group_map: dict[str, str]) -> bool:
    """Check if any of the user's groups is a hold:* group."""
    for gid in user.get("group_ids", []):
        name = group_map.get(gid, "")
        if name.startswith("hold:"):
            return True
    return False


def get_user_chats(client: httpx.Client, user_id: str) -> list[dict]:
    """Get all chats for a user via admin endpoint. Paginated."""
    chats = []
    page = 1
    expected_total = None
    while True:
        try:
            resp = client.get(
                f"/api/v1/chats/list/user/{user_id}", params={"page": page}
            )
        except httpx.RequestError:
            fail("Network error fetching chats")
        if resp.status_code != 200:
            fail(f"Chat list endpoint returned HTTP {resp.status_code}")
        data = resp.json()
        batch = response_items(data, ("chats", "items"), "chat list")
        require_timestamp(batch, "updated_at", "chat list")
        chats.extend(batch)
        if page_finished(data, chats, batch, "chat list", page_size=30, expected_total=expected_total):
            break
        expected_total = data.get("total") if isinstance(data, dict) else None
        page += 1
        if page > 500:
            fail("Chat pagination exceeded 500 pages; likely a bug")
    return chats


def delete_chat(client: httpx.Client, chat_id: str) -> bool:
    """Delete a single chat. Returns True on success."""
    try:
        resp = client.delete(f"/api/v1/chats/{chat_id}")
    except httpx.RequestError as e:
        fail(f"Network error during delete: {e}")
    return resp.status_code == 200


# --- Orphan file sweep helpers ---

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def get_all_files(client: httpx.Client) -> list[dict]:
    """Paginate through all files via /api/v1/files/ ({items, total} envelope).

    Uses content=false to avoid shipping extracted text over the wire.
    """
    files = []
    page = 1
    expected_total = None
    while True:
        try:
            resp = client.get(
                "/api/v1/files/", params={"page": page, "content": "false"}
            )
        except httpx.RequestError:
            fail(f"Network error fetching files page {page}")
        if resp.status_code != 200:
            fail(f"Files endpoint returned HTTP {resp.status_code} on page {page}")
        data = resp.json()
        if not isinstance(data, dict) or "items" not in data:
            fail(f"Unexpected /api/v1/files/ response shape: {type(data).__name__}")
        batch = response_items(data, ("items",), "files")
        require_timestamp(batch, "created_at", "files")
        files.extend(batch)
        if page_finished(data, files, batch, "files", expected_total=expected_total):
            break
        expected_total = data["total"]
        page += 1
        if page > 500:  # hard stop guard
            fail("Files pagination exceeded 500 pages; likely a bug")
    return files


def get_all_knowledge_bases(client: httpx.Client) -> list[dict]:
    """Paginate through all knowledge bases via /api/v1/knowledge/."""
    kbs = []
    page = 1
    expected_total = None
    while True:
        try:
            resp = client.get("/api/v1/knowledge/", params={"page": page})
        except httpx.RequestError:
            fail(f"Network error fetching knowledge page {page}")
        if resp.status_code != 200:
            fail(f"Knowledge endpoint returned HTTP {resp.status_code}")
        data = resp.json()
        # /api/v1/knowledge/ may return a list (small instances) or an envelope
        if isinstance(data, list):
            if expected_total is not None:
                fail("Changed knowledge pagination total")
            kbs.extend(response_items(data, ("items",), "knowledge"))
            break
        if isinstance(data, dict) and "items" in data:
            batch = response_items(data, ("items",), "knowledge")
            kbs.extend(batch)
            if page_finished(data, kbs, batch, "knowledge", expected_total=expected_total):
                break
            expected_total = data["total"]
            page += 1
            if page > 500:
                fail("Knowledge pagination exceeded 500 pages; likely a bug")
            continue
        fail(f"Unexpected /api/v1/knowledge/ response shape: {type(data).__name__}")
    return kbs


def get_kb_file_ids(client: httpx.Client, kb_id: str) -> set[str]:
    """Return the set of file ids attached to a knowledge base."""
    try:
        resp = client.get(f"/api/v1/knowledge/{kb_id}/files")
    except httpx.RequestError:
        fail("Network error fetching KB files")
    if resp.status_code != 200:
        fail(f"KB files endpoint returned HTTP {resp.status_code}")
    data = resp.json()
    items = response_items(data, ("items",), "KB files")
    # This endpoint is fetched once, so a declared remaining page is incomplete.
    if isinstance(data, dict) and "total" in data:
        if not page_finished(data, items, items, "KB files"):
            fail("Incomplete KB files enumeration")
    return {item["id"] for item in items}


def get_full_chat(client: httpx.Client, chat_id: str) -> dict:
    """Fetch a single chat's full JSON; any failure leaves references unknown."""
    try:
        resp = client.get(f"/api/v1/chats/{chat_id}")
    except httpx.RequestError:
        fail("Network error fetching chat")
    if resp.status_code != 200:
        fail(f"Chat detail endpoint returned HTTP {resp.status_code}")
    data = resp.json()
    if (
        not isinstance(data, dict) or data.get("id") != chat_id
        or not isinstance(data.get("chat"), dict)
    ):
        fail("Invalid chat detail response shape")
    return data


def delete_file(client: httpx.Client, file_id: str) -> bool:
    """Delete a single file. Returns True on success."""
    try:
        resp = client.delete(f"/api/v1/files/{file_id}")
    except httpx.RequestError as e:
        fail(f"Network error during file delete: {e}")
    return resp.status_code == 200


# --- Main ---

def run_cleanup(client: httpx.Client, settings: Settings, clock=time.time):
    """Run both phases with an owned-by-caller client and an explicit clock."""
    if settings.retention_days < 1:
        fail(f"RETENTION_DAYS must be >= 1, got {settings.retention_days}")
    if settings.orphan_grace_seconds < 0:
        fail(f"ORPHAN_GRACE_SECONDS must be >= 0, got {settings.orphan_grace_seconds}")
    cutoff = int(clock()) - settings.retention_days * 86400

    def log(msg: str):
        mode = "DRY_RUN" if settings.dry_run else "LIVE"
        print(f"[{mode}] {msg}")

    log(f"retention_days={settings.retention_days}")
    log(f"cutoff={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(cutoff))}")
    if settings.sunrise_ts:
        log(f"sunrise={time.strftime('%Y-%m-%d', time.gmtime(settings.sunrise_ts))}")
        grace_expires = time.strftime(
            "%Y-%m-%d", time.gmtime(settings.sunrise_ts + settings.retention_days * 86400)
        )
        log(f"grace_expires={grace_expires}")
    else:
        log("sunrise=none (immediate enforcement)")

    # 0. Health check
    check_health(client)
    log("health=ok")

    # 1. Get all users
    users = get_all_users(client)
    log(f"users_total={len(users)}")

    # 2. Get group map and identify held users
    group_map = get_all_groups(client)
    held_user_ids: set[str] = set()
    for user in users:
        if is_held(user, group_map):
            held_user_ids.add(user["id"])
    log(f"users_held={len(held_user_ids)}")

    # 3. Enumerate chats and apply retention
    total_scanned = 0
    total_expired = 0
    total_deleted = 0
    total_errors = 0
    users_impacted: set[str] = set()

    for user in users:
        uid = user["id"]
        if uid in held_user_ids:
            continue

        chats = get_user_chats(client, uid)
        for chat in chats:
            total_scanned += 1
            updated_at = chat["updated_at"]

            # Sunrise grace: treat activity as at least the sunrise date
            effective_updated = (
                max(updated_at, settings.sunrise_ts) if settings.sunrise_ts else updated_at
            )

            if effective_updated >= cutoff:
                continue  # still fresh (or protected by grace period)

            total_expired += 1
            chat_id = chat["id"]

            if settings.dry_run:
                users_impacted.add(uid)
            else:
                if delete_chat(client, chat_id):
                    total_deleted += 1
                    users_impacted.add(uid)
                else:
                    total_errors += 1

    # 4. Fail if any deletion errors occurred
    if total_errors > 0:
        # Log summary first so it's visible in DO logs before exit
        log(f"chats_scanned={total_scanned}")
        log(f"chats_expired={total_expired}")
        log(f"chats_deleted={total_deleted}")
        log(f"chats_errors={total_errors}")
        log(f"users_impacted={len(users_impacted)}")
        fail(f"{total_errors} deletion(s) failed")

    # 5. Phase A summary (non-sensitive aggregate only)
    log(f"chats_scanned={total_scanned}")
    log(f"chats_expired={total_expired}")
    if settings.dry_run:
        log(f"chats_would_delete={total_expired}")
    else:
        log(f"chats_deleted={total_deleted}")
    log(f"users_impacted={len(users_impacted)}")

    # --- Phase B: orphan file sweep ---
    #
    # Definition (per RETENTION.md §5): a file is an orphan when NO surviving
    # chat embeds its id in message JSON AND no knowledge base references it.
    # Files younger than ORPHAN_GRACE_SECONDS are exempt; this protects
    # in-flight uploads from temporary chats that have not yet been committed.
    #
    # Note: OWUI internally maintains a `chat_file` link table for permission
    # checks, which is not exposed through the API. Files referenced only by
    # that table (typically abandoned draft attachments that the user never
    # sent) are classified as orphans and deleted. This is intentional: those
    # files are no longer reachable through the UI.
    log(f"orphan_grace_seconds={settings.orphan_grace_seconds}")

    files = get_all_files(client)
    log(f"files_total={len(files)}")

    referenced_ids: set[str] = set()
    file_id_set: set[str] = {f["id"] for f in files}

    # Reference source 1: knowledge bases
    kbs = get_all_knowledge_bases(client)
    log(f"knowledge_bases={len(kbs)}")
    for kb in kbs:
        referenced_ids.update(get_kb_file_ids(client, kb["id"]))

    # Reference source 2: every surviving chat's full JSON.
    # After Phase A, expired chats have been deleted; their attachments
    # correctly no longer appear in anyone's chat list.
    chats_fetched = 0
    for user in users:
        uid = user["id"]
        # Re-list: a user whose chats were all expired during Phase A might
        # return an empty list now, which is fine.
        chats = get_user_chats(client, uid)
        for chat_summary in chats:
            chat_id = chat_summary["id"]
            full = get_full_chat(client, chat_id)
            chats_fetched += 1
            # Match file UUIDs against the known file-id set. This avoids
            # picking up unrelated UUIDs (model ids, message ids, etc.).
            haystack = json.dumps(full)
            for uid_match in UUID_RE.findall(haystack):
                if uid_match in file_id_set:
                    referenced_ids.add(uid_match)

    log(f"chats_scanned_for_refs={chats_fetched}")
    log(f"files_referenced={len(referenced_ids)}")

    # Candidate orphans: unreferenced AND older than grace window
    grace_cutoff = int(clock()) - settings.orphan_grace_seconds
    orphans = [
        f
        for f in files
        if f["id"] not in referenced_ids and f["created_at"] < grace_cutoff
    ]
    files_in_grace = sum(
        1
        for f in files
        if f["id"] not in referenced_ids and f["created_at"] >= grace_cutoff
    )
    log(f"files_in_grace={files_in_grace}")
    log(f"files_orphan={len(orphans)}")

    orphan_deleted = 0
    orphan_errors = 0
    if settings.dry_run:
        log(f"files_would_delete={len(orphans)}")
    else:
        for f in orphans:
            if delete_file(client, f["id"]):
                orphan_deleted += 1
            else:
                orphan_errors += 1
        log(f"files_deleted={orphan_deleted}")
        if orphan_errors > 0:
            log(f"files_errors={orphan_errors}")
            fail(f"{orphan_errors} orphan file deletion(s) failed")

    log("status=ok")


def main(argv=None):
    """Resolve CLI intent and credentials before opening the HTTP client."""
    args = parse_args(argv)
    env = os.environ
    dry_run_env = env.get("DRY_RUN", "true").lower()
    if args.live and dry_run_env == "true" and "DRY_RUN" in env:
        fail("--live conflicts with DRY_RUN=true in environment. "
             "Unset DRY_RUN or set DRY_RUN=false to proceed.")

    sunrise = env.get("RETENTION_SUNRISE", "")
    sunrise_ts = None
    if sunrise:
        try:
            sunrise_ts = int(time.mktime(time.strptime(sunrise, "%Y-%m-%d")))
        except ValueError:
            fail(f"RETENTION_SUNRISE must be YYYY-MM-DD, got {sunrise!r}")
    settings = Settings(
        retention_days=args.retention_days or int(env.get("RETENTION_DAYS", "90")),
        orphan_grace_seconds=int(env.get("ORPHAN_GRACE_SECONDS", "86400")),
        sunrise_ts=sunrise_ts,
        dry_run=not args.live if args.live else dry_run_env != "false",
    )
    url = env.get("OWUI_URL", "").rstrip("/")
    token = env.get("OWUI_TOKEN", "")
    if not url:
        fail("OWUI_URL is not set")
    if not token:
        fail("OWUI_TOKEN is not set")
    with httpx.Client(base_url=url, headers={"Authorization": f"Bearer {token}"}, timeout=30) as client:
        run_cleanup(client, settings)


if __name__ == "__main__":
    main()
