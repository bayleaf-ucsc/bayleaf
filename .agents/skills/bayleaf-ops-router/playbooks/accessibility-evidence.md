---
source-skill: bayleaf-ops-router
description: Capture, inspect, retain, and document bounded accessibility evidence for BayLeaf web interfaces.
status: First Chat keyboard-flow run completed; screen-reader procedure remains untested
last-reviewed: 2026-09-15
---

# Accessibility Evidence

## When to Use

Use for a BayLeaf VPAT/ACR evidence pass, keyboard-flow recording, focus-order
measurement, or material change to `chat/vpat-recordings/`. Read the target
service's `AGENTS.md`, the applicable ACR under `politics/`, and the harness
README first. This playbook currently has exercised coverage for Chat keyboard
flows only. Do not generalize it into a screen-reader or full-conformance method.

## Evidence Contract

1. Define the bounded claim before capture: viewport, identity, start state,
   interaction sequence, expected end state, and explicitly untested surfaces.
2. Drive real keyboard events. Programmatic `.focus()` or DOM invocation may
   prepare the test but does not establish keyboard operability.
3. Record focus order, accessible names, and computed focus styles in a
   content-bounded manifest. Treat viewport and responsive state as evidence:
   collapsed navigation can materially change the available path.
4. Separate the usability action from verification. For destructive Chat flows,
   delete through the UI, independently verify absence through the API, and use
   exact-ID API deletion only as recovery after failure.
5. A successful bounded flow does not establish criterion-wide conformance.
   Preserve `Not Evaluated` where untested functionality could change the result.

## Privacy and Identity

1. Use the dedicated non-admin synthetic identity and require a known-empty
   account before starting. Never use a personal account or administrator token.
2. Keep bootstrap credentials outside the repository in a mode-0600 file. Pass
   its path through `BAYLEAF_PROBE_BOOTSTRAP`; do not print credential values.
3. Use fixed synthetic markers and bounded prompts. Verify cleanup by exact ID
   and marker rather than broad deletion.
4. Cloudflare Browser Run recordings are rrweb full-DOM archives, not videos.
   Cloudflare retains its copy for 30 days. Hold the downloaded archive only in
   memory, render it, and retain no local `.rrweb.json` file.
5. Retain only a reviewed MP4 and content-bounded JSON manifest. Track MP4 files
   with Git LFS. Search both artifacts and diffs for credentials, personal data,
   unexpected identifiers, and stale raw-recording references before commit.

## Capture Procedure

1. Confirm required tools: Node/npm, `wrangler`, Chromium dependencies, `ffmpeg`,
   and `ffprobe`. Run `npm ci` in `chat/vpat-recordings/` when dependencies are
   absent or the lockfile changed.
2. Check that the intended MP4 and manifest paths do not already exist. The
   harness refuses replacement so evidence cannot be silently rewritten.
3. Run from `chat/vpat-recordings/`:

   ```sh
   BAYLEAF_PROBE_BOOTSTRAP=/absolute/path/to/bootstrap.secrets.json npm run record
   ```

4. Let the harness enforce the empty-account precondition, obtain a short-lived
   Cloudflare OAuth token through `wrangler auth token`, perform the keyboard
   flow, close the remote browser, verify deletion, render the recording, and
   remove its temporary replay directory.
5. On failure, require the final cleanup result to confirm exact-chat deletion.
   Check the synthetic account is empty before retrying. Record failed shortcut
   or focus-path assumptions rather than allowing the final green run to erase
   them.

## Inspection and Validation

1. Inspect the MP4, not merely the renderer's exit status. Check representative
   frames around every state transition and the final frame. Confirm there are
   no blank/frozen spans, credentials, personal data, or unintended chat content.
2. Read the manifest against the video. Confirm completed answers, keyboard
   reachability flags, focus trails/counts, computed focus style, exact UI
   deletion, API absence, and `cleanup: "confirmed_ui"`.
3. Validate the retained video:

   ```sh
   ffprobe -v error -select_streams v:0 \
     -show_entries stream=codec_name,width,height,r_frame_rate \
     -show_entries format=duration,size -of json \
     ../../politics/vpat-chat-videos/<artifact>.mp4
   ```

4. Run `npm run check`, `npm audit --audit-level=high`, `git diff --check`, and
   `git check-attr filter diff merge text -- <artifact>.mp4`. The video should be
   H.264 at the harness viewport and report `filter: lfs`.
5. Update the ACR's methodology, criterion row, and evidence links narrowly.
   State what the recording does not test, including CILogon and screen-reader
   behavior when applicable.
6. **[HUMAN GATE]** A real screen-reader claim requires a separate run by a
   competent VoiceOver/NVDA user. Do not infer assistive-technology behavior from
   a headless DOM replay.

## Known Failure Modes

- Cloudflare keyboard input does not accept chord strings such as `Shift+Tab`;
  send explicit Shift down, Tab, then Shift up events.
- An Open WebUI shortcut can be documented yet fail in the deployed build. Test
  its observed effect and fall back to ordinary keyboard traversal.
- A collapsed sidebar can make its chat menu unreachable. Use the visible
  responsive navigation path and preserve that layout fact in the evidence.
- Replay can technically complete while producing blank or stale video. Visual
  frame inspection is mandatory.
- Two output files create a partial-write risk. Render and verify the MP4 before
  writing the manifest; remove incomplete artifacts after failure.
- Conversational turns dominate runtime. Bound prompt and answer length before
  reducing interaction coverage.

## Cleanup

Confirm the remote browser session is closed, the synthetic account is empty,
and no local `bayleaf-vpat-*` temporary directory or rrweb archive remains. Do
not attempt destructive provider-side cleanup that the recording API does not
offer. Document Cloudflare's unavoidable 30-day retention boundary.

## Recording

Commit the harness, lockfile, reviewed MP4/manifest, ACR edits, and this playbook
as one coherent `add:` or `update:` commit. Never commit credentials, bootstrap
files, raw rrweb archives, browser profiles, or unreviewed failed-run artifacts.
Do not push without explicit approval.

## Refinement Log

- 2026-09-15: First production Chat run exercised a two-turn Basic conversation
  and keyboard-driven deletion. Reverse traversal did not shorten the composer
  path (12 `Shift+Tab` presses), but bounded answers kept the 34.64-second video
  compact. The deployed delete shortcut failed, the collapsed sidebar hid its
  menu, and the visible navbar Chat actions path succeeded. API verification and
  cleanup remained independent from the UI claim. Raw rrweb retention was
  rejected after inspection because the archive captures the full rendered DOM.
