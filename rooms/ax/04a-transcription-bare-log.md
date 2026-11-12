# AX run 04a: transcription brief, bare log (rooms-v2.md only)

Agent: fresh coding agent in an instructor's BayLeaf Sandbox. Exercise: plan and sketch only; nothing built, published or deployed.

## 1. Discovery trail

1. Read the harness skill catalog: `bayleaf-rooms` matched "multi-user documents, co-editing" with no server. Picked it.
2. Fetched `bayleaf-platform` skill (P3 ceiling, app tokens, pointer to llms.txt). Nothing about rooms in it, so I didn't follow llms.txt.
3. Read `rooms.md` (rooms-v2 draft) in full: two planes, capability links, log + WebSocket, "use a CRDT", checkpoint, limits, privacy.
4. Skipped `openapi.json` and `bayleaf-inboxes` (not relevant: nothing here is inbound email or webhooks).
5. Drew on what I already know of Yjs, y-prosemirror, Tiptap and y-indexeddb. I didn't fetch their docs.

## 2. Development sketch

**Architecture.** One static site on GitHub Pages (`transcribe-week`): `index.html` (student editor), `teacher.html` (overview), `letters/g1.jpg … g8.jpg`, and one bundled `app.js`. One room per group (8 of the 20-room quota) gives each group its own log and 10 MiB budget, and keeps replay small. BayLeaf Rooms is the only backend. The instructor runs a one-off provisioning script from the Sandbox with `curl` + `$BAYLEAF_TOKEN`.

**Libraries.** Yjs (CRDT), y-prosemirror + Tiptap StarterKit (editor bound to a `Y.XmlFragment`), y-indexeddb (local persistence for flaky wifi), and y-protocols/awareness for cursors, bridged onto room presence. I'd bundle with esbuild in the Sandbox and commit `app.js` so the page has no runtime CDN dependency. Tiptap's own Comments extension is a paid cloud product, so I'd build comments myself.

**Data model (inside one Y.Doc per group).**
- `doc.getXmlFragment("text")`: the transcription. The ProseMirror schema adds two marks: `uncertain` (attrs `{id, by}`) and `comment` (attrs `{threadId}`).
- `doc.getMap("threads")`: `threadId → Y.Map{anchorStart, anchorEnd, resolved, messages: Y.Array<{id, by, ts, body}>}`. The anchors are `Y.RelativePosition`s encoded to base64.
- `doc.getMap("meta")`: letter id and image URL.
- Room entries: `data = {t:"u", u:"<base64 Yjs update>", c:"<client uuid>"}`. The checkpoint entry is `{t:"snap", u:"<base64 full state>"}`.

**Concurrent editing.** Every local Y.Doc update (origin ≠ remote) goes into a buffer. A timer flushes every 250 ms: `Y.mergeUpdates(buffer)`, base64, then append over WebSocket with a fresh `idem`. Incoming `entry` frames are deduped by `seq` and applied with origin `"room"`. Yjs merges concurrent inserts and deletes deterministically, so no locks are needed. A student fixes a misreading by selecting and retyping, and everyone converges.

**Anchored comments ("Sacramento or Sacrament?").** I'd use two anchors on purpose:
1. The `comment` mark on the text range, so the highlight moves with the text as y-prosemirror inserts and deletes around it.
2. RelativePositions stored in the thread, as a fallback if someone deletes the marked text or splits the mark. Then the thread shows "anchor lost near …" instead of vanishing.

Flagging a word as uncertain is just toggling the `uncertain` mark. A sidebar lists the open flags and threads, and clicking one scrolls to its anchor.

**Teacher overview.** `teacher.html` opens 8 Y.Docs, one socket each (8 of 200 per room), and renders each group's text read-only in a grid. Each card shows open-flag and open-thread counts plus presence (who's in it). "Jump in" expands that card into the full editor, using the teacher's credential for that room.

**Credential/link plan.**
- Per student: one `write` credential in their group's room, labelled with a pseudonym (`g3-heron`) for per-person attribution. That's about 30 plus 8 teacher credentials, within 100 per room.
- Teacher: one `manage` credential per room, labelled `instructor`.
- Student link: `https://<user>.github.io/transcribe-week/#room=r_..&key=rk_..&g=3`. The `g` (group number) parameter is mine, not part of `link_fragment`.
- Teacher link: a custom fragment `#rooms=r_a:rk_a,r_b:rk_b,…`, because `link_fragment` only covers one room. This is my own convention, so I flag it.
- The page stores `{room, key}` in localStorage, calls `history.replaceState`, and shows a "forget this room on this device" button.
- The pseudonym→student mapping and the links go into the instructor's own spreadsheet or Canvas messages, never into BayLeaf or the repo.

