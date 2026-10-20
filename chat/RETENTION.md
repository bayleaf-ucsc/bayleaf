# Data Retention Policy

*BayLeaf Chat (`chat.bayleaf.dev`) — conversation and account data lifecycle.*

---

## 1. Policy Statement

BayLeaf Chat is not a system of record. It is a working surface for generative
AI interaction. Conversation data is retained only as long as it is reasonably
useful to the user, then automatically deleted. Account rows, including stored
profile information and settings, also have an inactivity-based lifetime.

Users who need to preserve AI-generated outputs as business records are
responsible for copying them to an appropriate system of record (Google Drive,
email, Canvas, etc.) before the retention window closes.

---

## 2. Retention Schedule

| Data class | Retention period | Clock |
|---|---|---|
| Active conversations | **90 days** since last activity | `updated_at` timestamp |
| Archived conversations | **90 days** since last activity | `updated_at` timestamp (archival does not reset or alter the clock) |
| Uploaded files attached to conversations | Inherited from owning conversation | Deleting the conversation does **not** delete the file (see note below); the file becomes an orphan and is removed by the sweep described in the next row |
| Orphan files (no live conversation or knowledge-base reference) | Deleted on next cleanup run after a **24-hour grace window** | `created_at` timestamp |
| Temporary conversations | Ephemeral (OWUI handles) | Not persisted |
| User accounts, including profile information and settings | **18 calendar months** without account activity | Later of `created_at` and `last_active_at`; admin and held accounts are exempt |

**"Last activity"** means any event that updates the conversation's `updated_at`
timestamp: a new message (user or assistant), an edit, a title change, or any
other mutation through the OWUI interface.

**No file cascade.** Deleting a conversation does not delete its attachments.
Verified against OWUI v0.10.2 (`models/chats.py`, `delete_chat_by_id`): the
operation unlinks automation runs, deletes the `chat_message` rows, deletes the
`chat` row, and revokes any share. It does **not** touch the `file` or
`chat_file` tables. Attachments therefore survive their conversation as orphans
and are reclaimed by the Phase B sweep (§5) on a subsequent run, once the
24-hour grace window has passed. Practical effect: an attachment outlives its
conversation by up to roughly 48 hours (grace window plus the wait for the next
daily run), not zero. This absence of a cascade is the reason Phase B exists.

### Account activity and deletion

The account clock is **`max(created_at, last_active_at)`**, not conversation
count or the age of the newest saved chat. In OWUI v0.12.3, authenticated HTTP
requests (including temporary-chat inference and API-key requests) and browser
WebSocket heartbeats refresh `last_active_at`. A connected idle browser can
therefore keep an account active. Reading an account through the admin API does
not refresh that account's activity: it refreshes the calling admin's activity.
Never-used placeholder accounts get their initial window from `created_at`.

The daily job subtracts 18 calendar months from its start time in UTC, clamping
the day to the target month's final day when necessary. Accounts strictly older
than that cutoff qualify; accounts exactly at the cutoff remain. Both `user`
and `pending` roles qualify. Admin accounts and accounts in a `hold:*` group are
exempt. Missing, invalid, or future timestamps cannot authorize deletion;
unknown roles are also preserved. There is no additional rollout grace period
or automated advance-warning email.

Just before deleting each candidate, the job re-reads its identity, role,
timestamps, and current group memberships. New activity, admin promotion, or a
new hold prevents deletion. This is not atomic: OWUI has no conditional-delete
API, so a change between the final check and deletion remains a race.

`DELETE /api/v1/users/{id}` in OWUI v0.12.3 removes the user row (including its
profile and settings), its authentication record, group memberships, and its
conversations. This is **not a promise to erase every associated object**:
the upstream handler does not explicitly delete memories, notes, knowledge
bases, owned workspace resources, or separate API-key rows. Orphan uploads are
handled by Phase B, not a user-delete cascade. BayLeaf API identities, sandboxes,
and other services are outside this Chat-only rule. Provider backups are not
directly rewritten by this job.

An eligible person can sign in again to create a fresh account, but old profile
settings and manually assigned access are not restored automatically.

**Initial enforcement (2026-10-18 Pacific):** a read-only inventory found 11
eligible ordinary accounts without stored profile content, saved settings, or
group memberships. With operator approval and no extra rollout grace period,
the account phase deleted those 11 accounts. A complete post-run inventory
confirmed their absence and a reduction from 595 to 584 accounts. No identifying
details are recorded in this public policy.

