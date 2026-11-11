# Windows desktop onboarding qualification: issue #69

Scoped end-to-end smoke test PASSED on 2026-11-11: installation, canonical
login with human browser approval, BayLeaf GUI inference with file tools,
app-relaunch persistence and local logout. This evidence supports the common
operations playbook, not general Windows compatibility. No credentials,
personal login inputs or approval tokens are recorded here.

## Environment and current scope

- Daytona `windows-medium`, US: 2 vCPU, 8 GiB RAM, 50 GiB disk.
- Snapshot reference `windows-server-2025-cu-r2`, Windows Server 2025 Datacenter,
  64-bit, version 10.0.26100. This is not Windows 11 qualification.
- PowerShell 5.1.26100.1591; system curl 8.8.0; Daytona daemon v0.222.0.
- Official stable OpenChamber 2.7.0 Windows x64 installer, SHA-256
  `3895c31faeccc29d8ce21a60f8d98327e2a170a8f9ffa9c7af4184da270dd1dd`.
  Downloaded bytes matched GitHub's published digest. Authenticode: NotSigned.
- Bundled OpenCode reports 2.2.6. First-launch setup briefly requested a separate
  OpenCode installation, then automatically resolved the bundled binary without
  installing anything else. Do not treat the transient screen as a final failure.
- Live Windows discovery aliases returned 404, despite historical deployment
  evidence in `api/TESTING.md`. Canonical discovery returned 200.

## Repeatable route exercised

1. Create a uniquely owned private `windows-medium` in `us`, with
   `autoStopInterval: 30`, `autoPauseInterval: 0`, `autoDeleteInterval: -1`,
   `ttlMinutes: 120`. Verify returned settings and `autoDestroyAt`; retain the
   exact ID for explicit deletion. This preserves disk on idle stop.
2. Download `https://downloads.openchamber.dev/desktop/stable/OpenChamber-2.7.0-win-x64.exe`
   to `C:\Windows\Temp\OpenChamber-2.7.0-win-x64.exe`. Verify the digest above.
   In the guest desktop press Win+R, wait for focus, enter that full path and
   press Enter. Do not launch the GUI installer through SYSTEM Toolbox exec.
3. Let bundled OpenCode detection finish. Open the right-side Terminal and run
   `opencode auth login https://api.bayleaf.dev`. Give the public approval URL
   to the human immediately: it expires after ten minutes. Approval needs their
   browser session and CSRF form, not an ordinary API key.
4. Wait for `Connected to api.bayleaf.dev` and `Done`. Close and reopen
   `C:\Users\Administrator\AppData\Local\Programs\@openchamberelectron\OpenChamber.exe`.
   Verify the selected model's tooltip says BayLeaf before sending any prompt.
5. Add the dedicated smoke-test folder using the sidebar Add project button.
   Run the bounded file task below, verify the actual output, export evidence,
   test relaunch, locally log out, then delete only the owned VM and verify both
   detail 404 and absence from inventory. Never revoke the shared account token.

## Lifecycle lesson: human handoff is part of the workload

The first allocation used a 15-minute idle stop and `autoDeleteInterval: 0`.
Zero means **delete immediately on stop**, not disabled. It disappeared during
the human approval handoff. At 22:41:05 UTC its exact ID returned 404 and it was
absent from the complete sandbox inventory. Cause is consistent with idle
stop/delete but was not independently audited. Its original claim expired.

Replacement creation accepted `autoStopInterval: 30`, `autoPauseInterval: 0`,
`autoDeleteInterval: -1` and `ttlMinutes: 120`. Negative auto-delete disables
delete-on-stop, preserving disk for a bounded handoff. The actual creation
response confirmed these settings and `autoDestroyAt: 2026-11-12T00:41:31.829Z`.
Explicit owned-resource deletion and verification are still required. Do not
keep compute awake indefinitely or assume a requested TTL is confirmed until
the returned destroy timestamp is checked.

Toolbox execution runs as SYSTEM/session 0, not the interactive Administrator.
Launching the installer there produced a systemprofile shortcut error. Launch
through the remote desktop instead. Also wait for the Run dialog to receive
focus before typing: immediate hotkey-plus-type can lose the path prefix.

## Local artifact roots and failure evidence

Temporary only, outside the repository; no video. First run root:
`/private/var/folders/qj/gyqbn5y57956rrqd_g6yfqwr0000gn/T/opencode/bayleaf-69-win-20261111-e4fc76ac/`

