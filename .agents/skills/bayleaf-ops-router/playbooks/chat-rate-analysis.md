---
source-skill: bayleaf-ops-router
description: Measure retained Chat message rates before tuning submission limits, without exporting conversation text.
status: practiced
last-reviewed: 2026-10-27
---

# Chat request-rate analysis

## Trigger and scope

Use when evaluating whether Chat's submission limits constrain ordinary use,
or before changing the minute/hour/long-window valves. Read `chat/AGENTS.md`,
`chat/DESIGN.md` §4 and `chat/RETENTION.md` first. This is a read-only operator
analysis, not new telemetry collection or permission to change limits.

**What we measure:** retained user-message timestamps as a submission proxy,
with retained assistant-message timestamps as a cross-check. Neither is an
admission log, a count of provider completions, or a token/cost measure.

## Recipe

1. Inspect live limiter source and valves. Use `owui-cli functions pull
   rate_limit_filter` and `owui-cli functions valves rate_limit_filter` after
   loading the operator environment below. Check active/global flags too.
   Verify the deployed OWUI version and its filter hooks if it has changed:
   v0.12.4 initial requests invoke `inlet`, native tool/code continuations invoke
   `request`. Our inlet-only filter therefore normally counts one admitted
   submission, not every internal model round. A separate resume/retry can count
   again. Do not assume this survives an upgrade.
2. Run the synthetic checks, then the scan from the repository root:

   ```bash
   uv run chat/analysis/request_rates.py --self-test
   set -a
   source ~/.tokens/owui/chat-bayleaf-dev
   set +a
   uv run chat/analysis/request_rates.py --days 30 90
   ```

   No writes to production, no inference, and no direct database access. Keep
   credentials out of command arguments/output. The script emits aggregate JSON
   on stdout and progress on stderr. If saving a report, redirect stdout to a
   private operator temporary directory, not the public repo. Do not publish
   results, even aggregate results, without separate approval.
3. Confirm coverage: successful exit, account/chat counts, skipped timestamps,
   duplicate IDs and conflicting duplicate timestamps. Errors abort the report;
   do not turn failed reads into empty accounts. This is a live scan, not a
   database snapshot: additions/deletions during pagination can affect coverage.
   If churn or inconsistent timestamps materially affect a decision, rerun or
   investigate before interpreting tails.
4. Start with `periods.90.user.non_admin`, then compare 30 days, admin separately,
   and `assistant` as a sensitivity check. Primary columns for each rolling
   window: per-user peak median, p90/p95/p99, maximum, number of users reaching
   80% of the comparison quota, and number reaching the quota.
5. Explain the denominator. **Per-user peak quantiles** give each observed user
   one value: their busiest rolling window in the selected period. These are not
   ordinary average traffic or calendar-bucket rates. **Event rolling quantiles**
   give every retained message one sample of that owner's recent activity, so
   heavy users are weighted more. Zero-activity accounts/windows are excluded.
6. **[HUMAN GATE]** Decide whether to change submission policy. Analysis alone
   does not authorize valve edits. If approved, snapshot live valves privately,
   change only the intended fields, verify readback and unrelated-field
   preservation, then update DESIGN and any non-secret recovery overrides.
   `sliding_window_minutes` is in **minutes**: 24 hours = 1440; 3600 = 60 hours.

## Implementation and data minimization

`chat/analysis/request_rates.py` uses these existing admin API reads:

- `/api/v1/users/`: stable email-sorted pagination, 30/page. Names/emails are not
  retained; email is used only to recognize the synthetic `probe@bayleaf.dev`.
- `/api/v1/chats/list/user/{id}`: 60/page, including archived chats. Titles may
  arrive in summaries but are not inspected, saved or printed.
- `/api/v1/chats/stats/export/{id}`: content-free per-message roles, IDs and
  timestamps. This endpoint also returns annotations and length statistics;
  ignore them. Never substitute full chat export or `/all/db`.
- The limiter's metadata and valves: only allowlisted non-secret fields appear
  in the aggregate output. Verify schema/source before relying on this on a
  different OWUI release.

At most two reads run concurrently, with a 10,000-read budget and bounded
transient HTTP retries. The first run needed about 1,250 reads for 586 accounts
and 643 retained chats. Rate-limit or transport failures are not partial success.
Raw identifying timestamps exist only in process memory, not persisted exports.
No LLM processing or external analytics service is used.

Count all stored history branches, not just the selected branch. Deduplicate
message IDs per owner to reduce clone/fork inflation. Conflicting timestamps
use the earliest value as a deterministic heuristic and are counted separately.
The rolling count at event time `t` includes `(t - window, t]`; events exactly
one window old have expired. The script reads live thresholds, and always adds
a 24-hour comparison using the long-window count allowance, whether or not that
is the current policy. Label that column as a comparison, not deployed behavior.

## Interpretation limits

- Retention is 90 days **since chat activity**, not since each message. Old
  messages can survive in active chats. Analyze a fixed recent timestamp range
  rather than treating all retained messages as an uncensored historical sample.
- Deleted chats, temporary chats, rejected attempts and unsaved activity are
  absent. Stored failed attempts can remain. Regenerations, edits, imports,
  multiple model responses and cloned IDs make message counts differ from inlet
  admissions. Assistant messages are not internal tool-completion counts.
- Surviving data are selection-biased and policy-censored. Lack of pile-up near
  a limit suggests headroom in observed use, not proof nobody was throttled or
  discouraged. Historical threshold settings and restart-resetting process-local
  counters also affect interpretation. The script compares against **current**
  valves; it does not reconstruct historical settings.
- Left-edge windows are partial. Event quantiles exclude them; per-user peaks
  can still understate activity crossing the analysis boundary. This matters
  most for long windows and short analysis periods.
- With `global_limit=false`, the current per-user pooled analysis no longer
  matches per-model enforcement. Review/redesign the grouping before tuning.
- Request quotas address submission frequency, not tool-loop workload or dollars.
  Gateway budgets or provider spend caps answer different questions.

## Verification, rollback and recording

Run `uv run chat/analysis/request_rates.py --self-test` and `git diff --check`.
The synthetic test needs no credentials. A source-trace/schema review remains
necessary after upgrades; synthetic arithmetic tests do not qualify live API
compatibility. There is no production rollback because analysis changes nothing.
Discard private intermediate outputs when no longer needed; do not preserve raw
data beyond its source retention merely to make future analysis easier.

After a run, append a short refinement entry with coverage/caveats and recipe
changes. Record code/docs as `add: retain Chat rate-limit analytics recipe`,
only with explicit commit/push approval. No user identities or raw results in git.

## Refinement log

- 2026-10-27: Initial read-only metadata scan covered 586 accounts and 643 chats;
  excluded the synthetic probe and deduplicated 38 message IDs (one conflicting
  timestamp). No raw message text or identifying rows persisted. Compared 30/90
  days and user/assistant proxies; saved the rerunnable script with live-valve
  discovery and deterministic duplicate handling. The original scan used fixed
  thresholds; the saved script's live-valve path has synthetic tests but has not
  been rerun against production. No limit change was authorized by this analysis.
