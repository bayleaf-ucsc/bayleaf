# Add-ons: a language proposal (draft, 2026-11-01)

Status: **adopted** 2026-11-01 with the decisions at the end; built on branch
`pouch-addons` (LANGUAGE.md "Add-on", README "Add-ons", NEXT.md "Add-ons"). Written against the main checkout's uncommitted state
(LANGUAGE.md, README "Transformers.js" and "Tool runtimes and engine jobs", `src/models.js`,
`src/models-cli.js`, `src/jobs.js`, `src/assets.js`, `build-runtime.mjs`, `src/defaults.js`,
`src/main.js`, `pouch.html`). Disciplines in play: domain-driven design (ubiquitous language),
interaction design (consent, recoverability), and agent experience (words a 1.7B model must
read and act on without guessing).

## 1. Inventory

### What exists today

| Thing | Code nouns | Storage | User-facing words | Agent-facing words |
|---|---|---|---|---|
| pdf.js, 3.9 MiB | `PDF_RUNTIME` pin, `partAssets`, `pdfEngine`, group `pdf` | Cache `pouch-runtime`, `runtime/pdf/` | none (silent) | task note "loading the pdf runtime"; skill: "The first command downloads the pdf runtime (about 4 MiB...)"; "the pdf runtime is not available here" |
| libav.js, 4.2 MiB | `LIBAV_RUNTIME`, `mediaEngine`, group `libav` | same cache, `runtime/libav/` | none | "loading the media runtime"; skill "downloads the media runtime" |
| libav.js source offer, 33 MiB | group `libav-source`, `LIBAV_SOURCE` | origin only, never fetched by the page | ffmpeg -L text | "source: /runtime/libav-source/manifest..." |
| Transformers.js runtime, 26 MiB | `LOCAL.runtime` pin, group `transformers` | `pouch-runtime` | progress "checking the runtime"; Settings "a saved `runtime` folder" | none |
| LFM3 weights, 1.09 GB | `models.lock.json`, `createModelStore`, `createModelService`, `LOCAL`, lock entry, "pin", catalog, release | Cache `pouch-models` (old: `pouch-local-models`) | Settings heading "Transformers.js model"; Download, Resume download, Stop download, Remove the model, Load from folder, Load from files; sheet "Download LFM3 1.7B?" | `models list/status/get/remove/verify`; states "downloaded", "partial", "not downloaded", "not in this build (no pin)" |
| Offline copy of the page | `src/offline.js`, `pouch-shell-<sha>` | Cache | Install app, Keep an offline copy, Uninstall offline copy, Update | none |
| Bundled skills | `SEED` in `src/defaults.js` | files under `/pouch/skills/` | file browser | skill text, `skill-authoring` |

### Inconsistencies

Same thing, different names:
- The act of fetching: "download" (models, skills), "loading" (pdf/media task notes), "fetching and
  checking" (Transformers.js progress), "obtain" (`partAssets.obtain`), "get" (`models get`),
  "ensure" (`ensureLocal`). States: "downloaded", "kept", "complete", "verified", "stored".
- The 1.1 GB LFM3 thing is "the Transformers.js model" (Settings), "LFM3 1.7B" (sheet), the id
  `lfm3-1.7b-q4f16` (command), "the local model" (`src/local/engine.js` refusal), "In-browser
  models" (device refusal). LANGUAGE.md retired "Local" and rejected "in-browser" (2026-10-31),
  but lowercase "the local model" slips past ul-node's case-sensitive pattern.
- The Transformers.js add-on is really two downloads (26 MiB runtime from Pouch's origin, 1.09 GB
  weights from the gateway). Consent names only the weights; the runtime arrives silently on first
  start. Settings' Remove deletes both (`engine.js remove`), `models remove` only the weights.

One name, different things:
- **engine**: the Harness's engine (pi-durable, LANGUAGE.md) and `src/jobs.js` "engines" (pdf,
  media workers) and `localEngine` (the Transformers.js worker). Three meanings, one adopted.
- **Download**: files leaving /work for the user's disk (Download, Download all, Download as
  .zip) and bytes arriving into Pouch (Download the model). Opposite directions, same verb.
