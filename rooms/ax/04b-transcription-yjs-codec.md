AX run 04b: transcription brief, yjs codec + provider

Hypothetical development sketch only. Nothing was built, created, published or deployed. No authenticated calls were made.

## 1. Discovery trail

1. Read the harness skill catalog. `bayleaf-rooms` ("durable shared state ... multi-user documents, co-editing") matched the brief on description alone.
2. Fetched `bayleaf-platform` skill (~600 tokens) to check for anything about hosting, P3 data, or credentials. Learned the P3 ceiling and the rule about never shipping a sandbox credential. Nothing else applied, so I skipped `llms.txt`.
3. Did not load `bayleaf-inboxes`. The brief has no email or webhook reception.
4. Read `rooms.md` (draft v2, ~2.5k tokens): two planes, capability links in the fragment, the log and WebSocket protocol, the "relays, does not arbitrate" principle, CRDT advice, manual checkpoint, limits, privacy.
5. Followed the "Co-editing? See Yjs rooms" link to `rooms-yjs.md` (~700 tokens): the `codec:"yjs"` room, server-side auto-compaction, the `BayLeafRoomProvider` client, the `?format=yjs` export. This is the page that made the task tractable.
6. Used prior knowledge of Yjs, Tiptap v2/v3, y-prosemirror and the GitHub Pages REST API. No other fetches.

## 2. Development sketch

**Architecture.** One public GitHub repo (`hist-transcribe-wk`) served by GitHub Pages:

- `index.html`: the group editor. It shows the letter image (pan/zoom) beside a Tiptap editor bound to the group's Yjs room, plus a comment sidebar.
- `overview.html`: the instructor dashboard. It opens all 8 rooms at once, shows each group's live text and who is present, and has a "jump in" button.
- `letters/g1.jpg … g8.jpg`: the letter scans. They are public in the repo, so the instructor needs to confirm public-domain or reuse status. 19th-century manuscripts usually qualify, but the archive's terms may not.
- No server. BayLeaf Rooms is the only stateful component.

**Rooms.** One `yjs` room per group (8 of the 20-room quota), each with `expires_at` = Sunday after class week + 7 days as an export buffer.

**Libraries** (ESM via esm.sh, pinned): `yjs@13`, `@tiptap/core`, `@tiptap/starter-kit`, `@tiptap/extension-collaboration`, `@tiptap/extension-collaboration-caret`, `y-prosemirror` (for relative-position helpers), and BayLeaf's `y-bayleaf.js` provider. One import map should pin a single Yjs instance (see stumbles).

**Data model (one Y.Doc per group):**

- `ydoc.getXmlFragment("transcription")`: the ProseMirror document, owned by Tiptap's Collaboration extension. Paragraphs map to letter lines or paragraphs.
- An `uncertain` mark on text runs, with attrs `{note}`. It is a custom Tiptap Mark of about 20 lines. Formatting marks are stored as Yjs formatting attributes, so they merge with the CRDT and move with the text.
- `ydoc.getMap("comments")`: `id → Y.Map{ start: RelPos(bytes), end: RelPos(bytes), quote, authorNick, resolved, thread: Y.Array<{nick, text, at}> }`.
- `ydoc.getMap("meta")`: `{letterId, status:"in progress"|"ready for review"}`.

**Concurrent editing.** Tiptap Collaboration binds the editor to the XmlFragment. Every keystroke becomes a Yjs update. The provider batches updates, appends them to the room with idempotency keys, receives everyone else's updates over WebSocket, and applies them. Yjs merges deterministically, so two students fixing the same misreading converge on the same document, possibly with both insertions kept, which they then clean up by talking. CollaborationCaret uses `provider.awareness` to show each person's cursor and pseudonym, which is the main social signal for "Heron is already fixing line 4." Flaky wifi: the provider persists unsent edits in IndexedDB and merges them on reconnect (per the doc, untested by me).