### Regulatory basis

- UCSC Records & Information Management classifies chat/instant messages as
  **non-records** that should be *"deleted promptly, or as soon as they are no
  longer immediately useful."* ([source](https://recordsretention.ucsc.edu/home/ucsc-retention/electronic-messages-as-business-records/))
- 90 days exceeds "promptly" but provides a practical grace period covering one
  academic quarter plus buffer. This is shorter than the default retention of
  most institutional messaging systems (Gmail, Slack) and materially limits P3
  data exposure.

### 2a. Sunrise Grace Period

The retention policy was announced on **April 28, 2026**. Existing
conversations were treated as active on at least that date, giving every user
a full 90-day window to export their data. This one-time grace period expired
on **July 27, 2026**. The cleanup job no longer contains sunrise logic or reads
`RETENTION_SUNRISE`; inactivity is measured directly from `updated_at`.

Users were notified via email on April 28, 2026, with instructions to export
via Settings > Data Controls > Export Chats.

---

## 3. Records Hold

Conversations belonging to users in a **`hold:*`** group (e.g. `hold:litigation-2026`,
`hold:audit-q2`) are exempt from automatic deletion for the duration of the hold.
Their accounts are also exempt from inactivity-based deletion.

- Holds are placed by an admin adding the user to a `hold:`-prefixed group.
- Holds are lifted by removing the user from the group.
- The cleanup job checks group membership before deleting any conversation.
- `hold:*` groups must be added to `OAUTH_BLOCKED_GROUPS` so OAuth group sync
  does not strip them on login.

This satisfies the UCSC requirement that records under litigation hold, government
investigation, audit, or CPRA request are preserved until the hold is officially
lifted.

---

## 4. User-Initiated Deletion

Users may delete individual conversations or all conversations at any time via
OWUI's Data Controls interface. This is immediate and permanent. The retention
policy sets a ceiling, not a floor: users are encouraged to delete conversations
they no longer need before the 90-day window.

---

## 5. Enforcement Mechanism

Retention is enforced by an automated **cleanup job** that runs daily, outside
the OWUI application process, using the OWUI admin API.

### Architecture

```
┌─────────────────────────────────────────────────┐
│  DO App Platform: bayleaf-chat-owui-app          │
│                                                   │
│  ┌─────────────┐         ┌───────────────────┐  │
│  │  open-webui │◄────────│  cleanup-job      │  │
│  │  (service)  │  HTTPS  │  (scheduled job)  │  │
│  └─────────────┘         └───────────────────┘  │
│         │                         │              │
│         ▼                         │              │
│  ┌─────────────┐                  │              │
│  │  PostgreSQL  │                  │              │
│  │  (managed)   │◄───────────────X│  (no direct  │
│  └─────────────┘                     DB access)  │
└─────────────────────────────────────────────────┘
```

The job communicates exclusively through the OWUI REST API. It does not connect
to the database directly. This ensures:

- Deletion respects whatever application-layer cleanup OWUI performs (message
  rows, share revocation, automation unlinking). Note this set is narrower than
  once assumed: it does **not** include file cleanup, which is why Phase B is a
  separate sweep rather than a convenience. See "No file cascade" in §2.
- The job survives OWUI schema migrations without modification.
- Access is gated by the same authentication and authorization as any admin.

### Algorithm (daily run)

```
Phase A: Conversation retention
1. Health check: GET /health (fail if unhealthy)
2. GET /api/v1/users/ (paginated) → build user list
   - User objects include group_ids inline
3. GET /api/v1/groups/ → build {group_id: group_name} map
4. Identify held users: any user whose group_ids include a hold:* group
   - Missing membership, unknown group IDs, or malformed groups abort before deletion
5. For each non-held user:
     GET /api/v1/chats/list/user/{user_id} (paginated)
     For each chat:
       If updated_at < cutoff:
         DELETE /api/v1/chats/{id}
6. If any deletion fails → exit non-zero (triggers DO alert)

Phase B: Orphan file sweep (runs after Phase A)
7. GET /api/v1/files/ (paginated) → build file list with created_at
   - If no files are older than the 24-hour grace window, finish without reference scanning
8. GET /api/v1/knowledge/ → enumerate knowledge bases
     For each KB: GET /api/v1/knowledge/{id}/files → collect referenced file ids
9. For each user, for each surviving chat:
     GET /api/v1/chats/{id} → scan full chat JSON for file-id UUIDs
10. orphan = file whose id appears in NEITHER KB references NOR any chat JSON
11. Apply 24-hour grace window: skip orphans with created_at >= now - ORPHAN_GRACE_SECONDS
12. DELETE /api/v1/files/{id} for each qualifying orphan
13. If any deletion fails → exit non-zero

14. Log aggregate summary (non-sensitive)
```