- **Install**: the browser installing Pouch as an app ("Install app"); no current add-on use.
- **load**: "Load from folder" (import verified files) and "loading the pdf runtime" /
  "starting the model on your GPU" (into memory) and `jobs.unload` (out of memory).
- **model**: LANGUAGE.md's Model (weights, any provider) vs the `models` command, which manages
  only models Pouch keeps (Sealed models never appear in it), so `models list` misleads by name.
- **manifest**: the runtime parts manifest and the web app manifest.
- **runtime**: a heavy tool's code (pdf.js), ORT inside Transformers.js, the build convention
  "tool runtime", a group that is never installed (`libav-source`), and the `run` tool's world.

Implementation leaking into user and agent text:
- "runtime", "group", "parts", "pins", "chunk", "receipt", "manifest" reach the Settings blurb,
  skills and task notes. A small model reading "the pdf runtime is not available here" cannot
  tell whether to retry, ask, or give up.
- Stale text: the trust panel says Pouch talks to "its own origin to download the optional
  Transformers.js model" and checks "a manifest" (weights now come from api.bayleaf.dev, pinned
  per file); README "Offline" excludes `/models/**` from `sw.js`; `models.lock.json`'s comment
  says "Local lane" and "dist/models/".
- pdf and libav runtimes cannot be removed at all except by Erase all.

## 2. Proposed vocabulary (LANGUAGE.md style)