**Anchored comments.** The yjs doc explicitly suggests `Y.RelativePosition`, so I'd anchor that way rather than with overlapping ProseMirror marks. I'm unsure y-prosemirror handles overlapping same-type marks with different attrs. When a student selects "Sacramento" and comments:

```js
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from "y-prosemirror";
function addComment(editor, text) {
  const { from, to } = editor.state.selection;
  const { type, binding } = ySyncPluginKey.getState(editor.state);
  const rel = (p) => Y.encodeRelativePosition(absolutePositionToRelativePosition(p, type, binding.mapping));
  const c = new Y.Map();
  ydoc.transact(() => {
    c.set("start", rel(from)); c.set("end", rel(to));
    c.set("quote", editor.state.doc.textBetween(from, to));
    c.set("authorNick", myNick); c.set("resolved", false);
    c.set("thread", Y.Array.from([{ nick: myNick, text, at: Date.now() }]));
    comments.set(crypto.randomUUID(), c);
  });
}
```

A small ProseMirror plugin turns each comment back into absolute positions on every transaction and draws an inline highlight decoration. The sidebar lists threads in document order. When start and end collapse (the quoted text was deleted), the thread shows as "orphaned" with its original `quote`, and nobody loses it. Edits around the span don't detach it, because relative positions bind to Yjs item IDs, not offsets.

**Teacher overview.** `overview.html` takes a fragment holding all 8 `{room,key}` pairs (custom format, e.g. `#rooms=<base64url JSON>`). It stores them in localStorage and scrubs the URL. It creates 8 `BayLeafRoomProvider`s with explicit `room`/`key` options, which means 8 sockets, well under the 200-per-room limit. Each card shows a read-only Tiptap instance (or plain-text render) of the group's fragment, the group's awareness list ("3 here: Heron, Wren, Owl"), open comment and uncertain-flag counts, and `meta.status`. "Jump in" opens `index.html` for that group with the instructor's own `write` credential in that room, so the instructor's edits and cursor show up as "instructor."

**Credential/link plan.** Per room: 4 student `write` credentials with pseudonymous labels (`g3-heron`, `g3-wren` …) plus one `write` credential labelled `instructor`. That is about 38–40 credentials, under 100 per room. Per-person credentials give server-stamped attribution on entries. The comment `authorNick` stays a client claim, which is fine for cooperative students. The instructor keeps the pseudonym ↔ student mapping offline and sends each student their link privately (Canvas message or email), outside BayLeaf. A single shared "group" credential would be simpler to distribute, but it loses per-person attribution and makes it impossible to revoke one student's link alone.