**Owner-plane and `gh` sequence (sketch only).**
```bash
B=https://api.bayleaf.dev/rooms; H="Authorization: Bearer $BAYLEAF_TOKEN"
curl -sH "$H" $B/limits                                   # check quota first
for g in 1..8; do
  curl -sH "$H" -d '{"label":"letters-g'$g'","expires_at":"2026-11-24T08:00:00Z"}' $B   # week + ~5 days buffer
  curl -sH "$H" -d '{"role":"write","labels":["g'$g'-heron","g'$g'-wren",...]}' $B/$ID/credentials
  curl -sH "$H" -d '{"role":"manage","label":"instructor"}' $B/$ID/credentials
done  > links.local.json   # secrets shown once; keep out of the repo, chmod 600
gh repo create transcribe-week --public --source . --push
gh api -X POST repos/{owner}/transcribe-week/pages -f 'source[branch]=main' -f 'source[path]=/'
```
Content-Type headers are omitted for brevity; the real script needs them.

**Key integration point: the provider (abridged).**
```js
let lastSeq = Number(localStorage[`seq:${room}`] || 0), pending = new Map(), buf = [];
doc.on("update", (u, origin) => { if (origin !== "room") buf.push(u); });
setInterval(() => { if (!buf.length) return;
  const idem = crypto.randomUUID(), data = { t: "u", u: b64(Y.mergeUpdates(buf)) }; buf = [];
  pending.set(idem, data); saveOutbox(); send(idem, data); }, 250);
function apply(e) { if (e.seq <= lastSeq) return; lastSeq = e.seq;
  if (e.data && !e.redacted) Y.applyUpdate(doc, unb64(e.data.u), "room");
  localStorage[`seq:${room}`] = lastSeq; }
async function connect() {
  const { url } = await post(`/${room}/tickets`, { after: lastSeq });
  ws = new WebSocket(url); ws.onmessage = onFrame;   // entry/ready/presence/ack/error/end
  ws.onopen = () => pending.forEach((d, idem) => send(idem, d));  // resend with SAME idem
  ws.onclose = () => backoff(connect); }
```
Because y-indexeddb holds local state, a student who goes offline keeps typing. On reconnect the outbox resends with the same idempotency keys. Yjs ignores duplicate updates anyway, so double delivery is harmless to the document; idempotency only protects the quota and the log size.

## 3. Coordination mechanisms

- **Room log sequencing**: the server assigns a total order (`seq`) and stamps `cred`. It orders entries; it doesn't decide anything.
- **Yjs CRDT merge** (client-side, deterministic): decides how concurrent text edits, mark toggles and thread replies combine. No human decides; the algorithm does, identically on every client.
- **Idempotency keys**: dedupe retried appends. The server decides, per key.
- **Comment threads and uncertainty flags**: social coordination. The group decides by discussion whether it's "Sacramento", and someone resolves the thread.
- **Presence/cursors**: soft awareness, so people avoid typing over each other. Nothing is enforced.
- **Local undo** (Yjs UndoManager scoped to local origin): each person undoes only their own edits.
- **Instructor authority** (manage/owner): redact entries, checkpoint, freeze (`read_only`), revoke credentials, delete rooms. The instructor decides.
- **Server limits**: 429/413 with `Retry-After` throttle the room. The server decides mechanically.

## 4. Plumbing you write yourself

| Piece | Est. lines |
|---|---|
| Yjs↔room provider: tickets, socket, frame dispatch, seq dedupe, 250 ms batching, ack/error handling | 150 |
| Reconnection: bounded backoff, `end` reasons, resend outbox with the same idem | 40 |
| Offline outbox persisted to IndexedDB/localStorage (y-indexeddb covers doc state) | 40 |
| Cold-start HTTP catch-up paging (`GET /log?after=`) before or instead of WS replay | 25 |
| Awareness↔presence bridge (cursor encoding, throttle to ≤5/s, map peers to awareness states) | 60 |
| Compaction script (manage holder: replay ≤ upto, encode state, `PUT checkpoint`, verify) | 50 |
| Capability-fragment handling, localStorage, forget button, multi-room teacher fragment | 40 |
| Export/decoder (JSONL → Y.Doc → plain text + comments as Markdown/JSON) | 50 |
| Owner-plane provisioning and teardown shell scripts | 70 |
| **Total plumbing** | **about 525** |

The editor UI, comment sidebar and teacher grid (roughly 400 more lines) are app code, not plumbing. I probably wouldn't need compaction at all. A rough estimate: 4 typists × about 3 hours × 4 flushes/s while typing at about 200 B base64 gives a few MB per room, under 10 MiB. I'd still have the script ready.

## 5. End-of-week teardown, and what each student keeps

