# BayLeaf Pouch (proof of concept)

Issue [#120](https://github.com/bayleaf-ucsc/bayleaf/issues/120). A single HTML file:
a coding agent that works on files in your browser, thinks through BayLeaf Sealed
(or, optionally, Transformers.js in the page), and keeps sessions and files only on your device.

**Trust roots:** BayLeaf (the operator), your browser, and your own machine. Every
provider Pouch talks to sits under one of them (BayLeaf Sealed under BayLeaf,
Transformers.js under the browser, Localhost under your machine), and
Pouch puts BayLeaf in a privileged position on purpose. Terms: [LANGUAGE.md](LANGUAGE.md).

**Experimental live preview:** <https://pouch.bayleaf.dev/>. This is an experimental
deployment built from `main`, not a tagged, reproducible public release (issue #138).
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

Edit `pouch.html` (markup, styles, CSP) and `src/` (TypeScript). `build.mjs` first checks the
trust boundaries and module structure (`arch.mjs`) and the types (`tsc`, "Architecture"
below), then bundles `src/main.ts` with its dependencies, pinned by `package-lock.json`, into
the page's one inline script and stamps the Content-Security-Policy with its hash.
`node build.mjs --watch` rebuilds on changes to `src/` without the type check (run
`npm run typecheck` alongside). The node tests import the `.ts` sources directly, so they
need a Node that strips types (22.18 or later). Serve it from `localhost` or HTTPS: opened from disk, browsers give
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

In `src/follow.ts`. The play-test reports of "sticky scrolling"
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

Inside a subagent you should always know you are inside
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

One rule (`src/dismiss.ts`) for every floating thing. A press
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
are done (JOURNEYS G13-G17; `src/ns/watch.ts`). The `watch` tool (its own small tool,
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

**Transformers.js:** no `watch` tool. Its profile (`transformersjs`, `src/profiles.ts`) keeps its four qualified tools and its verbatim
grounded prompt (adding a tool would re-open that qualification for a 1.7B model). Watches
made on BayLeaf Sealed still deliver if the session switches to Transformers.js, and a Transformers.js wake costs no
request.

## Continuity: color and motion

**Color carries identity, motion carries continuity, and neither alone
carries meaning.** Every colored or moving thing also says what it is in words; text in an
agent's color meets 4.5:1 and dots and edges 3:1 against the real backgrounds in both
themes; under `prefers-reduced-motion` each movement becomes a brief static highlight
(`.still-mark`, about a second). Motion uses transform and opacity only.

**Color math lives in CSS.** JS sets one number per element, the agent's spawn order
(`style="--seed: 3"` for a3, `seeded()` in `src/dom.ts`), and nothing else; main (a1) gets
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

Every moment is keyed (`src/motion.ts`): the log, tree and tray are rebuilt on every
streamed token, so `arm(key)` starts a clock and each rebuild's `play()` resumes the
animation where it was (a negative delay) until it has run its course. Recorded for review:
`/tmp/pouch-qa/motion/steer-delivery.webm`, `detach-fold.webm`.

Left out on purpose (no journey moment to tie them to): coloring tool pills by tool,
animating session switches or panel opens, coloring the main agent, and per-file colors in
the tree.

## Sessions: New and revert

New session (sidebar, top bar or `/new`) opens a **blank session**: an empty transcript
and the composer, with nothing stored and no sidebar row. The first send makes the
session, so pressing New repeatedly makes nothing, and New then Enter sends into the new
session, never the previous one. A reload in a blank session lands in the last saved one.

Revert to here (D12) forks the conversation, so later messages fold into an undoable
"Other branch"; on your own message it reverts to just before it and puts the text back
in the box. On the first message there is nothing before it, so the session is deleted
and a blank session takes its place with the text in the box: send again and it is named
afresh, leave and nothing remains. That one cannot be undone (the sheet says so).

## Deployed as static HTML: where state lives

The build step is the last place code runs before your browser. What deploys is
`dist/pouch.html` and `dist/SHA256SUMS`, served by any static host with no functions,
middleware or analytics. The host has no application-side conversation or file store.
Cloudflare can still process and retain hosting request metadata (such as IP address,
URL, timing and security events). Static delivery does not itself prove that the
separate model or API service is stateless.

"Static" is an auditability claim about what runs on the server (nothing), not a
constraint on the build. Build-time machinery is welcome, and can be as heavy as it
needs to be, when it hardens the page, enforces seams between modules, or supports
maintenance and evolution (bundling, type checking, a TypeScript source tree, asset
pinning, invariant checks), provided the output stays a static, hash-checkable
artifact (Adam, 2026-11-01).

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
| Transformers.js model files (optional, ~1.1 GB) | Cache Storage (`pouch-models`; earlier builds' `pouch-local-models` is migrated and deleted), until Remove the model or Erase all | the BayLeaf HF gateway sees which files and byte ranges this browser fetched |
| Localhost address, optional API key, model list | IndexedDB `settings.localhost`, until Remove key, Remove Localhost or Erase all; never synced | only your server, which receives the key with each request |

The CSP's `connect-src 'self' https://api.bayleaf.dev http://localhost:* http://127.0.0.1:*`
means the page has one remote network peer, its own static origin (used only to download
the optional Transformers.js model's hash-checked files) and loopback http on this computer
(used only for the Localhost provider you set up). An auditor checks the file's hash and
that its CSP is as stated.

## Architecture: trust boundaries the build checks

Pouch is meant for highly sensitive data, so its trust claims shape its modules, and the
build keeps them true instead of leaving them to convention and review. `arch.mjs` runs
before `build.mjs` bundles anything (and on its own: `node arch.mjs`); a violation fails the
build with a message naming the boundary and why it exists. `test/arch-node.mjs` shows a
deliberate violation of each rule failing and the real tree passing.

| Rule | What the build checks | Allowed |
|---|---|---|
| egress | network APIs (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `WebTransport`, `RTCPeerConnection`, `sendBeacon`, `importScripts`, `Worker`, `import()` of a non-bundled path) appear only in egress modules, each allowed only its own APIs | `src/sealed.ts` (EHBP ciphertext to the attested enclave), `src/bayleaf-api.ts` (account plane: claim, allowance, Campus Pass, Sealed model list; metadata only), `src/bayleaf-cli.ts` (the agent's `bayleaf` command, approved through `egress.ts`), `src/localhost.ts` (Localhost provider), `src/models.ts` and `src/assets.ts` (hash-checked weights and runtimes), `src/offline.ts` and `sw.js` (the offline copy, this origin); `Worker` only in `src/run.ts`, `src/pdf.ts`, `src/media.ts` and `src/local/engine.ts` (bundled, hash-checked code from `blob:` URLs) |
| html | no first-party code turns a string into HTML (`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `srcdoc`, `document.write`, `DOMParser`, ...), as a property or an `el()` prop | `viewer.html` only ("HTML reports") |
| sealed | only `src/sealed.ts` imports `tinfoil` or reaches into the client (`secureClient`, `openAIOptions`); checked in the sources and in esbuild's metafile | `src/sealed.ts` |
| cdn | no third-party CDN URL in the assembled page (`assertNoCdn`, as for runtimes) | URLs only compared against, never fetched (the Sigstore issuer the Tinfoil SDK checks) |
| exact | no `any` in a trust-boundary module (`EXACT` in `arch.mjs`): where data crosses a boundary, its type is the claim an auditor reads | `src/trust.ts`, `src/egress.ts`, `src/ns/namespace.ts`, `src/ns/control.ts`, the egress modules and `src/sealed.ts` |
| layers | the core (files, namespaces, storage, providers, sandboxed runtimes: `CORE` in `arch.mjs`) imports only the core; only `src/main.ts` imports the Interface | |
| seams | a region is imported from outside only through its entry modules: `src/run.ts`, `src/pdf.ts`, `src/media.ts`, `src/local/engine.ts` and `src/local/provider.ts`; Interface regions never import each other | |
| contract | a contract module (`CONTRACTS` in `arch.mjs`) holds types only, no runtime statement, and is imported only with `import type`; a contract may be imported across a seam, never across a layer | `src/trust.ts`, `src/agent-types.ts`, `src/subagents-types.ts`, `src/tools-types.ts`, `src/interface/app.ts`, and `protocol.ts` in `src/run/`, `src/local/`, `src/pdf/` and `src/media/` (each worker's messages) |
| escapes | each module's casts (`as`, `as unknown as`) and non-null assertions (`!`) stay within its count in `escapes.json`; a count above it fails, and so does one below it until `node arch.mjs --lower` records it, so the counts only go down | the counts in `escapes.json`: mostly where untyped data enters (JSON, `postMessage`, a tool's arguments) |
| size | each module stays within 700 lines; `src/main.ts` within 60 | |

An allowance no module uses any more is also an error, so the lists in `arch.mjs` stay an
exact inventory of where Pouch can reach out. The scan parses code (TypeScript's parser, no
type checking), so comments and strings do not count and a local named `fetch` is not the
network. It covers first-party code; bundled packages are held by what may import them and
by the page's CSP, which remains the enforcement in the browser.

**Types.** The sources are strict TypeScript, and `build.mjs` runs `tsc --noEmit` on two
projects before bundling: `tsconfig.json` for the page (DOM library) and
`tsconfig.worker.json` for the five worker entries (WebWorker library), since a worker's
global is not a `Window`. esbuild only strips the types, and Node runs the `.ts` sources
unbundled in the tests, so the sources use only erasable syntax (`erasableSyntaxOnly`,
`verbatimModuleSyntax`) and relative imports end in `.ts`. `alwaysStrict` is off because
esbuild reads `tsconfig.json` and would otherwise prepend `"use strict"` to the bundle,
changing bundled sloppy-mode packages; Pouch's own ES modules are strict regardless.
`src/trust.ts` is the data that crosses the trust boundaries, as plain data: egress
requests, Sealed attestation and the opaque `SealedHandle` (`ready`,
`getVerificationDocument`; outside `src/sealed.ts` the type system cannot reach the
encrypting client), account-plane replies, the control plane's `Authority`, `CtlCommand`
and `InMessage`, and namespace binds. `FileServer` in `src/ns/namespace.ts` is the file
server's contract.

**The Interface.** `src/main.ts` only composes the Interface (LANGUAGE.md) from regions in `src/interface/`, in the
order their wiring runs. Each region is a factory, `createXRegion(app)`, returning its
interface, `XRegion`, declared in the region's own module; `App` (`src/interface/app.ts`, a
contract) composes them, and `src/main.ts` starts from `const app = {} as App`. A region
reaches another only as `app.<region>.<name>`, resolved when called; a region that needs
only earlier ones takes them as values instead (`install.ts`). A cell lives with the region
that writes it and is read-only elsewhere (a getter); another region changes it only
through a named method of its owner (`transcript.filesChanged()`, `tree.reveal(path)`), so
the cross-region state is listed in the types. Some stays on `app` deliberately: the
agent and the composer in `state.ts`, which many regions read; the session list's `focus`
and `activeRun`; and every call to a later region. Those calls form real cycles (queues and
send, transcript and subagents), where a locator resolved at call time is the simplest
correct design.

| Region | Responsibility |
|---|---|
| `state.ts` | shared cells (agent, composer), status line, frame, action sheets, usage |
| `editing.ts` | the open file, conflicts and diffs, previews, `show` |
| `tree.ts` | the file browser: tree, uploads, archives, clipboard, first visit, Run script |
| `connection.ts` | Sealed verification and the verified client, the network state, the Sealed model list |
| `providers.ts` | Transformers.js and Localhost: picker entries and settings |
| `auth.ts` | the key, device claim, the key form, Erase everything |
| `install.ts` | the offline copy and updates |
| `session-list.ts` | the session list, egress consent hooks, model, pdf and media services |
| `namespaces.ts` | control plane wiring: per-session namespaces, the terminal |
| `subagents.ts` | subagent registry per session, child transcripts and cards |
| `meters.ts` | the Usage panel |
| `transcript.ts` | attaching a session and its view, rendering its log, the message toolbar, revert |
| `queues.ts` | send button and modes, steering and follow-up queues, the context meter |
| `harness.ts` | the control plane's harness side: stop, steer, follow-up through ctl files |
| `send.ts` | a turn's admission and errors, the composer's keys and send menu |
| `commands.ts` | slash commands, the activity tray, the composer widget |
| `boot.ts` | file watches, opening the agent, the first render |

The migration changed no behavior: bundled without identifier minification, every bundle
(the page and the four worker runtimes) matches the last JavaScript build apart from module
paths. The casts and non-null assertions it left are since paid down to what the
`escapes` rule lists, and `app` remains a narrowed service locator (`NEXT.md`). The typed trust boundaries are where the trusted core of #143 can
replace one module at a time, starting with egress.

## The coding agent

| Piece | What | Source |
|---|---|---|
| Agent loop | [pi-durable](https://github.com/earendil-works/pi): durable conversations in IndexedDB, tool tasks, automatic compaction | `src/agent.ts` |
| Tools | `read`, `write`, `edit`, `bash`, `look`, all in the page; `run` in a throwaway worker | `src/tools.ts`, `src/run.ts` |
| Run | JavaScript in [QuickJS](https://github.com/justjake/quickjs-emscripten) (WebAssembly, MIT) in a `blob:` worker per call, over a copy of the files it names; writes come back as changes checked against the snapshot. Also on a `.js` file's menu (Run script), offline too | `src/run.ts`, `src/run/` (from `experiments/quickjs`) |
| Shell | [just-bash](https://github.com/vercel-labs/just-bash): bash and coreutils reimplemented in TypeScript, no processes, no network | `src/tools.ts` |
| Files | one tree stitched from several stores (below) | `src/vfs.ts` |
| Editor | CodeMirror 6 with JS/TS, Python, Markdown, HTML, CSS, JSON | `src/editor.ts` |
| UI | sessions sidebar, chat, one side panel at a time (Files, Editor, Usage, Trust, Settings) from an icon rail; drawer, full-screen sheets and a bottom bar on phones | `pouch.html`, `src/main.ts` and `src/interface/` ("Architecture"), `src/layout.ts` |
| Composer | one card: activity tray (running subagents and `run` calls, approvals waiting, steering not yet read and the follow-up or paused message; Stop, Stop all, Cancel, Edit, Steer now), `@` path / `$` skill / `/` command autocomplete, the shield popover (provider, egress grants), Usage count, model picker, Send / Stop with the Steer-or-Follow-up split button while Pouch works; the turn footer (model, duration, time) is the transcript region's | `src/composer.ts`, `src/interface/transcript.ts` |
| Preferences / attachments | local display defaults; one ingest path for Attach, composer drop and image paste | `src/settings.ts`, `src/attachments.ts` |
| Titles | a session is named after its first turn by one tool-less completion on the session's own provider and model; the sparkle beside the title field, the session menu and `/rename` alone suggest another; never a different provider | `src/naming.ts` |
| Usage | today's Sealed allowance (`/usage` with a key, `/campus-pass` without), checked on load, sign-in and after each run, never polled; tokens per session | `src/usage.ts` |

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
A skill whose frontmatter says `listed: false` is *unlisted*: it is left out of that list
but still loads when named (by another skill, by path, or by the person). Only a YAML
boolean false unlists; anything else, including a quoted `"false"`, stays listed. The `$`
picker still offers unlisted skills, marked "Unlisted", because the person is choosing
deliberately, and inserts the skill's path so the agent can find it.

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
An attachment's copy is named in NFC with plain spaces for Unicode ones (macOS puts
U+202F before "PM" in screenshot names), so the path survives a model retyping it. Elsewhere
names stay as stored: a lookup that misses on a name differing only in Unicode
normalization (NFC "café" for a stored NFD one) finds the stored file, and a "No such
file" from bash, read or edit names any lookalike (same name modulo Unicode spaces and
case) with an ASCII `$'... ...'` spelling to retype.
The transcript retains file references without putting raw bytes into the visible bubble.
PNG/JPEG/GIF/WebP attachments also become pi-ai image blocks inside the same sealed request,
re-encoded in the browser to at most 2000px and 4 MB (first frame for animations). Models
marked **images** are derived from `/sealed/models`'s `multimodal` metadata. Text-only models
refuse pending raster images before inference; other formats, including SVG, stay files only.

The agent sees images only through the **`look`** tool (`look { paths, note? }`, at most
eight paths per call), never from `read`: sending pixels is an explicit act, one card per
call, counted like any tool round. Each PNG/JPEG/GIF/WebP is prepared exactly like an
attachment (same `prepareImage`, originals unchanged); the result is one line per path
(original and sent size, bytes) followed by the images. SVG is refused with a hint to read its
markup; other formats and missing files are refused on their line. The card shows thumbnails
of what was sent, from the stored bytes (blob URLs, no network), and notes that images count
toward context; allowance and token accounting are whatever the provider reports. Placement on
the wire is pi-ai's: in OpenAI chat format a `tool` message cannot hold images, so the tool
message carries the text and the images follow in a user message ("Attached image(s) from tool
result:"); the Responses transport puts `input_image` parts in the `function_call_output`.
On a model not marked images (every Localhost model today, Sealed models without
`multimodal`), `look` stays in the tool list but fails before reading anything with "This model
cannot see images; ask the person to switch to a model marked images." Keeping the tool and the
prompt line consistent across models means a small model asked to look at a picture reaches the
one tool that names the remedy, instead of reading a binary file or describing it from its
name. Transformers.js (LFM3) keeps its four qualified tools and never sees `look`. Switching an
image-bearing session to a text-only model replaces earlier images with pi-ai's "(tool image
omitted: model does not support images)", so pixels never go to a model that cannot take them.
Subagents get `look` too, judged by their own model.

Every model step of a BayLeaf Sealed session is one Sealed request from a daily allowance:
each tool round, each compaction summary and each automatic or suggested title. Titles
and compaction run on the session's own provider, so on Localhost or Transformers.js they
cost no allowance and send BayLeaf nothing; every label that states a cost is worded from
the session's provider (`costNote()` in `src/naming.ts`). The Usage panel shows what is
left (with a key, your own; under Campus Pass, an approximate bucket shared by everyone
behind the same campus network address) and when it resets; a send refused for quota
says so, with the reset time. A title you type is never replaced automatically; an
automatic one is asked for once, after the session's first turn that ends well, even if a
steer or a detach made that turn several messages.

**How much context a session holds.** Next to the allowance count, the composer shows about
how many tokens the session's next request would carry, against the window of the model in
the picker: `12.5k / 128k`, with a thin bar of the window under it (`src/context.ts`). The
count is the newest reply's own usage as its server reported it (prompt, cached prompt and
reply; exact for that request, system prompt and tool schemas included), plus an estimate
at 3.5 characters a token for anything stored since (tool results, a message, a compaction
summary). A `~` marks a count with an estimated part; with no reported usage at all (a new
session, a Localhost server that reports none) it is all estimate. It is computed in the page
from the stored conversation, so it sends nothing and needs no tokenizer; a draft is not
counted until it is sent. The window shows only when known (`context_window` from
`/sealed/models`, the Localhost server's reported length); otherwise only the count. Near the
point where Pouch compacts by itself (for a 128k window, about 98k) the meter turns the
warning color and its label says so; selecting it opens Usage, which spells out the same
figures, how they were counted, and a Compact now button with its cost. A phone keeps the
count and the bar and drops the window. The meter is main's: a subagent's view hides it.

**The allowance is outside state.** The same key works in other tools and on other
devices, and a top-up or a daily reset raises it, so it can move either way under Pouch.
Pouch never reconciles it with its own count (no "Other" row, nothing negative, no
warnings). The Usage table counts what this browser sent today, by session, and the
allowance box shows BayLeaf's own figure; when the allowance moved between two checks by
more or less than this browser sent then, the box says plainly "Changed outside this
browser: down N and up M". A request counted as it left but not yet booked is carried to
the next check, not reported. The badge's tooltip splits the same two figures.

**Subagents** (`src/subagents.ts`): the `subagent` tool lets the main agent hand a
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

**Agent graphs** (`src/graph.ts`, JOURNEYS G1-G12): the agents of one session (its
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

Replies render as markdown, but never through the HTML parser: `src/markdown.ts` parses
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

## Terminal: the same shell, for humans

A Terminal panel (rail icon, or Ctrl+` from anywhere; Ctrl+` again from its input closes
it) gives the user just-bash over the namespace the main agent sees: /work, /pouch, /tmp,
/task, /session (every session) and mounts (`src/terminal.ts`). It is deliberately not a terminal emulator: a
`role="log"` output region and one labeled text input, no new dependency, usable at
390 px (16 px input, so phones do not zoom).

- **Same commands, same rules.** `shellFor()` in `src/tools.ts` builds the same just-bash
  with the same command list, archive commands and `bayleaf` CLI the agents get. Writes go
  through `vfs.as('user')`, so a watch reports them as "by you", exactly like an editor
  save, and through the page-wide per-path write queue (`oneAtATime`, now module-level and
  shared by the agents' write/edit tools, `run` write-backs and the terminal).
- **Tasks.** Each command is a /task entry, kind `terminal` (`cat /task/<id>/status`).
  **Ctrl+C writes `kill` to `/task/<id>/ctl`**, the same control file an agent writes;
  it does not call the abort directly. From the terminal, `echo kill > /task/<n>/ctl` stops
  an agent's `run` or a subagent the same way, and `/session` steers and stops agents (see
  "Control plane"). Killed commands show `exit 130`.
- **Line editing.** The browser's own input editing, copy and paste; Up/Down history
  (persisted in localStorage as `pouch.terminal.history`, capped at 200, cleared by Erase
  all with the rest of localStorage); Tab completes paths; `clear` or Ctrl+L clears;
  `history`; cwd and exported variables persist between commands. Output is capped at
  2,000 lines or 200,000 characters per command with a note; non-zero exit codes appear
  small under the output. just-bash 3.6 returns output when a command ends, so output is
  per command, not streamed; a live line shows the elapsed time and the /task id.
- **`cat` and `open`.** `cat` is just-bash's own; when its output on screen would be binary
  (a NUL in the first 8,000 characters) the terminal prints `[binary output: N bytes not
  shown ...]` instead, while a pipe (`cat x.png | od -c | head`) still gets the bytes.
  `open <path>` (`src/open-cli.ts`) shows a file in the editor pane in the mode its type
  suggests, or a folder in Files, expanded and in view. The editor or Files then replaces
  the terminal (one panel at a time; Ctrl+` returns, and the terminal line says what opened).

  | Type | `open <path>` | Also |
  |---|---|---|
  | Markdown (`.md`) | Preview | `--raw` |
  | HTML (`.html`, `.htm`) | Preview, **Static** (no script runs) | `--raw`, `--interactive` |
  | SVG | Preview (an `<img>` from a blob) | `--raw` |
  | images, audio, video | Preview (no Raw view, no Save) | |
  | other text and code | Raw, in the editor (focused) | |
  | folder | Files at that folder | no flags |
  | binary with no preview | refused, with `file`/`od`/`unzip -l` hints | |

  Flags: `--raw`, `--preview`, `--static` and `--interactive` (the last two HTML only, and
  imply `--preview`); one path and at most one mode; `--` ends options; `open --help`.
  Exit codes: 0 opened, 1 error (missing, wrong flag for the type, binary, or you kept
  unsaved changes when it asked to discard them), 2 usage. Interactive is never a default:
  scripts run only when you type `--interactive`, and a plain `open` of an Interactive
  report goes back to Static. `open` neither reads nor changes the mode the editor remembers
  per kind for clicks (`pouch.view`): a command does what its arguments say, the same every
  time (that is why Markdown opens in Preview here while a click opens it in its remembered
  mode, Raw at first).
  **Agents show; the person opens.** In the agents' bash `open` exits 1 with "open is the
  person's; use `show <path>`", because an agent's `open` would take over the user's pane
  mid-task (and, with `--interactive`, run a report's scripts without a person choosing
  to). `show <path> [--raw | --preview | --static]` takes the same paths and type defaults
  (a folder shows Files) and never `--interactive`. It opens at once unless that would get
  in the person's way: unsaved edits in the editor, a dialog open, a key, pointer or wheel
  touch of the page in the last 4 s (`SHOW_QUIET_MS` in `src/interface/editing.ts`; sending a message
  does not count), or a subagent asking. Then it is offered instead: a card in that agent's
  transcript ("Pouch wants to show you ...") with an Open button. Either way the transcript
  records it (an opened show is a one-line "Shown" card), and the agent reads one line:
  `shown: opened /work/r.html (Preview, Static)` or `shown: offered ... (user busy: unsaved
  edits)`. Both exit 0 (the person has it either way); errors are 1, usage 2. The cards are
  read back from the bash output, so they survive reload. This rule is provisional
  (LANGUAGE.md "Show"). Links in replies still work.
- **Security.** The terminal runs nothing outside the page except `bayleaf`, which asks on
  the same approval sheet as an agent ("Send this outside the pouch from the terminal?",
  "you, in the terminal") on every use: the terminal belongs to no session, so no "Allow
  for this session" grant applies and that button is hidden. There is no other network
  access, no real process and no eval of JavaScript; `run` is an agent tool, not a shell
  command. Opening the terminal never sends a request.

## Namespaces

Pouch's filesystem is a Plan 9 namespace (`src/ns/`), in our own small code: no
Wanix, no new binaries, no new dependencies. The idea came from a look at
[Wanix](https://wanix.dev) (report in `test/journeys/reports/wanix.md`).

**Bind and union.** `src/ns/namespace.ts` is a per-task mount table over small
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

**9P at boundaries.** `src/ns/9p.ts` is 9P2000 (codec, server, client) over a
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
pouch is still the page CSP (`connect-src`) plus per-session egress grants (`src/egress.ts`);
a namespace cannot widen or narrow that. Namespaces do not isolate the main agent from the
user's files: they bound tasks, not the page. A worker's 9P port is a
capability, but the worker itself is our code, so this is defense in depth
behind QuickJS, not a new security boundary against a compromised page.

## Control plane: everything that acts is a file

The file tree is the control plane (`src/ns/control.ts`); the Interface is one client among
several, as rio's `/dev/wsys` and acme's `/mnt/acme` are in Plan 9. Every Interface control
that acts writes a file; the terminal writes the same files with `echo`, and the main agent
writes ctl files from bash. What a write does (the harness side) is one Interface region,
`src/interface/harness.ts`, marked "Control plane: the harness side", so the tray, the terminal and an
agent always get the same behavior: a steer typed in the terminal appears in the tray, and a
Stop clicked in the tray is in the events log.

```
/session/events                     recent state changes, one per line: "<seq> <sid> <ref> <what>"
/session/current                    the session open in the Interface (an agent: its own)
/session/<sid>/title, status        status: "<main state> agents=<n> running=<k>"
/session/<sid>/ctl                  stop (main and all its subagents), detach
/session/<sid>/usage                read: allowance left, requests this turn and today (counts only)
/session/<sid>/changes              read: "<op> <refs> <path>" per path the agents changed this turn
/session/<sid>/agents/a<n>/status   "<state> <seconds> <kind> <name>[: task]"
/session/<sid>/agents/a<n>/ctl      stop (or kill); a1 also "stop all"; detach
/session/<sid>/agents/a<n>/in       a message: steer | followup | message
/session/<sid>/agents/a<n>/last     its latest answer
/session/<sid>/agents/a<n>/ns       its mount table
/task/<id>/{status,log,ns,ctl}      runs, terminal commands, subagents (ctl: kill)
/task/watch/<id>/{paths,note,ctl}   watches (ctl: stop, deliver)
```

**Grammar.** ctl takes one command per line; every line is checked before any runs, and a bad
one fails the whole write the way a 9P Rerror does: `EINVAL: ctl accepts: stop, detach (got
"explode")`. `detach` returns main's waiting call (a foreground spawn or a join) so the
subagent keeps running in the background; on `a<n>` it is refused unless main waits on that
agent. `in` takes a header line (`steer`, `followup` or `message`) with the text below it, the
header as the first word (`echo steer use tabs > in`), or plain text, which is a message. A
steer joins a working agent's turn after its current step and is refused for an idle one; a
follow-up waits for the turn to end; a message steers a working agent and starts an idle one
(main: only in the session open in the Interface, where a turn's bookkeeping lives). There is
no `from` header: who wrote is the view the writer was handed, so nobody can claim to be
someone else. A write returns once it took effect (a stopped subagent's status reads
`stopped` next); same-page writers also get the harness's receipt back (a steer's id, which
the tray follows), while a 9P writer gets the usual byte count.

**Reading itself: usage and changes.** Two read-only files let the main agent plan and
check its own work without asking the person. `usage` (story AG35) is `key: value` lines:
`allowance: 412 of 500 requests left today (...)`, `resets:` (ISO time, when known),
`requests-this-turn:` and `requests-today-this-session:`. The allowance is BayLeaf's figure and
lives outside Pouch (the same key is spent by other tools and devices, and a reset or top-up
raises it), so the file says whose it is, and an unknown allowance reads `unknown`, never 0.
The counts come from the same ledger as the Usage panel. Context fill joins it once
`src/context.ts` is on main (#124). `changes` (story AG22) lists the paths the agents changed
since the user's last message, one line each, `created|modified|deleted <refs> <path>`, sorted
by path, refs like `a1` or `a1,a2` so a subagent's writes are marked. It is folded to the net
change (created then deleted is no line) and leaves out writes to /session, /task and /dev,
which are actions, not file changes. Paths only, never content: the tools report each change
where the caller is known (`noting` in `src/tools.ts`), because watch attribution (`vfs.as`)
names the kind of writer but not its session, and sees only watched paths.

**A failed write in a script (CP6).** just-bash 3.6 lets a failed redirection write escape the
whole script: `echo stop > /session/current/agents/a9/ctl; ls /session/current/agents` used
to drop everything, the output before it included, with no word about the `ls`. Its own error
classes, which it does catch, are not exported, so Pouch cannot make it continue. Instead the
shell's filesystem tags a failed write with its path and `execScript` (`src/tools.ts`, used by
the bash tool and the terminal) turns the escape into exit 1 with `bash: <path>: <error>` and a
note naming the commands that did not run ("1 later command did not run: `ls ...`. Rerun what
you still need."). The commands before it did run; their output is lost. Remove the shim once
just-bash reports a redirection write error the way bash does (status 1, script continues).

**Events.** `cat /session/events` prints the last 50 lines. Over 9P, an open fid of
`events` reads like acme's event file: each read blocks until something new happens, and
Tflush ends a blocked read (`openStream` in `src/ns/namespace.ts` and `src/ns/9p.ts`). The
Interface runs the same blocking-read loop (`control.tail()`), no callbacks: from it, it
re-draws the tray and sidebar and says writes from the terminal or main out loud ("From the
terminal: stop reader (a3)"). Events never carry message text, only who did what to which
agent and how long the text was.

**Who sees what (capabilities).** /session is not in the shared namespace; each client is
handed a view:
- The Interface and the terminal: every session, ctl and in writable.
- The main agent: only its own session, at `/session/<sid>` and `/session/current`, and
  only its own session's tasks under `/task` (its runs, subagents and watches, so it
  cannot kill another session's subagents or the user's terminal commands). ctl is
  writable (the same authority `echo kill > /task/<id>/ctl` gives it over its own tasks); in is refused
  with EPERM, because agents message each other with the agents tool, which enforces the
  session's message caps and tags who wrote. Making in writable for agents would duplicate
  that path without the caps.
- Subagents and `run`: no /session, as they have no /task. A subagent stopping its siblings
  or steering main is outside any task it is given, and a second messaging path would cost
  small models tokens and confusion (the AX argument); the agents tool stays their surface
  and is not rewritten as a file shim. Because /session is not in the shared tree, a
  capability view cut from it (`ns: ["/session"]`) cannot name it either.

**What stays direct, and why.** Same-page calls are direct namespace calls (no 9P on the hot
path); 9P is only for boundaries, as before. Three acting controls stay direct calls:
- Send (a new turn), a paused follow-up's Send, and a follow-up with attachments: a turn may
  create the session and carries attachments held in the page; a write to `in` carries text
  to an existing session. Text-only follow-ups do go through `in`.
- Cancel on a steer, Cancel and Edit on a follow-up: taking your own unsent words back into
  the composer is editing, not acting on an agent.
- Allow and Deny on the approval sheet: consent must not be a file. Main can write its own
  session's ctl, so a writable approval file would let an agent approve itself.

Out of scope: things that do not act (editor text, theme, layout, Usage). The Thread itself
(transcript items, streaming text) is content, not control state, and still reaches the
Interface from the harness's view stream; the control files and the tray read one cache of
agent states, so they cannot disagree.

**Parity test.** `test/controlplane-node.mjs` keeps the inventory in one table (21 acting
controls, 3 direct by design). For each control it writes the file from a just-bash terminal
and from the main agent's view and checks the harness was asked to do the same thing; then it
checks statically that the Interface handler writes the control file (`ctl(...)`) and that
no direct harness call (`agent.abort`, `subagents.stop`, `stopCall`, `detach`, `steer`,
`watches.remove`, ...) appears in the Interface (`src/main.ts`, `src/interface/`) outside the harness-side block. `test/batchF-browser.mjs` drives the same paths in a page.

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
  tinfoil 1.3.0). `'self'` serves the Transformers.js provider (below) and is used only to fetch
  `runtime/<group>/` parts, each checked against a manifest whose SHA-256 is built into the
  page (the weights come from `api.bayleaf.dev/hf`, checked against `models.lock.json`); the static host already serves the page, so it is not a new operator. It also
  lets page script send data to that host besides `api.bayleaf.dev`: the
  same operator, but a different service with different logs (Cloudflare Workers Static
  Assets keeps request metadata, not bodies; see DEPLOYMENT.md).
- **Loopback for Localhost, nothing else on your network.** `http://localhost:*` and
  `http://127.0.0.1:*` serve the Localhost provider (below): a permanent,
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
  markup into the page that holds your key. HTML an agent writes to a file renders only
  in the report viewer (below), never in this page.
- **One frame, and media from memory.** `frame-src 'self'` exists only to embed
  `/viewer.html` (HTML reports, below), which Pouch frames sandboxed into an opaque origin;
  `media-src blob:` plays audio and video previews from files already in the page. Neither
  reaches the network: the viewer has its own policy with no network at all.
- **Fail closed.** If attestation fails, Send stays disabled. No plaintext fallback exists.

## HTML reports

An agent can write a self-contained HTML report (inline CSS and script, images as `data:`
URLs) and show it (bash `show`) or link it; either opens it in Preview, Static. Reports come from your data, possibly
very sensitive, and an agent that read a hostile file may have been manipulated into
writing one that tries to leak it. So the viewer renders rich reports with **no network
egress and no access to Pouch** (its storage, key, files and other frames).

**Two frames.** Pouch frames `/viewer.html` (a static file, built, hashed and listed in
SHA256SUMS like the rest of the shell) with `sandbox="allow-scripts"` and no
`allow-same-origin`, so the viewer runs in an opaque origin. The viewer renders the report
in an inner `srcdoc` frame, which inherits the viewer's policy. Why not one frame: a
`srcdoc` or `blob:` frame inside Pouch inherits Pouch's policy, whose hash-only
`script-src` would block every report script, and loosening Pouch's policy is not on the
table.

**The viewer's policy** (meta tag in `viewer.html`, and as a header with `frame-ancestors
'self'` and `sandbox allow-scripts`, so it is opaque even when opened on its own; checked
by `deploy.mjs`):
`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:
blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none';
child-src 'none'; worker-src 'none'; manifest-src 'none'; object-src 'none'; form-action
'none'; base-uri 'none'`, plus `Referrer-Policy: no-referrer` and a `Permissions-Policy`
denying camera, microphone, geolocation, clipboard, fullscreen, payment and device APIs.
`'unsafe-inline'` rather than a hash: reports carry their own inline scripts, and a hash
would switch `'unsafe-inline'` off; the viewer document has nothing to steal and no network.
`_headers` detaches the page's CSP, `X-Frame-Options` and `Permissions-Policy` for this one
path (`headers.mjs`; the detach semantics were checked against `wrangler dev`).

**Messages.** Pouch posts `{ html, scripts }` to the viewer when it loads, with
targetOrigin `'*'` (the only one an opaque origin matches), so nothing but the report text
is ever posted. Pouch registers no window `message` listener at all (the exfiltration
suite checks the built page), so nothing the viewer or a report posts reaches Pouch's code.
The viewer accepts a message only when `event.source === parent`, with exactly the keys
`html` (a string up to 5 MB) and `scripts` (a boolean); a report posting to its parent
(the viewer) is ignored, so it cannot re-render itself with scripts on. Each message makes
a fresh inner frame, so nothing from a previous report keeps running.

**Cleanup before rendering.** The viewer parses the report with `DOMParser` (an inert
document: nothing runs or loads) and removes `<link>`, `<base>`, `<meta http-equiv>` and
every `target`/`formtarget`, inside `<template>` contents too, repeating on its own output
until nothing changes. Reason: WebKit acts on two of them before any policy applies
(below). Nothing a `<link>` could load is allowed anyway.

**Static and Interactive.** Static (the default, every time a report opens) gives the
inner frame `sandbox=""`: no script runs at all, which closes every script-based channel.
Interactive gives it `allow-scripts` (still no same-origin, forms, popups, modals,
downloads or navigation of other frames). Interactive keeps one channel no web policy
governs: **WebRTC** (STUN/TURN to a server the script names, over UDP or TCP), plus in
WebKit a `<link rel=preconnect>` a script adds. A hostile report in Interactive mode could
therefore send out what it shows (never your other files, Pouch's storage or key). The
interface says so beside the switch, and Interactive is never remembered.

### HTML viewer: what it blocks

`test/viewer-exfil-browser.mjs` runs one hostile report in each mode against a loopback
recorder (two HTTP ports, TCP for TURN and WebSocket, UDP for STUN; in Chromium
`*.exfil.test` resolves to it and a net log catches DNS lookups), with stand-ins for
Pouch's state on the host page. Chromium 1248 and WebKit 2370, 2026-11-01. "Naive" is a
`sandbox="allow-scripts"` srcdoc frame in a page with no CSP: the sanity check that the
suite sees leaks (37 tagged channels in Chromium, 34 in WebKit; an unsandboxed frame leaked
42 and also read the host's localStorage, cookie and IndexedDB).

| Channel | Static | Interactive | Naive |
|---|---|---|---|
| fetch, XHR, sendBeacon, EventSource, WebSocket, WebTransport | no script | blocked (`connect-src 'none'`) | leaked |
| `new Image()`, `Audio()`, `document.write`, `import()`, workers (remote, `blob:`), SharedWorker, service worker, paint worklet | no script | blocked | leaked (most) |
| `img`, `picture`/`srcset`, SVG `image`/`use`, `input type=image`, `video`/`audio`/`poster`/`source`/`track` | blocked (`img-src`/`media-src` `data: blob:`) | blocked | leaked |
| `script src`, `link` stylesheet/preload/prefetch/modulepreload/icon/manifest | blocked (and links removed) | blocked | leaked |
| CSS `url()`, `@import`, `image-set`, `@font-face`, cursor, mask, list-style, border-image | blocked | blocked | leaked |
| `object`, `embed`; `iframe` with a remote or Pouch-origin `src`; nested `srcdoc` | blocked (`object-src`, `frame-src 'none'`; srcdoc inherits) | blocked | leaked |
| `link rel=preconnect`/`dns-prefetch` in markup | blocked (removed; WebKit connected before the fix) | blocked | connections seen |
| `link rel=preconnect` added by script | no script | **leaks in WebKit** (bare TCP connection; with a hostname, a DNS lookup) | leaked |
| `meta refresh`, `<base href>` | blocked (removed; `base-uri 'none'`) | blocked | leaked (base) |
| the frame navigating itself (`location =`, a clicked link) | blocked (the viewer's `frame-src 'none'`) | blocked | navigated |
| `top`/`parent` navigation, `target=_top/_parent/_blank` links and `area` (clicked by a person), `window.open`, forms GET/POST and `formtarget` | blocked (sandbox; targets removed: WebKit connected on click before refusing) | blocked (script-added targets: the same WebKit click connection) | leaked |
| `a ping`, `download` | blocked | blocked | leaked |
| WebRTC (STUN, TURN over UDP and TCP, data channel) | no script | **leaks** (both engines) | leaked |
| Pouch's `document`, `localStorage`, cookie, IndexedDB, Cache Storage via `top`/`parent` or its own | no script | SecurityError (opaque origin) | read everything (unsandboxed) |
| `postMessage` to the viewer (re-render with scripts on) | no script | ignored (`event.source` check) | no viewer: reaches the host |
| `postMessage` to Pouch | no script | delivered; Pouch has no listener | delivered |
| BroadcastChannel, `history.pushState` to another origin | no script | not received; SecurityError | received when unsandboxed; error |
| DNS lookups (Chromium net log) | none | none | seen |

Residual: Interactive mode's WebRTC (and WebKit's script-added preconnect). Mitigation:
Static is the default and is not switchable by the report; Interactive is a per-opening
choice labeled with this risk. Not tested: Firefox (not installed here); real DNS (only
Chromium's net log); timing or covert channels to other frames (no shared origin to
signal through); a person following a link out of a report (links cannot navigate
anywhere, which is also a usability cost).

## Previews

`.md`, `.html`/`.htm` and `.svg` files get **Raw | Preview** in the editor header; images
(PNG, JPEG, GIF, WebP), audio (MP3, WAV, Ogg, Opus, M4A, AAC, FLAC) and video (MP4, WebM,
Ogg, MOV) open as a preview only, with no Save (there is no text to save over them).
`src/preview.ts` holds the table; PDFs and databases are later rows there.

- Markdown previews with Pouch's own renderer (DOM nodes, no HTML): only local raster
  images under `/work` are drawn; a remote image is a link you must confirm.
- HTML previews in the report viewer (above). A link in a reply to an `.html` file opens
  Preview; a link with a line number opens Raw.
- SVG is drawn as an `<img>` from a `blob:` URL, never inlined: no script in it runs and
  nothing it references loads. Audio and video play from `blob:` URLs (`media-src blob:`).
- Each kind remembers its last mode (`pouch.view` in localStorage; Markdown starts Raw,
  HTML and SVG Preview). The terminal's `open` (see "Terminal") picks by type instead and
  leaves this alone. A preview shows the saved file; with unsaved edits it says so. It
  follows changes on disk (an agent rewriting a report) when the bytes change.
- Caps: reports up to 5 MB, media up to 50 MB (read whole into memory); past that, a
  message and Raw or Download.
- Offline, HTML Preview says it needs a connection: the offline copy pins `viewer.html`
  (with its headers), but Chromium does not route a sandboxed, opaque-origin frame's
  navigation through the service worker (checked 2026-11-01), so the viewer cannot load
  from it. Markdown, image and media previews work offline.

## Transformers.js: a model in this browser

Builds carry an optional second provider next to
BayLeaf Sealed: **LFM3 1.7B (in this browser)** under Transformers.js in the picker, the `onnx-community/LFM3-1.7B-ONNX` q4f16
export at a pinned revision, run by Transformers.js 4.3.2 and ONNX Runtime Web on
WebGPU. It is for computers only. The picker shows it when the device and the WebGPU adapter meet its
requirements and otherwise lists it disabled with the reason; `models get` and Settings then refuse
before the approval sheet, so nothing is downloaded. Phones and tablets are refused first
(`deviceSupport` in `src/local/engine.ts`): on a Pixel 10 Pro the adapter passes every check
below, but the first request's one-shot prefill froze the whole phone for about a minute ("System
UI isn't responding"). The cause is scheduling, not memory: one long GPU submission starves the
system compositor on a mobile GPU. Signals, any of which refuses:
`navigator.userAgentData.mobile`, a user-agent string naming Android, iPhone, iPad or Mobile,
iPadOS's desktop-style "Macintosh" string with touch points, and `navigator.deviceMemory` below 8
(Chrome caps it at 8, so it can refuse but never qualify). A coarse pointer alone is not a signal,
so touch laptops are not refused. On such a device a model already downloaded stays removable
(Settings shows Remove, never Download); a saved choice of Transformers.js stays selected but Send
refuses with the reason before any GPU work, rather than quietly sending to Sealed. GPU
requirements (`gpuSupport` in `src/local/engine.ts`, read from
`navigator.gpu.requestAdapter()`, no device and no download): an adapter, the `shader-f16`
feature (q4f16), and `maxStorageBuffersPerShaderStage` of at least 10. The last because
Firefox on an M3 Max reports 9 and ORT-Web then fails mid-turn with "Too many storage buffers in
shader. Current: 10, Max is 9" (kernel not identified); Chrome on the same machine reports more. Pouch does not create the device (ONNX
Runtime Web's WebGPU EP calls `requestDevice` itself), so if a device still gets less than the
adapter reported, that runtime error is shown as the same plain reason. Choosing it is the only way in: Pouch never switches providers by itself, and the
shield says "Transformers.js: in this browser, nothing sent". (`node build.mjs --no-models` omits it.)

- **Weights, from the BayLeaf HF gateway** (`src/models.ts`, issue #121). `models.lock.json`
  pins every file (size, SHA-256, revision); the build puts those pins in the page. The
  page fetches each file from `https://api.bayleaf.dev/hf/<repo>/resolve/<commit>/<path>`
  (BayLeaf's mirror: Hugging Face sees no request) in 32 MiB byte ranges, four in flight,
  each retried on failure, and hashes the file **incrementally** in order
  (`src/sha256.ts`, a 60-line SHA-256 whose state survives a reload, tested against NIST
  vectors and `crypto.subtle`), so the 1.09 GB weights are never in memory at once. Each
  chunk is kept in Cache Storage as it is hashed, with the hash state after it: Stop (or
  a closed tab) keeps the verified prefix, and the next download continues there. A
  file whose whole hash differs from the lock is refused by name and dropped. The
  gateway's catalog (license, distribution, qualification) is shown, never trusted for
  bytes; `deploy.mjs` checks it agrees with the lock.
- **Runtime, from Pouch's origin** (`build-runtime.mjs`, `src/assets.ts` `partAssets`).
  The Transformers.js + ORT worker bundle and the ORT wasm, cut into content-hash parts of
  at most 20 MiB under `dist/runtime/transformers/` with a manifest whose SHA-256 the page
  embeds. The bundle's library defaults that name a CDN or the Hub are rewritten at build
  and the build fails if any remain (`test/batchH-node.mjs` scans the artifact too).
- **Loading.** Every later load re-checks every chunk (`crypto.subtle` against the receipt
  recorded when the whole file matched the lock) and needs no network; a damaged chunk is
  fetched again by range and checked against the same receipt. The worker starts from a
  verified `blob:` (CSP `worker-src blob:`), has no `fetch`, and gets the files as blobs
  and the wasm as bytes. Measured with the real model (M3 Max, Chrome, 2026-11-01):
  putting 1.09 GB into the store took 6 s with the browser 0.4 GiB above idle; loading
  peaked at 3.0 GiB in one process (ORT holds the weights as one buffer, as before).
- **Consent: the `models` command** (`src/models-cli.ts`). `models list | status | get |
  remove | verify`, for agents and the terminal; Settings' Download, Stop and Remove call
  the same code. `get` always opens an approval sheet naming size, storage, license and
  attribution, and origin; anyone may ask, only the user's click approves. The download is
  a `/task` entry whatever asked (`echo stop > /task/<id>/ctl`, the tray, Settings' Stop).
  The user's `remove` frees at once; an agent's asks, because it destroys a consented
  download that offline use depends on and costs 1 GB to undo.
- **Moving an earlier copy.** Parts kept by builds that served the weights from
  pouch.bayleaf.dev (cache `pouch-local-models`) are reassembled on first load, checked
  against the lock like a download, moved, and the old cache deleted: nothing is
  downloaded again. Files that do not match are dropped with a message.
- **Load from folder/files**: the original upstream files (matched by name and size),
  hashed against the lock the same way, plus a saved `runtime/transformers/` folder, for
  offline or `file://` copies (kept for that page load only there). **Remove the model**
  frees the storage; **Erase all** removes it too.
- **Recipe** (`experiments/lfm3-webgpu`, agent v2 "v8"; the `transformersjs` profile in `src/profiles.ts`, moved there byte for byte). A short grounded system prompt
  naming `/work`, one byte-exact example turn, four short tool schemas (read, write,
  edit, bash: no `run`, no subagents, which would spend BayLeaf Sealed requests), greedy
  decoding, at most 8 model steps per message and about 4k tokens of context: older
  turns are dropped first, then the current turn's long tool results are shortened. The
  model's native XML tool calls are parsed in the page. Stop interrupts generation.
  The context meter shows this against the 4,096-token budget (`3.9k / 4k`); its count is
  what the model actually saw (the worker's own tokenizer count of the fitted prompt). When
  a request left something out, the reply is stored with how much (`contextTrimmed`), and
  the meter reads "trimmed" in the warning color: the model is no longer seeing the whole
  conversation. It also warns when the next message would have to leave turns out. pi-durable
  is told a 131,072-token window on purpose, so it never compacts this model by itself; `/compact` does.
- **When to use BayLeaf Sealed.** Transformers.js suits inspecting a workspace and small, literal edits.
  A visible hint (with a "Use BayLeaf Sealed next" button that only changes the picker) appears
  when it hits its step cap, an edit fails twice, a task touches more than 3 files,
  or the thread outgrows its context. Its sessions are auto-named after the first turn
  by the same model in its worker (at most 24 new tokens from a digest well inside the 4k
  budget, so the page stays responsive; a message sent meanwhile waits its turn in the
  engine's queue) and use none of the BayLeaf Sealed allowance.
- **Tool policy for every provider.** Native XML tool calls blur trailing newlines, so
  `edit` makes newText end with a line break exactly when oldText does (an empty newText,
  a deletion, is left alone), `write` saves a non-empty file ending with exactly one
  newline, and a `bash` failure with no output says so ("no output, exit 1 (for grep this
  means no matches...)"). Each is disclosed in the tool description and its result.

## Localhost: a model server on this computer

Settings > Providers > Localhost connects Pouch to an OpenAI-compatible server on
loopback that the user runs: oMLX, Ollama, LM Studio, llama.cpp's server, or a proxy (for
example to their own Tinfoil account; Pouch itself integrates no third party). Source:
`src/localhost.ts` (pure, node-tested), profile `localhost` in `src/profiles.ts`.

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
  cap per message. No allowance is used and BayLeaf is not asked for anything: titles (automatic
  after the first turn, or suggested) and compaction run on the same Localhost model. Usage counts tokens when the server reports them.
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

## Tool runtimes and engine jobs

For heavy tools (pdf.js and libav.js now; OCR, ASR, DuckDB later):

- **Convention** (`build-runtime.mjs`): each heavy tool runs in its own same-origin
  worker; its files ship as content-hash parts under `runtime/<group>/` listed in
  `SHA256SUMS`; any model it needs comes from the gateway, pinned in the build. No asset
  may default to a CDN or the Hub (`assertNoCdn`, at build and in tests).
- **Reassembler** (`src/assets.ts`): `partAssets(pin)` for runtime files over 25 MiB;
  `fillFile` / `rangeSource` / `verifiedFile` for large gateway files. One rule: nothing
  is used unless its SHA-256 matches a hash the page was built with.
- **Engine jobs** (`src/jobs.ts`): one instance per engine shared by every agent, a queue
  (serial by default, `concurrency` per engine), each job a `/task` entry whose ctl stops
  only that job, a memory guard (unloads idle engines, then refuses with a reason), and
  capability scoping: a job gets its caller's namespace view, never the global tree.
  Tested with a sleep-and-hash engine (`test/batchH-node.mjs`).

### The first tool: pdf.js (`pdfinfo`, `pdftotext`, `pdftoppm`)

`src/pdf.ts` adds three commands to the terminal and the agents' bash, with poppler's
names and flags so a model's prior knowledge works:

- `pdfinfo [-upw PW] FILE`: pages, metadata, page size, PDF version, encryption,
  whether it carries JavaScript (never run), and which pages have no text layer.
- `pdftotext [-f N] [-l N] [-layout] [-nopgbrk] [-nomarkers] [-upw PW] FILE [OUT|-]`:
  each page starts with `[page N]` and ends with a form feed; a page without text says
  so and names the `pdftoppm` call that renders it.
- `pdftoppm [-f N] [-l N] [-r DPI] [-png|-jpeg] [-singlefile] [-x -y -W -H] [-upw PW] FILE PREFIX`:
  pages to PNG (or JPEG) in the VFS, `PREFIX-N.png` zero-padded like poppler, rendered on
  an OffscreenCanvas in the worker; `-x -y -W -H` crop a region.

Caps are named constants in `src/pdf.ts` and errors cite them: `MAX_PDF_BYTES` 256 MiB,
`TEXT_MAX_PAGES` 2000 per call, `INFO_SCAN_PAGES` 500, `RENDER_MAX_PAGES` 50 per call,
`MIN_DPI`-`MAX_DPI` 18-600 (default 150), `MAX_PIXELS` 25 million per page. A range over a
cap is refused, not cut. Without `-l`, `pdftotext` and `pdftoppm` stop at their cap with
exit 0 and say so on stdout (where an agent reads it, even with `-q`) as well as stderr:
`[stopped at page 50 of 312: pass -f 51 -l 100 for more]`. Exit codes follow poppler: 1 for a file error, 3 for an encrypted
PDF without its password, 99 for bad arguments; 130 when stopped.

Each command is an engine job (`/task`, Stop through ctl); one worker serves the terminal
and every agent. A non-PDF is refused before the runtime loads. The runtime
(`build-pdf.mjs`, `src/pdf/worker.ts`; sizes and licenses in DEPLOYMENT.md) runs pdf.js's
worker code in the same thread, reads cmaps, fonts and decoder wasm from a verified
`data.pack` instead of fetching them, and then removes `fetch` and `XMLHttpRequest` from
its worker. pdf.js's scripting sandbox is not shipped, so PDF JavaScript cannot run. The
page's CSP did not change. The bundled `pdf` skill gives agents the recipe (check the text
layer, extract with page markers and cite, render scans and look at them when a look tool
is available, crop figures for reports) and the caps. Tests: `node test/pdf-node.mjs`
(parsing, caps, errors, jobs, build pins) and `node test/pdf-browser.mjs` (the real
runtime under the production CSP on fixture PDFs, an encrypted one, a hostile one with
JavaScript and a link, Stop, offline reuse, and the network log).

### The second tool: libav.js (`ffprobe`, `ffmpeg`)

`src/media.ts` adds FFmpeg's own two programs to the terminal and the agents' bash
(libav.js 6.10.9.0, FFmpeg 9, variant `webm-vp9-cli`), with FFmpeg's flags and messages:

- `ffprobe [OPTIONS] FILE`: argv passes through; `-v error -show_format -show_streams -of
  json` is the overview (story AG2). `-o` is refused (redirect instead).
- `ffmpeg [OPTIONS] -i IN ... OUT`: argv passes through to libav's ffmpeg over copies of the
  inputs; outputs are written back to the paths named. libav never sees a Pouch path: files
  are `in0.webm`, `out0.opus` inside a fresh instance's memory, and messages map the names
  back. Progress lines are dropped and long logs keep their first and last lines.
- Images (`.png`, `.jpg`, `.webp`; `%03d` numbers them) are Pouch's own path, because no
  libav.js variant has an image encoder: frames are demuxed and decoded through libav's API,
  filtered by the user's `-vf` (fps, scale, crop, trim) to RGBA, and encoded by
  OffscreenCanvas in the worker. `-ss` seeks, `-t`/`-to` bound, `-r` and `-frames:v` work;
  each "wrote" line gives the frame's time in the source (story AG1).

What the CLI build decodes: WebM/Matroska, Ogg, WAV and FLAC containers; VP8 and VP9
video; Opus, FLAC and PCM audio (`ffmpeg -decoders`). Encoders: VP8, VP9, Opus, FLAC, PCM.
No published libav.js variant decodes H.264, HEVC or AAC (the author does not publish
patent-encumbered codecs), and MP3 is only in `obsolete`; an "empty output with exit 0"
from libav.js counts as a failure.

**The WebCodecs path** (phone videos and voice memos). MOV, MP4, M4A and MP3 inputs are
recognized by their first bytes (`src/media/wc.ts` `sniff`) and handled without libav's
programs. A second, API-only build, `webcodecs-avf` (same release, 3.4 MiB wasm: the MOV
demuxer, swresample, the audio and video filters, the FLAC and Opus encoders, no
decoders for those codecs), demuxes; the browser's `VideoDecoder` and `AudioDecoder`
decode (each codec feature-detected with `isConfigSupported`); MP3 frames are walked in JS,
since no variant demuxes MP3. Chosen over mp4box.js plus a JS resampler because the same
build also supplies `aresample` and the audio filters the CLI build is missing, with no
new license family (LGPL FFmpeg from the sources already shipped) and no CSP change.

| Input | Probe | Frames | Audio out |
|---|---|---|---|
| H.264 in MOV/MP4 | yes | yes (all Chromium builds tested) | AAC, MP3, Opus tracks |
| HEVC in MOV/MP4 | yes, plus a `note:` when undecodable | where `VideoDecoder` has HEVC (Chrome with hardware support: yes; Playwright's Chromium: no, refused clearly) | as above |
| AAC (M4A), MP3 | yes | no video | WAV, FLAC, Opus |
| ProRes, ALAC, others in MOV | yes | refused, naming the codec | refused, naming the codec |

- `ffprobe` builds the report from the demuxer (format, streams, duration, frame counts,
  frame rate, profile, the display rotation as `side_data_list`) and writes it as ffprobe
  does: `-of json`, `default` (with `nw`/`nk`), `csv` (`p=0`), `compact`, `flat`, with
  `-show_entries` and `-select_streams`. Without `-v error` it prints FFmpeg's `Input #0`
  summary on stderr.
- Frames: the image recipes work unchanged (`-ss T -frames:v 1 out.png`, `-vf
  fps=1/N,scale=W:-1 f-%03d.png`). Frames are drawn with OffscreenCanvas: the display
  rotation is applied as ffmpeg's autorotate does, then `-vf` fps (ffmpeg's frame choice,
  round to nearest), scale (numbers, `iw`/`ih` arithmetic, `-1`/`-2`) and crop. Other
  video filters are refused with that list.
- Audio: decoded to float, trimmed by `-ss`/`-t`/`-to`, then through `-af` and an
  `aformat` sink in the avf build (`aresample` converts the rate, layout and sample format),
  to WAV (`pcm_s16le` default, `pcm_s24le`, `pcm_s32le`, `pcm_f32le`, `pcm_u8`, written in
  JS because the build has no PCM encoders but f32), FLAC (24-bit sources stay 24-bit) or
  Opus in Ogg or WebM. Audio filters: acompressor, adeclick, adeclip, aecho, afade,
  aformat, agate, alimiter, amix, anull, apad, aresample, asettb, asplit, atempo, atrim,
  bandpass, bandreject, dynaudnorm, equalizer, loudnorm, pan, volume.
- Conversions the CLI build cannot do (it has no `aresample`, so Opus to WAV, 24-bit to
  16-bit, `-ar`, and `loudnorm`/`dynaudnorm` fail there even though `-filters` lists them)
  are retried on this path when the output is audio only; `ffmpeg -filters` now adds a note
  saying which filters run where.
- Not available, with a one-line hint (frames, audio, or a local re-export): writing MP4,
  MOV, M4A, MP3 or AAC, and any video out of a MOV/MP4. libav.js's `ff_init_filter_graph`
  double-frees on a graph error, which wedges the heap, so the audio graph is built from
  the lower-level calls. A custom libav.js build (MP3 demuxer, PCM encoders, an MP4 muxer
  for `-c copy` cuts) is a later option.

Caps are named constants in `src/media.ts`: `MAX_INPUT_BYTES` 256 MiB per call (checked
before the runtime loads), `MAX_INPUT_SECONDS` 3 h per input, `MAX_OUTPUT_BYTES` 256 MiB
(over it nothing is written), `MAX_IMAGES` 100 per call, `MAX_FRAME_PIXELS` 3840x2160,
`MAX_STDOUT_BYTES` 1 MiB, `MAX_STDERR_LINES` 60. Each run is an engine job (`/task`, Stop
through ctl) with an `ENGINE_MEMORY` estimate of 1 GiB for the jobs memory guard. FFmpeg
runs to completion inside wasm, so Stop ends the worker after `STOP_GRACE_MS` (1 s) and the
next job starts a new one; a stopped job writes nothing. Exit codes: 1 for errors, 130 when
stopped.

The runtime (`build-libav.mjs`, `src/media/worker.ts`) bundles libav.js's wrapper and
Emscripten factory into one module worker (three build-time rewrite rules, six replacements,
each matched an exact number of times: Emscripten's Node branches and libav.js's own worker bootstrap), compiles
the released wasm once from verified bytes, then removes `fetch` and `XMLHttpRequest` from
the worker. Each job gets a fresh libav instance, so no job sees another's files. Non-threaded:
no COOP/COEP, and the page's CSP did not change. The bundled `media` skill gives agents the
recipe (probe first; at most 8 frames per look, rate picked from the duration; look at them
if a look tool is available; audio copy; trims), the real codec coverage and filter list,
and never to send the person's media to an online converter (it suggests a local re-export
instead: QuickTime Export As, the phone's "Most Compatible" setting, a screen recorder's
WebM, or ffmpeg on their own computer). Tests: `node
test/media-node.mjs` (parsing, time syntax, image plans, caps, errors, jobs and Stop with a
fake engine, build pins and source) and `node test/media-browser.mjs` (the real runtime
under the production CSP on tiny committed fixtures in `test/fixtures/media/`: ffprobe JSON,
frame colors and times from VP8 and VP9, JPEG, audio copy, trim, VP9 transcode, the gaps'
messages, Stop mid-ffmpeg, offline reuse, and the network log).

## The `bayleaf` command: the one way out

`src/bayleaf-cli.ts` adds a `bayleaf` command to the shell for BayLeaf's non-inference
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
- In the page, `src/egress.ts` implements the hooks: an approval sheet (Deny, Allow once,
  Allow for this session) and per-session grants kept in settings as
  `egressGrants:<session>`, revocable from the session menu and deleted with the session.
  Tool cards that sent something show a "left the pouch" badge, rebuilt from the marker.
- The `bayleaf-cli` skill tells the agent what each service exposes and not to send private
  file contents unless the user asked for that action.

Sandbox `exec`, `poke` and every `files` command create or wake the VM (the API's
`ensureSandbox`); only `sandbox status` and `preview` do not. Test with
`node test/bayleaf-cli-node.mjs [--live]`, or as the agent with
`node test/ax-cli.mjs [--allow-egress] [--key-env NAME | --no-key] call ...`.

## Implementation notes

- Browser Sealed needs CORS: `api/src/index.ts` gives `/sealed/*` its own
  policy that reflects requested headers (EHBP plus the OpenAI SDK's `x-stainless-*`) and
  exposes `Ehbp-Response-Nonce`. That is safe because the origin is `*` without credentials
  and `sealed.ts` forwards only an allowlist upstream.
- The bundled SDK is about 640 KiB minified. Its verifier has a Node-only gzip fallback
  that is excluded from the build.
- Claim polling is one-shot: the server deletes the claim as it returns the key, so two
  overlapping poll loops (or a controller shared with streaming) see "expired" after
  approval. Pouch runs one loop with its own `AbortController`.

## Open questions

- Where transparent releases will live and how to make "check the hash" a ritual people
  actually perform (issue #138). On mobile, opening a file from disk is awkward.
- Storage mode chosen at sign-in: borrowed computer versus my device (issue #139).
- In-page agent tools over OPFS and `showDirectoryPicker`, with write confirmation.
