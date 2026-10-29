# Pouch user journeys

A story map for design and testing. The backbone runs left to right as one visit; each
column lists stories under it, marked **ok** (built and tested), **gap** (missing),
or **?** (built, untested). Tests and design changes should cite story IDs.

## People

| Persona | Setting | What they need most |
|---|---|---|
| **Lab** – a student on a borrowed lab computer | private window, campus network, no key, 40 minutes | bring files in fast, get them out before leaving, leave nothing behind |
| **Phone** – a student on their own phone | mobile browser, signed in with a claimed key | small edits and questions on files they already have; tapping, not dragging |
| **Desk** – a TA or researcher on their own laptop | Chromium, a project folder mounted read-write | the agent doing real multi-file work, and seeing exactly what changed before trusting it |
| **Auditor** – someone checking BayLeaf's claims | any browser, devtools open | proof the page is static, talks only to `api.bayleaf.dev`, and sends ciphertext |
| **Agent** – the model inside Pouch | system prompt, four tools, a simulated shell | to know where files are and what the shell can do, and to get errors it can recover from |

## Backbone

`Arrive → Trust → Bring files in → Direct the agent → Review → Take files out → Leave`

### 1. Arrive
- A1 ok: the page loads with no account; files and editor work at once. (t7: the tree is keyboard operable: roving tabindex, arrows, Enter, Shift+F10/menu key; rows and `...` are 44px on touch)
- A2 ok: Campus Pass works on campus without signing in.
- A3 ?: off campus, the reason sending is unavailable is clear, and so is the way to sign in.
- A4 ok: sign in by approving on another device, or by pasting a key.
- A5 ok: a first visit explains in one screen what Pouch is and where things are kept. (t7: dismissible card in the chat pane with Upload files / Mount a folder; dismissal persists)
- A6 ok: see how much of today's Sealed allowance remains, keyed or under Campus Pass, and when it resets; running out says so instead of a generic failure. (t9: rail meter and Usage panel with a key, decrement after a turn; Campus Pass view says the bucket is shared by the network address; a mocked 429 shows the reset time. The real relay's 429 body is untested.)
- A7 ok: the frame is chat first, sessions in a collapsible sidebar, one side panel at a time from an icon rail, panels and sidebar resizable by drag or keyboard and remembered. (t9 at 1280x800: chat 936px with Files, 596px with the Editor at its 50% default)
- A8 ok: Settings, separate from Trust, holds persisted Light/Dark/System appearance (follows OS in System) and new-message reasoning/tool expansion defaults. Both default collapsed; individual toggles survive streaming redraws; Erase all resets preferences. Settings is in the desktop rail and phone More sheet. (`test/composer-browser.mjs`, offline, desktop and 390px light/dark screenshots)

### 2. Trust
- T1 ok: the badge shows enclave verification; tapping it shows the attestation facts, and states the one network peer (CSP).
- T2 ok: inference bodies leave as ciphertext; only `api.bayleaf.dev` is contacted.
- T3 ok (revised): the page cannot honestly show its own hash, so the trust dialog shows a build id (commit + date), a `shasum -a 256 pouch.html` recipe against the release's SHA256SUMS, and a source link. (t7)
- T4 ok: it is clear which storage a file is in (browser, shared, memory, device folder). (t7: root tags carry a title and open the storage sheet on tap)

### 3. Bring files in
- I1 ok: upload files into a chosen folder (file picker, phone-friendly); an existing name asks Replace / Keep both / Skip, once per batch. (t7)
- I2 ok: drag files *and folders* from the desktop onto a folder; "Upload a folder here" where supported. (t7: webkitRelativePath fallback via synthetic drop, folder picker via Playwright; a real OS folder drag through webkitGetAsEntry is still untested headless)
- I3 ?: mount a device folder read-only or read-write (Chromium only).
- I4 ok: import a `.zip` or `.tar`: Unpack here (single top folder becomes that folder, else a folder named after the archive) and List contents. (t7: Info-ZIP zip, PAX long-name tar)
- I5 ok: paste text from the clipboard as a new file (the borrowed-computer case). (t7, Chromium with clipboard permission; Firefox/Safari readText behaviour unverified)
- I6 ?: after importing, the agent can be pointed at the files ("mention in chat").
- I7 ?: pull files down from the BayLeaf sandbox VM into /work (`bayleaf sandbox files get`, approved per transfer); decrypt with a password if they were sealed with O6. (CLI round trip live-tested in Node; untested in the browser; waking the VM is unavoidable today)
- I8 ok: composer Attach (+), file drop and image paste share local ingestion into unique `/work/.attachments/` paths, with removable name/size chips and no automatic send. Original bytes are exact; references survive in the transcript. Works before authentication; normal text paste is not intercepted. Eight files, 20 MB each. Removing a chip leaves the local file. (`test/composer-browser.mjs`, mocked provider, OPFS byte checks)
- I9 ok (offline): PNG/JPEG/GIF/WebP attachments become locally re-encoded pi-ai image blocks inside the sealed request; 2000px/4 MB cap, original VFS bytes unchanged, first animation frame only. Capability comes from actual catalog `multimodal`; text-only selections refuse before network, with a switch instruction. SVG and other formats are files only, never claimed as vision. (`test/composer-node.mjs`: serialization + durable history; browser: resize, paste, text-only rejection; live image inference not exercised)

