# Run evidence: desktop-onboarding-smoke

Dated record of past runs of [`desktop-onboarding-smoke.md`](../playbooks/desktop-onboarding-smoke.md), newest first unless noted.
Consult for diagnosis; current procedure lives in the linked file.

- 2026-11-11: Derived from three successful platform runs with OpenChamber 2.7.0
  and OpenCode 2.2.6, not an independent replay of this assembled document. Fixed
  delete-on-idle-stop handoff loss; recorded Linux sandbox/PATH repairs and an
  accidental default-provider request. macOS used guest-only direct control with
  VPN unchanged. Trusted-browser agent approval succeeded without privileged bypass.
- 2026-11-17: Added the hosted Mac route after a desktop smoke and a separate
  guest click probe. The checkout's five-minute wall-clock default deleted
  the first guest; a persistent replacement preserved disk. Browser approval
  alone did not prove that an interrupted guest client saved the login.

## Moved from the body

Original wording, verbatim, as it stood in the procedure.

Frontmatter status:

```text
status: exercised-components
```

Opening provenance:

```text
The platform instructions were derived from successful runs; this assembled
playbook has not yet had an independent clean-room replay.
```

Windows route, environment:

```text
  `windows-medium` tested Windows Server 2025 x64, not Windows 11.
```

Windows route, transient screen:

```text
A transient request to install OpenCode
  resolved to the bundled binary without intervention in the observed release.
```

Linux route, repairs:

```text
The
  observed Electron sandbox-helper permission failure was repaired with the
  package's root-owned helper at mode 4755, **not** `--no-sandbox`. First record
  the failure; apply this repair only for the same verified package/condition.
  An old PATH OpenCode required using the explicit bundled CLI instead.
```

macOS local route, guest version:

```text
Check cache dry-run and disk headroom before create. The successful guest was
  macOS 26.5.2 arm64. Use the official ZIP,
```

macOS local route, control path:

```text
Direct
  authenticated guest CLI control worked while daemon-backed control did not;
  follow that record rather than installing a host driver or disabling a VPN.
```

Lifecycle settings:

```text
`autoDeleteInterval: 0` means
delete on stop, whereas `-1` disabled it in the exercised API. Preserve disk
across idle stop and verify a separate maximum-lifetime backstop. For local Cua,
the requested TTL was not reflected in `expires_at`; an exact-owned-guest watchdog
provided the backstop. A requested timeout is not evidence of enforcement.
```

Synthetic task alternative:

```text
Windows' exercised alternative read `2,3,5` from an input
  file and wrote exactly `10` to a separate output file.
```

Initial run outcome:

```text
The initial runs found canonical onboarding working on all three environments.
Historical Windows discovery aliases returned 404: keep that separate from a
canonical-login failure. Sealed, Windows 11, broad accessibility, project permission
boundaries and reboot behavior were not qualified. This procedure
```

Logout behavior:

```text
OpenCode 2.2.6 noninteractive logout required both integration target
and credential label; inspect
```

Recording step:

```text
Update the selected platform record and this refinement log after a run. Propose
```
