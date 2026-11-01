# BayLeaf Pouch (proof of concept)

Issue [#120](https://github.com/bayleaf-ucsc/bayleaf/issues/120). A single HTML file:
a coding agent that works on files in your browser, thinks through BayLeaf Sealed
(or, optionally, Transformers.js in the page), and keeps sessions and files only on your device.

**Trust roots:** BayLeaf (the operator), your browser, and your own machine. Every
provider Pouch talks to sits under one of them (BayLeaf Sealed under BayLeaf,
Transformers.js under the browser; a future Localhost provider under your machine), and
Pouch puts BayLeaf in a privileged position on purpose. Terms: [LANGUAGE.md](LANGUAGE.md).

**Experimental live preview:** <https://pouch.bayleaf.dev/>. This is an explicitly
authorized uncommitted proof of concept, not a tagged, reproducible public release.
See [deployment status, checksum, verification and rollback](DEPLOYMENT.md).

The name comes from the diplomatic pouch, which a host state carries but may not open
(Vienna Convention on Diplomatic Relations, art. 27). Here BayLeaf, and through it the
university, is the host that carries the pouch. The analogy breaks in one instructive
place: a diplomatic pouch is protected by law, which a state can break; this one is
protected by encryption, which BayLeaf cannot open.

```bash
cd pouch && npm ci && node build.mjs   # writes dist/pouch.html and prints its SHA-256
python3 -m http.server 8742 --directory dist   # or save the file and open it from disk
```

Edit `pouch.html` (markup, styles, CSP) and `src/`. `build.mjs` bundles `src/main.js`
with its dependencies, pinned by `package-lock.json`, into the page's one inline script
and stamps the Content-Security-Policy with its hash. `node build.mjs --watch` rebuilds
on changes to `src/`. Serve it from `localhost` or HTTPS: opened from disk, browsers give
the page no origin-private file system, so `/work` falls back to memory.

## Sending while Pouch works

A message sent while the agent in view is working is either a **Steer** or a **Follow-up**:

- *Steer* (the default): the message joins the running turn and the model reads it after
  its current step (a pi-durable steer, placed after the current tool round). It shows as
  "You, while it worked". If main is blocked on a foreground subagent or a `join`, steering
  detaches it (G10). If the turn ended just as you sent it, it becomes the next turn and
  Pouch says so.
- *Follow-up*: the message waits until the whole turn ends, after every tool call and any
  subagent it waits on, then starts the next turn as an ordinary message. It goes before
  any subagent report or message that is waiting to wake main. There is one follow-up slot
  per session (Pouch queues it; queuing is the strategy, not the name); another follow-up appends to it.

Keys: **Enter** sends with the default, **Alt+Enter** (Option+Enter) with the other mode,
**Shift+Enter** is a new line, **Esc** stops (in a subagent's view it returns to the parent;
Stop there is the button), **Alt+Up** takes the follow-up back for
editing. Settings, "While Pouch is working, Enter: Steer / Follow-up", swaps the default.
On touch screens Enter is a new line. For the whole running turn the **Steer** or **Follow-up**
button sits beside Stop (it sends once there is a draft), and its arrow opens "Steer now", "Follow-up after this turn" and "Stop and send".
The activity tray lists what is pending (Cancel, Edit, Steer now). **Stop never sends:**
unread steers and the queued message become one paused item with Send and Cancel. A
subagent's own view works the same way for that subagent.

## Scrolling

Decided 2026-10-31 (Batch D, `src/follow.js`). The play-test reports of "sticky scrolling"
going wrong had three causes: a re-render moved cached reply nodes out of the live log while
building the next one, and a layout read at that moment clamped the thread to the top; the
streaming reasoning box was rebuilt on every token with its own scrollbar, so it showed
its oldest lines and trapped the wheel; and anything within 60 px of the end was pulled
back down. The rules now:

- **Follow only while following.** The thread follows new content while following is on:
  at the start, after you send, when you scroll to the end yourself, or after "New reply
  below". Any scroll that moves up (wheel, finger, scrollbar, keys) turns it off at once,
  and nothing pulls you back down. The rule reads scroll events, not input events, so every
  way of scrolling counts the same.
- **Reasoning streams in a capped box with no scrollbar**: about eight lines, the newest
  at the bottom, fading at the top. Its overflow is hidden, not scrollable, so a wheel or
  finger over it scrolls the thread. Once done it is full height when open (no inner
  scroller at all) and its summary says how long it is ("Reasoning, 412 words").
- **Opening or closing a disclosure keeps its summary where it was on screen** (reasoning,
  tool output, a subagent transcript). If that leaves the end out of view, following stops,
  as if you had scrolled, and the pill says when something new arrives.
- **Inner scroll boxes** (an expanded inline subagent transcript) keep their place across
  re-renders, follow when at their end, and hand the wheel to the thread at their end
  (no `overscroll-behavior: contain`).
- The browser's own scroll anchoring is off on the thread (`overflow-anchor: none`): Pouch
  anchors itself, so Chromium and WebKit behave alike.

Tested with a streaming fake (long replies, long reasoning, an expanding transcript) on
desktop and at 390 px with touch, in Chromium and WebKit (`test/batchD-browser.mjs`).

## Subagent views

Decided 2026-10-31 (Batch D): inside a subagent you should always know you are inside
something you can pop out of.

- **Breadcrumbs** at the top: "<session title> › <subagent>". The session crumb is a button
  that pops out; it gives way first when space is short, so the subagent's name stays whole.
  Spawning is flat, so there is no deeper path; a subagent opened from another's view says
  "opened from <name>".
- **A frame in the agent's hue** (its `--seed`, CSS only): the whole chat column wears an
  inset ring and a tinted left edge, and the composer's border takes the same color, so
  the view never passes for the parent, even scrolled. A finished subagent's view replaces
  the disabled composer with one compact bar ("<name> finished; its report is in the parent
  thread." and Back). Status words are the same everywhere: working, waiting, finished,
  stopped, failed, interrupted. On a phone the elapsed time and request count move under
  Details.
- **Motion**: opening zooms the view out of what you clicked (its card, tray row or sidebar
  row) in 200 ms; leaving folds it back into its card. Transform and opacity only; under
  reduced motion both are instant with a brief highlight.
- **Esc pops out** when nothing nearer takes it (a popover, a sheet, the completion list),
  and so do browser **Back** (one history entry per stay) and the session crumb. Drafts
  belong to the view they were typed in: main's waits while a subagent is open, and the
  subagent's comes back when you reopen it.

## Dismissing

Decided 2026-10-31 (Batch D, `src/dismiss.js`): one rule for every floating thing. A press
outside the topmost one, or Esc, closes it when that is safe: nothing typed is lost and no
decision is left hanging.

| Surface | Outside / Esc |
|---|---|
| Shield popover, split send menu, @ / $ / / completion | close; the composer's text stays |
| Action sheets (file, folder, revert, confirmations) | close, which is Cancel |
| Sheets with a field (sign-in key, message to a subagent, names) | close and keep what was typed for the next opening |
| Sign-in sheet while the key is being checked | stays open and says why (it closes itself on the answer) |
| Waiting for sign-in approval | close, which is Cancel (start again any time) |
| A request waiting to leave the pouch | close, which is Deny: the answer that sends nothing |
| Sessions drawer (phone) and overlaid sidebar (desktop) | close |
| Model picker | the browser's own select |

Docked panels (Files, Editor, Usage, Settings, What BayLeaf can see) are not popovers: they
sit beside the chat and are used together with it, so a press outside never closes them;
on a phone they are whole screens with no outside. Esc is taken by the topmost surface
first, so it never also stops a run or leaves a subagent view.

## Watching files

An agent can ask to hear when files change instead of asking you to tell it when you
are done (JOURNEYS G13-G17; `src/ns/watch.js`). The `watch` tool (its own small tool,
not actions on `subagent`: watching is not about subagents, and main and subagents share
one schema) has three actions: `watch({ paths, by, once, note })` returns an id (w1, w2,
...), `unwatch(id)`, `list`. Subagent `list` rosters also name the session's watches.

- **paths**: files, folders (watched recursively) or globs (`*`, `?`, `**`, `[abc]`),
  resolved in the caller's namespace: a subagent can only watch inside its own mounts, and
  `/task` cannot be watched.
- **by**: `"user"` (default), `"agent"` or `"any"`. Writes are attributed where they
  enter the tree: every writer gets its own tagged view of the namespace (`vfs.as(source)`):
  the editor's Save, uploads, drops, unpack, rename, delete, chat attachments and Undo are
  `user`; the main agent's tools `agent`; `run` scripts `run`; a subagent's 9P view
  `subagent <name> (sN)`; a seed layer stacked or removed `seed` (user). A user watch never
  fires on agent or run writes. Writes through the raw namespace are not reported.
- **once**: removed after its first event (waiting for files to arrive).
- **note**: why the agent is watching; shown in the tray and repeated in each event.

**Events** never carry content: `[from files] essay.md changed by you: lines 12-18 (+4 -2)`
(line ranges in the new file and counts, from an LCS over the changed middle), or
`created by you: 20 lines, 1.2 KB`, `deleted by you (was 3 lines, 120 B)`, followed by
`[watch w1, your note: ...; unwatch w1 to stop]`. Several writes of one file in one batch
merge into one line ("(3 writes)").

**Delivery** uses the message paths of agent graphs. There is deliberately no settle or
debounce parameter: the editor writes only on Save; events wait while you have a message
queued (user first); a busy owner reads them at its next step (a steer; `steeringMode:
'all'` puts several together); an idle owner is woken (one request, like a report) and
anything arriving during that turn joins it. **Wake cap:** at most 3 wakes per watch
between your messages; after that events are held, and the tray says "3 changes to
essay.md, not delivered" with **Deliver** and **Stop watching**.

**Visibility.** Every watch is a tray row ("Watching essay.md: offer to re-run the panel",
or "Waiting for files in data" with Cancel for a once-glob), with its id, whose changes
count and `/task/watch/<id>`. That folder has `paths`, `note` and `ctl`;
`echo stop > /task/watch/w1/ctl` unwatches. A woken turn is labeled "Woken by watch w1:
<note>"; an event read mid-turn "From watch w1".

**Lifetime.** Watches belong to their session and persist (setting `watches:<sid>`, with a
SHA-256 prefix and size per watched file, updated on every write, whoever made it). On
reload they are re-armed, and a file whose hash changed while the tab was closed (a
mounted folder edited on disk, another tab) fires once as "changed by outside Pouch (while
it was closed)". Deleting the session or Erase all removes them.

**Transformers.js:** no `watch` tool. Its profile (`transformersjs`, `src/profiles.js`) keeps its four qualified tools and its verbatim
grounded prompt (adding a tool would re-open that qualification for a 1.7B model). Watches
made on BayLeaf Sealed still deliver if the session switches to Transformers.js, and a Transformers.js wake costs no
request.

## Continuity: color and motion

Decided 2026-10-30: **color carries identity, motion carries continuity, and neither alone
carries meaning.** Every colored or moving thing also says what it is in words; text in an
agent's color meets 4.5:1 and dots and edges 3:1 against the real backgrounds in both
themes; under `prefers-reduced-motion` each movement becomes a brief static highlight
(`.still-mark`, about a second). Motion uses transform and opacity only.

**Color math lives in CSS.** JS sets one number per element, the agent's spawn order
(`style="--seed: 3"` for a3, `seeded()` in `src/dom.js`), and nothing else; main (a1) gets
`.main-agent` and stays neutral. `pouch.html` turns the seed into a hue with the golden
angle (`calc(var(--seed) * 137.508deg)`), `--agent: oklch(var(--agent-l) var(--agent-c)
var(--hue))` and `--agent-tint` (12% via `color-mix()`, not relative color syntax, for
cross-browser support). The theme sets only lightness and chroma (light 48% / 0.13, dark
76% / 0.11; tuned on measurement: light text on the tint was 4.45:1 at 50%). A spawn
number, not a hash, so a3 is the same color in every session and adjacent spawns differ
most. `test/batchB-node.mjs` fails on any JS-computed color; `test/batchB-browser.mjs`
measures contrast for seeds 1-12 in both themes (light text min 4.79:1, dark 5.88:1; dots
5.26 / 6.54).

| Moment (journey) | Treatment |
|---|---|
| Who talks to whom (G4-G6, G9) | One hue per agent on its sidebar dot and edge, card edge and name, tray row edge and icon, sender tags in any transcript ("from judge-evidence (a4)"), the to/from message list (each peer a dot and its count), the "reported to chair (s2)" part of join summaries, and the subagent view's bar. |
| Steering delivered (D25-D27) | The tray's "Steering" row travels into its place in the transcript (FLIP, 200 ms) and its glow fades (1.2 s, on `::after`). A follow-up then "Steer now" keeps the row in place; only its label and edge change. The "Steering ..." status clears once delivered. |
| Detach (G10, G12) | The foreground card, or the running spawn pill, folds into its tray row (a ghost, 240 ms); the row keeps the agent's hue and briefly highlights. |
| Watch wake (G14, G17) | The changed file's tree row pulses once (watch accent edge); the woken turn's label ("Woken by watch w1: ...") uses the same `--watch` accent. |
| Editor follows or conflicts (R4) | The lines that changed underneath you flash once in the editor, separate from the conflict bar. |
| Revert to here (D12) | Messages after the point dim (200 ms) and fold into a collapsed "Other branch: N messages Pouch no longer sees"; the file tree does not move, because files are not touched. |
| Build identity (I-stories, offline copy) | A swatch seeded from the first byte of the page's sha256 beside the hash in "This copy" and in the update notice: the same build always shows the same color, a new build a visibly different one. The hash stays the authority. |
| Providers | Fixed theme tokens, never agent hues: `--provider-sealed` (leaf, BayLeaf Sealed), `--provider-tjs` (blue, Transformers.js) and `--provider-localhost` (amber, Localhost) on the model picker's provider icon and the composer shield. |

Every moment is keyed (`src/motion.js`): the log, tree and tray are rebuilt on every
streamed token, so `arm(key)` starts a clock and each rebuild's `play()` resumes the
animation where it was (a negative delay) until it has run its course. Recorded for review:
`/tmp/pouch-qa/motion/steer-delivery.webm`, `detach-fold.webm`.

Left out on purpose (no journey moment to tie them to): coloring tool pills by tool,
animating session switches or panel opens, coloring the main agent, and per-file colors in
the tree.

## Deployed as static HTML: where state lives

The build step is the last place code runs before your browser. What deploys is
`dist/pouch.html` and `dist/SHA256SUMS`, served by any static host with no functions,
middleware or analytics. The host has no application-side conversation or file store.
Cloudflare can still process and retain hosting request metadata (such as IP address,
URL, timing and security events). Static delivery does not itself prove that the
separate model or API service is stateless.

| State | Lives in | Who can read it |
|---|---|---|
| Session list, settings, your key | IndexedDB (`bayleaf-pouch`) in your browser | you, and anything running in your browser profile |
| Agent transcripts | one IndexedDB database per session (`bayleaf-pouch-agent-<id>`), deleted with the session; older sessions share `bayleaf-pouch-agent` until the last of them is deleted | same |
| Layout preferences (open panel, widths, sidebar) | localStorage in your browser | same |
| `/work` files | the browser's origin-private file system | same |
| `/mnt/*` | real folders on your device, by your grant | same, plus whatever else can read that folder |
| The page itself | the static host | everyone: it is the published, hash-checkable file |
| Identity, claims, keys, spend metadata | BayLeaf API (`api.bayleaf.dev`) | the BayLeaf operator; no prompt or file content |
| Prompts, file contents the agent reads, replies | in transit only, EHBP-encrypted to the Tinfoil enclave | the attested enclave; not BayLeaf |
| Transformers.js turns (prompts, files, replies) | this browser only: generated on its GPU | nobody else; nothing is sent |
| Transformers.js model files (optional, ~1.1 GB) | Cache Storage (`pouch-local-models`), until Remove the model or Erase all | the static host sees that this browser downloaded them |
| Localhost address, optional API key, model list | IndexedDB `settings.localhost`, until Remove key, Remove Localhost or Erase all; never synced | only your server, which receives the key with each request |

The CSP's `connect-src 'self' https://api.bayleaf.dev http://localhost:* http://127.0.0.1:*`
means the page has one remote network peer, its own static origin (used only to download
the optional Transformers.js model's hash-checked files) and loopback http on this computer
(used only for the Localhost provider you set up). An auditor checks the file's hash and
that its CSP is as stated.

## The coding agent

| Piece | What | Source |
|---|---|---|
| Agent loop | [pi-durable](https://github.com/earendil-works/pi): durable conversations in IndexedDB, tool tasks, automatic compaction | `src/agent.js` |
| Tools | `read`, `write`, `edit`, `bash`, all in the page; `run` in a throwaway worker | `src/tools.js`, `src/run.js` |
| Run | JavaScript in [QuickJS](https://github.com/justjake/quickjs-emscripten) (WebAssembly, MIT) in a `blob:` worker per call, over a copy of the files it names; writes come back as changes checked against the snapshot. Also on a `.js` file's menu (Run script), offline too | `src/run.js`, `src/run/` (from `experiments/quickjs`) |
| Shell | [just-bash](https://github.com/vercel-labs/just-bash): bash and coreutils reimplemented in TypeScript, no processes, no network | `src/tools.js` |
| Files | one tree stitched from several stores (below) | `src/vfs.js` |
| Editor | CodeMirror 6 with JS/TS, Python, Markdown, HTML, CSS, JSON | `src/editor.js` |
| UI | sessions sidebar, chat, one side panel at a time (Files, Editor, Usage, Trust, Settings) from an icon rail; drawer, full-screen sheets and a bottom bar on phones | `pouch.html`, `src/main.js`, `src/layout.js` |
| Composer | one card: activity tray (running subagents and `run` calls, approvals waiting, steering not yet read and the follow-up or paused message; Stop, Stop all, Cancel, Edit, Steer now), `@` path / `$` skill / `/` command autocomplete, the shield popover (lane, egress grants), Usage count, model picker, Send / Stop with the Steer-or-Queue split button while Pouch works; the turn footer (model, duration, time) is in `main.js` | `src/composer.js`, `src/main.js` |
| Preferences / attachments | local display defaults; one ingest path for Attach, composer drop and image paste | `src/settings.js`, `src/attachments.js` |
| Titles | a session is named after its first turn by one tool-less sealed completion; the sparkle beside the title field suggests another | `src/naming.js` |
| Usage | today's Sealed allowance (`/usage` with a key, `/campus-pass` without), checked on load, sign-in and after each run, never polled; tokens per session | `src/usage.js` |

The filesystem the agent, the file browser and the editor share:

| Path | Backed by | Lifetime |
|---|---|---|
| `/work` | origin-private file system (OPFS) | until you erase it; the agent's default directory |
| `/pouch` | IndexedDB | shared `AGENTS.md` and `skills/`, kept apart from your files |
| `/mnt/<name>` | a folder picked with `showDirectoryPicker` (Chromium only), read-only or read-write | a real folder; reconnecting after a reload takes one tap |
| `/tmp` | memory | until reload |

Instructions come from `/pouch/AGENTS.md` and `/work/AGENTS.md`. Skills in
`/pouch/skills/<name>/SKILL.md` and `/work/.agents/skills/<name>/SKILL.md` are listed by
name and description in the system prompt, and the model reads one when it applies.

The file browser and the editor work without signing in. Drag files or folders onto a
folder to add them; on phones, every row's `...` menu offers upload (files or a folder),
download (folders as `.zip` or `.tar`), unpacking `.zip`/`.tar`, copy text, new file from
clipboard, rename, delete and "mention in chat". Nothing is overwritten silently: an
existing name asks Replace, Keep both or Skip. The tree works from the keyboard (arrows,
Enter, Shift+F10). **Download all** saves `/work` as one `.zip`. **Erase all** deletes every IndexedDB
database, all of OPFS and other storage for the page's origin, then reloads. Folders
mounted from the device are left alone; only Pouch's permission to reach them is forgotten.

**Settings** (rail, or More on phones) holds Light/Dark/System appearance and defaults for
expanding reasoning and tools, both initially collapsed. These are display preferences,
not reasoning-effort controls. Individual disclosures keep their state through streaming;
Erase all clears preferences. Trust remains about attestation and privacy.

Below the message, **Attach (+)**, the model picker and Send/Stop share a toolbar. A model
choice applies at the next user submission, not to running tool rounds or existing children.
Attach, dropping files onto the composer, and pasting images save unchanged originals under
unique `/work/.attachments/` paths, even without authentication. Remove a chip to detach it
(the local file remains). Nothing sends until Send. Limits: eight files, 20 MB each.
The transcript retains file references without putting raw bytes into the visible bubble.
PNG/JPEG/GIF/WebP attachments also become pi-ai image blocks inside the same sealed request,
re-encoded in the browser to at most 2000px and 4 MB (first frame for animations). Models
marked **images** are derived from `/sealed/models`'s `multimodal` metadata. Text-only models
refuse pending raster images before inference; other formats, including SVG, stay files only.

Every model step is one Sealed request from a daily allowance: each tool round, each
compaction summary and each automatic or suggested title. The Usage panel shows what is
left (with a key, your own; under Campus Pass, an approximate bucket shared by everyone
behind the same campus network address) and when it resets; a send refused for quota
says so, with the reset time. A title you type is never replaced automatically; an
automatic one is asked for once, after the session's first turn that ends well, even if a
steer or a detach made that turn several messages.

**The allowance is outside state.** The same key works in other tools and on other
devices, and a top-up or a daily reset raises it, so it can move either way under Pouch.
Pouch never reconciles it with its own count (no "Other" row, nothing negative, no
warnings). The Usage table counts what this browser sent today, by session, and the
allowance box shows BayLeaf's own figure; when the allowance moved between two checks by
more or less than this browser sent then, the box says plainly "Changed outside this
browser: down N and up M". A request counted as it left but not yet booked is carried to
the next check, not reported. The badge's tooltip splits the same two figures.

**Subagents** (`src/subagents.js`): the `subagent` tool lets the main agent hand a
self-contained task (web research through `bayleaf`, exploring `/work` or a mounted folder)
to a background child while it keeps talking with you. A child is an ownerless pi-durable
conversation in the session's own database (so deleting the session erases it, and the
parent is never busy because of it), with the same tools but no `subagent` tool, at most
six running per session (a panel is a chair and four judges), using the parent's model. A watcher in the page waits for the
child's submission and posts its report to the parent: a follow-up input when it finished
or failed (the parent gets a turn to use it), a model-visible write that spends no request
when you stopped it. Reports carry the request id `sa-report:<submission>`, so they post once.
A reload never spends Sealed requests by itself: Pouch does not call `harness.resume()`;
opening a session aborts any run a reload cut off (parent or child), marks it interrupted
(the parent is told with a write, not a request) and offers **Resume**.
The child's card at the spawn point shows its status, time, requests, a live read-only
transcript, Stop, Message and the files it changed (Diff, Undo); approvals it asks for say
"Subagent <name> wants to ...". Its steps spend the same daily allowance.
Expanding the card shows its transcript compactly (one line per tool call, the final
answer set apart) and **Open** fills the chat pane with the child's own view, as do its
tray row and its row nested under the session in the sidebar (state: working, waiting for
an approval, done, stopped, failed, interrupted). The view is headed "subagent of
<session>" with its task and mounts (what `/task/<id>/ns` lists) and renders the
transcript live, like a session. Its composer **steers** the child: the text is a
pi-durable `whenBusy: "steer"` input with a `pouch.steer` entry, placed after the current
tool round and so read before the child's next model request; it never starts a new turn
(the composer is disabled once the child is done, and says so). Steering messages are
marked as yours in both views, and the parent's report (or a foreground spawn's tool
result) quotes them, so the main agent knows you redirected it. The card's Message uses
the same marked entry. Transformers.js: no subagents, so none of this.

**Agent graphs** (`src/graph.js`, JOURNEYS G1-G12): the agents of one session (its
main agent, `a1`, and its subagents `a2`, `a3`, ... in spawn order) message each
other by handle, so subagents can form graphs: many-to-one collectors, pipelines,
cross-checks. Spawning stays flat (only main spawns); graphs come from messages, and a
message never crosses scopes (ids resolve only in the sender's own registry). Main's
`subagent` tool has `spawn` (returns the id; `report: false` for a child that never posts
reports, such as a chair idling until messaged; `mode: "oneshot"` for exactly one request
with no tools and no Pouch prompt, the task plus `files` read in main's namespace and
attached, at most 48,000 characters each, its reply its report or, with `to`, forwarded
by the harness as a message from it; a one-shot takes no messages or steering), `list`,
`message`, `join` (a quiet child whose reply was empty but who sent its work by message is
reported as "sent its findings to <name> (<id>)" with a preview), `stop`;
children get a trimmed `agents` tool (`list`, `message`, `join`; a pi-durable deferred tool
that only their `modelTools` add, so main never sees it). A child cannot stop others or
itself: it stops by finishing its reply. Each child's prompt names its own id and main's,
plus a short gloss shared with main's prompt (ids, the common shapes, "messages arrive
between your steps; do not poll", "join never wakes a thread: to get new work, message
then join", "when your part is done send your result to whoever asked, then stop").
- *Delivery* has one path: a `pouch.msg` entry in the recipient's conversation whose
  model text is `[from <name> (<handle>)] <text>`. A running agent gets it as a steer (its
  next step; pi-durable's `steeringMode: "all"`, so several arrive together and in
  order), a finished child is woken (one more step from the allowance; refused at the
  running cap; a child may wake only a *finished* peer, not a stopped one), an idle main
  starts a turn as reports do. Every view labels the sender ("from chair (a2)"; "You"
  for the user's steering); cards, the child view and the session list show per-edge
  counts.
- *Reports*: a child that sent any message in its run (or was woken by a peer) reports to
  main only that it finished, without its output, as a quiet write: judges' raw findings
  never enter main's context. Otherwise reports work as before.
- *join* (subagent ids, timeout default 300 s, at most 1800) returns, per target, `state`
  (`quiet` for a normal end, `stopped`, `failed`; `finished` is not emitted separately,
  because a message can always wake a quiet child), `last` (its last message before
  going quiet, at most 4000 characters), `blocked_ms`, and `fresh`, or `cached` with
  `quiet_since` and `age_s`. A working target blocks the joiner until it is quiet (no
  step running, nothing queued); an already quiet one returns at once, cached. Join never
  wakes anyone. Each settle bumps the child's result number `seq`; a message records
  the target's `seq`, and a later join by that sender waits for a larger one, so
  message-then-join never returns the stale pre-message answer. All joiners of one
  target are released in the same tick with the same text (cached per `seq`), each with
  its own `blocked_ms`. Timeout returns `timed_out` with the state and last message so
  far; the target keeps running. A join that would close a cycle of blocked sessions
  (holds: joins and foreground spawns, followed transitively) is refused naming the
  cycle. main cannot be joined (it answers by message). When main is joined on a child
  as it settles, the join result is its report: no separate report, no extra turn.
- *Caps*, per user turn (reset when you write to main): 40 messages in the session, 8
  between any two agents in either direction. A refused message is a tool error for the
  sender ("Not sent: a3 and a4 have exchanged 8 messages ...") and a "Message limit" row in
  the tray with the reason, never a silent drop.
- *User steering preempts blocking* (G10-G12): while main is blocked on a foreground spawn
  or a `join`, steering from main's composer (Enter by default; the split menu says "Steering will
  detach <name>") submits your text as a steer and releases the blocking call at once with "detached: <name> (<id>)
  continues in the background; the user said: '...'". The tray row of a subagent main
  waits on has **Background**, which does the same with "the user sent it to the
  background". Detaching never stops anything: a foreground child turns background and
  its report arrives later as an ordinary message. Steering a child that is blocked in
  its own `join` releases that join the same way.
- The bundled `panel` skill (`/pouch/skills/panel/`, seeded once into existing profiles
  too: `seeded` now lists the default paths given) is the worked example, rewritten after
  the play-test (41 requests for one review): four one-shot judges spawned in one step
  with the draft attached (foreground, so they run in parallel and return together), then
  one one-shot chair given their findings, then main shows the list; cross-examination is
  optional (one more one-shot per disagreement). Measured 9 requests on the fake; its
  frontmatter declares `requests: 9-12`, which the `$` completion shows. The peer-to-peer
  chair flow stays in the graphs tests as the protocol's exercise.
- Cost while it runs: the tray header counts this turn's Sealed requests ("Running 4 · 6
  requests this turn"); the Usage panel rolls each session's subagents into its row and
  has a Requests column. Stop all stops main as well as every subagent and run: requests
  in flight are aborted (the EHBP transport forwards the abort signal to the browser's
  fetch), and nothing new starts; one BayLeaf already received may still count.

**Disclosures** follow one convention. Inline disclosures (folder twisties, tool cards,
reasoning, a subagent card's transcript) use the native twisty: pointing right when closed,
down when open, with the content appearing below. A panel attached to an edge (the
activity tray above the input) instead shows where it goes when clicked: collapsed it
points up (the tray opens upward), open it points down (it folds back down).

Tool calls execute in the page, so files the agent reads reach the model only inside the
sealed request. A mounted folder is a real folder: a read-write mount lets the agent change
or delete files on your disk, so mount read-only unless you want that.

Replies render as markdown, but never through the HTML parser: `src/markdown.js` parses
with micromark (GFM) and builds every element with `createElement` and `textContent`, so raw
HTML in a reply shows as text. Local `/work/` PNG/JPEG/GIF/WebP images render from
magic-checked bytes using revocable blob URLs; SVG never renders. External images remain
confirmation-gated links and are never fetched for display. Fenced code is
highlighted by the editor's Lezer parsers. Links to Pouch paths (`/work/app.js:12`,
`pouch:///work/app.js#L12`, relative to `/work`) open the editor at that line or reveal a
folder; missing paths are muted. An `http(s)` link shows its host and asks before opening,
because navigation is outside `connect-src` and the link address itself can carry data to
that site. Other schemes are plain text.

Subagent views and steering, with a gated fake model: `node test/subagent-browser.mjs`.
Agent graphs: `node test/graphs-node.mjs` (routing, caps, join, cycles, detach) and
`node test/graphs-browser.mjs` (G1-G12 in the page), both on the rule-based fake in
`test/graph-fixture.js`; `test/graphs-sealed.mjs` is one live panel run (spends requests).
Offline checks: `node test/{theme-node,composer-node,markdown-node,vfs-node,subagents-node,bayleaf-cli-node}.mjs`
(run each file separately). Full-UI mocks and desktop/390px light/dark screenshots:
`POUCH_OUT=/scratch/build node build.mjs`, then the same `POUCH_OUT` with
`node test/composer-browser.mjs`. Set `PLAYWRIGHT_MODULE` to an installed Playwright ESM
entry point if needed. Tests mock the Sealed provider and spend no inference quota.

## Namespaces

Pouch's filesystem is a Plan 9 namespace (`src/ns/`), in our own small code: no
Wanix, no new binaries, no new dependencies. The idea came from a look at
[Wanix](https://wanix.dev) (report in `test/journeys/reports/wanix.md`).

**Bind and union.** `src/ns/namespace.js` is a per-task mount table over small
file servers. A file server has path-based methods (stat, readFileBuffer,
writeFile, mkdir, readdir, rm); OPFS `/work`, IndexedDB `/pouch`, picked
folders `/mnt/*`, the in-memory root, a read-only seed archive, the synthetic
`/task` tree, a 9P client, and a namespace itself all qualify. `mount` and
`bind` take Plan 9's flags: replace, before, after. Lookup is first match; a
directory lists the union of its members; a create lands in the first writable
member; read-only mounts refuse writes with EROFS. Two departures, both for
seed layers: unions are deep (like overlayfs, so `/work/src` merges every
member's `src`), and writing a read-only member's file copies it up into the
writable one. A plain mount with one member passes calls straight through, so
the common path costs one table lookup.

**Seed layers.** `/seed /work/starter.zip` (or "Layer under /work" on an
archive) stacks `/work` over a read-only `.zip` or `.tar` (bind after): your
files win, edits land in `/work`, and removing a seed file records a whiteout
(kept in settings) that hides it, and for a folder everything below it.
Recreating a whited-out folder starts it empty. We chose whiteouts over
refusing deletes because a model that cannot `rm` a starter file loops on it.
`/seed off`, or the button in What can BayLeaf see?, removes the layer and
its whiteouts. The archive bytes are kept in IndexedDB, so the layer survives
a reload.

**9P at boundaries.** `src/ns/9p.js` is 9P2000 (codec, server, client) over a
MessagePort, one transferred ArrayBuffer per message. We use plain 9P2000, not
9P2000.L: our stores have names, sizes, a directory bit and a time, and
9P2000's thirteen requests (walk, open, create, read, write, clunk, remove,
stat, wstat) cover exactly that. .L would make us invent uid, gid and xattr
values. Writes are close-to-open: a fid's writes commit at clunk through a
hook, which takes Pouch's per-path write turn. There is no auth, because
holding the port is the capability. Stop answers every request in flight with
Rerror and refuses new ones; a client abort sends Tflush. 9P carries a
namespace wherever it crosses a boundary:

- `run`: the worker gets its namespace only as a 9P port. It reads its
  snapshot through the port, and writes the guest's changes back through the
  port. It stays snapshot-in / diff-out because the guest's fs API is
  synchronous, and a synchronous call cannot wait on a reply without
  SharedArrayBuffer (cross-origin isolation) or an asyncify QuickJS build
  (another wasm binary).
- Subagents: their tools mount a 9P client to a view the page serves.
- Not on the hot path: the agent's own tools, just-bash, the file browser and
  the editor call the namespace directly.

The same server could export a namespace to another tab, a saved archive or the
remote sandbox; see NEXT.md.

**Capabilities are namespaces.** A task can only reach what is bound into its
namespace, at the same paths as the agent's (so diffs and errors name the same
files):

- `run`: by default, `/work` plus the mounts its `files` live in, plus a
  private scratch `/tmp`. `ns: ["/work/data:ro"]` narrows it, and a file
  outside the declared mounts is refused before the worker starts.
- Subagents: by default, `/work`, `/pouch` read-only, the mounted folders and a
  private `/tmp`, but not `/task`; `ns` on spawn narrows this.
- The trust panel lists the agent's mount table and each task's. A tray row's
  tooltip shows its task's mounts.

**Task files.** `/task/<id>/{status,log,ns,ctl}` lists running and recent `run`
calls and subagents: `cat /task/3/status`, `cat /task/3/ns`, and
`echo kill > /task/3/ctl`. Every profile sees `/task`; main's and the subagents' prompts
name it in one line and the transformersjs prompt does not mention it.

**What namespaces do not enforce.** They do not cover the network. Leaving the
pouch is still the page CSP (`connect-src`) plus per-session egress grants (`src/egress.js`);
a namespace cannot widen or narrow that. Namespaces do not isolate the main agent from the
user's files: they bound tasks, not the page. A worker's 9P port is a
capability, but the worker itself is our code, so this is defense in depth
behind QuickJS, not a new security boundary against a compromised page.

## Stance: no BayLeaf-controlled component holds plaintext

Each BayLeaf surface leaves the operator a different set of capabilities:

| Operator capability | Chat | Sandbox agents | Pouch |
|---|---|---|---|
| Read stored conversations | yes (database) | yes (VM access) | no: IndexedDB on your device |
| Read content in flight | posture only | posture only | no: EHBP ciphertext to an attested enclave |
| Ship code that leaks | n/a | n/a | only visibly, if you run a hash-checked copy |

The third row decides everything. In a web app, whoever serves the code can make
it skip verification or post your prompts elsewhere, which would void the other two
rows. Pouch's answer is publicly logged delivery rather than prevention:
run a copy whose SHA-256 matches a public, tagged release, and any malicious build
would have to be published to reach you. This mirrors how Tinfoil earns trust in its
enclave: the code is in a transparency log, not taken on promise. It also means Pouch
releases should not follow the repo's usual "deploy first, commit later" practice.
The current live preview is an explicitly authorized exception: its published checksum
identifies the bytes served, but a checksum on the same host is not an independent
transparency log, and no tagged reproducible release has been made.

## What the page enforces

- **One network peer, plus its own origin.** `connect-src 'self' https://api.bayleaf.dev`.
  Attestation verification succeeds under this policy because the relay's
  `/sealed/attestation` bundle carries the whole trust root (verified 2026-10-27,
  tinfoil 1.3.0). `'self'` was added for the Transformers.js provider (below) and is used only to fetch
  `models/<id>/` files, each checked against a manifest whose SHA-256 is built into the
  page; the static host already serves the page, so it is not a new operator. It also
  lets page script send data to that host, which before needed `api.bayleaf.dev`: the
  same operator, but a different service with different logs (Cloudflare Workers Static
  Assets keeps request metadata, not bodies; see DEPLOYMENT.md).
- **Loopback for Localhost, nothing else on your network.** `http://localhost:*` and
  `http://127.0.0.1:*` were added for the Localhost provider (below): a permanent,
  build-wide exception, since a CSP is fixed per build, not per user. It does not reach
  LAN addresses, other hosts or `0.0.0.0`. `http://[::1]:*` is not in it: CSP host
  sources cannot name IPv6 literals (Chromium 156 ignores it as an invalid source), so an
  IPv6-only server is reached as `localhost`. The cost of the widening: any script in the
  page could talk to any loopback service that allows the page's origin (CORS) or that
  answers no-cors requests; with hash-pinned scripts only, that is the same code you
  checked. Chromium's Local Network Access permission adds a browser-side gate when the
  page is served from `https://pouch.bayleaf.dev`.
- **An offline copy that changes only when you say so.** `worker-src 'self' blob:` and
  `manifest-src 'self'` exist for installing: `'self'` in `worker-src` lets the page
  register `/sw.js`, the one script not covered by the hash list. See "Install and the
  offline copy" below for what that worker may do and how to check it.
- **Only its own scripts.** `script-src` lists two SHA-256 hashes, so an injection cannot run.
  It also has `'wasm-unsafe-eval'` and `worker-src blob:`, for the `run` tool (D18).
  The first compiles wasm, not JS strings: wasm can only call what its importer hands
  it, so it adds no capability page script lacks. The second is the weaker point: page
  script could start any string as a worker, bypassing the hashes, but only code that
  already runs (hashed) can do that, the worker source is a constant inside the hashed
  script, and a `blob:` worker inherits this CSP (one network peer, `eval` refused). The
  guest lives inside the QuickJS heap with no `fetch`, storage or DOM; the worker also
  drops those after loading the engine, and is terminated after each run (Stop, 5 s).
  An escape would have to break QuickJS and the wasm sandbox. Assessment and tests:
  `experiments/quickjs/README.md`.
- **No HTML from models.** Replies render as `textContent`, so a reply cannot inject
  markup into the page that holds your key.
- **Fail closed.** If attestation fails, Send stays disabled. No plaintext fallback exists.

## Transformers.js: a model in this browser

Builds made with `node build.mjs --with-models` carry an optional second provider next to
BayLeaf Sealed: **LFM3 1.7B (in this browser)** under Transformers.js in the picker, the `onnx-community/LFM3-1.7B-ONNX` q4f16
export at a pinned revision, run by Transformers.js 4.3.2 and ONNX Runtime Web on
WebGPU. The picker shows it when WebGPU works and otherwise lists it disabled with the
reason. Choosing it is the only way in: Pouch never switches providers by itself, and the
shield says "Transformers.js: in this browser, nothing sent".

- **Files.** `models.lock.json` pins every file (URL, revision, size, SHA-256);
  `node fetch-models.mjs` fetches them into `~/.cache/bayleaf-pouch/models` (never the
  repo). The build cuts each file, and the ORT wasm, into parts of at most 20 MiB named
  by their SHA-256 under `dist/models/<id>/`, bundles Transformers.js and the ORT WebGPU
  build (with its embedded wasm glue) into one `worker.<hash>.js`, and writes
  `manifest.<hash>.json`. The page embeds that manifest's SHA-256 and so trusts exactly
  those bytes. Nothing comes from a CDN or Hugging Face at run time.
- **Loading.** The first use asks, then downloads (bytes and percent in the status line
  and Settings), checks every part with `crypto.subtle` and keeps it in Cache Storage. A
  part that fails is fetched once more, then refused. Every later load checks every kept
  part again (a damaged one is dropped and fetched again) and needs no network. The
  worker starts from a verified `blob:` (CSP `worker-src blob:`), has no `fetch`, and gets
  the files as blobs and the wasm as bytes. Settings can **Load from folder/files**: a
  saved `models/<id>/` folder, or the original upstream files (cut at the manifest's part
  boundaries and checked the same way), for offline or `file://` copies (where it is
  kept for that page load only). **Remove the model** frees the storage; **Erase all**
  removes it too.
- **Recipe** (`experiments/lfm3-webgpu`, agent v2 "v8"; the `transformersjs` profile in `src/profiles.js`, moved there byte for byte). A short grounded system prompt
  naming `/work`, one byte-exact example turn, four short tool schemas (read, write,
  edit, bash: no `run`, no subagents, which would spend BayLeaf Sealed requests), greedy
  decoding, at most 8 model steps per message and about 4k tokens of context: older
  turns are dropped first, then the current turn's long tool results are shortened. The
  model's native XML tool calls are parsed in the page. Stop interrupts generation.
- **When to use BayLeaf Sealed.** Transformers.js suits inspecting a workspace and small, literal edits.
  A visible hint (with a "Use BayLeaf Sealed next" button that only changes the picker) appears
  when it hits its step cap, an edit fails twice, a task touches more than 3 files,
  or the thread outgrows its context. Its sessions are not auto-named (that
  would be a BayLeaf Sealed request) and use none of the BayLeaf Sealed allowance.
- **Tool policy for every provider.** Native XML tool calls blur trailing newlines, so
  `edit` makes newText end with a line break exactly when oldText does (an empty newText,
  a deletion, is left alone), `write` saves a non-empty file ending with exactly one
  newline, and a `bash` failure with no output says so ("no output, exit 1 (for grep this
  means no matches...)"). Each is disclosed in the tool description and its result.

## Localhost: a model server on this computer

Settings > Providers > Localhost connects Pouch to an OpenAI-compatible server on
loopback that the user runs: oMLX, Ollama, LM Studio, llama.cpp's server, or a proxy (for
example to their own Tinfoil account; Pouch itself integrates no third party). Source:
`src/localhost.js` (pure, node-tested), profile `localhost` in `src/profiles.js`.

- **Address**: `http://localhost` or `http://127.0.0.1`, any port; a bare origin gets
  `/v1`. Everything else is refused in code (lookalikes such as `127.0.0.1.evil.com`,
  `localhost.evil`, `0.0.0.0`, LAN addresses, `user@host` forms, https) and again by the
  CSP. Every request goes through one fetch that refuses any origin but the configured one.
- **Key** (optional): kept in this browser's IndexedDB like the BayLeaf key, shown masked,
  never synced, sent only to that server; Remove key or Erase all deletes it.
- **Test connection** checks the address, reachability, CORS, the key, the model list
  (`/v1/models`, with `max_model_len` or `context_length` as the context window) and the
  transport, without generating anything. A failed fetch is diagnosed with a `no-cors`
  probe: if the server answers it, the real request was blocked by CORS, and Pouch names the
  origin to allow (`server.cors_origins` in oMLX's `~/.omlx/settings.json`, `OLLAMA_ORIGINS`
  for Ollama, LM Studio's Enable CORS). A denied Local Network Access permission is
  reported as such where the browser exposes it.
- **Transports**: pi-ai's own OpenAI Chat Completions and OpenAI Responses APIs, chosen by
  probing `POST /v1/responses` with an empty body (a 400/422 validation error means the
  route exists; 404/405 means it does not), or by the user. Streaming, tool calls, usage
  and abort work through both; reasoning streams (`reasoning_content`, reasoning summary
  events) but no reasoning controls are sent.
- **Profile `localhost`**: main's prompt and page tools without `subagent` and `agents`
  (one local server runs a few requests at a time and a second model may not fit in
  memory, so a Localhost agent works alone; a note in the prompt says so), and a 24-step
  cap per message. No allowance is used and BayLeaf is not asked for anything, not even a
  session title. Usage counts tokens when the server reports them.
- **Interface**: a Localhost group in the picker (laptop icon, its own color), a shield
  saying "your machine runs the model" and what is sent; "Waiting for your server: it may
  be loading the model" after 4 s without a token; specific errors (unreachable, CORS,
  401, model missing, context too long). It keeps working with Wi-Fi off. Switching to or
  from it is always an explicit picker choice.
- **Chrome Local Network Access**: from `https://pouch.bayleaf.dev`, Chromium may ask
  whether the site may reach devices on the local network the first time it calls the
  server. Denying it makes every request fail like an unreachable server; change it in the
  site settings. oMLX also rejects the older Private Network Access preflight header
  (`Disallowed CORS private-network`), which current Chromium no longer sends.
- **Tested** with `test/dummy-openai.mjs`, a loopback stand-in shaped after oMLX's captured
  responses (`test/fixtures/omlx/`): `test/localhost-node.mjs`, `test/localhost-browser.mjs`.

## Offline

When the network drops (the browser's offline event, or a request that fails like a
dropped network followed by a failed re-check), the shield turns grey, the status line
and the Send button's title say "Offline: the model is unreachable", Send is disabled,
and a turn in flight ends at once with "Connection lost". Files, the editor,
archives and `run` keep working. Pouch re-checks every 15 s and on the online event;
when the relay answers it re-verifies the enclave, re-enables Send and refreshes usage,
without a reload. The draft in the composer is kept throughout.

The hosted page also loads with no network, from its offline copy (below).

A saved copy of `pouch.html` opened from disk (`file://`) starts offline and works, with
one caveat: Chromium refuses OPFS to `file://` pages, so `/work` falls back to memory
(tagged "memory only") and is lost on reload; IndexedDB (`/pouch`, sessions, settings)
does persist. Sealed sending needs the network, because attestation fetches the
enclave's bundle; Transformers.js does not (load its files from a saved folder in Settings).

## Install and the offline copy

Open `https://pouch.bayleaf.dev` and use the browser's Install (Chromium: the address
bar, or "Install app" in the trust panel; Android: Add to Home screen; Safari: Share,
Add to Dock or Add to Home Screen). Firefox desktop cannot install web apps; Pouch works
the same in a tab. Installed or not, the hosted page keeps an offline copy of itself:

- **Pinned, checked bytes.** On the first visit the page fetches `pouch.html`, the
  manifest and icons with the cache bypassed, checks each against `/SHA256SUMS`, and
  only then stores them in Cache Storage under `pouch-shell-<sha256 of pouch.html>`.
  `/sw.js` serves exactly those files (`/`, `/pouch.html`, manifest, icons) from that
  cache, online or not. It does not touch `api.bayleaf.dev`, `/models/**` (the Transformers.js
  provider's own verified cache), `/SHA256SUMS`, itself, or any URL with a query.
- **Explicit updates.** At start (when online) and on "Check for updates", the page
  reads `/SHA256SUMS`. If the published HTML hash differs from the pinned one, a notice
  names both. Nothing changes until you press Update, which fetches the new files,
  checks them against the SHA256SUMS just fetched, and swaps the cache and reloads only
  if all match; otherwise it says which file did not match and keeps the running copy.
- **The trust panel says which build runs:** where it was loaded from, the pinned hash,
  the published hash when last checked, whether the served `sw.js` matches the hash
  built into this page, whether Pouch runs installed, and whether storage is persistent
  (requested at start and on install, which also covers the Transformers.js model's cache).
- **Uninstall offline copy** (trust panel) unregisters the worker, deletes the copy and
  remembers the choice; **Erase all** also does both (the next visit starts fresh).

**The unavoidable channel.** Browsers re-fetch `sw.js` on navigation and replace it,
without asking, whenever its bytes change. That is why it is tiny, has no logic beyond
serving the pinned cache, and is listed in SHA256SUMS with its hash built into the page:
the page can show a mismatch, but a hostile `sw.js` controls what loads next time, so
it could serve a different page that would not report itself. The pinned copy therefore
protects against accidental or quiet *page* changes between releases, not against an
operator who changes `sw.js` on purpose. The saved-file route (`file://`, check its hash
yourself) remains the strongest guarantee. The hash shown is computed by this page's
own code, so it is a convenience, not an independent proof.

## What it does not protect

- **Metadata.** BayLeaf sees caller identity (key, or IP under Campus Pass), timing,
  sizes, request counts and which model ran.
- **The device.** IndexedDB is not encrypted. Extensions and anyone else using the
  browser profile can read your history and key.
- **The key, while you are there.** Pouch holds a full `sk-bayleaf-` key on purpose: it is
  a client for all of BayLeaf, not only Sealed inference. On a borrowed computer, anything
  that can read the page can copy that key during the session. Ephemeral storage limits
  what persists afterward, not what is exposed during use. If you suspect the key was
  copied, rotate it from the dashboard. Until users can hold more than one key, rotating
  also cuts off your other clients. Narrower credentials are a separate API concern, not
  a Pouch one. Campus Pass needs no key at all, but works only on campus.
- **Localhost content.** A Localhost turn sends this session's messages, the files the
  model reads and tool results in plaintext to your server. Pouch checks that the address
  is loopback; it cannot see what the server does next (logging, or forwarding to another
  provider as a proxy). That is your machine's trust root, and your responsibility.
- **Which actions are sealed.** Only Sealed inference is encrypted from BayLeaf. The shell's
  `bayleaf` command (web search and fetch, Sandboxes, Inboxes; below) is plaintext to
  BayLeaf under its ordinary no-logging posture, and some of it reaches Tavily, Daytona or
  the sites fetched. The UI must mark which actions stay inside the pouch and which ones
  leave it. Tinfoil's tool-like catalog entries stay hidden until their data paths are
  reviewed.

## The `bayleaf` command: the one way out

`src/bayleaf-cli.js` adds a `bayleaf` command to the shell for BayLeaf's non-inference
services: `web search|fetch`, `sandbox status|exec|poke|files ls/get/put|preview
expose/unexpose`, `inbox list|limits|show|messages|read|create|destroy`, and `status`.
`bayleaf --help` (and `--help` at every level) is the documentation; it is rendered from the
same table the parser uses. Inference, key management and browser-session routes are not
included. Every route it uses passes browser CORS (`*`, checked 2026-10-28).

The privacy boundary is enforced in the command itself, not left to the model:

- Before each request it awaits `hooks.approveEgress({ command, service, summary, detail,
  audiences })`. Anything other than `true`, or no hook at all, means
  `bayleaf: denied by the user (nothing was sent)` and exit 1.
- Each request that goes out prints `[left the pouch: <audiences>]` to stderr and calls
  `hooks.onEgress({ command, service, summary, audiences, method, path, status, ok })`.
- The bash tool ends its result with `[this call sent data outside the pouch: ...]`.
- In the page, `src/egress.js` implements the hooks: an approval sheet (Deny, Allow once,
  Allow for this session) and per-session grants kept in settings as
  `egressGrants:<session>`, revocable from the session menu and deleted with the session.
  Tool cards that sent something show a "left the pouch" badge, rebuilt from the marker.
- The `bayleaf-cli` skill tells the agent what each service exposes and not to send private
  file contents unless the user asked for that action.

Sandbox `exec`, `poke` and every `files` command create or wake the VM (the API's
`ensureSandbox`); only `sandbox status` and `preview` do not. Test with
`node test/bayleaf-cli-node.mjs [--live]`, or as the agent with
`node test/ax-cli.mjs [--allow-egress] [--key-env NAME | --no-key] call ...`.

## PoC findings

- Browser Sealed was blocked by CORS. `api/src/index.ts` now gives `/sealed/*` its own
  policy that reflects requested headers (EHBP plus the OpenAI SDK's `x-stainless-*`) and
  exposes `Ehbp-Response-Nonce`. That is safe because the origin is `*` without credentials
  and `sealed.ts` forwards only an allowlist upstream.
- The bundled SDK is about 640 KiB minified. Its verifier has a Node-only gzip fallback
  that is excluded from the build.
- Claim polling is one-shot: the server deletes the claim as it returns the key. Earlier
  prototypes saw "expired" after approval, consistent with two overlapping poll loops or a
  controller shared with streaming. Pouch runs one loop with its own `AbortController`.

## Open questions

- Where transparent releases will live (GitHub release asset, or hosting at a tagged commit), and
  how to make "check the hash" a ritual people actually perform. On mobile, opening a file
  from disk is awkward.
- The experimental preview is hosted at `pouch.bayleaf.dev` on Cloudflare Static Assets;
  publicly logged, tagged release delivery remains unresolved.
- Storage mode chosen at sign-in: borrowed computer (memory only, Leave wipes it) versus
  my device (IndexedDB and OPFS).
- In-page agent tools over OPFS and `showDirectoryPicker`, with write confirmation.
