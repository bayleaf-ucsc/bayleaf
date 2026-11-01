# `open` and `cat` progress (terminal)
- [x] facts: `cat` is a just-bash builtin and works over the namespace; pipes keep raw bytes; long output already capped (2,000 lines / 200,000 chars, capOutput). Gap: binary output printed control bytes into the log. `open` did not exist (exit 127). The editor opens through main.js openFile(path, line, { link }); per-kind modes in preview.js rememberedMode/rememberMode (`pouch.view`), Interactive never remembered. One panel at a time (layout.js), so opening the editor replaces the terminal.
- [x] src/open-cli.js: parseArgs, planOpen (type -> mode table), openCommands (terminal: hooks.openFile, hooks.revealDir), agentOpenCommands (refusal), HELP
- [x] tools.js: shellFor registers open; bashFor registers the refusing open. terminal.js: passes openFile/revealDir hooks; binaryOutput note (display only)
- [x] main.js (narrow): openFile takes { mode, interactive }, returns false when unsaved changes are kept; terminal hooks openFile + revealDir
- [x] steer (Adam): `open <folder>` reveals it in Files (revealDir), not a usage error; flags on a folder are exit 2
- [x] decisions: defaults by type only, `open` does not read or write `pouch.view`; Interactive only with --interactive (plain open of an Interactive report returns to Static); agents refused (pane takeover, scripts without a person's choice; links already exist); Raw focuses the editor like a link click
- [x] test/open-node.mjs 8/8; test/open-browser.mjs 9/9 (rerun 9/9 after the concurrent context-meter edits landed; step 9 now waits for the refusal in main's request, since idle() could resolve before the turn started)
- [x] build (916b6d7+dirty, includes the other agent's uncommitted work); ul-node 0 retired terms
- [x] regressions: batchE-node 6, ns-node 10, controlplane-node 9, bayleaf-cli-node, taskscope-node, markdown-node pass; batchE-browser 10/10, batchF-browser 5/5, batchG-browser 8/8
- [x] docs: README Terminal (`cat` and `open` bullet, table, flags, agent refusal), Previews note; JOURNEYS TM8-TM11. LANGUAGE.md unchanged (no new term)
- gaps: `open` on /session or other overlay-only paths: the command stats through the terminal's view but openFile reads vfs.fs, so it fails with the read error (not tested). No `+line` argument. Phone layout not exercised for `open` (same panel switch as a link). Not built with --with-models, not deployed, not committed.

# `show` progress (agents; Adam's decision: the agent shows, the person opens; option (c) "for now")
- [x] src/open-cli.js: agentShowCommands (open's parseArgs/planOpen with the name `show`; never --interactive), SHOW_HELP; AGENT_REFUSAL points to show. tools.js: bashFor registers show with hooks.show(req, caller); system prompt line. defaults.js: pouch-environment tip (an unedited copy updates in place, an edited one is offered, vfs.seed)
- [x] main.js: show/showBusy (subagent, unsaved edits, a dialog open, a key/pointer/wheel touch within SHOW_QUIET_MS = 4000; send() resets the touch), shownLines/shownCard read back from the bash output (like egressOf), in main's log and the subagent thread
- [x] decisions: offered and opened both exit 0 (the person has it either way; a non-zero exit turns the tool card red and invites retries); the line says which. Open on a card uses show's mode
- [x] test/open-node.mjs 9/9; test/open-browser.mjs 16/16; batchE-node 6, ns-node 10, controlplane-node 9, batchG-browser 8/8, subagent-browser 10; build ok
- [x] docs: LANGUAGE.md Show; README Terminal (agents show) and HTML reports; JOURNEYS TM11 updated, TM12-TM14
- gaps: a subagent with a remapped namespace shows a path the card then opens in the page's vfs (the default view maps /work the same; a custom spawn ns may not). Subagents' own system prompt does not teach show. Phone layout not exercised. Busy does not consider a running terminal command or an open sheet that is not a <dialog>.
