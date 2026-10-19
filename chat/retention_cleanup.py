# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx==0.28.1"]
# ///
"""
BayLeaf Chat — Retention Cleanup Job

Three-phase cleanup per RETENTION.md:

  Phase A: Delete conversations older than RETENTION_DAYS (default 90) with no
           recent activity. Users in any `hold:*` group are exempt.

  Phase B: Delete orphan files: file rows with no reference from any surviving
           chat or knowledge base, older than ORPHAN_GRACE_SECONDS (default
           86400 = 24h). The grace window protects in-flight uploads from
           temporary chats that have not yet been sent or saved.

  Phase C: Delete non-admin, non-held accounts after 18 calendar months without
           activity, measured from max(created_at, last_active_at).

Communicates exclusively through the OWUI admin API (no direct DB access).

Design principles:
  - Fails hard on inconsistencies or permanent/exhausted API errors.
    Transient reads retry up to three attempts; deletes never retry.
  - Logs are never sensitive: no user names, emails, chat titles, or IDs.
    Only aggregate counts and content-free diagnostics appear in stdout.
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
    USER_RETENTION_MONTHS Calendar months of account inactivity (default: 18)
    DRY_RUN               "true" (default) or "false"
"""

import argparse
import calendar
from dataclasses import dataclass
from datetime import datetime, timezone
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
        "inactive for longer than RETENTION_DAYS and accounts inactive for "
        "USER_RETENTION_MONTHS. Users in hold:* groups are exempt; admin accounts are kept.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
environment variables:
  OWUI_URL              Base URL of the OWUI instance (required)
  OWUI_TOKEN            Admin bearer token (required)
  RETENTION_DAYS        Days of inactivity before deletion (default: 90)
  ORPHAN_GRACE_SECONDS  Min age of an orphan file before deletion (default: 86400).
                        Protects in-flight uploads from temporary chats that have
                        not yet been sent or saved.
  USER_RETENTION_MONTHS Calendar months of account inactivity (default: 18)
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
        help="Run in live mode (actually delete). Refuses explicit DRY_RUN=true.",
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
    dry_run: bool = True
    user_retention_months: int = 18


def fail(msg: str):
    """Print error and exit non-zero. DO alerts trigger on this."""
    print(f"FATAL: {msg}", file=sys.stderr)
    sys.exit(1)


# --- API helpers (bounded read retries, fail closed) ---

def request(client: httpx.Client, method: str, path: str, label: str, **kwargs):
    """Retry transient reads only; diagnostics never include URLs or bodies."""
    attempts = 3 if method == "GET" else 1
    for attempt in range(1, attempts + 1):
        try:
            response = client.request(method, path, **kwargs)
        except httpx.RequestError as exc:
            reason = type(exc).__name__
            retryable = isinstance(exc, (
                httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError,
            ))
        else:
            if response.status_code == 200:
                return response
            reason = f"HTTP {response.status_code}"
            retryable = response.status_code in (408, 429, 500, 502, 503, 504)
        if method != "GET" or not retryable or attempt == attempts:
            fail(f"{label}: {reason}; attempt={attempt}/{attempts}")
        print(f"retry operation={label} reason={reason} attempt={attempt}/{attempts}", flush=True)
        time.sleep(attempt)


def get_json(client: httpx.Client, path: str, label: str, **kwargs):
    response = request(client, "GET", path, label, **kwargs)
    try:
        return response.json()
    except (ValueError, UnicodeError):
        fail(f"{label}: invalid JSON")


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
    data = get_json(client, "/health", "health")
    if not isinstance(data, dict) or data.get("status") is not True:
        fail("Health check returned unhealthy or invalid response")


def get_all_users(client: httpx.Client) -> list[dict]:
    """Paginate through all users.

    OWUI API quirk: page 1 (or no page param) returns a bare list;
    pages > 1 return {"users": [...], "total": N}.
    """
    users = []
    page = 1
    expected_total = None
    while True:
        # Creation timestamps tie for bulk-provisioned users. Email is unique
        # and avoids duplicate/missing entries across those page boundaries.
        data = get_json(client, "/api/v1/users/", "users", params={
            "page": page, "order_by": "email", "direction": "asc",
        })
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
    groups = get_json(client, "/api/v1/groups/", "groups")
    if not isinstance(groups, list):
        fail(f"Unexpected groups response type: {type(groups).__name__}")
    groups = response_items(groups, (), "groups")
    if any(not isinstance(g.get("name"), str) or not g["name"].strip() for g in groups):
        fail("Invalid group names")
    if len({g["id"] for g in groups}) != len(groups):
        fail("Duplicate groups")
    return {g["id"]: g["name"] for g in groups}


