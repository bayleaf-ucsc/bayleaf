# Pouch AX report (2026-10-28)

Harness: `test/ax-cli.mjs` (same `systemPrompt` and `createTools` as the page, browser command set). Prompt: 3,065 bytes with two seeded skills. Fixtures: copy of `landing/` mounted read-only at `/mnt/site`; a 4-file todo app at `/work/todo`; a 61-row messy `grades.csv`; `notes.zip` and `notes.tar.gz` in `/work`. Call log: `calls.tsv`.

## (a) Narrative

The prompt is short and honest, and I knew where I was within one call. The four tools are the familiar ones, so read/edit/bash felt natural, and `tree` plus `wc -l` gave me a good overview in two calls. The mounted tree was also easy: `rg` and `rg -o '.{0,120}ZDR.{0,120}'` answered the question in three calls. The edit tool's errors are good. "matches 2 times ... add surrounding lines" told me exactly what to do, and the stale-text error is fine.

Things went wrong at the edges. I wrote to the read-only mount and got `EROFS: read-only file system, write '/NOTES.md'`, a path that doesn't exist from my point of view, with no next step. A shell redirect into the mount killed the whole script: `echo before` output was lost and `|| echo caught` never ran. Every not-found error gives paths relative to the mount (`'/todo/missing.js'`, `'/~/todo/app.js'`), and a small model would copy those back verbatim. The data task cost the most. I learned only by failing that `awk -f` doesn't exist, and that this awk silently mishandles `s = s (cond ? a : b) t` (it drops `s`) and `print > "/dev/stderr"` (output vanishes). The skill says gzip is unavailable, but `gzip`, `gunzip`, `zcat`, `file`, `column`, `join` and `html-to-markdown` all exist. There is no `zip`, `unzip` or `tar`, and nothing told me the user can download a folder as .tar from the file browser. So for "zip it" I could only say "I can't". I never learned about the UI path that would actually help them.

## (b) Findings

| id | story | sev | evidence | proposed change |
|---|---|---|---|---|
| F1 | D5, D6 | major | `read todo/missing.js` -> `ENOENT: no such file or directory, open '/todo/missing.js'`; `read ~/todo/app.js` -> `open '/~/todo/app.js'`; write on mount -> `write '/NOTES.md'` | Wrap read/write/edit in a `try` that rethrows with the absolute path the agent used: `No such file: /work/todo/missing.js. List the folder with bash \`ls /work/todo\`.` Map the error codes ENOENT/EISDIR/EROFS to plain-language messages that say what to do next. |
| F2 | D5, I3 | major | `echo before; echo hi > /mnt/site/x.txt \|\| echo caught; echo after` -> only `ERROR: EROFS ... '/x.txt'` (no "before", no "caught") | In just-bash, a failing redirect should set `$?=1` with `bash: /mnt/site/x.txt: Read-only file system` on stderr, and keep earlier stdout. Until that's fixed, catch it in `bashTool` and append: `[/mnt/site is read-only; write under /work instead, or ask the user to remount read-write]`. |
| F3 | D5, I3 | major | `write /mnt/site/NOTES.md` -> `EROFS: read-only file system, write '/NOTES.md'` | Before writing, check whether the path falls under a read-only mount and throw `"/mnt/site is mounted read-only. Write to /work/<name> instead (e.g. cp -r /mnt/site /work/site), or ask the user to mount it read-write."` |
| F4 | D5 | major | `awk 'BEGIN{o="";n=split("pat shaw",w,/ +/);for(i=1;i<=n;i++) o = o (i>1?" ":"") w[i]; print o}'` -> `[shaw]` (real awk: `[pat shaw]`) | This is a silent wrong-answer bug in just-bash awk (concatenation followed by a parenthesized expression is probably parsed as a call). Report it upstream. Meanwhile, add a "Known awk differences" line to `pouch-environment`. |
| F5 | D5 | minor | `awk -f clean.awk` -> `awk: invalid option -- 'f'`; `print ... > "/dev/stderr"` produced no output | Add to `pouch-environment`: "awk has no -f: run `awk \"$(cat prog.awk)\" file`. Inside awk, write diagnostics to a file, not /dev/stderr." |
| F6 | D5, D6 | minor | skill: "Not available: ... tar, gzip"; actual `ls /bin` includes `gzip gunzip zcat file column join html-to-markdown du stat`. `which zip` prints nothing (exit 1) | Generate the skill's "Available" list from `getCommandNames()` minus the browser denylist at seed time, or add the line "Run `ls /bin` for the exact command list." Fix the gzip claim. |
| F7 | O2, O3, I4 | major | `zip -r todo.zip todo` -> `bash: zip: command not found`; `unzip` same; `tar` blocked; no prompt text about the file browser | Add to the system prompt: "You cannot create or unpack .zip/.tar. The user can download any folder as .tar from the file browser (folder menu -> Download); tell them that." Once I4/O3 land, add `zip`/`unzip` commands (a pure-JS fflate wrapper registered as just-bash custom commands) and update this line. |
| F8 | D5 | minor | `python3 -c 1` -> `python3: command not available in browser environments. Exclude 'python3' from your commands or use the Node.js bundle.` | That message is written for the library's developer. Override it with a custom command stub: `python3 is not available in Pouch. Use awk/sed/jq, or write an .html file with JavaScript the user can open.` |
| F9 | D5 | minor | `read /work/todo/app.js offset=99` on a 52-line file -> `(empty file)` | Return `[offset 99 is past the end; file has 52 lines]`, and use `(empty file)` only when the file has length 0. |
| F10 | D5 | minor | `read notes.zip` -> `PK ... ���` mojibake | Detect NUL bytes or a high share of replacement characters and return `[binary file, 484 bytes; use \`file\` or \`od -c \| head\` to inspect]`. |
| F11 | D5 | minor | `read todo` -> `EISDIR: illegal operation on a directory, read '/todo'` | `"/work/todo is a folder. List it with bash: ls /work/todo"`. |
| F12 | D1, R3 | minor | edit success: `Replaced 1 occurrence in /work/todo/app.js` | Return the line range and 2 lines of context, e.g. `Replaced lines 30-38 in /work/todo/app.js`. That supports R2/R3 and lets small models check the edit without a re-read. Optionally warn when `oldText === newText` (it currently reports success). |
| F13 | D1 | minor | No way to check JS: no node, no `js-exec`; my app.js change can't be run | Prompt line: "You cannot run JavaScript; re-read changed code carefully, and tell the user how to test it (open index.html)." Longer term: a syntax-only check via `new Function` / acorn as a `jscheck` command. |
| F14 | D1 | nit | `read` output has no line numbers; I used `cat -n` in bash instead | Fine for edit's exact matching. Mention `cat -n` / `sed -n 'a,bp'` in `pouch-environment` for orientation. |
| F15 | D6 | nit | Prompt lists mounts but not workspace contents; orientation took 2 calls / 722 B | Optional: append to the prompt a one-line summary of `/work` (top-level entries, about 200 B). That saves the first call for every small model. |
| F16 | D4 | nit | Frontmatter parser is a line regex; `description: >` multiline YAML would become the literal ">" | Note in `skill-authoring`: "Keep name and description on one line each." |
| F17 | – | nit (harness) | `/tmp/notes.tar` written in one call is gone the next (ax-cli rebuilds InMemoryFs per process); the page keeps /tmp until reload | Persist /tmp to `state/tmp` in ax-cli, or document the difference in the harness header. |
| F18 | D5 | nit | `read {"file_path":...}` -> `Cannot read properties of undefined (reading 'startsWith')` | Probably caught by schema validation in the page; if not, check `typeof path !== 'string'` and say `read needs "path"`. |