### 4. Direct the agent
- D1 ok: ask in plain language; the agent reads, writes, edits and runs bash.
- D2 ok: tool calls are visible as they run; Stop works.
- D3 ok: several sessions, each independent; they survive reload.
- D4 ok: `/work/AGENTS.md` and `/pouch/AGENTS.md` steer the agent; skills are listed.
- D5 ?: the agent recovers from tool errors (missing file, ambiguous edit, unsupported command).
- D6 ?: the agent finds its way around an unfamiliar imported tree without wasted calls.
- D7 ok: long sessions compact automatically.
- D8 ok: sessions are named automatically after the first turn (one sealed request); click the title to rename in place, or press the sparkle to suggest one from the recent conversation. A typed title is never overwritten. (t9 with glm-5-3)
- D9 ok: switch, rename, compact and delete sessions from the sidebar; a running session shows a spinner. (t9, t3)
- D17 ok: model picker is below composition with 44px Attach/Send targets, fits 390px; selection is pending until the next user turn. In-flight tool rounds and first-turn naming use the frozen turn model; configured children do not change. (`test/composer-node.mjs`, `test/composer-browser.mjs`, fake Sealed provider, zero quota)
- D10 ok: the agent uses BayLeaf web search/fetch, its sandbox VM (exec, files put/get, previews) and inboxes through the `bayleaf` shell command (`src/bayleaf-cli.js`). Each request leaves the pouch, so the user approves it first in a sheet (`src/egress.js`: summary, exact payload, who can see it; Deny has focus; Esc, close and backdrop deny; queued requests ask one at a time; full-screen on phones). Allow for this session remembers (session, service), is listed and revocable in the session menu, and is deleted with the session. A denial sends nothing. Cards that sent something get a "left the pouch" badge, rebuilt after reload from the `[this call sent data outside the pouch: ...]` marker. Node: `test/bayleaf-cli-node.mjs --live`. (t10b with glm-5-3: deny sends no request, allow once exactly one, session grant skips the prompt, new session and revoked grant prompt again, badge survives reload, 390px sheet with 44px targets and no overflow; only web search exercised in the browser, sandbox and inbox approvals untested there; no real-phone session yet)

