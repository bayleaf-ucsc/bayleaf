---
source-skill: bayleaf-ops-router
description: Reproduce reported OpenChamber desktop onboarding failures in disposable platform environments.
status: partly tested; assembled playbook has no independent clean-room replay
last-reviewed: 2026-11-17
---

# Desktop onboarding incident response

Use after an onboarding error report or for an explicitly requested release
qualification. This is **incident response, not scheduled monitoring**, a video
production workflow, or a promise of upstream stability. Related work: [#69](https://github.com/bayleaf-ucsc/bayleaf/issues/69).

Read `api/AGENTS.md` and `GETTING-STARTED.md`. Load `daytona-api` for hosted
guests or `cua-router` for local macOS if available. The repo-relative platform
records below stand on their own; Darknut's global skills are not required.
This assembled playbook has not yet had an independent clean-room replay.

## Pick the coverage before provisioning

| Level | When | What counts |
|---|---|---|
| API regression | Routine claim or discovery changes | `cd api && npm run test:claim-curl`. No credentials or rented desktop. Not live login or inference. |
| Desktop smoke | Installer, bundled OpenCode or BayLeaf setup changes | Install the official app, complete the claim, relaunch and independently verify one synthetic file task. Record steps exercised via guest shell or CLI. |
| User-path qualification | Release gate or reported GUI failure | Drive the actual installer and OpenChamber UI in a disposable guest. Observe, act and verify the visible result on the same desktop. Use shell for staging and independent checks, not in place of the UI steps being qualified. |

## Dispatch brief

Give each platform agent the incident symptoms, target app/version, evidence
directory, budget, deadline, ownership label, and approval coordinator. Assign
only one controller per desktop. Delegate only when authorized. Do not paste
this whole playbook into every agent: give common constraints and its platform
record, with the other records available on demand.

> Install the official OpenChamber desktop inside an owned disposable guest.
> Verify its artifact provenance and actual bundled OpenCode version. Use the
> integrated terminal for the documented BayLeaf login. Coordinate normal claim
> approval through the operator's trusted browser. Verify BayLeaf in the GUI,
> perform one bounded synthetic file task, independently verify the file, and
> check persistence after real app relaunch. Capture private landmark screenshots.
> Export evidence, log out locally, delete only this run's guest, and verify
> deletion. Report failed, blocked and untested checkpoints separately.

## 1. Scope and authority before allocation

- Record reported OS/build/architecture, app and bundled CLI versions, installation
  source, failing step and sanitized exact error. Do not request credentials,
  entire auth stores, or unrelated user conversations.
- Reproduce the reported platform/version first where available. Then use other
  platforms or a current release to bound impact. An unaffected platform does
  not prove the reported environment works.
- **[HUMAN GATE]** Establish paid-compute and inference budget, maximum lifetime,
  temporary credential custody, and cleanup ownership. Approval of this document
  is not standing permission to provision resources or approve arbitrary claims.
- The operator's computer is the **controller only**, regardless of OS. Never
  install the test app on the host, reuse its configuration, dispatch guest input
  through its keyboard or clipboard, or change its permissions or networking.
  For handoff, arrange the new operator's own provider access, a named trusted
  BayLeaf claim approver, and project-approved compute spending. Do not depend
  on Darknut, a personal billing balance or someone else's browser session.
- Arrange trusted-browser sign-in before starting ten-minute claims. If no valid
  session exists, ask the operator to sign in on their trusted machine, not the guest.

## 2. Disposable platform routes

Read only the selected detailed record, including its limitations:

- **Windows:** `api/qualification/desktop-onboarding/windows.md`. Daytona
  `windows-medium` is Windows Server 2025 x64, not Windows 11. Download and
  hash-check the official installer; inspect Authenticode separately. Launch
  through the interactive desktop, not Toolbox's SYSTEM/session-0 shell. Wait
  for Run-dialog focus before typing. Let a transient
  install-OpenCode screen resolve to the bundled binary before intervening.
- **Linux:** `api/qualification/desktop-onboarding/linux.md`. Daytona
  `daytona-large` is a Debian container desktop sharing a host kernel, not a VM
  or clean ordinary workstation. Verify/install the official amd64 DEB. If
  the Electron sandbox helper fails on permissions, set the
  package's root-owned helper to mode 4755, **not** `--no-sandbox`. First record
  the failure; apply this repair only for the same verified package/condition.
  If PATH resolves an older OpenCode, use the explicit bundled CLI instead.
- **macOS, local:** `api/qualification/desktop-onboarding/macos.md`. Prefer for
  routine runs on a capable Apple silicon Mac. Create an owned
  Cua/Lume task VM from a retained base; never boot/install into the base itself.
  Check cache dry-run and disk headroom before create. Use the official
  ZIP, checksum, Apple signature and Gatekeeper
  checks inside the guest. This does not qualify a novice DMG workflow. If
  daemon-backed control fails, use the record's direct authenticated guest CLI
  control rather than installing a host driver or disabling a VPN.
- **macOS, hosted:** `api/qualification/desktop-onboarding/macos-daytona.md`.
  Use Daytona v2 for a non-Mac operator, a release batch, or a hosted
  reproduction. Check live price and stock; stage the cases and approval
  handoff before buying a day. Pin every guest to the approved reservation,
  verify renewal is off, and verify the guest's actual wall-clock lifetime.
  Persistence preserves disk on stop but does not extend the timeout. If
  neither Mac route is available, report macOS as **blocked**, not passed.

For legacy Daytona Windows/Linux, verify returned lifecycle settings: `autoDeleteInterval: 0` means
delete on stop, whereas `-1` disables it. Preserve disk
across idle stop and verify a separate maximum-lifetime backstop. For local Cua,
`expires_at` may not reflect the requested TTL: run an exact-owned-guest watchdog
as the backstop. A requested timeout is not evidence of enforcement.

## 3. Observe, connect, and approve

1. Record OS, architecture, snapshot/image, app and bundled OpenCode versions,
   installer URL/digest/signing result, controller versions, ownership and deadline.
   Current stable is not necessarily the version in the incident report.
2. Observe a settled, usable desktop window before every input. Titles can appear
   during splash screens; blind coordinate clicks can trigger starter prompts.
   **Do not send a default-provider prompt.** Record accidental requests honestly.
3. Open the built-in terminal and check which OpenCode executable it resolves.
   For user-path qualification run `opencode auth login https://api.bayleaf.dev` there,
   using the explicit bundled executable if PATH is contaminated. Never erase an
   existing database to make the command work. Capture the public claim URL only.
   For smoke, the same bundled executable over guest SSH is acceptable: keep
   the claim client alive through approval and confirm `Connected`/`Done`.
4. The coordinator opens that exact URL in the operator's trusted signed-in
   browser. With explicit authorization for this run, the agent may verify the
   account and matching request code, click **Approve**, and confirm the Approved
   page. The requesting guest retains its device secret; the browser uses its
   genuine session and CSRF form. No CF secrets, forged sessions, DB edits,
   owner-key injection, or institutional password entry in the guest are needed.
5. Confirm the guest CLI reaches Connected/Done without displaying a key. Browser
   approval alone does not prove an interrupted guest client saved the login. If a
   claim expires, cancel only its login process, start a fresh claim and reverify
   the code. Generic expired errors can also mean a mistyped or already-used code:
   crop/inspect small terminal text rather than guessing it.
6. Relaunch only the guest app when required by the observed integration behavior.
   Reacquire fresh window handles and verify the actual **BayLeaf** provider and
   selected model in the GUI. A successful login message alone is insufficient.
   Model names change; do not hardcode today's selection as a permanent invariant.

## 4. Prove useful behavior and persistence

- Establish an absent output file in a neutral task folder. Submit one synthetic
  GUI task asking the model to use at most three tool calls to write and read a
  short sentinel there, then stop. No web access, subagents, personal files or
  extended agent loop. Alternative: read `2,3,5` from an input
  file and write exactly `10` to a separate output file.
- Independently read/export the output through guest execution/file tools and
  compare exact bytes/hash. A model saying “done” is not proof. Capture the GUI
  tool result and provider/model. Report application cost as client-reported,
  not an enforced cap or reconciled provider invoice.
- For smoke, the installed CLI may produce the task output instead. Record
  the exact bytes or digest, and leave desktop prompt submission, GUI tool
  result and conversation persistence untested unless separately observed.
- Actually close/quit and relaunch the guest app, verifying process/window
  turnover and restored conversation/result/model. This qualifies app relaunch,
  **not** OS reboot, sleep/resume, fresh service cold start, or another inference
  after restart unless those are separately exercised.

## 5. Evidence, diagnosis and impact report

Keep screenshots, traces and synthetic output outside git in the approved private
temporary artifact directory. Capture installer/provenance where possible,
first-ready UI, claim handoff, Connected/Done, BayLeaf selection, verified task,
relaunch and relevant failures. Maintain a timestamped manifest with actual
postconditions and omitted-capture reasons. A filename is not proof of its label.
Never capture keys, cookies, credential-store contents, personal sign-in input or
unrelated host windows. Review before any sharing. No continuous video required.

For each platform report:

- Exact environment/version and **passed / failed / blocked / untested** checkpoints.
- First failure, literal sanitized error, reproduction actions and intervention.
- Whether the failure belongs to the test controller/lifecycle, installer,
  OpenCode service/PATH, claim approval, remote config, inference or tool execution.
- Baseline result versus workaround result. Do not silently fold repairs into a pass.
- Affected/unaffected combinations and untested impact, evidence path, cost basis,
  cleanup proof, and an explicit artifact retention/delete decision from the owner.

Keep a 404 from historical Windows discovery aliases separate from a
canonical-login failure. Sealed, Windows 11, broad accessibility, project permission
boundaries and reboot behavior remain unqualified. This procedure does not prove
all BayLeaf capabilities are exposed by a desktop provider connection.

## 6. Cleanup and recording

Export and verify needed artifacts first. Use local OpenCode logout, not BayLeaf
account-key revocation: the ordinary key may be shared by the operator's other
clients. Noninteractive logout may require both integration target
and credential label; inspect `auth logout --help` and metadata-only `auth list`.
Then explicitly delete only owned guests and verify both exact-ID absence and
complete inventory convergence. Cancel owned watchdogs only after verification.
Leave base images, host apps, shared daemons and unrelated resources untouched.

There is no service rollback: this workflow changes no production code or policy.
Stop the guest attempt and preserve diagnostics when a repair would exceed scope.
Update the selected platform record after a run. Propose
one coherent `docs:` commit; never commit, push, edit issues or publish evidence
without approval. Sanitized markdown may be proposed for git; raw artifacts may not.