Phase C runs after Phase B (including when no files need sweeping):

1. From the complete user inventory, select non-admin, non-held accounts whose
   valid `max(created_at, last_active_at)` is older than the 18-month cutoff.
2. Re-read each candidate through `GET /api/v1/users/{id}`, including current
   groups, and recheck eligibility. Malformed identity/group responses abort;
   invalid timestamps or changed eligibility skip the account.
3. `DELETE /api/v1/users/{id}` for each still-eligible account; require HTTP 200
   and JSON `true`. Do not retry DELETEs. Stop on any failure and log completed
   deletion counts even if the phase fails partway through.
4. Log `status=ok` only after every phase finishes. Attachments orphaned by
   account deletion are eligible for the next run's file sweep.

User discovery explicitly orders by unique email ascending. Default creation-time
ordering can repeat or omit users at page boundaries when bulk-provisioned
accounts share a timestamp. Complete pagination and duplicate checks remain
required; ordering does not provide an atomic snapshot during concurrent edits.

GET requests retry transient network errors and HTTP 408, 429, 500, 502, 503,
and 504 responses, up to three attempts with one- and two-second backoffs.
Permanent errors, malformed JSON, and exhausted retries abort the job. DELETE
requests are never retried; any failure stops the run immediately. Earlier
successful deletions are not rolled back. Logs contain aggregate counts and
content-free operation labels, exception classes, HTTP status codes, and attempt
counts, never raw exception messages, URLs, response bodies, names, titles, or IDs.

#### Phase B design notes

- **Discovery must complete before file deletion**: unknown list envelopes,
  malformed required IDs/timestamps, inconsistent pagination totals, repeated
  entries, and truncated reference discovery abort the run, rather than being
  treated as an empty reference set. A listed chat that cannot be fetched
  (including HTTP 404) also aborts the sweep. Concurrent removal can therefore
  defer cleanup until the next run. This is fail-closed enforcement, not a change
  to the retention schedule. Phase A deletions already completed are not rolled
  back if Phase B fails.
- **Reference sources**: surviving chat JSON (`chat.chat` column, including
  embedded `{type: 'file', file: {id: ...}}` entries in each message) and
  knowledge-base file lists (`knowledge_file` equivalent, exposed via the
  `/knowledge/{id}/files` endpoint). These cover every file the user can
  reach through the OWUI UI.
- **24-hour grace window** (`ORPHAN_GRACE_SECONDS`, default `86400`): protects
  in-flight uploads from temporary chats. When a user pastes a screenshot or
  drags a file into a temporary chat that is never saved, OWUI creates a
  `file` row immediately but no chat record. Without the grace window, such
  files could be deleted during an active session.
  The eligibility cutoff is fixed before reference discovery. This is not an
  atomic snapshot: an older file can still acquire a new reference between its
  chat's scan and file deletion. The grace window does not eliminate that race.
- **Abandoned draft attachments**: files that the user attached to a
  compose/draft but never sent are classified as orphans. OWUI internally
  records these in a `chat_file` table for permission checks, but the table
  is not exposed through the API and the files are not reachable through
  the UI. They are safe to delete.
- **Why pure-API**: consistent with the rest of the cleanup job's design;
  the retention service does not hold DB credentials and does not require
  database firewall exceptions. Trade-off: orphan detection cost scales
  linearly with total chats (one `GET /chats/{id}` per surviving chat per
  run). At current scale (~500 chats) this completes in under two minutes.

Offline transaction regressions exercise the import-safe `run_cleanup` runner
with an explicit HTTP client (`httpx.MockTransport`), settings, and clock.
Fresh-process CLI smoke tests cover side-effect-free import, help, missing
credentials, and the `--live`/`DRY_RUN=true` guard. No live admin API or file
storage access is used:

