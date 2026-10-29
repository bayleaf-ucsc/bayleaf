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

The CSP's `connect-src https://api.bayleaf.dev` means the page has exactly one network
peer, so an auditor checks two things: the file's hash, and that its CSP is as stated.

## The coding agent

| Piece | What | Source |
|---|---|---|
| Agent loop | [pi-durable](https://github.com/earendil-works/pi): durable conversations in IndexedDB, tool tasks, automatic compaction | `src/agent.js` |
| Tools | `read`, `write`, `edit`, `bash`, all in the page | `src/tools.js` |
| Shell | [just-bash](https://github.com/vercel-labs/just-bash): bash and coreutils reimplemented in TypeScript, no processes, no network | `src/tools.js` |
| Files | one tree stitched from several stores (below) | `src/vfs.js` |
| Editor | CodeMirror 6 with JS/TS, Python, Markdown, HTML, CSS, JSON | `src/editor.js` |
| UI | sessions sidebar, chat, one side panel at a time (Files, Editor, Usage, Trust, Settings) from an icon rail; drawer, full-screen sheets and a bottom bar on phones | `pouch.html`, `src/main.js`, `src/layout.js` |
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

- **One network peer.** `connect-src https://api.bayleaf.dev`. Attestation verification
  succeeds under this policy because the relay's `/sealed/attestation` bundle carries
  the whole trust root (verified 2026-10-27, tinfoil 1.3.0).
- **Only its own scripts.** `script-src` lists two SHA-256 hashes, so an injection cannot run.
- **No HTML from models.** Replies render as `textContent`, so a reply cannot inject
  markup into the page that holds your key.
- **Fail closed.** If attestation fails, Send stays disabled. No plaintext fallback exists.

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