def is_held(user: dict, group_map: dict[str, str]) -> bool:
    """Check if any of the user's groups is a hold:* group."""
    group_ids = user.get("group_ids")
    if not isinstance(group_ids, list) or any(
        not isinstance(gid, str) or gid not in group_map for gid in group_ids
    ):
        fail("Missing or inconsistent user group membership")
    return any(group_map[gid].startswith("hold:") for gid in group_ids)


def get_user_chats(client: httpx.Client, user_id: str) -> list[dict]:
    """Get all chats for a user via admin endpoint. Paginated."""
    chats = []
    page = 1
    expected_total = None
    while True:
        data = get_json(
            client, f"/api/v1/chats/list/user/{user_id}", "chat_list",
            params={"page": page},
        )
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


def delete_chat(client: httpx.Client, chat_id: str):
    """Delete a single chat; stop on failure without retrying."""
    request(client, "DELETE", f"/api/v1/chats/{chat_id}", "chat_delete")


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
        data = get_json(
            client, "/api/v1/files/", "files", params={"page": page, "content": "false"},
        )
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
        data = get_json(client, "/api/v1/knowledge/", "knowledge", params={"page": page})
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
    data = get_json(client, f"/api/v1/knowledge/{kb_id}/files", "knowledge_files")
    items = response_items(data, ("items",), "KB files")
    # This endpoint is fetched once, so a declared remaining page is incomplete.
    if isinstance(data, dict) and "total" in data:
        if not page_finished(data, items, items, "KB files"):
            fail("Incomplete KB files enumeration")
    return {item["id"] for item in items}


def get_full_chat(client: httpx.Client, chat_id: str) -> dict:
    """Fetch a single chat's full JSON; any failure leaves references unknown."""
    data = get_json(client, f"/api/v1/chats/{chat_id}", "chat_detail")
    if (
        not isinstance(data, dict) or data.get("id") != chat_id
        or not isinstance(data.get("chat"), dict)
    ):
        fail("Invalid chat detail response shape")
    return data


def delete_file(client: httpx.Client, file_id: str):
    """Delete a single file; stop on failure without retrying."""
    request(client, "DELETE", f"/api/v1/files/{file_id}", "file_delete")


# --- Account retention ---

def months_before(timestamp: float, months: int) -> float:
    """Subtract UTC calendar months, clamping the day at month end."""
    date = datetime.fromtimestamp(timestamp, timezone.utc)
    year, month_zero = divmod(date.year * 12 + date.month - 1 - months, 12)
    if year < 1:
        fail("USER_RETENTION_MONTHS exceeds supported calendar range")
    month = month_zero + 1
    return date.replace(
        year=year, month=month,
        day=min(date.day, calendar.monthrange(year, month)[1]),
    ).timestamp()


def account_activity(user: dict, now: float) -> float | None:
    """Unknown or future timestamps cannot authorize account deletion."""
    values = [user.get("created_at"), user.get("last_active_at")]
    if any(
        type(value) not in (int, float) or not math.isfinite(value)
        or value <= 0 or value > now
        for value in values
    ):
        return None
    return max(values)


def delete_user(client: httpx.Client, user_id: str):
    response = request(client, "DELETE", f"/api/v1/users/{user_id}", "user_delete")
    try:
        confirmed = response.json() is True
    except (ValueError, UnicodeError):
        confirmed = False
    if not confirmed:
        fail("user_delete: deletion not confirmed")