**Add-on.** Something optional Pouch keeps in this browser so a tool or provider can work:
code, weights or data, fetched only when wanted, checked against hashes this page was built
with, kept outside the Workspace (agents cannot see or edit it as files), removable at any time.
Examples: pdf.js, libav.js, LFM3 1.7B, later DuckDB. *Alternative:* "component" (neutral, but
reads as UI widget). *Avoid:* extension (browser extensions, a different trust story), plugin
(implies third-party code), package (implies a package manager and dependencies), capability
(already means a Namespace's grants).

**Kind.** `tool` (code that adds commands: pdf.js, libav.js, DuckDB) or `model` (weights a
Provider runs: LFM3). A model add-on that needs code names a tool-kind dependency internally
(the Transformers.js code), shown to the user as one add-on with one size. *Alternative:*
`runtime | model` (the brief's shape; "runtime" is the word we are trying to keep out of UI).

**Install / Remove.** Install: fetch whatever is missing, check every byte, keep it. Remove:
delete it from this browser. Resumable: installing again continues where a Stop left off.
"Download" stays for files the user takes out of Pouch; "Install" never means the app. The
browser's "Install app" becomes **Add to this device** (Chromium also says "app"; we keep our
verb unambiguous). *Alternative:* Get / Remove (what `models get` says; short, but agents
expect `install` from apt, pip, npm).

**Size.** Bytes to install, in MiB below 1 GiB and GB above (as now). One number per add-on,
everything included (LFM3: 1.09 GB weights + 26 MiB code = about 1.1 GB).

**Pin.** Code and docs only: the size and SHA-256 per file this build carries. Never in UI
("checked against this page's hashes" says it plainly).

**State.** Exactly one of: *not installed* (with size), *installing* (n of size, its /task),
*partly installed* (n of size; Install resumes), *installed*, *not available here* (with a
reason). Retire "downloaded", "partial", "kept" as states ("kept in this browser" may stay in
prose about where). "Not available here" applies both before install (refused, nothing fetched)
and after (installed but this device cannot run it; Remove still offered).

**Reason.** The one sentence after "not available here", from the device check (phones,
memory under 8 GB, WebGPU missing, `shader-f16`, storage buffers) or the build ("this build of
Pouch leaves it out"). Always says what would work instead (a computer, Chrome, BayLeaf Sealed).

**Consent.** The user's click on the install sheet. Two tiers: *quiet* (at most 10 MiB, from
Pouch's own origin, no license beyond the shipped NOTICE: installs on first use and the tool
card says so) and *asked* (anything else: size, where kept, license, attribution, origin, and
who asked). Anyone may request an install; only a person approves an asked one. Removing is
the person's right without asking; an agent's remove request always asks.

**Make available offline.** One action installs every add-on this device can run (quiet
ones directly, asked ones through one combined sheet). Not "offline copy", which stays the
name for the page itself.

**Start / Stop / Unload.** Memory, not storage: an installed add-on *starts* when a job needs
it and is *unloaded* when idle or over the memory budget. "Stop" stays the /task verb (an
install or a job). Retire "load" for both storage and memory ("Load from folder" becomes
**Install from folder**, "Install from files").

How the other terms relate:
- **Provider ↔ add-on.** Transformers.js is a Provider; it *needs* the LFM3 add-on. The picker
  lists LFM3 under Transformers.js; choosing it when not installed opens the install sheet.
- **Tool/command ↔ add-on.** `pdftotext` *needs* pdf.js. Commands name their add-on in
  `--help` and errors.
- **Engine.** Keep for the Harness only (adopted). The pdf/media/Transformers.js workers are
  **workers**; `src/jobs.js` runs **jobs** on them.
- **Skills are not add-ons.** A skill is Context: plain files in `/pouch/skills` the agent reads
  and the person may edit or delete, governed by the Namespace. An add-on is opaque, verified,
  immutable, outside the Workspace, gated by device. A skills pack is a **seed layer** (already
  in "The shape"). An add-on may *come with* a skill (pdf, media); the skill is seeded whether or
  not the add-on is installed, and says the add-on installs on first use.
- **Offline copy** (the page) and add-ons share Cache Storage and Erase all, but not a
  lifecycle: the copy updates by explicit Update; an add-on is fixed per build (a new build
  with a new pin installs the new version on next use, and drops the old one).

## 3. Retirements and renames

ul-node additions (banned in the built page, with reasons):
- `\b(pdf|media|Transformers\.js) runtime\b` in UI/agent text: use the add-on name
  ("pdf.js", "libav.js"). Allow in source-offer text if needed.
- `\b[Tt]he local model\b`, `\bIn-browser models?\b`: use "LFM3" or "Transformers.js".
- `\bnot downloaded\b`, `\bResume download\b`, `\bStop download\b`, `\bRemove the model\b`,
  `\bLoad from (folder|files)\b`: use Install/Remove/Install from folder.
- `models get` in agent-facing strings (after the rename below), with an ALLOW for the alias's
  own help line.

Code renames (optional; cost noted):
- `src/jobs.js` `engines`/`define`/"Engine jobs" → `workers`/"jobs" (cheap: one module, one test).
- `pdfEngine`/`mediaEngine`/`localEngine` → `pdfWorker`/... (cheap, mechanical).
- `createModelStore`/`createModelService` → one `createAddons` registry with a weights backend
  (medium: the real framework work, below).
- `partAssets` → keep (it names the mechanism, not the term). `runtime/<group>/` paths, Cache
  names `pouch-runtime`/`pouch-models`, `models.lock.json`: keep (renaming orphans installed
  bytes; LANGUAGE.md's precedent: storage keys stay).
- `models.lock.json` comment: fix ("Local lane", "dist/models/") at no cost.

UI strings to change: Settings heading "Transformers.js model" → section **Add-ons** with a
row "LFM3 1.7B (for Transformers.js)"; buttons as above; sheet title "Install LFM3 1.7B?" /
"main (a1) asks to install LFM3 1.7B"; trust panel's stale download sentence; skills `pdf` and
`media` ("The first command installs pdf.js, about 4 MiB, from Pouch's own origin; it says so").
"Install app" → "Add to this device"; "Uninstall offline copy" → "Remove offline copy".

## 4. Framework sketch, in the new language

Registry entry (built from pins; replaces ad hoc `LOCAL`, `POUCH_PDF_RUNTIME`, `POUCH_LIBAV_RUNTIME`):

```js
{ id: 'pdfjs', label: 'pdf.js', kind: 'tool', size: 4_112_740,  // dist/runtime/pdf/ today
  needs: [],                          // LFM3: needs: ['transformersjs'] (hidden tool-kind entry)
  files: { origin: pin } | { gateway: lockEntry },   // partAssets or fillFile backend
  notice: { license: 'Apache-2.0 and others', source: 'runtime/pdf/NOTICE.txt' },
  device: (env) => ({ ok, reason }),  // LFM3: deviceSupport + gpuSupport; others: always ok
  consent: 'quiet' | 'asked',         // derived: size <= 10 MiB && origin && no extra license
  usedBy: ['pdfinfo', 'pdftotext', 'pdftoppm'] }   // or provider: 'transformersjs'
```

Command: **`addons`** (`list | info <name> | install <name> [--wait] | remove <name> | verify
<name>`), plus `addons install --all` for make available offline. `models` stays one release as
an alias that prints `models is now addons; ran: addons install lfm3` on stderr, then is retired
(ul-node). Names accept unique prefixes, as now. `list` columns: NAME, KIND, SIZE, STATE, USED BY.

Settings: one **Add-ons** section: a row per add-on with label, what uses it, size, state (or
"not available here: reason"), and Install/Stop/Remove; Install from folder/files on model rows;
a **Make available offline** button with the total size; a footer line on storage use
(`navigator.storage.estimate`). Erase all removes every add-on (as now).

Agent-facing behavior:
- Quiet install: the job's tool card and `/task` note say "installing pdf.js (3.9 MiB, once,
  from Pouch's own origin)" before the result; the person sees it, the agent learns it.
- Asked install: the tool returns at once with `not installed: LFM3 1.7B (1.1 GB). Run
  \`addons install lfm3\`; the user will be asked.` and never auto-opens a sheet from a tool.
- Refusal strings name state + next step, one sentence each: "denied by the user: nothing was
  installed", "not available here: <reason>; nothing was fetched", "stopped; `addons install X`
  resumes". Exit codes as now (0, 1, 2).
- Offline and not installed: "not installed, and the network is not available".

Mapping existing pieces: `models.lock.json` and the runtime manifests are the two `files`
backends (gateway per-file pins; origin content-hash parts); `SHA256SUMS` stays the
deploy-level list and gains nothing; `src/assets.js` is unchanged; every install is a `/task`
entry with `kind: 'install'` (today `'download'`), stoppable by ctl, tray and Settings; jobs
(`src/jobs.js`) call `addons.ensure(id)` before starting a worker, which installs quietly or
fails with the asked-tier string. `deploy.mjs`'s catalog check stays.

## 5. Open questions for Adam

1. The noun. (a) **add-on** (b) component (c) extension. Recommend (a): plain, no prior
   trust story, and agents parse "add-on not installed" unambiguously.
2. The verb pair. (a) **Install/Remove**, renaming the PWA's "Install app" to "Add to this
   device" (b) Get/Remove, leaving "Install app" alone (c) Download/Remove as today. Recommend
   (a): `install` is the strongest agent prior and frees "Download" for files leaving Pouch.
3. The quiet tier's rule. (a) **at most 10 MiB, from Pouch's origin, no license beyond NOTICE**
   (b) size only (c) always ask. Recommend (a): the Transformers.js code (26 MiB) and DuckDB
   (36 MiB) then ask, honestly; pdf.js and libav.js stay quiet.
4. The `models` command. (a) **alias to `addons` for one release, then retire** (b) keep both
   permanently (c) rename now with no alias. Recommend (a): stored transcripts and the
   qualified Transformers.js recipe's habits mention `models get`.
5. Rename the jobs "engines" to "workers" now, in the same realignment? (a) **yes**, with the
   code renames in section 3 (b) docs only (c) not now. Recommend (a): "engine" is adopted for
   the Harness, and the collision will spread as DuckDB and OCR arrive.

## Decisions (Adam, 2026-11-01)

1. Noun: **add-on** (kinds: tool, model).
2. Verbs: **Install / Remove**; the browser's PWA "Install app" becomes "Add to this device"; "Download" means only exporting files out of /work.
3. Quiet tier: at most 10 MiB, from Pouch's own origin, no extra license; everything else asks first.
4. `models` command: **renamed to `addons` with no alias** (clean break; retire "models" as a command name in ul-node).
5. `jobs.js` engines: **renamed to workers in code and docs** in the same realignment.
6. Compatibility: Pouch is R&D with no users this week (Adam, 2026-11-01): no aliases, migrations or upgrade shims are needed for renames in this realignment; stored state from older builds may be discarded with a one-line notice.