- D11 ok: your messages are tinted bubbles on the right, replies full-width markdown, tool calls small grey pills, thinking muted. Under each message a toolbar row (space always reserved, so nothing jumps) shows on hover, on keyboard focus (messages are focusable, with a focus ring) or after a tap: the time (full timestamp on hover), Copy (your text, or the reply's markdown source) and Revert to here. (t10c with glm-5-3: computed styles, no height change on hover, Tab order, clipboard contents; 390px: tap shows it, 44px targets, no overflow)
- D12 ok: Revert to here forks the conversation just after a message (pi-durable `fork`, in the session's own database) and points the session at the fork, so the model never sees the later turns. A confirm sheet counts the messages that leave and offers "Also undo changes to N files made after this message" (checked, files listed). The revert is undoable until the next revert, from an inline "Reverted to <time>. Undo" and the session menu: it points back to the earlier conversation and puts the files back as they were at the revert, warning if they changed since and if you sent messages since. Disabled while a run is active and for legacy sessions. Deleting the session erases every fork and the kept file bytes. (t10c: model recall excludes turn 2/3 words, undo restores transcript and file, marker scan empty after delete)

Beyond the pouch, through the `bayleaf` CLI (each outbound action asks first; see D10):
- D13 ok: research on the web: the agent searches and fetches pages and saves notes or sources into /work; each query and URL is approved, and the transcript marks what left the pouch. (t10b: search with deny/allow once/allow for session)
- D14 ?: check BayLeaf inboxes for new messages ("anything new since yesterday?"): the agent lists inboxes and summarizes unread messages. Listing and reading exist in the CLI (live-tested in Node with no inboxes); untested in the browser, and "new since last check" needs a remembered per-inbox marker (gap).
- D15 ok: background subagents: "look into related work on X while we keep going": the agent hands a self-contained task to a child conversation (`subagent` tool, `src/subagents.js`) that runs in the background (web research through the `bayleaf` CLI, or exploring a codebase in /work or a mounted folder) while the main conversation stays responsive. When the child finishes, its report joins the main conversation as a follow-up (the parent gets one turn to use it); a stopped child is noted without spending a request. A reload never spends requests by itself: a running child (or parent run) is stopped and marked interrupted, the parent is told without a request, and one click on Resume continues it; reports post once (request ids). (Background *bash* jobs were considered and dropped: just-bash runs on the page's main thread, so only network-bound work interleaves, and that work is what subagents do.) (t11 with glm-5-3: parent answered while child ran, exactly one report, summary file written, parent used report next turn; node test/subagents-node.mjs with a scripted fake model; t12: 0 Sealed POSTs across 3 reloads after a finished turn, mid-run, and with a child running)
- D16 ok: subagents are visible and controllable: each child shows as a card at the spawn point with its task, status, time, request count, live read-only transcript, Stop, Message, and the files it changed (Diff, Undo); the report renders in the transcript; the sidebar badges sessions with running children; approvals from a child say "Subagent <name> wants to ..."; children spend the daily allowance (Usage panel notes running ones; spawning when 15 or fewer are left warns), cannot spawn their own children, run at most three at a time, and are erased with the session. (t11: deny/allow from a child, Stop button, 390px card without overflow, marker scan empty after delete; cap and no-nesting only in the node test; no real-phone session)

### 5. Review
- R1 ok: open any file in the editor with syntax highlighting, by tap or Enter; rename onto an existing name is refused. (t7)
- R2 ok: see which files the agent changed in a turn, and open each from the chat. (t6: "Changed N files" under each turn, survives reload; tree dot until opened)
- R3 ok: see a diff of an agent edit, not only the new text. (t6: unified diff in the editor with per-chunk Keep/Revert; deleted files offer Restore)
- R4 ok: the editor follows agent edits to the open file without losing your unsaved edits. (t6: conflict bar with Show diff / Keep mine / Take theirs; Save asks)
- R5 ok: undo an agent change (restore the previous version). (t6: one file and whole turn, byte-exact; t7: the agent is told about undos, reverts and user edits with the next message, while the transcript shows only the typed text)
- R6 ?: review on a phone: switching between chat and the changed file is quick. (t6: Open and tappable paths open the Editor as a full-screen sheet over the chat, the bottom bar returns to Chat, no overflow; no real-phone session yet)
- R7 ok: readable replies: markdown, highlighted code, file links open in the editor. (t8 with glm-5-3: tok- spans, Copy, table, link opens util.js at the named line, external link confirm sheet, no overflow at 390px; md-unit: XSS payloads stay text; no real-phone session yet)
- R8 ok (offline): local `/work/` PNG/JPEG/GIF/WebP markdown images render via magic-checked blob URLs, revoked when removed or page closes. No remote image fetch; SVG remains a file link; external images retain confirmation. (`test/composer-browser.mjs`, `test/markdown-node.mjs`; no real-phone session yet)

### 6. Take files out
- O1 ok: download one file.
- O2 ok: download a folder as `.tar`, including paths over 100 bytes (PAX). (t7)
- O3 ok: `.zip` export (what Windows and phone users can open without tools); Download all exports /work. (t7: python zipfile and `unzip -t`)
- O4 ok: copy a file's text to the clipboard (the borrowed-computer case). (t7)
- O5 ?: a read-write mounted folder receives the agent's changes directly.
- O6 gap: push files up to the BayLeaf sandbox, optionally sealed first with a password the *user* types into Pouch (never the model, so the password never enters the transcript or a request): the VM, and therefore the BayLeaf operator, then holds only ciphertext. Needs a local `seal`/`unseal` command (WebCrypto: PBKDF2 or similar key derivation plus AES-GCM) whose password prompt is a UI hook like the egress approval.

### 7. Leave
- L1 ok: Erase all removes every trace this origin stored; the reloaded page says so, and that empty databases are recreated at start. (t7)
- L2 ok: deleting one session erases its transcript (its own IndexedDB database), its change records and its notes; Shift held shows a no-confirm trash button per row on desktop. Sessions saved before per-session storage are marked legacy: deleting one stops and resets it, and the shared legacy database is dropped once none is left. (t10a: marker scan of every store of every database)
- L3 ok: a "borrowed computer" reminder: export, then erase, before closing (first-visit card, storage sheet, Erase confirm).
- L4 ?: forgetting the key leaves files and sessions intact, and says so.

## Release slices

1. **Walking skeleton (now):** A1–A4, T1–T2, I1, D1–D4, D7, R1, O1–O2, L1.
2. **Review and round trip:** R2, R3, R5, I4, O3, O4, I5, L2.
3. **Trust and first visit:** T3, A5, L3.
4. **Frame and allowance:** A6, A7, D8, D9.
