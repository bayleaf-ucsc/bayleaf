# Sealed daily spend limits: defer pending better upstream support

Decision date: 2026-10-05. Investigation for [issue #82](https://github.com/bayleaf-ucsc/bayleaf/issues/82). ✨

## Decision

**Do not implement daily dollar allowances as a small feature under the current
Tinfoil API contract.** They are feasible as a dedicated accounting/control
subsystem, but are materially more complicated than OpenRouter's native daily
caps. Keep the existing request allowance and provider-reported spend display
until upstream support improves or we deliberately fund that subsystem.

This is a scope/maintenance decision, not a finding that confidential inference
prevents dollar metering. Tinfoil already measures actual spend, including
streaming. No request-body inspection or local model-price estimation is needed.

## Evidence and its limits

Reviewed the current [Admin API documentation](https://docs.tinfoil.sh/admin/admin-api)
and [quota errors](https://docs.tinfoil.sh/sdk/error-handling), plus
`src/tinfoil.ts`, `src/provision.ts`, `src/openrouter.ts`,
`src/routes/sealed.ts`, `src/routes/usage.ts`, and migration 0005.

- Tinfoil documents `max_cost` on creation and update, lifetime
  `cost_used_nanos` / `max_cost_nanos`, and `429 insufficient_quota` on exhaustion.
  Raising the cap is the documented way to restore access.
- The caps are explicitly **lifetime totals**. No daily reset field is documented.
  `max_cost: 0` clears a cap; creation requires at least $0.01 for a finite cap.
- Billing supports explicit time ranges, limited to two years, and returns dollar
  costs. The docs do not specify a finalized-through watermark, atomic snapshot
  shared with lifetime counters, maximum accounting delay, midnight attribution
  for requests spanning the boundary, or a bound on concurrent-request overshoot.
- OpenRouter creation already supplies `limit` and `limit_reset: daily`.
  Its upstream service owns rollover; BayLeaf does not emulate it.
- BayLeaf preserves Tinfoil keys on ordinary token rotation. Healing overwrites
  the stored provider key/name without a retained key-history table. Today's
  atomic D1 request counter survives healing, but a fresh provider dollar cap
  would not automatically include spending on the old key.
- `/usage` currently reports Sealed requests, not a dollar allowance. The
  dashboard's day/month dollar readings are informational, not enforcement.

These are documentation and code findings. No live cap changes or paid inference
experiments were performed for this investigation. Native enforcement precision,
propagation, streaming behavior, and overshoot remain unmeasured. Earlier July
measurements in `AGENTS.md` establish that billing includes streaming and was
visible at the first poll six seconds after completion; they do not establish a
maximum delay or a hard cap.

## Why a midnight cron is insufficient

For one persistent provider key, the intended absolute ceiling is:

```
ceiling(day) = finalized spend before day starts + daily allowance
```

The arithmetic is simple; establishing and maintaining the baseline is not.

1. **Unused credit must disappear.** If yesterday's ceiling was $105 and actual
   lifetime spend was $102 at midnight, today's $5 ceiling should be $107,
   not $110. Incrementing yesterday's ceiling accumulates unused credit.
2. **Delayed rollover must include today's existing spend.** If the user spends
   $2 after midnight before a job runs, `current spend + $5` gives a total $7
   allowance that day. An explicit historical query is better, but its settlement
   and boundary semantics must be established. Subtracting separate lifetime and
   day-to-date readings can also race or mix differently updated counters.
3. **Retries require durable coordination.** Updating the same established
   ceiling is idempotent. Recomputing it from moving readings is not necessarily
   so. Day/version tracking and serialized updates are needed to prevent delayed
   old jobs from overwriting newer allowances or operator exceptions. The
   documented upstream update endpoint has no conditional version parameter.
4. **Availability becomes coupled to rollover.** An exhausted key remains
   exhausted after midnight until the cap update succeeds. A lazy first-use
   rollover can recover missed jobs, but adds an admin-plane dependency to the
   request path. Fail-open recovery would defeat the budget.
5. **Healing becomes accounting, not just credential repair.** A replacement
   needs the remaining allowance across all of that user's keys for the day,
   including late charges to old in-flight requests. Missing billing must not
   mean zero spent. Exhausted users need a local denial state: zero is not a
   finite upstream cap. Attribution needs retained lineage, not just the current
   key name.
6. **A daily policy needs its own source of truth.** A lifetime ceiling alone
   cannot encode a durable $5/day default or $20/day exception. BayLeaf must
   persist that policy and rollover state somewhere. This would require an
   explicit revision of the current no-local-limit policy, rather than pretending
   the absolute provider cap is equivalent to a daily allowance.

Periodic billing polling plus local admission control is another feasible design,
but it has accounting lag and in-flight spend exposure. A concurrency limit alone
does not establish a dollar bound without a defensible maximum request cost;
BayLeaf cannot inspect or constrain encrypted model/context/output parameters.
Provider enforcement could improve that bound, but its reservation and concurrent
charging behavior must first be measured or guaranteed. Neither design should be
advertised as an exact daily hard ceiling on present evidence.

## Personal exceptions

Adam's desire for additional Sealed headroom is separate from implementing daily
dollar accounting:

- **Lifetime dollar exception:** Tinfoil documents a simple per-key `max_cost`
  update. This is a lifetime ceiling, not a recurring daily allowance. BayLeaf
  currently creates uncapped keys, so raising a provider dollar cap would not
  remove the existing 500-requests/day gate.
- **Daily request exception:** a per-user override of the existing atomic Sealed
  request limit is a small, practical feature. It would need one authoritative
  policy location and consistent enforcement/dashboard/`/usage` reads, keyed to
  the user's stable identity so token rotation preserves it. This provides more
  headroom but does not reward cheaper requests or enforce dollars.
- **Daily dollar exception:** small once a correct daily-budget subsystem exists;
  it does not make that prerequisite subsystem small.

No personal limit was changed in this investigation. Choose an explicit request
allowance before implementing a personal request-count exception.

## When to revisit

Reopen implementation if either:

1. Tinfoil adds provider-managed per-key calendar-day spend caps with a defined
   reset timezone, update semantics, and observable daily usage/remaining budget.
   Persistent keys and per-key exceptions should then map naturally to BayLeaf.
   Replacement-key carryover still needs a policy or upstream identity support.
2. We explicitly choose to own a daily-budget controller. Before building it,
   establish billing settlement/boundary semantics and live-test streamed and
   non-streamed exhaustion, raising an exhausted cap, monetary precision,
   update propagation, concurrent overshoot, and old-key billing after deletion.
   Then implement durable policy, lineage, serialized rollover/recovery,
   fail-closed admission, and matching UI/API states. Use integer monetary units
   with validated decimal conversion; never use zero as an exhausted cap.

The presence of `max_cost`, spend charts, or explicit date-range billing alone
is **not new evidence** that resolves this decision. Those capabilities were
already considered here. A lifetime-cap canary could characterize enforcement,
but would not eliminate the daily policy and lifecycle work above.
