# AX run 05: audience-cursor slide deck (presence-heavy, fan-in)

- Date: 2026-11-11
- Issue: #159
- Agent: fresh `general` subagent, claude-opus-5-5 (session `ses_e32e6f050ffeFs4MGSEaTjI165`)
- Mode: hypothetical development sketch only
- Rooms knowledge: `rooms-v2.md` and `rooms-v2-yjs.md` after delta presence, the
  refusal fix and the Tiptap demo; `client/y-bayleaf.js` and `client/demo/editor.html`
  readable. Advertised as a `bayleaf-rooms` skill.
- Brief (Adam's idea): 120-person lecture; phones join via a projected QR code, tap
  to park a `?` or check mark on the current slide; the projector shows dots live;
  anonymous; cleared on advance; nothing kept; used all quarter; **lectures are
  recorded** (stated neutrally, risk not pointed out); slides are a weekly Keynote PDF;
  GitHub Pages.

## Operator summary

- Built the whole app on presence alone: an empty log, the JSON codec, one room for
  the quarter. It noticed unprompted that the QR code appears in the recording, and
  mitigated it with 20 per-lecture `write` credentials, each expiring 15 minutes
  after its lecture.
- Used the server-stamped `cred` on presence as authority: phones follow slide state
  only from `cred === "projector"`. Label uniqueness makes this unspoofable.
- Wanted: a presence-only role, a projector-only (sink) subscription, a
  per-credential socket cap, `not_before` on credentials, credential rotation under
  the same label, a clear answer on whether presence works in a frozen room, and a
  statement that presence-only rooms are intended.
- Found a provider bug: localStorage holds keys under `bayleaf-room:${room}`, so
  testing a student link on the projector laptop overwrites the projector key. It
  also found drift between the docs and the code: IndexedDB persistence is claimed
  in the doc but marked as a gap in the code, and `setPresence` is undocumented.
- About 465 lines of plumbing, about 7–8k tokens read.

---

# BayLeaf Rooms playtest report: live slide dots for a 120-person lecture

## 1. Discovery trail

1. **`rooms-v2.md`** (about 2.5k tokens), read first because it's the base contract.
   Two things settled the design early. Presence is "ephemeral and never stored".
   Every presence frame arrives with a `cred` label the server stamps, so I can
   check which credential sent it. Since the brief says "I don't need to keep any
   of it", I decided to try building the whole app on presence alone.
2. **`rooms-v2-yjs.md`** (about 1.3k tokens), read to decide whether I needed the
   yjs codec. I didn't: nobody co-edits anything, and dots aren't a document. I
   kept one idea from it: when two people write the same key, the winner is
   arbitrary, so design so either outcome is fine. That shaped the rule that only
   the projector controls the slide.
3. **`client/y-bayleaf.js`** (about 3.5k tokens), skimmed to see whether I could
   reuse BayLeaf's provider instead of writing my own WebSocket client. I found an
   undocumented plain-JSON presence mode (`setPresence(json)` plus a `"presence"`
   event with `peerList()`). Two other findings: the header says "Spike gap: no
   IndexedDB persistence across reloads", which contradicts the addendum's claim
   that it does. And it stores the key in localStorage under
   `bayleaf-room:${room}`, which matters below.
4. **`client/demo/editor.html`**: skipped on purpose. It's a Tiptap import-map
   recipe, and this app has no text editor.

Total read: about 7–8k tokens of docs and code, plus the brief.

## 2. Development sketch

**Architecture.** One public GitHub Pages repo, `lecture-dots`, holding two static
pages and the slide images:

- `index.html`: the phone page. It shows the current slide; you tap to park a `?`
  or check mark.
- `projector.html`: the lecture laptop runs this full-screen instead of Keynote. It
  shows the slide image with all dots overlaid, a readiness meter ("71 of 104
  ready"), and the join QR code on demand.
- `decks/<deck-id>/NNN.webp` plus `manifest.json`: slide images, rendered from the
  weekly PDF by a GitHub Action.

**Rooms.** One room for the whole quarter, created with the default (JSON) codec
and `expires_at` set to the last lecture plus 7 days. The quarter has to fit under
the 90-day maximum: a 10-week quarter plus finals fits.

**The room's log is never used.** All coordination happens through presence:
nothing is appended, so nothing is stored. I chose the JSON codec over yjs so that
120 phones don't download Yjs just to carry an empty document.

**Libraries.**
- A small hand-written client following the WebSocket snippet in the contract.
- A QR library vendored into the repo (for example `qrcode-generator`, one file).
  The QR code must be drawn in the browser, never by a remote QR API, because the
  URL it encodes contains a secret key.
- No pdf.js: phones load pre-rendered images, which is much lighter than 120
  phones each downloading and rendering a 20 MB PDF.

**Data model (presence states only).**

```js
// projector (cred === "projector"):
{ k: "slide", deck: "w03-tue", n: 12, aspect: 1.778 }
// phone (cred === "L05", shared by everyone at lecture 5):
{ deck: "w03-tue", n: 12, mark: "?" | "ok" | null, x: 0.41, y: 0.63 }   // x, y normalized 0..1
```

Each phone has one dot, and tapping again moves or changes it. The brief could
also mean several dots per phone; it doesn't say, so I chose one.

**How the slide syncs.** The instructor presses arrow keys or a clicker on the
projector page, which sends its new presence state. Phones accept a slide state
*only* when the server-stamped `cred === "projector"`. Credential labels are
unique within a room, so no student credential can be named "projector", and a
student can't spoof the slide. A phone that joins late gets the current slide
from the `peers` snapshot in the `ready` frame. If the projector disconnects
(`left`), phones keep showing the last slide with a "projector offline" badge.

**How the dots clear.** "Clearing" is filtering, not deleting. The projector draws
only dots whose `deck` and `n` match the current slide. When a phone sees the
slide change, it resets its own mark to `null` and re-sends. Stale states are also
discarded on arrival, so a slow phone can't paint an old dot onto the new slide.
Going back a slide shows it clean, which matches "when I advance the slide, the
dots clear."

**Key integration code (phone).**

```js
const BASE = "https://rooms.bayleaf.dev";
const { room, key } = takeLink("lecture-dots:student");   // fragment → localStorage → history.replaceState
let slide = null, mine = { mark: null }, ws, backoff = 500;

async function connect() {
  const auth = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const t = await fetch(`${BASE}/${room}/tickets`, { method: "POST", headers: auth, body: '{"after":0}' });
  if (t.status === 401 || t.status === 404) return showExpired();   // "Scan today's QR code"
  ws = new WebSocket((await t.json()).url);
  ws.onmessage = (m) => {
    const f = JSON.parse(m.data);
    if (f.type === "ready") { backoff = 500; f.peers.forEach(onPeer); pushMine(); }
    if (f.type === "presence") onPeer(f.peer);
    if (f.type === "end") return f.reason ? showExpired() : null;
  };
  ws.onclose = () => setTimeout(connect, backoff = Math.min(backoff * 2, 15000));
}
function onPeer({ cred, state }) {
  if (cred !== "projector" || state?.k !== "slide") return;        // server-stamped, unspoofable
  if (slide?.deck !== state.deck || slide?.n !== state.n) { slide = state; mine = { mark: null }; render(); pushMine(); }
}
img.onclick = (e) => {
  const b = img.getBoundingClientRect();
  mine = { mark: currentMark, x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height };
  render(); pushMine();
};
const pushMine = throttle(() => ws?.readyState === 1 &&
  ws.send(JSON.stringify({ type: "presence", state: { deck: slide?.deck, n: slide?.n, ...mine } })), 250);
```

**Projector.**

```js
const dots = new Map();                                    // conn → state, never persisted
onPresence(({ conn, cred, state }) => { if (cred !== "projector") dots.set(conn, state); draw(); });
onLeft((conn) => { dots.delete(conn); draw(); });
function go(n) { cur = n; sendPresence({ k: "slide", deck, n, aspect }); draw(); }
function draw() {
  const here = [...dots.values()].filter((s) => s.deck === deck && s.n === cur);
  plot(here.filter((s) => s.mark));                        // ? in orange, check mark in green, low alpha so clusters show
  meter(here.filter((s) => s.mark === "ok").length, dots.size);
}
```

## 3. Coordination mechanisms

| Mechanism | What it coordinates | Who or what decides |
|---|---|---|
| Projector presence `{k:"slide"}` | Current deck and slide on every phone | The instructor's keystroke; trust comes from the server-stamped `cred === "projector"` |
| Phone presence `{deck,n,mark,x,y}` | Each student's single dot | That student's latest tap; the server's 5/s cap (my 250 ms throttle) limits the rate |
| `deck`/`n` filter on the projector | Which dots count as current (that's how dots clear) | Projector client code |
| Phone resets its own mark on slide change | Dots don't carry over to the next slide | Each phone's code; nothing is deleted server-side |
| `left` frames | A dot disappears when a phone closes or drops | The relay server |
| Per-lecture credential with `expires_at` | Who can join today; links in the recording stop working | The owner (instructor's agent) at setup; the clock enforces it |
| Unique credential labels | "projector" can't be impersonated | Server-enforced uniqueness |
| 200-socket room cap | How many phones fit | Server, first come first served |
| Deck publishing (Action) | Which slide images exist | Instructor's push to `main` |
| Two projector tabs open at once | Slide flips back and forth | **Nobody.** Last sender wins; the app should warn when it sees a second `projector` connection |

## 4. Plumbing you write yourself

| Piece | Est. lines |
|---|---|
| Fragment → localStorage → `replaceState` link handling, plus "forget this room on this device" | 25 |
| Shared WebSocket client: ticket, reconnect/backoff, presence throttle, `end` handling | 60 |
| Phone page: slide image, tap to mark, mark toggle, expired/offline states | 90 |
| Projector page: deck loader, keyboard/clicker, dot overlay, readiness meter, QR overlay, second-projector warning | 140 |
| CSS (both pages) | 70 |
| GitHub Action: `pdftoppm` → WebP plus `manifest.json` per PDF pushed to `pdfs/` | 35 |
| Owner-plane setup script (curl/jq): create room, mint 1 + N credentials, write private links file | 45 |
| **Total** | **about 465** |

## 5. Credential and link plan

The owner plane is used only from the instructor's sandbox with `$BAYLEAF_TOKEN`.
That token never appears in the repo, a page, or a link.

| Credential | Role | Label | How it reaches its holder | What anyone holding the link can do |
|---|---|---|---|---|
| Projector | `write` | `projector` | The setup script writes it into a private file in the sandbox (not the repo). The instructor opens `projector.html#room=…&key=…` once on the lecture laptop, and it's stored in that browser's localStorage. | Control which slide every phone shows, see all dots, append junk to the unused log. Can't revoke anyone. Revoke it if the laptop is lost. |
| Per-lecture student credentials, one for each of 20 lectures | `write` | `L01`…`L20` (dates would also be fine; no names) | All 20 are minted at setup, each with `expires_at` = that lecture's end + 15 min. Each is packed into that day's projector start link as an extra fragment field (`…&student=rk_…`), and the projector page turns it into the QR code. Students scan it. | Until that credential expires: see the slides (which are public anyway), park dots, see classmates' anonymous dots, and append to the log. **Also open many sockets.** One student with a script could use up the 200-socket cap. |

That private links file holds 20 lines like
`L07  2026-…  projector.html#room=…&key=<proj>&student=<L07>`. Anyone who gets it
effectively has every credential. It should stay in the sandbox or a personal
password manager, never in a Google Doc shared with TAs.

The recording problem: the QR code will appear in the lecture recording. Because
each lecture's credential expires within minutes of the lecture ending, the QR is
dead by the time anyone watches. And since nothing is stored, a late viewer
couldn't see anything even with a valid key.

A rough edge: I can't set a *start* time on a credential, only `expires_at`, so
`L20` is valid from week 1. That's acceptable only because those links stay
secret until shown.

A localStorage gotcha: if I had used BayLeaf's provider, it stores keys under
`bayleaf-room:${room}`. If the instructor tests the student QR on the lecture
laptop, the student key would overwrite the projector key. My own client keeps
`lecture-dots:projector` and `lecture-dots:student` separate.

## 6. Lifecycle across the quarter

**Setup (once, about 20 minutes with the agent):**
1. `GET /rooms/limits`.
2. `POST /rooms` with `expires_at` = last lecture + 7 days.
3. Mint the projector credential and `L01`–`L20` with per-lecture expiries from the
   schedule.
4. Write the private links file.
5. Create the repo with Pages enabled and the Action.
6. Dry run with 3–4 phones, checking QR readability from the back row (QR version
   about 6 for a roughly 110-character URL; display it large).

**Each week:**
1. Export from Keynote to PDF. Turn on "Print each stage of builds" if you use
   builds, since builds become separate pages.
2. Commit it as `pdfs/w03-tue.pdf`. The Action publishes the images in about a
   minute.

**Each lecture:**
1. Open that lecture's start link on the laptop and choose the deck.
2. Press `Q` to show the QR code full-screen; leave it up for about 60 s; press
   `Q` again later for latecomers.
3. Present with the clicker.

What you lose by not presenting in Keynote: presenter notes, transitions, and
video. That's a real cost the brief doesn't acknowledge.

**Mid-lecture abuse:** if one student floods the room, revoking `L07` kicks
everyone. The fallback is to mint `L07b` on the spot from the sandbox and re-show
the QR. That's slow and needs the agent during class.

**End of quarter:**
1. Nothing to export.
2. `DELETE /rooms/{id}`. There's no need to warn participants: no student has data
   in the room.
3. Optionally remove `decks/` from Pages, or keep it as a study resource.
4. Revoking the projector credential first isn't necessary; deleting the room
   covers it.

## 7. AX report

**Confidence:** medium-high that the presence-only design works within the
contract as written; medium on behavior the docs don't specify.

**Stumbles and ambiguities:**
- **Rooms are framed as "durable shared state."** Neither doc says a room used
  purely as a presence relay, with an empty log, is fine or intended. I'm fairly
  sure it's allowed, but I had to infer that. Tickets renew the idle window, so the
  room stays alive.
- **Does presence work in a `read_only` room?** If it did, freezing the room would
  be ideal: students could send dots but couldn't append to the log. The contract
  says freezing refuses "all writes" but lists presence under the `write` role.
  Unclear.
- **The role I actually wanted is "presence only."** Today, posting a dot requires
  `write`, which also allows appending to a log I never read. That's harmless
  here, but it's more power than the job needs.
- **No per-credential socket limit and no `not_before` on credentials.** I'd also
  like an owner call to rotate a credential: revoke and reissue under the same
  label.
- **The `peers` snapshot in `ready`:** does it include peers who haven't sent any
  state yet (`state: null`)? I assumed yes, which matters for the "N connected"
  denominator in the readiness meter.
- **Fan-out cost:** each of 120 phones receives every other phone's presence
  frames, about 14k frames when everyone taps together. Nothing says whether
  that's fine on the server side. Phones don't need classmates' dots; a
  projector-only ("sink") subscription mode would cut this.
- **The provider's plain presence mode** (`setPresence`) is documented only in
  source comments, not in the addendum.
- **IndexedDB persistence:** the provider header says "Spike gap: no IndexedDB
  persistence across reloads", which contradicts the addendum. Irrelevant here,
  but a trust ding for the docs.
- **IP addresses and connection metadata:** the docs don't say whether the relay
  logs them. That's the only identifying data this app would produce.

**What I'd get wrong first:**
1. Putting the slide position in the log, which makes a student able to set the
   slide unless every reader filters by `cred`.
2. Generating the QR code through a public QR API, which leaks the key.
3. Missing that the QR appears in the recording.
4. The localStorage key collision on the lecture laptop.

## 8. Privacy and data notes

- **Nothing durable in the room.** The log stays empty, and presence is relayed,
  never stored, so no exportable record exists. Teardown is clean.
- **Anonymity.** Every student at a lecture shares one credential label (`L07`),
  so `cred` reveals nothing about identity. Connection ids are short-lived and
  change on reconnect. The instructor could link one connection's dots across
  slides within a single session but can't connect them to a person. Anonymity
  weakens in small sections or office-hours use. With 120 people it's fine.
- **No free text by design.** Dots only: no names, no messages. That shuts out
  harassment and accidental exposure of personal data, and stays well under P3.
- **The recording becomes the retention.** If the projector feed is recorded, the
  dot clusters are recorded too. They're anonymous and arguably harmless, but the
  claim "I don't keep any of it" stops being strictly true. A keyboard toggle to
  hide dots is cheap if the instructor cares.
- **Slides become public.** GitHub Pages is publicly readable even from a private
  repo on most plans. If the slides contain anything not meant for the public
  (copyrighted figures, exam hints), this hosting choice is a problem in its own
  right. The instructor should decide that before setup.
- **Operators.** Under the rooms contract, operators can technically read room
  content. Here the only content is transient coordinates, plus whatever
  connection metadata the relay sees, which the docs don't describe.
- **Power and fairness.** The instructor holds the projector credential and
  decides when dots clear. Students' "ready" signals advise; they don't decide.
  That's appropriate here, but the readiness meter could be read as consensus, and
  it shouldn't be used to pressure the "?" minority. A good default is to show
  question dots more prominently than check marks.
