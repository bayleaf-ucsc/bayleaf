# Rooms aggregate contract

**Status: approved by Adam 2026-11-11 with two changes (see below), activation at
the Rooms launch.** Approved changes: `room.connections` carries no `codec`
(auth failures need no room format), and `room.compactions` is dropped. That
leaves 6 names and 30 fixed series. Counts are never published. Deployed
2026-11-11: collector `bayleaf-telemetry` version `a8d9859f` with
`ROOMS_METRICS_ENABLED` true and a dedicated `rooms` writer (evidence in
`rooms/QUALIFICATION.md`). The approved vocabulary is `ROOM_VOCABULARY` in
`src/policies.js` (policy 5), enforced by `src/validate.js`.

## Approved vocabulary: 6 names, 30 fixed series

| Metric | Unit | Attributes | Series | Operator question |
|---|---|---|---|---|
| `room.lifecycle` | `1` | `codec` json\|yjs; `outcome` created\|expired\|deleted\|retired | 8 | Adoption; are rooms ending by expiry, owner deletion or account retirement as designed? |
| `room.appends` | `1` | `codec`; `outcome` accepted\|frozen\|too_large\|room_full\|scope\|rate_limited | 12 | Use volume; are limits (entry size, room cap, rate, read-only) hit, and by which codec? |
| `room.append.bytes` | `By` | `codec`; `outcome` accepted | 2 | Storage growth and cost; is `MAX_ENTRY_BYTES_*` sized right? |
| `room.connections` | `1` | `outcome` opened\|auth_failed\|room_busy | 3 | Live usage; credential guessing or broken links; socket cap pressure |
| `room.presence` | `1` | `outcome` relayed\|rate_limited\|too_large | 3 | Presence volume and whether its 1 KiB / 5/s limits bite |
| `room.fanout.frames` | `1` | `kind` entry\|presence | 2 | Frames sent: the actual relay cost (Durable Object egress/CPU) |

Sections marked historical below are the original proposal as reviewed, kept for
the record. Where they differ from this table, this table is current; the
exclusions, privacy argument and retention sections still apply unchanged.

Source `rooms` uses the existing authenticated `POST /v1/metrics` protocol, schema
1, policy 5 (policy 4 plus this source; no other policy change). It gets its own
entry in collector `WRITE_KEYS_JSON`, scoped to class `metrics` and source `rooms`
only. That writer cannot read: `/v1/read/*` accepts only `READ_SECRET`, and tests
assert writer reads return 401. No new collector table, public read, cloud
resource or per-request event store.

Shape is identical to Inboxes: monotonic delta sums, integer values, aligned UTC
15-minute windows (`start_at`, exclusive `observed_at = start_at + 900000`),
envelope observation equals window end, batch UUID identifies only that export
window and is unchanged on retry, at most one point per series per batch. Every
attribute listed for a name is required; unknown names, attributes or values are
rejected for the whole batch. Missing points/windows are unknown, not zero.

## Vocabulary: 7 names, 34 fixed series (original proposal, historical)

At proposal time `rooms/DESIGN.md` claimed 33 series, while the product of the
listed vocabularies was **34** (`ROOM_SERIES` then asserted 34).

| Metric | Unit | Attributes | Series | Operator question |
|---|---|---|---|---|
| `room.lifecycle` | `1` | `codec` json\|yjs; `outcome` created\|expired\|deleted\|retired | 8 | Adoption; are rooms ending by expiry, owner deletion or account retirement as designed? |
| `room.appends` | `1` | `codec`; `outcome` accepted\|frozen\|too_large\|room_full\|scope\|rate_limited | 12 | Use volume; are limits (entry size, room cap, rate, read-only) hit, and by which codec? |
| `room.append.bytes` | `By` | `codec`; `outcome` accepted | 2 | Storage growth and cost; is `MAX_ENTRY_BYTES_*` sized right? |
| `room.connections` | `1` | `codec`; `outcome` opened\|auth_failed\|room_busy | 6 | Live usage; credential guessing or broken links; socket cap pressure |
| `room.presence` | `1` | `outcome` relayed\|rate_limited\|too_large | 3 | Presence volume and whether its 1 KiB / 5/s limits bite |
| `room.fanout.frames` | `1` | `kind` entry\|presence | 2 | Frames sent: the actual relay cost (Durable Object egress/CPU) |
| `room.compactions` | `1` | `outcome` compacted | 1 | Whether yjs compaction runs at the expected rate |

Definitions to pin before activation (the Rooms Worker owns counting):
`lifecycle` counts completed destruction (D1 row removed), not requests;
`retired` counts rooms destroyed by `retireOwner`; appends count terminal handler
outcomes, once per attempt (idempotent replays should not count twice);
`room.append.bytes` counts stored bytes of accepted entries before compaction;
`fanout.frames` counts frames handed to sockets, not frames delivered.

## Explicitly excluded

Room ids, credential ids, labels, owners or account pseudonyms, link fragments,
secrets, IPs/UA, hostnames, paths, query strings, entry content or sizes per
entry, presence payloads or presence state, participant counts per room, per-room
anything, raw errors, and timing finer than 15 minutes. No histogram or gauge is
proposed; no per-room dimension can be added without a new policy version.

## Privacy argument and its limits