1. **Friday, in class:** PATCH every room to `"mode":"read_only"`. Students can still read and export.
2. **Students:** an "Export" button downloads their group's transcription as plain text and Markdown with the flags and comment threads inlined, plus the raw room JSONL from `GET /{room}/export`. Each student keeps the full group commons: final text, every comment, and per-pseudonym attribution. The raw JSONL is only useful with Yjs, which is why the app also decodes it.
3. **Instructor:** export all 8 rooms from the Sandbox and archive them locally (not in the public repo).
4. **After the buffer** (or on request): `DELETE /rooms/{id}` ×8. Sockets get `end`, and links stop working.
5. **Site:** `gh api -X DELETE repos/{owner}/transcribe-week/pages`, then `gh repo delete` (this may need `gh auth refresh -s delete_repo`) or archive it. The rooms' `expires_at` is a backstop if teardown is forgotten.
6. **localStorage keys on devices:** these are dead once the rooms are deleted. The "forget" button cleans them up.

## 6. What I had to bring from outside BayLeaf and GitHub Pages

Yjs, y-prosemirror, Tiptap/ProseMirror, y-indexeddb, y-protocols (awareness), and esbuild to bundle them. I also need the letter images and confirmation that they're public domain or licensed for a public repo. Link distribution (Canvas messages, email or printed QR codes) and the private pseudonym roster happen outside BayLeaf.

## 7. AX report

The contract is short and readable. I had a credible design within one read, mostly because it says "use a CRDT, base64 the updates, batch at 250 ms." That one paragraph decided the architecture. But it hands me the whole sync layer. The principle "relays, does not arbitrate" is honest, and in practice it means I write a Yjs provider from scratch. The obvious thing to want is an official `y-bayleaf-rooms` provider. Without one, every app re-implements about 300 lines of subtle reconnection code.

**Stumbles and ambiguities:**
- **Redaction vs CRDT.** Redacting one Yjs update leaves later updates that depend on it stuck as pending, so the doc silently stops converging for everyone who replays. The docs present redaction as a generic moderation tool. For CRDT rooms it's close to a foot-gun. The safe path is redacting the *text* via a new edit plus a checkpoint, but then the original still lives in older entries until compaction. Not documented.
- **Checkpoint semantics.** What `seq` and `cred` does the checkpoint entry get? What happens to a client reconnecting with `after` < `upto`: does replay start with the checkpoint? Is the checkpoint subject to the 64 KiB entry cap (it says entries ≤ 64 KiB; a merged state could exceed that)? "A wrong checkpoint erases others' work" scared me. I also don't know whether appends that arrive between my reading `head` and my PUT are safe. I'd assume yes, since it's `upto`-bounded.
- **WS append vs HTTP append idempotency.** Is the WS `idem` the same key space as the HTTP `Idempotency-Key`? Will I get both an `ack` and my own `entry`? I assumed both, deduped by seq. And is an unacked WS append safe to resend after reconnect?
- **Presence.** There's no stated size cap on `state`. The `peers` list is a whole-list replacement with no join/leave deltas, and 5/s per connection is tight for cursor tracking. Bridging to y-protocols awareness is guesswork.
- **Multi-room teacher view.** `link_fragment` is one room. I invented a multi-room fragment. A "room bundle" or a per-owner read credential across rooms would help.
- **Large replay on page load.** Thousands of entries replay over WS before `ready`, and nothing says whether to prefer HTTP paging or how fast the WS replay is.
- **Link distribution.** Creating 30 per-student links is easy. Getting them to the right students privately isn't covered: no mail-merge hint, no QR helper.

**What I'd get wrong first:** forgetting to resend with the *same* idem after reconnect (duplicates, harmless to Yjs but wasteful); persisting `lastSeq` before the update is applied to IndexedDB (then a crash loses edits on reload); and using redaction to remove a rude comment, which breaks the doc.

**Confidence:** about 70% that the design works this week as sketched. About 85% that the architecture is right, and lower on the provider details until I test against the real socket.

**Reading volume:** 2 fetches/reads (platform skill and the rooms draft), roughly 4.5k tokens. No openapi.json, no llms.txt. That was light enough, but the gaps above are exactly where openapi.json might or might not have helped.

## 8. Privacy and data notes

- Rooms are outside BayLeaf's zero-data-retention posture: operators can technically read every transcription and comment. Tell students that.
- Credential labels and presence nicks are pseudonyms. The roster mapping stays with the instructor, outside BayLeaf and outside the public repo.
- Student work is an education record under FERPA. P3 is fine, but don't include grades or real names. Comments are free text, so ask students not to name each other.
- The GitHub repo is public: page source, letter images, and no secrets. Capability links are bearer secrets, so don't post them in a shared Canvas discussion. Shared lab machines need the "forget" button.
- Export before deletion. After `DELETE`, only exports and cached clients remain.