def cleanup_accounts(client, settings, users, held_user_ids, now, log):
    """Recheck identity, role, activity and live holds immediately before DELETE.

    This narrows but cannot eliminate races: OWUI has no conditional account
    deletion endpoint. Listing somebody as admin does not refresh their activity.
    """
    cutoff = months_before(now, settings.user_retention_months)
    log(f"user_retention_months={settings.user_retention_months}")
    log(f"user_cutoff={datetime.fromtimestamp(cutoff, timezone.utc).isoformat()}")
    candidates = []
    invalid = 0
    for user in users:
        activity = account_activity(user, now)
        if activity is None:
            invalid += 1
            continue
        if (user.get("role") in ("user", "pending")
                and user["id"] not in held_user_ids and activity < cutoff):
            candidates.append(user)
    log(f"users_invalid_activity={invalid}")
    log(f"users_expired={len(candidates)}")
    deleted = eligible = skipped = 0
    try:
        for candidate in candidates:
            fresh = get_json(client, f"/api/v1/users/{candidate['id']}", "user_recheck")
            if not isinstance(fresh, dict) or fresh.get("id") != candidate["id"]:
                fail("user_recheck: invalid identity")
            groups = response_items(fresh.get("groups"), (), "user recheck groups")
            if (len({g["id"] for g in groups}) != len(groups) or any(
                not isinstance(g.get("name"), str) or not g["name"].strip()
                for g in groups
            )):
                fail("user_recheck: invalid groups")
            activity = account_activity(fresh, now)
            if (activity is None or activity >= cutoff
                    or fresh.get("role") not in ("user", "pending")
                    or any(g["name"].startswith("hold:") for g in groups)):
                skipped += 1
                continue
            eligible += 1
            if not settings.dry_run:
                delete_user(client, candidate["id"])
                deleted += 1
    finally:
        log(f"users_recheck_skipped={skipped}")
        if settings.dry_run:
            log(f"users_would_delete={eligible}")
        else:
            log(f"users_deleted={deleted}")


# --- Main ---

def run_cleanup(client: httpx.Client, settings: Settings, clock=time.time):
    """Run all phases with an owned-by-caller client and an explicit clock."""
    if settings.retention_days < 1:
        fail(f"RETENTION_DAYS must be >= 1, got {settings.retention_days}")
    if settings.orphan_grace_seconds < 0:
        fail(f"ORPHAN_GRACE_SECONDS must be >= 0, got {settings.orphan_grace_seconds}")
    if type(settings.user_retention_months) is not int or settings.user_retention_months < 1:
        fail("USER_RETENTION_MONTHS must be a positive integer")
    now = clock()
    months_before(now, settings.user_retention_months)
    cutoff = int(now) - settings.retention_days * 86400

    def log(msg: str):
        mode = "DRY_RUN" if settings.dry_run else "LIVE"
        print(f"[{mode}] {msg}", flush=True)

    log(f"retention_days={settings.retention_days}")
    log(f"cutoff={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(cutoff))}")

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
    users_impacted: set[str] = set()

    try:
        for user in users:
            uid = user["id"]
            if uid in held_user_ids:
                continue

            chats = get_user_chats(client, uid)
            for chat in chats:
                total_scanned += 1
                if chat["updated_at"] >= cutoff:
                    continue

                total_expired += 1
                if not settings.dry_run:
                    delete_chat(client, chat["id"])
                    total_deleted += 1
                users_impacted.add(uid)
    finally:
        # Preserve partial progress on failure, without claiming success.
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
    # With no old files, references cannot affect this run's deletion decisions.
    # Keep the candidate cutoff fixed rather than aging new files into eligibility
    # while discovery is running.
    grace_cutoff = int(clock()) - settings.orphan_grace_seconds
    if not any(f["created_at"] < grace_cutoff for f in files):
        log("file_sweep=skipped_no_eligible_files")
        cleanup_accounts(client, settings, users, held_user_ids, now, log)
        log("status=ok")
        return

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
    if settings.dry_run:
        log(f"files_would_delete={len(orphans)}")
    else:
        try:
            for f in orphans:
                delete_file(client, f["id"])
                orphan_deleted += 1
        finally:
            log(f"files_deleted={orphan_deleted}")

    # Account deletion comes last so Phase B never tries to fetch deleted users'
    # chats. Attachments orphaned by account deletion are swept on the next run.
    cleanup_accounts(client, settings, users, held_user_ids, now, log)
    log("status=ok")


def main(argv=None):
    """Resolve CLI intent and credentials before opening the HTTP client."""
    args = parse_args(argv)
    env = os.environ
    dry_run_env = env.get("DRY_RUN", "true").lower()
    if args.live and dry_run_env == "true" and "DRY_RUN" in env:
        fail("--live conflicts with DRY_RUN=true in environment. "
             "Unset DRY_RUN or set DRY_RUN=false to proceed.")

    settings = Settings(
        retention_days=(
            args.retention_days if args.retention_days is not None
            else int(env.get("RETENTION_DAYS", "90"))
        ),
        orphan_grace_seconds=int(env.get("ORPHAN_GRACE_SECONDS", "86400")),
        dry_run=not args.live if args.live else dry_run_env != "false",
        user_retention_months=int(env.get("USER_RETENTION_MONTHS", "18")),
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
