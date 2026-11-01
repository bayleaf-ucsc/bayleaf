# BayLeaf Pouch: UX study of the non-agent journeys

Build tested: `dist/pouch.html`, SHA-256 `f16dd53d…c9d4`, served at `http://127.0.0.1:8742/pouch.html`.
Headless Playwright Chromium, fresh profile per persona under `/tmp/pouch-ux/ux/profile-*`. No sign-in, no model calls.
Scripts: `p1-lab.mjs`, `p2-phone.mjs`, `p345.mjs`; logs `p1.log`, `p2.log`, `p345.log`; screenshots in `shots/`.
Times are machine times (scripted), so they measure system latency, not human reading; click/tap counts are the meaningful cost.

## 1. Lab (desktop 1280x800, cold arrival)

| Step | Clicks | Result |
|---|---|---|
| Arrive | 0 | Badge verifies in ~5 s (`sealed: enclave verified`). **The chat pane is crushed into a ~20 px column** (`shots/lab-01-arrive.png`, `lab-02-after-verify.png`): the hint text, session picker and status wrap one word per line. No explanation of what Pouch is or where files live (A5 gap confirmed); the only hints are tags `this browser` / `shared` / `memory` on three bare roots. |
| Upload 3 files | 3 (… → Upload files here → picker) | Works (I1). No empty-state "Upload" affordance; you must guess that `...` on `work` holds it (`lab-03-work-menu.png`). |
| Drop a folder | n/a | Synthetic `DataTransfer` gives no `webkitGetAsEntry()` entries, so the code's fallback ran and **flattened** `assignment/src/lib/util.js` into `/work/util.js` (`lab-05-after-drop.png`). Real OS folder drags do supply entries, so I2 remains unverified rather than failed; but the fallback path silently drops folder structure and would silently overwrite same-named files. |
| Bring a `.zip` | 4 | Uploads as an opaque file; opening it says "looks binary" with only Download (`lab-06-zip.png`). I4 gap confirmed: no unpack, no hint that the agent's shell cannot unzip either. |
| Open, edit, save | 2 + Save | Works; `(unsaved)` marker is clear (`lab-08-dirty.png`). Opening a file fixes the layout because the editor column becomes real. |
| Find a file | n/a | No filter/search; fine at 7 files, not at a 200-file project. |
| Download a file | 2 | OK (O1). |
| Download folder `.tar` | 2 | OK; `tar tvf` lists all 7 entries with correct sizes (O2). No `.zip` option (O3 gap); a Windows lab machine can open `.tar` only via 7-Zip or `tar` in a terminal. |
| Erase all | 1 + confirm | OPFS empty, localStorage empty after reload (L1 ok). IndexedDB names `bayleaf-pouch`, `bayleaf-pouch-agent` **reappear** because boot recreates them and writes a fresh `cacheSecret` (`main.js:331`); an auditor checking "nothing remains" sees the databases and may doubt the claim (`lab-09-after-erase.png`). |

Total: 14 clicks, ~15 s machine time, plus the time a human loses to the crushed chat pane. No reminder to export before erasing (L3 gap).

## 2. Phone (390x844, touch)

| Step | Taps | Result |
|---|---|---|
| Arrive | 0 | Lands on **Chat**, not Files, though nothing can be sent off campus without a key. Header wraps to 110 px (title, badge, model, Sign in, Erase all) (`phone-01-arrive.png`). |
| Files tab → `...` → Upload → picker | 4 | Works. Sheet is a centered modal that fits (`phone-03-sheet.png`). |
| Tap row → editor | 1 | Opens and switches to Editor tab automatically (good). Editor 390x632. |
| Edit with on-screen keyboard | 1 | With a 500 px viewport (keyboard simulated by resize) the editor keeps 288 px and Save stays visible (`phone-06-keyboard.png`); header still eats 110 px of it. CodeMirror took focus from a tap and accepted typing. Real IME/selection-handle behaviour cannot be simulated headless. |
| Save | 1 | OK. |
| Download | 3 | OK. |
| Image | 1 | "looks binary" sheet, Download only; no preview though `img-src blob:` is allowed by the CSP. |
| Mention → back to editing | 2 after mention (4 total) | Mention inserts plain text `/work/notes.md ` into the composer; nothing in chat is tappable, so returning is Files tab + row tap. |

Total 16 taps for the whole journey. **Tap targets:** tree rows measured 32 px tall and `...` buttons 44x29 px despite the CSS's 44 px coarse-pointer rule: the `@media (pointer: coarse)` block (`pouch.html` line ~50) precedes the `.row` and `.row .more` rules, which redefine `min-height` at equal specificity and win. Session `...` is 35 px wide. Tag text 11.2 px, status/notice 12.8 px.

## 3. Auditor (desktop)

