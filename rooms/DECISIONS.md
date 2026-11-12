# Rooms design decisions (spike branch, issue #159)

Provisional decisions from the AX playtests in `ax/`. Each cites its evidence.

1. **Family name for humans, separate contracts for agents.** People meet
   "Inboxes and Rooms: places data accumulates while your agent is away".
   Agents read separate docs. Evidence: run 03 (Inboxes framing produced four
   contradictions, with no gain in discovery).
2. **Principle: BayLeaf relays, it does not arbitrate.** No locks, turn-taking or
   ownership of parts of the data. The authority that remains (quotas, credentials,
   redact on non-CRDT rooms, delete) is named in the docs. Any read holder can
   export, so the commons does not depend on the owner. (Adam, 2026-11-11.)
3. **Opaque log by default, opt-in `codec: "yjs"`** with server-side compaction
   and an official provider. Evidence: runs 04a and 04b (about 525 vs 90 lines of
   self-written plumbing). The workload in run 04 needs a CRDT even when the
   agent isn't offered one.
4. **The commons wins over attribution in CRDT rooms.** Yjs rooms carry no `cred`
   on entries and keep no `clientID → cred` sidecar. Authorship is an in-document
   convention, treated as a claim. (Adam, 2026-11-11.) Credentials still gate
   access, and presence still shows `cred`.
5. **Redact is codec-aware.** Allowed on opaque logs of self-contained entries;
   absent in yjs rooms. Evidence: run 04a.
7. **Rooms host live activities, not gradeable records.** Use a room the way you'd
   use a live discussion. Anything graded is submitted elsewhere (Canvas, etc.).
   Authorship inside a room is ephemera for the exercise, so the provider ships
   no attribution helper: a nickname in presence and a `by` field by convention
   are enough. (Adam, 2026-11-11.)
8. **Entry cap is per codec: 64 KiB for JSON, 1 MiB for yjs.** A Yjs update can't be
   split meaningfully, so a large paste needs a large entry. The cap guards against
   abuse; it is not a document-size limit. Evidence: SPIKE.md finding 3.
   (Adam, 2026-11-11.)
9. **The provider never drops an update.** A gap in one client's Yjs updates
   silently stalls all its later edits on every peer. A freeze (409) queues edits
   and reports `read_only`. An edit that can never sync (413, 403) reports
   `diverged`, and the app reloads from the room. Evidence: SPIKE.md finding 4.
   (Adam, 2026-11-11.)
10. **Mechanism, not policy.** Add general mechanisms that many apps compose, not
    features shaped to one brief. Evidence: run 05 asked for a `present` role,
    send-only tickets, `not_before`, rotation and per-credential socket caps.
    Each fits the deck; most are policy. (Adam, 2026-11-11.)
11. **Fixed expiry, owner can extend.** Use never renews a room (as with
    Inboxes): default 30 days, at most 90 days ahead, extended by `PATCH`. The
    Durable Object alarm is the only reaper. (Adam, 2026-11-11.)
12. **Participant host is `bayleaf-rooms.dev`,** chosen for elegance and symmetry
    with `bayleaf-inboxes.dev`, not for technical reasons. The domain is in the
    BayLeaf Cloudflare account. (Adam, 2026-11-11.)
13. **Production rollout:**
    - Open to campus at launch, with no pilot-owner stage. The `ROOMS_ENABLED`
      kill switch stays.
    - Propose a telemetry vocabulary now (for policy review).
    - Agents discover Rooms through skills (desktop and hosted OpenChamber)
      that teach the HTTP API, not through agent tools.
    - Full API docs, app-token scopes, and a dashboard card; no Chat coverage.
    (Adam, 2026-11-11.)
14. **Scopes, not ranked roles.** Every credential reads the log, exports and
    receives presence. Three independent scopes add powers: `presence`, `append`
    and `manage`. `read`, `write` and `manage` remain as shorthands. A freeze
    stops `append` only; presence keeps flowing, because it was never part of the
    record. This is the mechanism behind run 05's wishes. Deferred as policy until
    a second app asks: `not_before`, `rotate`, per-credential socket caps,
    send-only subscriptions. (Adam, 2026-11-11.)
6. **Pre-issued credentials (#159 decision 2, option A) suffice** for the class
   workloads tested. Bulk issue and freeze-to-read-only are in; runtime
   issuance is out.

Open: multi-room kits and links (runs 04a and 04b), provider packaging with Yjs
as a peer dependency (run 04b), checkpoint semantics on opaque logs (run 04a).

Candidate workload (Adam, 2026-11-11), not yet playtested: an **audience-cursor
slide deck**. An audience of 30–150 joins from phones via a projected QR code.
Each person taps a spot on the slide to park a cursor ("question here",
"ready"), which works as informal real-time polling. It is presence-only (nothing
needs to be stored) and fan-in shaped (one projector reads, many phones write).
It raises two questions: a presence-only role, since a projected link is
effectively public, and a send-only subscription, so 150 phones don't each
receive 150 cursors.
