# AX run 02: docs-first, draft Rooms contract, GitHub Pages for a week

- Date: 2026-11-11
- Issue: #159
- Agent: fresh `general` subagent, claude-opus-5-5, no conversation context
  (session `ses_e3335393dffeKzWQs6dQqM4KRg`)
- Mode: hypothetical development sketch only
- Scenario change from run 01: the agent runs inside the instructor's Sandbox with `gh`
  authenticated; the app lives on GitHub Pages Monday to Friday, must outlive the
  Sandbox, and is torn down at the end of the week
- Rooms knowledge: `rooms/docs/rooms.md` (draft), advertised as a `bayleaf-rooms`
  skill in the catalog

## Run 01 vs run 02

| | 01 baseline | 02 draft Rooms |
|---|---|---|
| Server it had to write or operate | 200-line `ws` server on the Sandbox | None |
| Lifecycle babysitting | Poke and re-expose every 24 h, idle-stop risk | Set `expires_at`; teardown script |
| Self-reported confidence | ~70% (needs rehearsal) | ~80% (WS frame details) |
| Fetches / tokens read | 8 / 15–20k | 4 / ~20k, of which ~3k useful |
| Fallback if the platform is missing | Firebase | Firebase or Supabase, *if the skill weren't in the catalog* |

## What held up

- Capability links with the secret in the fragment, plus `replaceState`: used exactly
  as written. The public-repo concern dissolved.
- The "what `cred` proves" section: the agent used `cred === "teacher"` as its one
  server-backed rule and labeled nicknames as unverified in the UI.
- Event-sourced `data` with client-side ids: adopted without friction. It chose
  last-write-wins card edits and pushed back on Yjs.
- Export-then-delete teardown, with students warned and a "download my contributions"
  button.

## Contract defects to fix in the draft

1. **Is `cred` a label or an ID?** Two credentials can share a label, which makes
   `cred === "teacher"` ambiguous. Fix: labels must be unique per room, or stamp both
   `cred_id` and `cred_label`.
2. **Ticket URL shape:** `${url}&after=` assumes there's an existing query string.
   Specify `url` fully, or accept `after` in the ticket request.
3. **WebSocket append semantics:** no error or nack frame (413/429), and own appends
   may or may not echo as `entry`. The agent fell back to HTTP appends. Define:
   - `ack {idem, seq}` or `error {idem, status, retry_after}`;
   - whether the server always echoes the writer's own entries.
4. **`head` is undefined.** Specify it as the highest seq.
5. **Eligibility is unstated.** Say who can own rooms (campus owners), matching Inboxes.
6. **Credential count limit and bulk issuance** for the per-student option.
7. **Deletion vs backups:** state what deletion means operationally.

## Design questions it surfaced (need a decision, not just a docs fix)

- **Moderation:** `manage` adds only checkpoint. The first thing a real instructor
  asks for is removing one inappropriate entry. Candidate: a manage-only
  `redact {seq}` that replaces `data` with a tombstone while keeping `seq`, `ts` and
  `cred`. This doesn't make the room a CRDT; it's a narrow, platform-level operation
  that is the same for every app (so it passes the #159 scope-creep test).
- **Extending expiry:** `PATCH` can only shorten. Allowing extension up to the 90-day
  maximum looks harmless and avoids the export, recreate and reissue dance.
- **A read-only snapshot that outlives the room:** decision 4, and still deferred.

## Discovery lesson

The agent found Rooms only because the catalog listed a dedicated skill whose
description matched. `bayleaf-platform` and llms.txt don't mention it. Both need a
one-line pointer, and the skill description should name "class activity" and
"multiplayer" explicitly, since those are the words in requests.
