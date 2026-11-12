# AX run 01: baseline (no Rooms), history peer-review brief

- Date: 2026-11-11
- Issue: #159
- Agent: fresh `general` subagent, claude-opus-5-5, no conversation context
- Mode: hypothetical development sketch only (no builds, no authenticated calls)
- Entry point: public skill catalog, then whatever it pointed to; GitHub issues/PRs forbidden
- Brief: the history-class request verbatim, plus "about 30 students, cooperative,
  instructor has an ordinary API key and would rather not run or pay for a server"

## Operator observations

1. **Unprompted convergence on #159.** With no knowledge of the proposal, the agent
   asked for an owner-created room with per-role capabilities, a server-ordered append
   log with live broadcast, `log?after=cursor` catch-up, and optional y-websocket
   compatibility. It also generalized to a category: think-pair-share, gallery walks
   and live polls.
2. **Workload evidence for open decision 1.** The agent judged Yjs to be overkill: the
   activity is an append-only threaded board, so it designed an event log. This is a
   point for the opaque log, or at least for keeping the log usable without a CRDT.
3. **Reinvented wheel: the Sandbox as an app server.** About 200 lines of `ws` server,
   plus lifecycle babysitting: poke before class, re-expose every 24 h, and the risk of
   an idle stop. Its confidence was about 70%, contingent on a rehearsal.
4. **Docs gaps that exist independently of Rooms:**
   - Does inbound traffic through an exposed port count as Sandbox activity?
   - Are there concurrency or bandwidth limits on public exposure?
   - Is hosting a class app through `/sandbox/expose` a sanctioned use?
   - WebSocket support through the preview proxy is documented only as a clause in
     the OpenAPI spec.
   - Archive and retention behavior after a Sandbox is archived is unclear to an
     outside reader.
5. **Inboxes were correctly ruled out** because the 4-subscriber SSE cap is documented
   clearly. Clear limits produced fast, correct negative decisions.
6. **Credential shape it reached for:** shareable join links, with the token in the
   WebSocket query string. That's the bearer-in-URL pattern that #159's tickets are
   meant to avoid. The ergonomics we must match are "a link the teacher can paste into
   Canvas."
7. **Static hosting was sidestepped** by serving `index.html` from the same Sandbox.
   With Rooms but no static host, the agent will either reach for GitHub Pages or keep
   using a Sandbox.
8. **Reading cost:** 8 fetches, about 15–20k tokens, of which about 80% of llms.txt was
   irrelevant to the task.

## Agent's report (verbatim)

The full sketch and AX report are in the session transcript (subagent
`ses_e33412168fferlYZq2ceM6oFrM`). Key excerpt, the API it wished for:

```
POST /rooms {"ttl_seconds":10800,"retention_seconds":604800,"max_participants":40}
 -> {room_id, owner_url, join_url, join_token}
POST /rooms/{id}/join-links {"role":"participant","expires_at":...}   // capability per role
WS   wss://rooms.bayleaf.dev/{id}?t=<join token>     // server-ordered append log + broadcast
GET  /rooms/{id}/log?after=cursor   (owner)          // export / teacher replay
DELETE /rooms/{id}
```

Its data model (event-sourced):

```js
{ id, ts, actor: { nick, role }, type, ...payload }
// source.claim { sourceId } | arg.create { argId, sourceId, text }
// reply.create { replyId, argId, stance: "support"|"counter", text }
// phase.set { phase }   (teacher only, enforced by its own server)
```

Note the server-stamped `id`, `ts` and `actor`. In an opaque-log Rooms, the server can
assign `seq` and `ts`, but `actor` would be client-asserted unless the platform
attributes writes to credentials (open decision 6).