Each series is a sum across all rooms in a 15-minute window, keyed only by codec,
outcome or frame kind. None of those values names a room or person, and the
collector rejects any other attribute. The operator already holds strictly more
precise data in the Rooms D1 index (owner, `created_at`, `expires_at`), so these
counts give the operator no new ability to identify anyone.

The honest risk is **small numbers**, which matter if these counts ever leave the
operator's private read (a public chart, a shared export, a paper figure):

- With one or a few rooms, `room.lifecycle created=1` in a window discloses when a
  room was created, and `retired` discloses roughly when some account holding rooms
  was deleted. Anyone who knows which person uses Rooms can then read their timing.
- `room.fanout.frames / room.appends` in a window with one active room approximates
  that room's live audience size; `connections opened` gives its join rhythm.
- `auth_failed` spikes can point at a specific known room under attack.
- Counts outlive the rooms: after a room is deleted or its owner retired, its
  activity profile persists, unlinked, for up to 90 days of collector retention.

Mitigations proposed: no public exposure (current authorization covers none);
any derived or published artifact aggregates to at least one day and suppresses
cells below a small threshold (for example, fewer than 5 rooms or windows); the
public status page continues to show configuration only, never counts.

## Retention and best effort

Collector retention is the existing durable metrics-class ceiling, 90 days in
production, anchored to the window end; retries never extend expiry. Time Travel,
backup and derived-artifact caveats in `../AGENTS.md` apply unchanged.

Counting is best effort, as in `rooms/DESIGN.md`: each Durable Object holds
counters in memory and flushes to Rooms D1 `metric_windows` at most every 10
seconds and on hibernation/destruction; eviction loses unflushed counts. The
15-minute cron exports completed windows and deletes them. These are operational
signals, not billing, quota enforcement or exactly-once accounting. Telemetry
failure must never fail a participant request. Rooms should bound local storage
and export eligibility as Inboxes does (sealed windows, 24-hour local expiry,
durable batch UUID, only HTTP 202 acknowledges); that is Rooms-side work.

## Recommendations (keep/drop; historical, adopted as the two approved changes)

- `room.lifecycle`: **keep.** Needed to verify expiry and retirement paths work.
- `room.appends`: **keep.** Core limit-tuning and abuse signal.
- `room.append.bytes`: **keep.** Cost/growth signal; `accepted` only is right.
- `room.connections`: **keep, but fix `codec` for `auth_failed`.** In the current
  spike `rooms/worker/src/index.js` the codec getter defaults to `json` when meta
  is absent, so a failed connection to a nonexistent or destroyed room would be
  counted as `json`, and guessing nonexistent ids is the main abuse case. Either
  drop `codec` from `room.connections` (3 series, total 31) or count `auth_failed`
  only where the codec is known and document that guessing is not covered.
  Recommendation: drop `codec` here; the codec split adds little to a connection
  count.
- `room.presence`: **keep, lower priority.** `relayed` overlaps with
  `fanout.frames kind=presence`, but input vs amplification is a useful ratio.
- `room.fanout.frames`: **keep.** It is the cost signal the service exists to
  bound. It is also the series most exposed to the audience-size inference above.
- `room.compactions`: **drop, or add `failed`.** Compaction is yjs-only, and a
  success-only count cannot answer "is compaction healthy". As proposed it mostly
  restates appends / `COMPACT_ENTRIES`.

At proposal time the code matched the proposal exactly so review could decide.
Both drops were approved and are implemented: dropping `codec` from connections and `room.compactions`
would give 6 names and 30 series.

## Activation checklist (all operator gates; completed at launch, 2026-11-11)

1. Operator approves this vocabulary (or a revised one), including the series
   count and the small-number publication rule. Record date and scope here.
2. Correct the series count in `rooms/DESIGN.md`; reconcile `PRIVACY.md` text
   (owned elsewhere) with exact-diff publication approval before commit/push.
3. Deploy the collector with policy 5 and `ROOMS_METRICS_ENABLED` still `"false"`
   (present as `"false"` in both Wrangler configs). Collector deploys **before**
   the Rooms Worker exports anything; no migration is required.
4. Provision a dedicated `rooms` entry in collector `WRITE_KEYS_JSON` (at least 24
   non-space characters, distinct from every other writer and `READ_SECRET`),
   preserving existing writers, and the same value as Rooms secret
   `ROOMS_TELEMETRY_WRITE_SECRET`.
5. Deploy Rooms with `ROOMS_TELEMETRY_ENABLED` false; then explicitly enable the
   collector `ROOMS_METRICS_ENABLED` and the Rooms `ROOMS_TELEMETRY_ENABLED`.
6. Qualify with synthetic rooms: private operator readback of one aligned window,
   writer read 401, duplicate retry deduplicated. Mark synthetic windows so they
   are not read as human usage.

## Local evidence

`npm test` in `telemetry/` (2026-11-11), including `test/rooms.test.js`: the full
30-series matrix round-trips through validation;
unknown attributes, values, names, units, codec on codec-less names, cross-source
names, non-delta or misaligned windows and duplicate series are rejected; the
receiver is off by default, accepts only the `rooms` writer, deduplicates retries
and keeps reads operator-only with 90-day expiry. Local tests are not live proof.
