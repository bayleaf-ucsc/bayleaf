"""Explicit aggregate adapter for chat/retention_cleanup.py. No log scraping.

Import is inert. Build from counters at their source, never from users/chats/files.
All integration is intentionally pending; this module reads no environment or keys.
"""
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import json
import re
import threading
from urllib.parse import urlsplit

MAX_BYTES = 16384
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", re.I)
_delivery_slot = threading.BoundedSemaphore(1)


@dataclass
class ChatRetentionCounts:
    # None means a phase was not reached or its count is not yet known.
    users_total: int | None = None
    users_held: int | None = None
    chats_scanned: int | None = None
    chats_expired: int | None = None
    chats_deleted: int | None = None
    chats_would_delete: int | None = None
    users_impacted: int | None = None
    files_total: int | None = None
    knowledge_bases: int | None = None
    chats_scanned_for_refs: int | None = None
    files_referenced: int | None = None
    files_in_grace: int | None = None
    files_orphan: int | None = None
    files_deleted: int | None = None
    files_would_delete: int | None = None
    users_invalid_activity: int | None = None
    users_expired: int | None = None
    users_recheck_skipped: int | None = None
    users_deleted: int | None = None
    users_would_delete: int | None = None


@dataclass(frozen=True)
class Run:
    # A fresh job-run UUID, never an account, chat, file or provider identifier.
    run_id: str
    started_at: str
    ended_at: str
    outcome: str


@dataclass(frozen=True)
class RetentionPolicy:
    retention_days: int
    orphan_grace_seconds: int
    user_retention_months: int
    file_sweep: str | None = None


def _count(value):
    return type(value) is int and 0 <= value <= 1000000000000


def _time(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", value):
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z") == value
    except ValueError:
        return False


def chat_retention_summary(counts: ChatRetentionCounts, run: Run, mode: str,
                           policy: RetentionPolicy) -> dict | None:
    """Return a whitelist-only wire record, or None on invalid source metadata."""
    try:
        if type(counts) is not ChatRetentionCounts or type(run) is not Run or type(policy) is not RetentionPolicy:
            return None
        if (not isinstance(run.run_id, str) or not UUID.fullmatch(run.run_id)
                or run.outcome not in ("ok", "partial", "failed", "disabled")
                or not _time(run.started_at) or not _time(run.ended_at) or run.ended_at < run.started_at
                or mode not in ("delete", "dry-run", "disabled")
                or (mode == "disabled") != (run.outcome == "disabled")):
            return None
        values = {key: value for key, value in asdict(counts).items() if value is not None}
        if not all(_count(value) for value in values.values()):
            return None
        if mode == "dry-run" and any(values.get(key, 0) for key in ("chats_deleted", "files_deleted", "users_deleted")):
            return None
        if mode == "delete" and any(key in values for key in ("chats_would_delete", "files_would_delete", "users_would_delete")):
            return None
        extensions = asdict(policy)
        if any(not _count(extensions[key]) for key in ("retention_days", "orphan_grace_seconds", "user_retention_months")):
            return None
        if policy.retention_days < 1 or policy.user_retention_months < 1:
            return None
        if policy.file_sweep is None:
            extensions.pop("file_sweep")
        elif policy.file_sweep != "skipped_no_eligible_files":
            return None
        started = round(datetime.fromisoformat(run.started_at.replace("Z", "+00:00")).timestamp() * 1000)
        ended = round(datetime.fromisoformat(run.ended_at.replace("Z", "+00:00")).timestamp() * 1000)
        if ended - started > 3600000:
            return None
        extensions.update(started_at=started, ended_at=ended, mode=mode, counts=values)
        return dict(schema_version=1, source="chat-retention", job="chat-retention",
                    batch_id=run.run_id, observed_at=ended, duration_ms=ended-started,
                    outcome={"ok": "success", "partial": "partial", "failed": "failure", "disabled": "skipped"}[run.outcome],
                    deleted=sum(values.get(key, 0) for key in ("chats_deleted", "files_deleted", "users_deleted")),
                    extensions=extensions)
    except Exception:
        return None


def submit_summary(build, *, enabled=False, endpoint=None, service_token=None, sender=None, deadline_ms=1000) -> bool:
    """Bound caller latency and concurrency; no retries or shared admin HTTP client.

    Sender is injectable for offline qualification. Default uses a fresh httpx
    client with no inherited cookies/auth/proxy environment, bounded I/O and no
    redirects. Only its explicit collector-specific Bearer token is attached.
    A daemon is a final caller-latency bound even if DNS or injected transport
    ignores its timeout. The single slot remains held until that work exits.
    False means disabled, invalid, timed out or failed. Never raises/logs.
    """
    acquired = False
    try:
        if enabled is not True or type(deadline_ms) is not int or not 1 <= deadline_ms <= 2000:
            return False
        # Collector-specific chat-retention write token, not OWUI/admin auth.
        # Explicit in-memory argument only; never consult environment or files.
        if not isinstance(service_token, str) or not re.fullmatch(r"[\x21-\x7e]{24,512}", service_token):
            return False
        url = urlsplit(endpoint)
        local = url.hostname in ("localhost", "127.0.0.1", "::1")
        if (url.scheme != "https" and not (local and url.scheme == "http")
                or not url.hostname or url.username or url.password
                or url.path != "/v1/deletions" or url.query or url.fragment):
            return False
        summary = build()
        if not isinstance(summary, dict) or summary.get("source") != "chat-retention":
            return False
        body = json.dumps(summary, allow_nan=False, separators=(",", ":")).encode()
        if len(body) > MAX_BYTES:
            return False
        if not _delivery_slot.acquire(blocking=False):
            return False
        acquired = True
        done = threading.Event()
        result = [False]

        def send():
            try:
                headers = {"Content-Type": "application/json", "Authorization": f"Bearer {service_token}"}
                if sender is not None:
                    status = sender(endpoint, body, headers, deadline_ms / 1000)
                else:
                    import httpx
                    with httpx.Client(timeout=deadline_ms / 1000, trust_env=False,
                                      follow_redirects=False) as client:
                        # Stream and close without consuming an untrusted reply body.
                        with client.stream("POST", endpoint, content=body, headers=headers) as response:
                            status = response.status_code
                result[0] = type(status) is int and 200 <= status < 300
            except Exception:
                pass
            finally:
                _delivery_slot.release()
                done.set()

        threading.Thread(target=send, daemon=True).start()
        acquired = False  # The worker now owns the slot, even after timeout.
        return done.wait(deadline_ms / 1000) and result[0]
    except Exception:
        return False
    finally:
        if acquired:
            _delivery_slot.release()