- **What BayLeaf can see:** the trust dialog (`audit-01-trust.png`) answers this well in one paragraph, then lists enclave host, repo, release digest, matching fingerprints in green, five verification steps, credential. Good (T1). It fits the 800 px viewport (686 px).
- **Page hash (T3):** absent. The dialog says "compare its SHA-256 with the published release" but shows neither the page's hash, nor the expected one, nor a link to the release, nor instructions. No `<a>` exists anywhere on the page. A page cannot reliably hash itself (it could lie), so the honest UI is instructions plus the release URL, not a computed value.
- **Network peer (T2):** only by devtools. Observed requests: the page itself, `GET api.bayleaf.dev/sealed/models`, `GET api.bayleaf.dev/sealed/attestation`. CSP in DOM matches the README (`connect-src https://api.bayleaf.dev`, one script hash). The dialog never states "this page can contact only api.bayleaf.dev", which is the second of the README's two audit checks.
- Unlabelled 96-hex fingerprints (SHA-384 measurements) beside a 64-hex "Release" digest: an auditor has to know which is which. Also missing: where stored data lives (T4), and how to verify Erase.

## 4. Accessibility

Tooling: axe-core 4.x injected into a CSP-stripped copy (`nocsp/pouch.html`, port 8743), keyboard walk, computed contrast, `ariaSnapshot` (`a11y-snapshot.yaml`).

- **axe:** 1 violation, `aria-input-field-name` (serious): CodeMirror's `.cm-content` textbox has no accessible name. Sheet-open state: 0 violations.
- **Tree is not keyboard operable.** 0 of 5 `treeitem` rows are focusable; only their `...` buttons are. Files can be opened via `...` → Open in editor, but **folders cannot be expanded by keyboard at all** (no Expand action in the folder sheet), so nested files are unreachable. `treeitem`s lack `aria-expanded`/`aria-level`/`aria-selected`, and their accessible names include the twisty glyph: "v work this browser", "> pouch shared".
- **Focus:** default focus ring visible on all buttons (Chromium `auto 1px`). Tab order: tree `...`s, chat, then wraps to header; the editor is skipped when no file is open (correct). After "Open in editor" from the sheet, **focus lands on `<body>`**, not the editor. Escape closes the sheet and returns focus to the invoking `...` (good, native `<dialog>`). In the editor, Tab indents (trap), Escape then Tab leaves: standard CodeMirror, but undiscoverable without a hint.
- **Contrast** (WCAG 2.x): muted text `#5b6b75` on white 5.52:1 (passes AA, also on `#f7f9fa`); badge green 6.39:1; warn 6.44:1; danger text 7.66:1. Non-text: `--line` borders 1.38:1 and danger border 1.76:1 fail 1.4.11 (3:1) for input/button boundaries; text inside still identifies the buttons, so this is minor except for the composer textarea, whose only boundary is that border.
- Live region: `#log` is `aria-live=polite` but `#status` (where "Added to /work", errors and the Campus Pass notice appear) is not; most errors use `alert()`.

## 5. Edge cases

| Case | Result |
|---|---|
| 108-char file name | Ellipsized in tree with `title` tooltip (fine on desktop, no tooltip on touch). **Breaks folder export:** `Download as .tar` on `/work` fails with `alert: Path too long for tar: …` because a single component over 100 bytes cannot use the ustar prefix split. One long name blocks taking out the whole folder. |
| 10-deep folders | Indentation reaches ~180 px at depth 11; on 390 px still legible (`edge-03-deep-narrow.png`). Creating `a/b/c/…/j` in one "New folder" prompt works (nice, undocumented). |
| 5 MB text file | Upload ~0.9 s, open ~0.7 s, typing responsive (~0.13 s for a keystroke round-trip). OK. |
| PNG | "looks binary" → Download only; no preview. |
| Unicode name `日本語 ノート é.md` | Uploads, opens, renders content correctly. |
| Same name uploaded twice | **Silent overwrite**, no dialog, no status. `hw1.py` became the second version. |
| Rename onto existing name | **Silent overwrite**: renaming `日本語 ノート é.md` to `hw1.py` destroyed the old `hw1.py` (implemented as copy+delete in `vfs.js` `mv`). |
| Delete the open file | Dirty buffer: path shows `(deleted) (unsaved)`, Save re-creates it (`edge-04-deleted-open.png`): clear and deliberate. Clean buffer: editor closes. Good (R4-adjacent). |

## Findings