Its `computer/sessions/bayleaf-69-win-20261111-e4fc76ac/` includes
`0003-installer-visible.png` (about 22:17 UTC, SYSTEM shortcut failure),
`0005-first-ready-desktop.png` (about 22:18, transient setup) and
`0008-login-command-result.png` (about 22:19, expired public claim).
`0006-bundled-detection-failure-custom-path.png` is misleadingly named: it
actually shows the ready app; no custom binary path was set.

Replacement run root:
`/private/var/folders/qj/gyqbn5y57956rrqd_g6yfqwr0000gn/T/opencode/bayleaf-69-win-20261111-051b82dd/`

- `computer/sessions/bayleaf-69-win-20261111-051b82dd/0001-installer.png`:
  approximately 22:42 UTC, Run-dialog lost-prefix failure. Retained as harness
  evidence, not a failure of OpenChamber's installer.

## Completed replacement run: observed result

The human approved the replacement public claim in their own browser. At
22:45:51 UTC the guest integrated-terminal CLI showed `Connected to
api.bayleaf.dev`, `Done`, and returned to its prompt. No API key was displayed.
This verifies terminal credential handoff, not guest-browser CILogon login.

Closing and reopening selected `DeepSeek: DeepSeek V4.1 Flash 1017`; its tooltip
identified `BayLeaf`. This establishes remote configuration without reading the
authentication store. No default-provider prompt was sent. Historical GLM guide
examples are not the model observed in this run.

Added `C:\Users\Administrator\Desktop\bayleaf-smoke` using the GUI project
picker. The synthetic input was `input.txt` containing `2,3,5`. One GUI prompt
requested reading it, writing the decimal sum to `result.txt`, and stopping,
with at most three tool calls and no network/subagent work. The visible session
used exactly two tools, Read File and Write File, then answered that the sum
was 10. Independent Toolbox file inspection and downloaded-artifact comparison
verified that `result.txt` contains exactly `10`, without a newline:

`sha256:4a44dc15364204a80fe80e9039455cc1608281820fe2b24f1e5233ade6af1dd5`

The GUI reported about 10.1K used tokens and **$0.0011**. This is the client's
reported cost, not an independently reconciled provider invoice or enforced
per-session dollar ceiling. It is well below the authorized $0.25 test budget.
No extended loop or second inference task was run.

After a second real close/relaunch, the project, conversation, two tool rows,
answer and selected model remained visible. Process IDs/start times changed,
supporting actual app restart rather than merely hiding/showing its window.
No second post-restart inference was run. Sleep/resume and OS-reboot persistence
remain unverified, as do Windows 11, ARM64, Sealed, other tool categories and
Windows accessibility semantics.

Local `opencode auth logout https://api.bayleaf.dev` prompted for the account;
confirming it showed `Removed account from api.bayleaf.dev` and `Done`.
No shared ordinary BayLeaf account token was revoked.

### Completed-run screenshot landmarks

All below are relative to the replacement root's
`computer/sessions/bayleaf-69-win-20261111-051b82dd/` directory:

- `0005-approved-login-result.png`: 2026-11-11T22:45:51.464473Z, terminal handoff.
- `0008-connected-provider-model-tooltip.png`: 22:46:49.766969Z, BayLeaf provider
  and actual DeepSeek model after app relaunch.
- `0015-synthetic-task-progress.png`: 22:48:08.981483Z, despite the checkpoint
  name, this shows the completed two-tool task and correct answer.
- `0016-verified-synthetic-task-usage.png`: 22:48:27.851150Z, completed task and
  usage tooltip with $0.0011 reported cost.
- `0017-post-task-relaunch-persistence.png`: 22:48:56.999679Z, restored session.
- `0019-local-logout-completed.png`: 22:49:33.091794Z, local account removal.

The unnecessary `0018-local-logout-result.png` was removed because its account
picker displayed a local credential record ID (not a secret token). The clean
completed-logout checkpoint is retained. `screenshot-manifest.json` records
exact timestamps, hashes and retained status. `result.txt` and
`synthetic-task-verification.json` are exported beside it. Installer animation
was not successfully captured on the clean second run; the blank-loading frame
is not evidence of a finished installer screen.

### Cleanup

Owned replacement deletion returned HTTP 200 at approximately 22:49:56 UTC;
its exact detail endpoint then returned 404. Immediate list inventory was still
stale and contained the ID, requiring a separate convergence check. Final
verification at **22:50:29.729642 UTC** confirmed both detail **404** and absence
from the complete sandbox inventory. The temporary `deletion-verification.json`
records this final check. Both Windows allocations are now confirmed absent.

The replacement lived about eight minutes, approximately $0.06 at the conservative
$0.407/hour estimate. Combined Windows allocations were comfortably below the
assigned $2 share, but provider billing was not independently reconciled.
