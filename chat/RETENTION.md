# Data Retention Policy

*BayLeaf Chat (`chat.bayleaf.dev`) — conversation data lifecycle.*

---

## 1. Policy Statement

BayLeaf Chat is not a system of record. It is a working surface for generative
AI interaction. Conversation data is retained only as long as it is reasonably
useful to the user, then automatically deleted.

Users who need to preserve AI-generated outputs as business records are
responsible for copying them to an appropriate system of record (Google Drive,
email, Canvas, etc.) before the retention window closes.

---

## 2. Retention Schedule

| Data class | Retention period | Clock |
|---|---|---|
| Active conversations | **90 days** since last activity | `updated_at` timestamp |
| Archived conversations | **90 days** since last activity | `updated_at` timestamp (archival does not reset or alter the clock) |
| Uploaded files attached to conversations | Inherited from owning conversation | Deleted when the conversation is deleted (CASCADE) |
| Orphan files (no live conversation reference) | Deleted on next cleanup run | — (not yet implemented) |
| Temporary conversations | Ephemeral (OWUI handles) | Not persisted |

**"Last activity"** means any event that updates the conversation's `updated_at`
timestamp: a new message (user or assistant), an edit, a title change, or any
other mutation through the OWUI interface.

### Regulatory basis

- UCSC Records & Information Management classifies chat/instant messages as
  **non-records** that should be *"deleted promptly, or as soon as they are no
  longer immediately useful."* ([source](https://recordsretention.ucsc.edu/home/ucsc-retention/electronic-messages-as-business-records/))
- 90 days exceeds "promptly" but provides a practical grace period covering one
  academic quarter plus buffer. This is shorter than the default retention of
  most institutional messaging systems (Gmail, Slack) and materially limits P3
  data exposure.

### 2a. Sunrise Grace Period

The retention policy was announced on **April 28, 2026**. All existing
conversations are treated as if their last activity occurred on at least that
date, regardless of their actual `updated_at` timestamp. This guarantees every
user a full 90-day window from the announcement date to export any data they
wish to preserve.

- **Grace period expires**: July 27, 2026
- **Mechanism**: `RETENTION_SUNRISE` env var on the cleanup job. The effective
  age of a chat is `max(updated_at, sunrise_date)`.
- After the grace period expires, the sunrise date has no further effect (all
  surviving chats will have been active within the last 90 days, or will be
  deleted on their next scheduled run).

Users were notified via email on April 28, 2026, with instructions to export
via Settings > Data Controls > Export Chats.

---

## 3. Records Hold

Conversations belonging to users in a **`hold:*`** group (e.g. `hold:litigation-2026`,
`hold:audit-q2`) are exempt from automatic deletion for the duration of the hold.

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

- Deletion respects any application-layer cascades (file cleanup, tag removal,
  share revocation).
- The job survives OWUI schema migrations without modification.
- Access is gated by the same authentication and authorization as any admin.

### Algorithm (daily run)

```
1. Health check: GET /health (fail if unhealthy)
2. GET /api/v1/users/ (paginated) → build user list
   - User objects include group_ids inline
3. GET /api/v1/groups/ → build {group_id: group_name} map
4. Identify held users: any user whose group_ids include a hold:* group
5. For each non-held user:
     GET /api/v1/chats/list/user/{user_id} (paginated)
     For each chat:
       effective_updated = max(updated_at, SUNRISE_TS)
       If effective_updated < cutoff:
         DELETE /api/v1/chats/{id}
6. If any deletion fails → exit non-zero (triggers DO alert)
7. Log aggregate summary (non-sensitive: counts only)
```

The job fails hard (non-zero exit) on any API error, network failure, or
deletion error. Logs contain only aggregate counts (chats scanned, deleted,
users impacted), never user names, emails, chat titles, or IDs.

### Configuration

| Variable | Value | Notes |
|---|---|---|
| `OWUI_URL` | `https://chat.bayleaf.dev` | Target instance |
| `OWUI_TOKEN` | (secret) | Long-lived admin JWT (10-year expiry, signed with `WEBUI_SECRET_KEY`) |
| `RETENTION_DAYS` | `90` | Configurable; default matches this policy |
| `RETENTION_SUNRISE` | `2026-04-28` | Grace period start date (see §2a below) |
| `DRY_RUN` | `false` | Set to `true` for dry-run mode; `--live` flag also available |

### Deployment

The job runs as a **DO App Platform Job** component (type: `SCHEDULED`,
cron: `0 6 * * *`, timezone: `America/Los_Angeles`, i.e. daily at 6am Pacific).
It builds from `chat/Dockerfile.retention` in the `bayleaf-ucsc/bayleaf` repo
(`python:3.12-slim` + `uv`). The job component shares the app but authenticates
to OWUI over HTTPS like any external client.

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
- Logs are **non-sensitive by design**: only aggregate counts appear (total
  users, chats scanned, chats deleted, users impacted). No user names, emails,
  chat titles, or identifiers are ever logged.
- Each run logs: retention_days, cutoff timestamp, sunrise date, health status,
  user/chat counts, and final status.
- A failed run (non-zero exit) triggers DO's built-in "Failed job invocation"
  alert, which emails the operator.
- The policy document itself (this file) is version-controlled in the public
  repository, providing a transparent audit trail of policy changes.

---

## 7. Scope and Limitations

- This policy covers **conversation data** (the `chat` table and associated
  files). It does not cover:
  - User accounts (retained indefinitely while active)
  - Model configurations, tools, functions (operational, not user data)
  - Knowledge base content (admin-managed, separate lifecycle)
  - Memories (OWUI's persistent memory feature; out of scope for v1)
  - Code Sandbox data (see §7a below)
- The 90-day retention applies uniformly to all users including admins.
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
(via `expose(target="dufs")` or `ssh`) before the 90-day inactivity window
closes. Any tool call resets the idle clock, so active users are never affected.

This aligns with the 90-day retention window for conversation data (§2), giving
users a consistent expectation: inactive data is cleaned up after one quarter
of inactivity regardless of where it lives.

---

## 8. Policy Review

This policy will be reviewed:

- Annually, or
- When UC/UCSC records retention guidance changes, or
- When BayLeaf's data classification level changes (e.g. P3 approval granted), or
- When OWUI ships a native retention feature that supersedes this mechanism.

---

## References

- [UCSC Records Retention: Electronic Messages](https://recordsretention.ucsc.edu/home/ucsc-retention/electronic-messages-as-business-records/)
- [UC Records Retention Schedule](http://recordsretention.ucop.edu/)
- [OWUI Feature Request: Configurable Chat Retention](https://github.com/open-webui/open-webui/discussions/21027)
- [OWUI WIP PR: Periodic Data Cleanup](https://github.com/open-webui/open-webui/pull/13396)
- CISO Talking Points Memo, April 28, 2026 (internal)
