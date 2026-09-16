# BayLeaf Chat VPAT Recordings

This operator-run harness captures a synthetic keyboard-only BayLeaf Chat flow
with Cloudflare Browser Run session recording, retrieves its rrweb event archive,
and renders an MP4 with `rrweb-player`, Playwright video capture, and `ffmpeg`.

Cloudflare recordings are DOM-event archives, not videos. They are retained by
Cloudflare for 30 days. The harness holds the retrieved archive only in memory
long enough to render the MP4; it does not write or retain the full DOM archive.

The first proof-of-concept flow:

- signs in as the dedicated non-admin `probe@bayleaf.dev` account;
- refuses to run unless that account has no saved chats;
- opens Basic and reaches the composer using `Shift+Tab` only;
- types and submits a bounded synthetic prompt with the keyboard;
- waits for the completed answer, then composes and submits a follow-up;
- reaches Chat actions, Delete, and the confirmation dialog by keyboard;
- deletes the exact marked chat through the UI and independently verifies its
  absence through the API;
- retains API deletion as a recovery path if the UI flow fails.

It does not exercise CILogon or a screen reader. A headless Browser Run session
cannot substitute for a human VoiceOver, NVDA, or JAWS pass. It can provide
inspectable evidence for keyboard traversal, focus visibility, rendering, and
reflow scenarios.

## Run

Prerequisites:

- `../probe/bootstrap.secrets.json` contains the dedicated account bootstrap
  credentials and remains ignored with mode 0600. From an isolated worktree,
  set `BAYLEAF_PROBE_BOOTSTRAP` to the primary checkout's ignored copy.
- Wrangler is logged into the BayLeaf Cloudflare account with Browser Run edit
  permission. The harness obtains the short-lived OAuth token through
  `wrangler auth token`; it neither prints nor stores it.
- `ffmpeg` is installed.

```sh
npm ci
npm run check
npm run record
```

For example, from an isolated worktree:

```sh
BAYLEAF_PROBE_BOOTSTRAP=/path/to/bayleaf/chat/probe/bootstrap.secrets.json npm run record
```

Artifacts are written to `../../politics/vpat-chat-videos/`. Existing artifacts
are never overwritten. Inspect the MP4 and manifest before treating the run as
accessibility evidence. In particular, a recording demonstrates what happened
in one browser session; it does not by itself establish WCAG conformance.

The reusable workflow, evidence boundaries, inspection gates, and failure modes
are maintained in the BayLeaf operations
[accessibility-evidence playbook](../../.agents/skills/bayleaf-ops-router/playbooks/accessibility-evidence.md).
