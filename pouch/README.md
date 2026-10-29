# BayLeaf Pouch (proof of concept)

Issue [#120](https://github.com/bayleaf-ucsc/bayleaf/issues/120). A single HTML file:
a coding agent that works on files in your browser, thinks through the API's Sealed
lane, and keeps conversations and files only on your device.

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
| Local lane turns (prompts, files, replies) | this browser only: generated on its GPU | nobody else; nothing is sent |
| Local model files (optional, ~1.1 GB) | Cache Storage (`pouch-local-models`), until Remove local model or Erase all | the static host sees that this browser downloaded them |

The CSP's `connect-src 'self' https://api.bayleaf.dev` means the page has one remote
network peer plus its own static origin, which it uses only to download the optional
Local model's hash-checked files. An auditor checks the file's hash and that its CSP is
as stated.

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
| Composer | one card: activity tray (running subagents and `run` calls, approvals waiting, a queued message; Stop, Stop all), `@` path / `$` skill / `/` command autocomplete, the shield popover (lane, egress grants), Usage count, model picker, Send / Queue / Stop; the turn footer (model, duration, time) is in `main.js` | `src/composer.js`, `src/main.js` |
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
says so, with the reset time. A title you type is never replaced automatically.

**Subagents** (`src/subagents.js`): the `subagent` tool lets the main agent hand a
self-contained task (web research through `bayleaf`, exploring `/work` or a mounted folder)
to a background child while it keeps talking with you. A child is an ownerless pi-durable
conversation in the session's own database (so deleting the session erases it, and the
parent is never busy because of it), with the same tools but no `subagent` tool, at most
three running per session, using the parent's model. A watcher in the page waits for the
child's submission and posts its report to the parent: a follow-up input when it finished
or failed (the parent gets a turn to use it), a model-visible write that spends no request
when you stopped it. Reports carry the request id `sa-report:<submission>`, so they post once.
A reload never spends Sealed requests by itself: Pouch does not call `harness.resume()`;
opening a session aborts any run a reload cut off (parent or child), marks it interrupted
(the parent is told with a write, not a request) and offers **Resume**.
The child's card at the spawn point shows its status, time, requests, a live read-only
transcript, Stop, Message and the files it changed (Diff, Undo); approvals it asks for say
"Subagent <name> wants to ...". Its steps spend the same daily allowance.

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

Offline checks: `node test/{theme-node,composer-node,markdown-node,vfs-node,subagents-node,bayleaf-cli-node}.mjs`
(run each file separately). Full-UI mocks and desktop/390px light/dark screenshots:
`POUCH_OUT=/scratch/build node build.mjs`, then the same `POUCH_OUT` with
`node test/composer-browser.mjs`. Set `PLAYWRIGHT_MODULE` to an installed Playwright ESM
entry point if needed. Tests mock the Sealed provider and spend no inference quota.

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
  tinfoil 1.3.0). `'self'` was added for the Local lane (below) and is used only to fetch
  `models/<id>/` files, each checked against a manifest whose SHA-256 is built into the
  page; the static host already serves the page, so it is not a new operator. It also
  lets page script send data to that host, which before needed `api.bayleaf.dev`: the
  same operator, but a different service with different logs (Cloudflare Workers Static
  Assets keeps request metadata, not bodies; see DEPLOYMENT.md).
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

## Local lane: a model on this device

Builds made with `node build.mjs --with-models` carry an optional third lane next to
Sealed: **Local: LFM3 1.7B (on this device)**, the `onnx-community/LFM3-1.7B-ONNX` q4f16
export at a pinned revision, run by Transformers.js 4.3.2 and ONNX Runtime Web on
WebGPU. The picker shows it when WebGPU works and otherwise lists it disabled with the
reason. Choosing it is the only way in: Pouch never switches lanes by itself, and the
shield says "On this device: nothing sent".

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
  kept for that page load only). **Remove local model** frees the storage; **Erase all**
  removes it too.
- **Recipe** (`experiments/lfm3-webgpu`, agent v2 "v8"). A short grounded system prompt
  naming `/work`, one byte-exact example turn, four short tool schemas (read, write,
  edit, bash: no `run`, no subagents, which would spend Sealed requests), greedy
  decoding, at most 8 model steps per message and about 4k tokens of context: older
  turns are dropped first, then the current turn's long tool results are shortened. The
  model's native XML tool calls are parsed in the page. Stop interrupts generation.
- **When to use Sealed.** Local suits inspecting a workspace and small, literal edits.
  A visible hint (with a "Use Sealed next" button that only changes the picker) appears
  when Local hits its step cap, an edit fails twice, a task touches more than 3 files,
  or the conversation outgrows its context. Local sessions are not auto-named (that
  would be a Sealed request) and use none of the Sealed allowance.
- **Tool policy for every lane.** Native XML tool calls blur trailing newlines, so
  `edit` makes newText end with a line break exactly when oldText does (an empty newText,
  a deletion, is left alone), `write` saves a non-empty file ending with exactly one
  newline, and a `bash` failure with no output says so ("no output, exit 1 (for grep this
  means no matches...)"). Each is disclosed in the tool description and its result.

## Offline

When the network drops (the browser's offline event, or a request that fails like a
dropped network followed by a failed re-check), the shield turns grey, the status line
and the Send button's title say "Offline: the model is unreachable", Send is disabled,
and a turn in flight ends at once with "Connection lost". Files, the editor, review,
archives and `run` keep working. Pouch re-checks every 15 s and on the online event;
when the relay answers it re-verifies the enclave, re-enables Send and refreshes usage,
without a reload. The draft in the composer is kept throughout.

A saved copy of `pouch.html` opened from disk (`file://`) starts offline and works, with
one caveat: Chromium refuses OPFS to `file://` pages, so `/work` falls back to memory
(tagged "memory only") and is lost on reload; IndexedDB (`/pouch`, sessions, settings)
does persist. Sealed sending needs the network, because attestation fetches the
enclave's bundle; the Local lane does not (load its files from a saved folder in Settings). A hosted copy that loads with no network would need a service
worker; see JOURNEYS F3 for what that implies for the hash story.

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
