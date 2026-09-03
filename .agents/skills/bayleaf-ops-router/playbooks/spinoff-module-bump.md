---
source-skill: bayleaf-ops-router
description: Bump a spin-off module (Lathe, gws-toolkit, and other toolkits) from Adam's personal instance to BayLeaf Chat.
status: rough
last-reviewed: 2026-08-25
---

# Spin-off Module Bump

## When to use

A newer version of a toolkit with an independent upstream exists (Lathe,
gws-toolkit) or a toolkit was improved on Adam's personal instance
(`chat.adamsmith.as`) and BayLeaf Chat should catch up.

## Upgrade paths (they differ; identify which one applies)

**Repo-homed tools.** Some modules have their own git repos:
- `lathe` → https://github.com/rndmcnlly/lathe
- `gws_toolkit` → https://github.com/rndmcnlly/gws-toolkit

The personal instance runs newer builds first. The authoritative source for
a bump is **the soaked personal instance**, not the git repo tag: pull the
tool source from `chat.adamsmith.as` (it is the thing actually proven in
use), and cross-check against the repo if they should agree.

**Manually ported tools.** Everything else under `chat/tools/` (web_context,
campus_directory, youtube, etc.) is ported by hand when improved. The pull
diff between instances is the change record.

## Prerequisites

- **[HUMAN GATE]** The new version has been running on the personal instance
  for a while (same soak rule as OWUI bumps). No direct-to-BayLeaf first
  contact.
- `owui-cli` env for **both** instances:
  `~/.tokens/owui/chat-adamsmith-as` and `~/.tokens/owui/chat-bayleaf-dev`.

## Steps

1. Pull the current source from both instances:
   `uvx owui-cli tools pull <id>` under each env; diff them. The diff is the
   candidate change set. Watch version fields in the docstring headers.
2. Review the diff for new admin valves (they will need values set in the
   OWUI admin panel before the tool functions), new requirements lines
   (OWUI installs them on deploy), and new tool specs (the model's surface
   changes).
3. Deploy to BayLeaf:
   `uvx owui-cli tools deploy <source.py> <id>` — pass the existing id
   explicitly (deploy ID mismatch is the classic silent-duplicate bug).
4. Set any new valves in the BayLeaf admin panel; note non-secret valve
   defaults in `chat/DESIGN.md` if they're worth recording.
5. **[HUMAN GATE]** Exercise the tool in prod through its model (Code Sandbox
   via Basic; Google Workspace via its consent flow).
6. Run `backup-reconcile.md` to capture meta + source into the repo.
7. Record: `update: <tool> to v<version>` (or `chore:` for pure ports).

## Verification

- `uvx owui-cli tools list` shows the new version on BayLeaf.
- User's prod exercise passes.
- Backup pull diff is the expected change set only.

## Rollback

```bash
git checkout chat/tools/<id>/tool.py
uvx owui-cli tools deploy chat/tools/<id>/tool.py <id>
```

## Refinement log

- 2026-08-25: drafted from issue #65 + chat/AGENTS.md; never yet run as a
  playbook.
- 2026-09-01: `opencode-tinfoil` showed that independently published client
  plugins consumed by the API do not fit this Chat-only deployment playbook;
  treat their BayLeaf integration as ordinary API work unless a package bump is
  the task itself.
- 2026-09-03: `opencode-tinfoil` 0.2.0 validated the release order: publish and
  verify the client package first, then deploy its exact-pinned API consumer.
  Local well-known config probes caught npm-plugin deduplication behavior before
  the production update.
