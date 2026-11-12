# Rooms addendum: Yjs rooms (codec "yjs")

Status: DRAFT (issue #159). Not deployed. Extends rooms-v2.md.

For co-editing (shared text, rich text, outlines, whiteboards) create the room
with a codec, and use BayLeaf's provider instead of writing your own:

`POST /rooms` `{"label":"...","expires_at":"...","codec":"yjs"}`

In a `yjs` room every entry is a Yjs update. The server still never interprets
your document; it only uses `Y.mergeUpdates` to **compact the log automatically**,
so no participant needs a manage credential to keep it small, and `after=0`
returns one merged update first. The ordinary log, export, tickets, freeze and
lifecycle rules all apply, with two exceptions:

- **No platform authorship.** The document is a commons: merged state carries no
  server-verified record of who wrote what, so yjs entries carry no `cred`, even
  before compaction (nothing to rely on and then lose). Credentials still gate
  who may read and write, and presence still shows each connection's `cred`.
  If your app needs authorship, model it by convention inside the document,
  e.g. a `Y.Map` of `{commentId: {by: "Owl"}}` or Tiptap marks with an author
  attribute, and treat it as a claim, like everything else in `data`.
- **No `redact`.** Removing one update would break every later edit that depends
  on it. Remove content with an ordinary edit (the CRDT's job); remove a person
  by revoking their credential.

Concurrent writes to the same `Y.Map` key are settled by Yjs's deterministic
tiebreak (client ID), which is arbitrary, not a judgment. Design shared toggles
so either outcome is acceptable, or use per-person keys.

## Provider

```js
import * as Y from "https://esm.sh/yjs@13";
import * as awarenessProtocol from "https://esm.sh/y-protocols@1/awareness";
import { BayLeafRoomProvider } from "https://bayleaf-rooms.dev/client/y-bayleaf.js";

const ydoc = new Y.Doc();
const provider = new BayLeafRoomProvider(Y, ydoc, {   // pass your Y module: one copy of Yjs per page
  link: location.hash,            // reads room/key from the fragment, stores them in localStorage, scrubs the URL
  // or: room: "r_...", key: "rk_..."
  awarenessProtocol,              // optional: enables provider.awareness for editor carets
  // storageKey: "myapp:student", // optional: name stored links apart when a page holds two for one room
});
provider.on("status", ({ status }) => {});   // "connecting" | "connected" | "read_only" | "diverged" | "ended"
provider.on("synced", () => {});             // catch-up complete
provider.awareness;                          // y-protocols Awareness: cursors and names; relayed opaquely as presence, never stored
provider.whoami;                             // {scopes, cred_label, room_label, expires_at}
provider.can("append");                      // false until whoami arrives, and for links without the scope
provider.forget();                           // remove stored link from this device
provider.destroy();
```

**Load exactly one Yjs and one ProseMirror.** The bare imports above are fine
alone. With an editor, `@tiptap/y-tiptap` pulls its own Yjs, and editors break
silently ("Yjs was already imported"). Start from the import map in
`client/demo/editor.html`, a tested Tiptap 3 setup with no build step. It marks
`yjs` and `prosemirror-{model,state,view,transform}` with esm.sh `?external=` and
maps each to one pinned URL. Copy it whole: every `@tiptap/pm/*` subpath and
`@tiptap/core/jsx-runtime` needs its own entry.

`provider.whoami` is set only after the first fetch: create the editor, or set
the caret name, on `synced`. CollaborationCaret needs a `#rrggbb` color and ships
no CSS (style `.collaboration-carets__caret` and `__label`). If two people open
an empty room at once, each editor adds its own starting paragraph, so the
document begins with two blocks. If that matters, seed the content once.

It sends a lone edit at once and batches bursts, retries with idempotency keys,
reconnects with backoff, and exposes `awareness` for editor bindings (tested:
Tiptap 3 `Collaboration` + `CollaborationCaret`; y-prosemirror, BlockNote and
y-codemirror.next take the same Awareness). Unsent edits live in memory only: a
reload while offline loses them. Use `Y.RelativePosition` (or the editor's
comment/mark features) to anchor annotations so they survive concurrent edits.

Lock the editor whenever it can't sync: when `!provider.can("append")` and while
status is `read_only` (the owner froze the room). Edits that race a freeze are
kept and sent in order if the room reopens; the provider never drops one, because
a gap in one client's updates stalls all its later edits on every peer.

`diverged` means a local edit can never sync (a single change over the entry cap,
such as an enormous paste, or an edit from a link without `append`). The provider
stops sending but keeps showing others' edits. Tell the person and reload the
page from the room; the unsyncable edit is lost.

## Export and exit

`GET /{room}/export?format=yjs` (any credential) returns one merged Yjs update:
`Y.applyUpdate(new Y.Doc(), bytes)` reconstructs the document anywhere, with no
BayLeaf dependency. Any participant can do this.
