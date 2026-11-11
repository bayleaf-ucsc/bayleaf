---
source-skill: bayleaf-ops-router
description: Reproduce reported OpenChamber desktop onboarding failures in disposable platform environments.
status: exercised-components
last-reviewed: 2026-11-11
---

# Desktop onboarding incident response

Use after an onboarding error report or for an explicitly requested release
qualification. This is **incident response, not scheduled monitoring**, a video
production workflow, or a promise of upstream stability. Related work: [#69](https://github.com/bayleaf-ucsc/bayleaf/issues/69).

Read `api/AGENTS.md` and `GETTING-STARTED.md`. Load `daytona-api` for Windows/Linux
or `cua-router` and its sandbox guidance for macOS. Paths below are repo-relative.
The platform instructions were derived from successful runs; this assembled
playbook has not yet had an independent clean-room replay.

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
- The laptop is the macOS **controller only**. Never install the test app on the
  host, reuse its app configuration, or modify its permissions/networking as setup.
- Arrange trusted-browser sign-in before starting ten-minute claims. If no valid
  session exists, ask the operator to sign in on their trusted machine, not the guest.

## 2. Disposable platform routes

Read only the selected detailed record, including its limitations:

- **Windows:** `api/qualification/desktop-onboarding/windows.md`. Daytona
  `windows-medium` tested Windows Server 2025 x64, not Windows 11. Download and
  hash-check the official installer; inspect Authenticode separately. Launch
  through the interactive desktop, not Toolbox's SYSTEM/session-0 shell. Wait
  for Run-dialog focus before typing. A transient request to install OpenCode
  resolved to the bundled binary without intervention in the observed release.
- **Linux:** `api/qualification/desktop-onboarding/linux.md`. Daytona
  `daytona-large` is a Debian container desktop sharing a host kernel, not a VM
  or clean ordinary workstation. Verify/install the official amd64 DEB. The
  observed Electron sandbox-helper permission failure was repaired with the
  package's root-owned helper at mode 4755, **not** `--no-sandbox`. First record
  the failure; apply this repair only for the same verified package/condition.
  An old PATH OpenCode required using the explicit bundled CLI instead.
- **macOS:** `api/qualification/desktop-onboarding/macos.md`. Create an owned
  Cua/Lume task VM from a retained base; never boot/install into the base itself.
  Check cache dry-run and disk headroom before create. The successful guest was
  macOS 26.5.2 arm64. Use the official ZIP, checksum, Apple signature and Gatekeeper
  checks inside the guest. This does not qualify a novice DMG workflow. Direct
  authenticated guest CLI control worked while daemon-backed control did not;
  follow that record rather than installing a host driver or disabling a VPN.

For Daytona, verify returned lifecycle settings: `autoDeleteInterval: 0` means
delete on stop, whereas `-1` disabled it in the exercised API. Preserve disk
across idle stop and verify a separate maximum-lifetime backstop. For local Cua,
the requested TTL was not reflected in `expires_at`; an exact-owned-guest watchdog
provided the backstop. A requested timeout is not evidence of enforcement.

## 3. Observe, connect, and approve

1. Record OS, architecture, snapshot/image, app and bundled OpenCode versions,
   installer URL/digest/signing result, controller versions, ownership and deadline.
   Current stable is not necessarily the version in the incident report.
2. Observe a settled, usable desktop window before every input. Titles can appear
   during splash screens; blind coordinate clicks can trigger starter prompts.
   **Do not send a default-provider prompt.** Record accidental requests honestly.
3. Open the built-in terminal and check which OpenCode executable it resolves.
   Run the current documented `opencode auth login https://api.bayleaf.dev` there,
   using the explicit bundled executable if PATH is contaminated. Never erase an
   existing database to make the command work. Capture the public claim URL only.
4. The coordinator opens that exact URL in the operator's trusted signed-in
   browser. With explicit authorization for this run, the agent may verify the
   account and matching request code, click **Approve**, and confirm the Approved
   page. The requesting guest retains its device secret; the browser uses its
   genuine session and CSRF form. No CF secrets, forged sessions, DB edits,
   owner-key injection, or institutional password entry in the guest are needed.
5. Confirm the guest CLI reaches Connected/Done without displaying a key. If a
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
  extended agent loop. Windows' exercised alternative read `2,3,5` from an input
  file and wrote exactly `10` to a separate output file.
- Independently read/export the output through guest execution/file tools and
  compare exact bytes/hash. A model saying “done” is not proof. Capture the GUI
  tool result and provider/model. Report application cost as client-reported,
  not an enforced cap or reconciled provider invoice.
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

The initial runs found canonical onboarding working on all three environments.
Historical Windows discovery aliases returned 404: keep that separate from a
canonical-login failure. Sealed, Windows 11, broad accessibility, project permission
boundaries and reboot behavior were not qualified. This procedure does not prove
all BayLeaf capabilities are exposed by a desktop provider connection.

## 6. Cleanup and recording

Export and verify needed artifacts first. Use local OpenCode logout, not BayLeaf
account-key revocation: the ordinary key may be shared by the operator's other
clients. OpenCode 2.2.6 noninteractive logout required both integration target
and credential label; inspect `auth logout --help` and metadata-only `auth list`.
Then explicitly delete only owned guests and verify both exact-ID absence and
complete inventory convergence. Cancel owned watchdogs only after verification.
Leave base images, host apps, shared daemons and unrelated resources untouched.

There is no service rollback: this workflow changes no production code or policy.
Stop the guest attempt and preserve diagnostics when a repair would exceed scope.
Update the selected platform record and this refinement log after a run. Propose
one coherent `docs:` commit; never commit, push, edit issues or publish evidence
without approval. Sanitized markdown may be proposed for git; raw artifacts may not.

## Refinement log

- 2026-11-11: Derived from three successful platform runs with OpenChamber 2.7.0
  and OpenCode 2.2.6, not an independent replay of this assembled document. Fixed
  delete-on-idle-stop handoff loss; recorded Linux sandbox/PATH repairs and an
  accidental default-provider request. macOS used guest-only direct control with
  VPN unchanged. Trusted-browser agent approval succeeded without privileged bypass.