**Owner plane and `gh` sequence** (instructor's agent, in the Sandbox):

```bash
A=https://api.bayleaf.dev; H="Authorization: Bearer $BAYLEAF_TOKEN"
curl -sH "$H" $A/rooms/limits
for g in 1 2 3 4 5 6 7 8; do
  R=$(curl -sH "$H" -H 'Content-Type: application/json' -X POST $A/rooms \
      -d "{\"label\":\"hist-g$g\",\"expires_at\":\"2026-11-23T08:00:00Z\",\"codec\":\"yjs\"}" | jq -r .room_id)
  curl -sH "$H" -H 'Content-Type: application/json' -X POST $A/rooms/$R/credentials \
      -d "{\"role\":\"write\",\"labels\":$(jq -c . roster-g$g.json)}" > creds-g$g.json   # NOT in repo
done
# build links: https://<user>.github.io/hist-transcribe-wk/?g=$g#<link_fragment>
gh repo create hist-transcribe-wk --public --source site --push
gh api -X POST repos/{owner}/hist-transcribe-wk/pages -f 'source[branch]=main' -f 'source[path]=/'
```

`creds-g*.json` and the link list live outside the repo, e.g. in `~/private/` in the Sandbox, and are deleted after distribution. Pages from a private repo needs a paid GitHub plan, so the repo is public. That is fine because it contains no secrets.

**Provider integration (key point):**

```js
const provider = new BayLeafRoomProvider(ydoc, { link: location.hash });
const editable = provider.whoami.role !== "read";
const editor = new Editor({ editable, extensions: [StarterKit.configure({ history: false }),
  Collaboration.configure({ document: ydoc, field: "transcription" }),
  CollaborationCaret.configure({ provider, user: { name: provider.whoami.cred_label, color } }),
  Uncertain, CommentDecorations] });
provider.on("status", ({ status }) => banner(status));   // "read_only" after Friday freeze, "ended" after delete
```

Open question: is `whoami` populated synchronously or only after first connect? I'd guard it inside `synced`.

## 3. Coordination mechanisms

| Mechanism | What it coordinates | Who or what decides |
|---|---|---|
| Yjs CRDT merge (YATA ordering of text items, clientID tie-break) | Concurrent inserts and deletes in the transcription | The algorithm, deterministically, in every client |
| Yjs formatting attributes | Concurrent `uncertain` marks and their removal | The algorithm |
| Y.Map last-writer-wins (comment `resolved`, `meta.status`) | Concurrent toggles | The algorithm (Lamport clock + clientID); effectively arbitrary |
| Y.Array append (comment threads) | Concurrent replies; all kept | The algorithm; nothing is lost |
| `Y.RelativePosition` anchors | Keeping comments attached as text changes | The algorithm |
| Server `seq` ordering + idempotency keys | Total order of relay delivery; no duplicate appends on retry | The BayLeaf server (relay order only, not content) |
| Server auto-compaction via `Y.mergeUpdates` | Log size | The BayLeaf server; content-preserving by construction |
| Awareness (cursors, names) | Social turn-taking ("someone's on line 4") | The students |
| Comments and uncertain flags | Disagreements about readings | The group, by discussion; the instructor when asked |
| Instructor jump-in | Stuck groups | The instructor (a peer editor with no special edit power) |
| Freeze / revoke / delete / expiry | Ending writes, removing a participant, ending the room | The instructor as owner; the server enforces |
| Rate limits (429/413) | Load | The server; the provider retries |

Nothing locks or assigns ownership of parts of the text. "Whose reading wins" is never decided by software in a meaningful sense: concurrent edits interleave and humans clean up.

## 4. Plumbing you write yourself

| Item | Lines (est.) |
|---|---|
| Sync / transport / reconnection | 0 (provider) |
| Offline persistence | 0 (provider, IndexedDB) |
| Compaction | 0 (server-side with `codec:"yjs"`) |
| Multi-room fragment parsing + localStorage for the overview (provider handles one link per page) | ~30 |
| Overview "forget all rooms" control | ~10 |
| Owner-plane provisioning script + link builder | ~50 (bash/jq) |
| **Plumbing total** | **~90** |

Application code (not plumbing): uncertain mark ~25, comment anchoring + decoration plugin + sidebar ~150, overview cards ~80, export/download button ~40, image viewer ~30.

## 5. End-of-week teardown

1. Friday after the last session: `PATCH /rooms/{id} {"mode":"read_only"}` for all 8. Students see a "read only" banner but can still read and export.
2. Students export through an in-app "Download" button. It writes (a) a plain-text/Markdown transcription with `[?word?]` for uncertain flags and footnoted comment threads, and (b) the raw `?format=yjs` update, which reloads with only the `yjs` library. Any `write` or `read` holder can call `GET /{room}/export?format=yjs` directly too.
3. The instructor exports all 8 for the course archive, then runs `DELETE /rooms/{id}` after warning the class. `expires_at` is the backstop.
4. GitHub: `gh api -X DELETE repos/{owner}/hist-transcribe-wk/pages`, then `gh repo archive` or `gh repo delete` (deletion needs the `delete_repo` scope and confirmation).
5. Students keep whatever they downloaded: the final text, comment threads, and the Yjs file. After deletion, their browsers' IndexedDB still holds a copy until they press "forget," which the doc implies but doesn't state outright.

## 6. Brought from outside BayLeaf and GitHub Pages

Yjs, Tiptap and its collaboration extensions, y-prosemirror, esm.sh as the CDN (a third-party runtime dependency for a week-long class), the letter scans and their rights clearance, a private channel to deliver per-student links (Canvas/email), and the instructor's offline pseudonym mapping.

## 7. AX report

The two docs read well and fast. The yjs addendum was exactly the "don't write your own provider" answer I hoped for, and its compaction story removed my biggest worry from rooms.md ("a wrong checkpoint erases others' work"). Total reading was 3 documents and roughly 4k tokens, which is very lean. Confidence the design works as sketched: about 70%. The remaining 30% is integration risk the docs don't settle.

Stumbles and ambiguities:

1. **Duplicate Yjs instance.** The provider is loaded from `rooms.bayleaf.dev` and Yjs from `esm.sh/yjs@13`, with Tiptap pulling its own Yjs through esm.sh. Mixing them is the classic "Yjs was already imported" bug, where `instanceof` checks fail silently. The doc doesn't say whether `y-bayleaf.js` bundles Yjs, imports it as a peer, or which esm.sh URL it expects. I'd hit this first. I want a tested import map in the doc, or a `?deps=` recipe.
2. **Attribution under compaction.** "Attribution (`cred`) rules apply," but auto-compaction merges entries. Once merged, who wrote what? If `cred` only survives for uncompacted entries, per-student credentials buy much less than I'd assumed. I'd still issue them for revocability.
3. **Multi-room clients.** The provider's `link:` mode stores *a* room in localStorage. Does a student who opens two group links (or an instructor with 8) clobber the stored room, or is storage keyed per room? `forget()` is per-provider. The overview needs a whole-class pattern the docs don't show.
4. **Anchoring recipe.** "Use `Y.RelativePosition` (or the editor's comment/mark features)" points the right way but leaves the hard part out. Tiptap's own Comments extension is a paid Tiptap Cloud product, and y-prosemirror's position helpers are under-documented. A 30-line anchored-comment example would save every co-editing app an hour.
5. **Version pinning.** `https://rooms.bayleaf.dev/client/y-bayleaf.js` is unversioned. For a week-long deployment I'd want `y-bayleaf@1.x.js` or an SRI hash.
6. Unanswered small questions: is `codec` fixed at creation? Is `whoami` sync? Does IndexedDB persistence survive `ended`? Can a `read` link be minted later for a class gallery? (Yes, by the general credential API, I believe.) Does freeze surface in the provider as `status:"read_only"` while still connected? (Implied.)

What I'd get wrong first: the import map (1), then forgetting `history: false` in StarterKit, which conflicts with Collaboration, then putting the whole credential list in the repo by building links in `site/`.

What I wanted: a per-room "class kit" endpoint returning N labelled links in one call, a multi-room overview example, a documented anchored-comments snippet, a pinned provider URL, and clarity on attribution after compaction.

## 8. Privacy/data notes

- Room contents (transcriptions, comments, presence names) are readable by BayLeaf operators. They sit outside the API's ZDR posture, so tell students so. Content is historical text plus coursework discussion. Student work is FERPA-relevant, but pseudonymous rooms keep it well within P3.
- Labels, awareness names and `authorNick` are visible to group members and the instructor: pseudonyms only. The pseudonym-to-student mapping and link list stay off the repo and off Rooms, ideally only in the instructor's local files, deleted after the week.
- No grades in rooms. If participation is graded, the instructor derives it from the export offline.
- Capability links are bearer secrets: anyone a student forwards one to gets write access until it's revoked. Per-student credentials make a single revocation possible.
- The public repo holds only code and letter scans, so check the archive's reuse terms. esm.sh sees students' IPs on page load, a third-party exposure worth one sentence in the activity instructions.
- After teardown, copies remain in student downloads and browser IndexedDB. Tell students how to "forget" on shared or lab machines.