## (c) Call/byte log

| task | calls | bytes out | notes |
|---|---|---|---|
| 1 orientation | 2 | 722 | `tree` + `wc -l`/`head`; good enough for a useful answer |
| 2 mounted tree + RO write | 10 | 2,504 | answered in 3; 7 were write-failure probes |
| 3 clear-completed (4 files) | 9 | 3,947 | 1 read-all via `cat -n` (biggest output), 6 edits incl. 1 ambiguous + 1 stale (both recovered in 1 call), 1 verify |
| 4 CSV with shell only | 15 | 2,923 | 4 discovery, 2 profile, 9 on awk failures (-f, stderr, ternary bug, plus my own missing braces) |
| 5 packaging | 3 | 378 | inspection is possible with gunzip/file/od; zip/unzip/tar are not |
| 6 skill authoring | 2 | 728 | read the skill, wrote the new one; `prompt` lists it immediately |
| 7 small-model probes | 10 | 508 | edge-case errors (F1, F9–F11, F18) |

Result: `grades.clean.csv` has 54 rows (61 in, 7 duplicates including 1 case variant, 4 missing emails, 0 missing scores, every date ISO-formatted). That matches a ground truth computed with real awk.

## (d) Top 5 recommendations (value/cost)

1. **Rewrite fs errors with absolute paths and a next step** (F1, F3, F11; also F9, F10). It's one wrapper in `tools.js` and it fixes the most likely small-model loop.
2. **Make `pouch-environment` true and complete** (F5, F6, F4): generate the command list or point to `ls /bin`, fix the gzip claim, and add the three awk pitfalls. It's text only.
3. **Tell the agent about the UI's export path, and give it honest limits on archives** (F7, F13): one prompt sentence each. This turns "I can't" into a useful handoff for O2.
4. **Handle redirect failures in bash** (F2): report the just-bash bug, and add a read-only hint in `bashTool` meanwhile.
5. **Make edit results more useful** (F12): line range plus context. It's cheap, and it's the hook for R2/R3 change tracking.
