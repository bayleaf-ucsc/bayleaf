# AX run 03: same contract, framed as an Inboxes type ("shared")

- Date: 2026-11-11
- Issue: #159
- Agent: fresh `general` subagent, claude-opus-5-5 (session `ses_e332d1a08ffeZkmnzsVKXV74b0`)
- Only variable vs run 02: framing. The contract is identical, defects included,
  re-expressed as `POST /inboxes {"type":"shared"}` in `rooms/docs/inboxes-shared-variant.md`.
  It is delivered as an addendum to the real `docs/inboxes.md`; there is no Rooms skill,
  and the `bayleaf-inboxes` skill description is broadened to name class activities,
  shared boards and multi-user documents.
- Added neutral probe: "list every limit and lifetime your plan depends on, with its source"

## Run 02 vs run 03

| | 02 Rooms framing | 03 Inboxes framing |
|---|---|---|
| Found the capability | Yes, via a dedicated skill description | Yes, via the broadened inboxes description |
| Wrong transfer of inbox semantics into the design | n/a | None: it correctly noted entries never expire individually |
| Contradictions it had to reconcile | 0 | 4 (30- vs 90-day max lifetime; "lives until destroyed" vs idle reap; "stores content for up to 90 days"; deployed `type` enum and `additionalProperties:false`) |
| Hosted-tool policy conflict | Not raised | Raised: the inboxes skill says hosted agents must use MCP tools, not shell plus credentials |
| Credential plan | Shared `students` link (+ per-student option) | 30 per-student credentials by default; blocked on the unknown credential cap |
| Confidence | ~80% | ~70% |
| Context read | ~20k tokens (~3k useful) | ~13k tokens |

## Reading

- Familiar framing did not cause harmful transfer for a capable model. It cost carve-outs:
  every Inboxes invariant (one reader, per-message expiry, lifetime never renewed, 30-day
  `ttl_seconds` maximum, the SSE subscriber cap) needed an "except shared" in the docs, and
  the agent spent its attention reconciling them. Smaller models are the untested risk.
- Discovery worked equally well in both runs because the skill description used request
  vocabulary ("class activities", "shared boards", "multi-user documents"). Vocabulary,
  not product family, did the discovery work.
- The familiarity benefit Adam is after is a human one. The agents never needed the
  concept to be familiar. Humans see a link in Canvas.

## New findings that hold under either framing

1. **The hosted OpenChamber path is undefined.** The Inboxes skill forbids shell-plus-credential
   bypasses in hosted setups. Rooms would need hosted MCP tools, or an explicit statement
   that owner-plane `curl` with the sandbox credential is the sanctioned path.
2. **Multi-day return:** `sessionStorage` loses the key when the tab closes; students
   come back across the week. Recommend `localStorage` with an explicit "forget this
   device" control, or tell students to bookmark the link.
3. **Credential labels are visible to every participant.** The docs must say so, because
   it's the easiest way to leak real names.
4. **Bulk issuance and a credential cap** are wanted (per-student links: 32 credentials).
5. **Freeze to read-only:** one call that revokes all write credentials and keeps reads.
   Wanted for teardown in both runs.
6. **Does the WebSocket replay after `after`, or must the client page `/log` first?**
   Still unspecified.
7. **Moving files out of the Sandbox** (the links CSV, the export) has no documented route.
