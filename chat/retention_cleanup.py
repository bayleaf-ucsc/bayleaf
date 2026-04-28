# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx"]
# ///
"""
BayLeaf Chat — Retention Cleanup Job

Deletes conversations older than RETENTION_DAYS (default 90) that have not been
updated. Users in any `hold:*` group are exempt.

Communicates exclusively through the OWUI admin API (no direct DB access).

Design principles:
  - Fails hard (non-zero exit) on ANY inconsistency or API error.
  - Logs are never sensitive: no user names, emails, chat titles, or IDs.
    Only aggregate counts appear in stdout.
  - DO App Platform captures stdout; configure "Failed job invocation" alert
    to get emailed on failures.

Usage:
    # Dry run (default): report what would be deleted
    uv run chat/retention_cleanup.py

    # Live run: actually delete
    DRY_RUN=false uv run chat/retention_cleanup.py

Environment:
    OWUI_URL        Base URL of the OWUI instance (required)
    OWUI_TOKEN      Admin bearer token (required)
    RETENTION_DAYS  Days of inactivity before deletion (default: 90)
    DRY_RUN         "true" (default) or "false"
"""

import argparse
import os
import sys
import time
import httpx


def parse_args():
    parser = argparse.ArgumentParser(
        description="BayLeaf Chat retention cleanup. Deletes conversations "
        "inactive for longer than RETENTION_DAYS. Users in hold:* groups are exempt.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
environment variables:
  OWUI_URL           Base URL of the OWUI instance (required)
  OWUI_TOKEN         Admin bearer token (required)
  RETENTION_DAYS     Days of inactivity before deletion (default: 90)
  RETENTION_SUNRISE  Policy announcement date, YYYY-MM-DD (optional).
                     Existing chats are treated as active until at least this
                     date, giving users a full RETENTION_DAYS grace period.
  DRY_RUN            "true" (default) or "false"

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
    return parser.parse_args()


args = parse_args()

# --- Configuration ---

OWUI_URL = os.environ.get("OWUI_URL", "").rstrip("/")
OWUI_TOKEN = os.environ.get("OWUI_TOKEN", "")
RETENTION_DAYS = args.retention_days or int(os.environ.get("RETENTION_DAYS", "90"))

# Sunrise date: the date the retention policy was announced. All chats are
# treated as if their last activity was at least this date, giving existing
# users a full RETENTION_DAYS window from announcement to back up their data.
# Format: YYYY-MM-DD (UTC). If unset, no grace period (immediate enforcement).
_sunrise_env = os.environ.get("RETENTION_SUNRISE", "")
SUNRISE_TS: int | None = None
if _sunrise_env:
    try:
        SUNRISE_TS = int(time.mktime(time.strptime(_sunrise_env, "%Y-%m-%d")))
    except ValueError:
        print(
            f"FATAL: RETENTION_SUNRISE must be YYYY-MM-DD, got {_sunrise_env!r}",
            file=sys.stderr,
        )
        sys.exit(1)

# Mode resolution: --live requires DRY_RUN to not be "true".
# If --live is passed but DRY_RUN=true is set, abort (conflicting intent).
# Destructive action requires positive consent (--live) AND lack of negative
# consent (DRY_RUN not explicitly "true").
_dry_run_env = os.environ.get("DRY_RUN", "true").lower()
if args.live and _dry_run_env == "true" and "DRY_RUN" in os.environ:
    print(
        "FATAL: --live conflicts with DRY_RUN=true in environment. "
        "Unset DRY_RUN or set DRY_RUN=false to proceed.",
        file=sys.stderr,
    )
    sys.exit(1)

DRY_RUN = not args.live if args.live else _dry_run_env != "false"


def fail(msg: str):
    """Print error and exit non-zero. DO alerts trigger on this."""
    print(f"FATAL: {msg}", file=sys.stderr)
    sys.exit(1)


def log(msg: str):
    """Non-sensitive structured log line."""
    mode = "DRY_RUN" if DRY_RUN else "LIVE"
    print(f"[{mode}] {msg}")


# --- Preflight checks ---

if not OWUI_URL:
    fail("OWUI_URL is not set")
if not OWUI_TOKEN:
    fail("OWUI_TOKEN is not set")
if RETENTION_DAYS < 1:
    fail(f"RETENTION_DAYS must be >= 1, got {RETENTION_DAYS}")

CUTOFF = int(time.time()) - (RETENTION_DAYS * 86400)
HEADERS = {"Authorization": f"Bearer {OWUI_TOKEN}"}
client = httpx.Client(base_url=OWUI_URL, headers=HEADERS, timeout=30)


# --- API helpers (fail hard on any error) ---

def check_health():
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


def get_all_users() -> list[dict]:
    """Paginate through all users.

    OWUI API quirk: page 1 (or no page param) returns a bare list;
    pages > 1 return {"users": [...], "total": N}.
    """
    users = []
    page = 1
    while True:
        try:
            resp = client.get("/api/v1/users/", params={"page": page})
        except httpx.RequestError as e:
            fail(f"Network error fetching users page {page}: {e}")
        if resp.status_code != 200:
            fail(f"Users endpoint returned HTTP {resp.status_code} on page {page}")
        data = resp.json()
        if isinstance(data, list):
            batch = data
        elif isinstance(data, dict):
            batch = data.get("users", [])
        else:
            fail(f"Unexpected users response type: {type(data).__name__}")
        if not batch:
            break
        users.extend(batch)
        if len(batch) < 30:  # page size is fixed at 30
            break
        page += 1
    if not users:
        fail("Users list is empty (auth issue or misconfiguration?)")
    return users


def get_all_groups() -> dict[str, str]:
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


def get_user_chats(user_id: str) -> list[dict]:
    """Get all chats for a user via admin endpoint. Paginated."""
    chats = []
    page = 1
    while True:
        try:
            resp = client.get(
                f"/api/v1/chats/list/user/{user_id}", params={"page": page}
            )
        except httpx.RequestError as e:
            fail(f"Network error fetching chats: {e}")
        if resp.status_code != 200:
            fail(f"Chat list endpoint returned HTTP {resp.status_code}")
        data = resp.json()
        batch = data if isinstance(data, list) else data.get("chats", data.get("items", []))
        if not batch:
            break
        chats.extend(batch)
        if len(batch) < 30:
            break
        page += 1
    return chats


def delete_chat(chat_id: str) -> bool:
    """Delete a single chat. Returns True on success."""
    try:
        resp = client.delete(f"/api/v1/chats/{chat_id}")
    except httpx.RequestError as e:
        fail(f"Network error during delete: {e}")
    return resp.status_code == 200


# --- Main ---

def main():
    log(f"retention_days={RETENTION_DAYS}")
    log(f"cutoff={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(CUTOFF))}")
    if SUNRISE_TS:
        log(f"sunrise={time.strftime('%Y-%m-%d', time.gmtime(SUNRISE_TS))}")
        grace_expires = time.strftime(
            "%Y-%m-%d", time.gmtime(SUNRISE_TS + RETENTION_DAYS * 86400)
        )
        log(f"grace_expires={grace_expires}")
    else:
        log("sunrise=none (immediate enforcement)")

    # 0. Health check
    check_health()
    log("health=ok")

    # 1. Get all users
    users = get_all_users()
    log(f"users_total={len(users)}")

    # 2. Get group map and identify held users
    group_map = get_all_groups()
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

        chats = get_user_chats(uid)
        for chat in chats:
            total_scanned += 1
            updated_at = chat.get("updated_at", 0)

            # Sunrise grace: treat activity as at least the sunrise date
            effective_updated = max(updated_at, SUNRISE_TS) if SUNRISE_TS else updated_at

            if effective_updated >= CUTOFF:
                continue  # still fresh (or protected by grace period)

            total_expired += 1
            chat_id = chat["id"]

            if DRY_RUN:
                users_impacted.add(uid)
            else:
                if delete_chat(chat_id):
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

    # 5. Success summary (non-sensitive aggregate only)
    log(f"chats_scanned={total_scanned}")
    log(f"chats_expired={total_expired}")
    if DRY_RUN:
        log(f"chats_would_delete={total_expired}")
    else:
        log(f"chats_deleted={total_deleted}")
    log(f"users_impacted={len(users_impacted)}")
    log("status=ok")


if __name__ == "__main__":
    main()