```bash
uv run --offline --with httpx python -m unittest discover -s chat -p 'test_retention_cleanup.py' -v
```

The HTTP seam checks which DELETEs the job attempts, reference preservation,
holds, and grace windows. It does not qualify a deployed OWUI version's response
schemas, actual storage deletion, or concurrent writes during discovery.

### Configuration

| Variable | Value | Notes |
|---|---|---|
| `OWUI_URL` | `https://chat.bayleaf.dev` | Target instance |
| `OWUI_TOKEN` | (secret) | Long-lived admin JWT (10-year expiry, signed with `WEBUI_SECRET_KEY`) |
| `RETENTION_DAYS` | `90` | Configurable; default matches this policy |
| `ORPHAN_GRACE_SECONDS` | `86400` | Min age of an orphan before deletion (24h default protects temporary-chat uploads) |
| `USER_RETENTION_MONTHS` | `18` | Calendar months of account inactivity; positive integer |
| `DRY_RUN` | `false` | Set to `true` for dry-run mode; `--live` flag also available |

### Deployment

The job runs as a **DO App Platform Job** component (type: `SCHEDULED`,
cron: `0 6 * * *`, timezone: `America/Los_Angeles`, i.e. daily at 6am Pacific).
It builds from `chat/Dockerfile.retention` in the `bayleaf-ucsc/bayleaf` repo
(`python:3.12-slim`). The Dockerfile installs pinned HTTP dependencies at build
time and runs Python directly, with no runtime package resolution or download.
Refresh the pins using the `uv pip compile` command in the Dockerfile. The job
component shares the app but authenticates to OWUI over HTTPS like any external
client. The deployment's obsolete `RETENTION_SUNRISE` setting can be removed on
the next deployment; the updated script ignores it. `DRY_RUN` remains supported,
including the guard against `--live` with explicit `DRY_RUN=true`.

Source: [`chat/retention_cleanup.py`](retention_cleanup.py)

### Token management

The job authenticates with a **long-lived JWT** (10-year expiry) signed with
the deployment's `WEBUI_SECRET_KEY`, bound to the admin user. This avoids
enabling password login for a service account and keeps the attack surface
minimal. If `WEBUI_SECRET_KEY` is rotated, a new token must be generated and
updated in the job's secret env var.

---

## 6. Audit and Observability

- The cleanup job logs to stdout; DO App Platform captures these as structured
  logs viewable via `doctl apps logs`.
- Logs are **non-sensitive by design**: aggregate counts and content-free
  retry/error diagnostics only. No user names, emails, chat titles, or
  identifiers are ever logged. Completed deletion counts are emitted even
  when a phase fails partway through.
- Each run logs: retention_days, cutoff timestamp, health status,
  user/chat counts, account retention months and cutoff, expired accounts,
  invalid activity timestamps, recheck skips, account deletions, and final status.
- A failed run (non-zero exit) triggers DO's built-in "Failed job invocation"
  alert, which emails the operator.
- The policy document itself (this file) is version-controlled in the public
  repository, providing a transparent audit trail of policy changes.

---

### 6a. Private operational telemetry (approved, rollout pending)