| id | story | sev | evidence | proposed change |
|---|---|---|---|---|
| F1 | A1, A5 | **blocker** | `lab-01/02`, `lab-06`, `audit-01`: with no file open on desktop, chat is squeezed into the zero-width middle track because `#editor-pane{display:none}` removes it from grid auto-placement | In `pouch.html`, give panes explicit columns: `#files{grid-column:1} #editor-pane{grid-column:2} #chat{grid-column:3}`, or set `main.no-editor{grid-template-columns:minmax(13rem,18rem) minmax(0,1fr)}`. Add a Playwright layout assertion: `#chat` width > 300 px at 1280. |
| F2 | I1, I2 | major | duplicate-upload test | Before writing an existing path, open the sheet: title "hw1.py already exists in /work", actions "Replace", "Keep both (hw1 (2).py)", "Skip". For multi-file drops, add "Apply to all". |
| F3 | R1, L1 | major | rename test | `rename()` checks `exists(dest)` and refuses: `alert('A file named hw1.py is already here. Pick another name.')`, or reuses F2's sheet. Same guard for "New file here" (already guarded) and New folder. |
| F4 | O2 | major | `alert: Path too long for tar` | Emit a PAX extended header (`typeflag 'x'`, `path=` record) or GNU `././@LongLink` for any path that won't fit ustar; both are read by bsdtar, GNU tar and 7-Zip. Never let one name block an export. |
| F5 | A1 (a11y), R1 | major | 0 focusable treeitems; folders cannot be expanded by keyboard | Roving `tabindex` treeitems with Up/Down move, Right/Left expand/collapse, Enter opens, Shift+F10 or `...` opens actions; `aria-expanded`, `aria-level`; twisty `aria-hidden="true"`. Minimum fix: add "Expand"/"Collapse" to folder sheets. |
| F6 | R6, I1 (phone) | major | rows 32 px, `...` 44x29 px measured | Move the `@media (pointer: coarse)` block after the tree rules (or raise its specificity). Add a test that asserts row height ≥ 44 px with `hasTouch`. |
| F7 | A5, T4 | major | first screen shows three bare roots | One-time dismissable card at the top of the tree (and on the phone Files tab, which should be the landing tab when not signed in): "Your files live in this browser only. **work**: kept until you erase. **pouch**: instructions the agent reads. **tmp**: gone on reload. Nothing is uploaded; only questions to the AI leave, encrypted." with buttons "Upload files" and "Got it". |
| F8 | T3 | major | no hash or release link anywhere | Add to the trust dialog a "Check this page" section: expected release tag + SHA-256 baked in at build, a link to the release, and a 2-line recipe (`shasum -a 256 pouch.html`); state that a served page cannot vouch for itself. |
| F9 | T2 | minor | peer visible only via devtools | Add a fact row "Network: this page can contact only api.bayleaf.dev (enforced by its Content-Security-Policy)" and label fingerprint rows with their algorithm. |
| F10 | I4 | major (Lab) | `lab-06-zip.png` | Binary sheet for `.zip`/`.tar`: add "Unpack into /work/assignment/". A tar reader is ~40 lines; zip needs inflate (`DecompressionStream('deflate-raw')` is built in, so no dependency). |
| F11 | O3 | major (Lab, Phone) | `.tar` only | "Download as .zip" with stored (uncompressed) entries: no dependency, opens natively on Windows, macOS, iOS, Android. Keep `.tar` as a secondary action. |
| F12 | L1, L3 | minor | DBs reappear after Erase | After erase-reload, show a status line "Erased. This browser now holds only an empty Pouch." and defer creating `cacheSecret` until the first send, so a fresh-after-erase origin has no settings written. Add L3: Erase confirm offers "Download /work as .zip first". |
| F13 | R1 (a11y) | minor | axe `aria-input-field-name` | `EditorView.contentAttributes.of({'aria-label': 'Editor: ' + path})`, updated on load; move focus to the editor after Open in editor. |
| F14 | R1 | minor | `phone-07-image.png` | Preview images (PNG/JPEG/GIF/WebP) via `blob:` URL in the editor pane, with Download. SVG as text is already handled. |
| F15 | I6, R6 | minor | mention is plain text; 2 extra taps back | Render `/work/...` paths in user/assistant messages as buttons that open the file (still `textContent`, built with `el()` after splitting on a path regex, so no HTML injection). |
| F16 | A1 (phone) | minor | header 110 px | On narrow screens collapse model select, Sign in and Erase all into one `...` header sheet; keep badge. Reclaims ~55 px for the editor when the keyboard is up. |
| F17 | L1 | nit | Erase all sits beside Sign in, red | Keep, but on touch place it inside the header sheet (F16) to avoid a mis-tap leading straight into the confirm. |
| F18 | a11y | nit | 1.38:1 borders | Darken `--line` for inputs/buttons to ≥ 3:1 (e.g. `#8a99a3`), keep the light line for dividers. |
| F19 | A1 | nit | status not live | `#status` `role="status"`; replace `alert()` for routine errors with status messages. |

## Top 5 recommendations (value / cost)

1. **Fix the desktop grid (F1).** One CSS line; it is the first thing every desktop visitor sees.
2. **Never overwrite silently (F2, F3).** One `exists()` check in `writeUpload` and `rename`, routed through the existing `sheet()`; prevents unrecoverable loss in the exact Lab scenario (re-uploading a revised file).
3. **Make export robust and Windows/phone-friendly (F4, F11).** PAX long names plus a stored-zip writer, both small, both dependency-free, the same walk as `downloadDir`.
4. **Touch and keyboard operability of the tree (F6, F5).** Reorder CSS (trivial) now; roving-tabindex tree next (moderate), with "Expand" in folder sheets as an interim.
5. **First-visit and trust copy (F7, F8, F9).** One dismissable card and three rows in the trust dialog close A5, T3 and most of T4 without new machinery.
