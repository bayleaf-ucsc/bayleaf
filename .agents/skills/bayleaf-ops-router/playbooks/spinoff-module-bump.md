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

Not for: client packages consumed by the API (e.g. `opencode-tinfoil`). Treat
those as API work: publish and verify the package first, then deploy its
exact-pinned consumer.

## Upgrade paths (they differ; identify which one applies)

**Repo-homed tools.** Some modules have their own git repos:
- `lathe` → https://github.com/rndmcnlly/lathe
- `gws_toolkit` → https://github.com/rndmcnlly/gws-toolkit

The personal instance runs newer builds first. The authoritative source for
a bump is **the soaked personal instance**, not the git repo tag: pull the
tool source from `chat.adamsmith.as` (it is the thing actually proven in
use), and cross-check against the repo if they should agree.

**Lathe is a read-only upstream dependency, not a BayLeaf fork.** Never modify
Lathe source just for BayLeaf, including the vendored `chat/tools/lathe/tool.py`.
When BayLeaf needs behavior that Lathe does not support, push Adam to formulate
the requirement generally and implement it in the upstream Lathe project, then
test it, soak it on the personal instance, and consume it here byte-for-byte.
BayLeaf-specific policy belongs in supported admin valves, BayLeaf's own gateway
and infrastructure, or separate user/agent guidance, not patches to Lathe.

**Manually ported tools.** Everything else under `chat/tools/` (web_context,
campus_directory, youtube, etc.) is ported by hand when improved. The pull
diff between instances is the change record.

## Prerequisites

- **[HUMAN GATE]** The new version has been running on the personal instance
  for a while (same soak rule as OWUI bumps). No direct-to-BayLeaf first
  contact. A passing staging run does not satisfy this gate.
- Run the upstream offline tests on the exact source being promoted.
- `owui-cli` env for **both** instances:
  `~/.tokens/owui/chat-adamsmith-as` and `~/.tokens/owui/chat-bayleaf-dev`.
- Model-mediated live qualification must use a dedicated synthetic account,
  not Adam's ordinary admin identity. Admin credentials may deploy/inspect the
  isolated toolkit, but a separate test identity must make completion requests.
  Verify the event collector filters both chat and message IDs before recording
  or accepting results. Isolated toolkit IDs and sandbox labels alone do not
  isolate account-level Socket.IO traffic.

## Steps

1. Pull the current source from both instances:
   `uvx owui-cli tools pull <id>` under each env; diff them. The diff is the
   candidate change set. Watch version fields in the docstring headers, but
   identify the build by commit and source hash: the version can lag the code.
   Save source, valves and grants to a new private snapshot; never overwrite an
   earlier one.
2. Review the diff for new admin valves (they will need values set in the
   OWUI admin panel before the tool functions), new requirements lines
   (OWUI installs them on deploy), and new tool specs (the model's surface
   changes). Check companion skills (e.g. `code-sandbox`) and retention docs for
   guidance the new version contradicts, and update them in the same rollout.
   If the bump needs an API contract change, deploy that first.
3. Deploy to BayLeaf:
   `uvx owui-cli tools deploy <source.py> <id>` — pass the existing id
   explicitly (deploy ID mismatch is the classic silent-duplicate bug). Deploy
   source only; avoid rollout helpers that also rewrite valves.
4. Preserve existing BayLeaf valves; never copy personal-instance credentials or
   lifecycle defaults. Set any new valves in the BayLeaf admin panel; note non-secret valve
   defaults in `chat/DESIGN.md` if they're worth recording.
5. **[HUMAN GATE]** Exercise the tool in prod through its model (Code Sandbox
   via Basic; Google Workspace via its consent flow).
6. Run `backup-reconcile.md` to capture meta + source into the repo.
7. Record: `update: <tool> to v<version>` (or `chore:` for pure ports).

## Verification

- `uvx owui-cli tools list` shows the new version on BayLeaf.
- Live source matches byte for byte; schemas are as expected; valves, name and
  grants are unchanged; `/health` returns 200.
- Test fixtures are gone: revoke only your own leases and delete only your own
  files. Owning a fixture does not permit deleting the sandbox around it, and a
  missing fixture sandbox does not justify creating a second one for that owner.
- User's prod exercise passes.
- Backup pull diff is the expected change set only.

## Rollback

Deploy the privately saved pre-upgrade source to the existing tool ID, then
restore its saved valves if they changed. Do not use `git checkout` to discard
the working copy: it may contain unrelated user work, and the committed source
may not match the actual pre-upgrade deployment.