On 2026-10-20 the operator approved deployment and live collection of four
classes in a separate Cloudflare Worker/D1 collector: public-page arrivals,
native OWUI aggregate metrics, aggregate deletion-job summaries and summaries of
existing synthetic monitoring probes. Approval does not establish that the
collector or sources are already live. Exact-diff publication approval remains
required; see the [rollout record](../telemetry/README.md#retention-and-rollout-gates)
and [privacy notice](../PRIVACY.md).

Public-page arrivals record only destination service, collector-assigned time
and referring hostname (or unknown), not referrer paths/query strings. They are
nonunique observations, not visitor counts: no visitor identifiers, tracking
cookies, stable pseudonyms or per-client deduplication. Native OWUI metrics are
aggregate HTTP counts/duration histograms and global user-count gauges, with
fixed method, sanitized route, status and instance categories, not individual
request records. Cleanup summaries preserve job/run IDs and times, fixed
outcomes, durations, modes/configuration and approved aggregate counters. Probe
summaries preserve synthetic run IDs/times, layer, fixed result codes, outcomes,
durations, phase/event timings and cleanup status, not actual conversations or
raw logs/errors. No prompts, completions, identities, IP/UA, private URLs,
credentials or model strings enter this collector. Sealed coverage is only
synthetic probe summaries, never per-request user inference metadata. The
operator can read the telemetry; it is not zero-operator-access.

The maximum live lifetime is **90 days from observation for every class**,
including each metric point's own observation time. Receipt/retry does not
restart it. Private reads exclude expired observations immediately. Physical
purge runs each minute in bounded batches (at most 500 rows per table), so
backlogs/outages can delay deletion. Cloudflare D1 paid-plan Time Travel may
retain deleted rows for **up to 30 additional days after physical deletion**,
on top of purge delay; this is not erasure at day 90. Before restored data can
be read or collection resumed, effective retention ceilings/cutoffs must be
reapplied and expired rows purged.

No automatic exports or long-term archive are created. Reports, downloaded
exports and derived artifacts must expire with their underlying observations
(at the earliest included observation's expiry); copying or aggregation cannot
restart retention or create indefinite copies. The operator must set and enforce
artifact expiry because downloaded files cannot be revoked by the collector.
Four content-free policy rows persist to prevent raising an established TTL
ceiling or resurrecting retired observations. This separate telemetry schedule
does not change conversation/account/file retention, DigitalOcean's existing
platform-log lifecycle, or the inference-only ZDR boundary. Chat still stores
history accessible to the administrator.

## 7. Scope and Limitations

- This policy covers **conversation data** (the `chat` table and associated
  files) and **user account rows**, including profiles and settings. It does not
  automatically delete all resources associated with a deleted account. It does
  not cover:
  - Model configurations, tools, functions (operational, not user data)
  - Knowledge base content (admin-managed, separate lifecycle)
  - Memories (OWUI's persistent memory feature; out of scope for v1)
  - Code Sandbox data (see §7a below)
- The 90-day conversation retention applies uniformly to all users including
  admins. Admin accounts are exempt only from the 18-month account rule.
- Shared conversations: deletion removes the share link. Recipients who
  previously viewed a shared chat lose access.

### 7a. Code Sandbox (Lathe) Data

The Code Sandbox is an **opt-in** feature: users must explicitly enable the
toolkit and invoke a tool before any sandbox is created. User data lives
entirely within the Daytona-managed sandbox VM filesystem
(`/home/daytona/workspace`): project files, cloned repos, build artifacts,
installed packages.

**No persistent volume.** The `persistent_volume` valve is set to `false` on
this deployment. There is no S3/FUSE-backed storage that survives sandbox
destruction. When a sandbox is deleted, all user data within it is permanently
removed.

**Retention lifecycle (managed by Daytona, not BayLeaf):**

| State | Trigger | Data preserved |
|---|---|---|
| Running | User tool call | Full VM filesystem |
| Stopped | 15 min idle (`auto_stop_minutes`) | Full VM filesystem (dormant) |
| Archived | 60 min after stop (`auto_archive_minutes`) | VM image compressed |
| **Deleted** | **90 days after archive (`auto_delete_minutes` = 129600)** | **Nothing: permanently removed** |

Users who need to preserve sandbox artifacts long-term should copy them out
via `expose(target="dufs")`, code-server, or a Git repository before the 90-day
inactivity window closes. Any tool call resets the idle clock, so active users
are never affected.

This aligns with the 90-day retention window for conversation data (§2), giving
users a consistent expectation: inactive data is cleaned up after one quarter
of inactivity regardless of where it lives.

---

## 8. Policy Review

This policy will be reviewed:

- Annually, or
- When UC/UCSC records retention guidance changes, or
- When BayLeaf's data-handling authorization changes (ITS has cleared P3-grade data
  on technical security grounds; FERPA authorization for student education records is
  a separate Registrar process, still pending), or
- When OWUI ships a native retention feature that supersedes this mechanism.

---

## References

- [UCSC Records Retention: Electronic Messages](https://recordsretention.ucsc.edu/home/ucsc-retention/electronic-messages-as-business-records/)
- [UC Records Retention Schedule](http://recordsretention.ucop.edu/)
- [OWUI Feature Request: Configurable Chat Retention](https://github.com/open-webui/open-webui/discussions/21027)
- [OWUI WIP PR: Periodic Data Cleanup](https://github.com/open-webui/open-webui/pull/13396)
- CISO Talking Points Memo, April 28, 2026 (internal)
