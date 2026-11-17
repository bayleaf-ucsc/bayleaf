# Desktop onboarding qualification

Incident-response evidence for [issue #69](https://github.com/bayleaf-ucsc/bayleaf/issues/69),
observed 2026-11-11. Procedure:
[desktop onboarding smoke playbook](../../../.agents/skills/bayleaf-ops-router/playbooks/desktop-onboarding-smoke.md).

All three isolated environments passed official app installation, ordinary
BayLeaf claim handoff, GUI provider/model selection, one independently verified
file-producing tool task, and conversation/model persistence after app relaunch.
All owned guests were removed and absence verified. No service changes were made.

| Record | Actual environment | Result qualification |
|---|---|---|
| [Windows](windows.md) | Daytona Windows Server 2025 x64 VM | Passed; canonical login, unsigned installer matched published checksum |
| [Linux](linux.md) | Daytona Debian 13 x64 container desktop | Passed with sandbox-helper permission repair and bundled-CLI PATH workaround |
| [macOS](macos.md) | Cua/Lume macOS 26.5.2 arm64 VM | Passed through direct authenticated guest control; daemon-backed access remained broken |

Every run used OpenChamber 2.7.0 and bundled OpenCode 2.2.6. App-reported task
costs were approximately $0.0011, $0.005 and $0.002 respectively, not independent
provider billing measurements. The assembled playbook has not yet had an
independent replay. Do not generalize these passes to Windows 11, a clean Linux
workstation, OS reboot, Sealed, broad accessibility or all desktop capabilities.

Windows/Linux approval was human-operated in a trusted browser; macOS approval
was agent-operated in the operator's genuine signed-in OpenChamber browser with
explicit authorization and a verified matching request code. Neither required
institutional sign-in inside a guest, Cloudflare secrets, or fabricated sessions.

## Hosted macOS follow-up (2026-11-17)

[Daytona v2](macos-daytona.md) passed the desktop smoke on macOS 26.6.2 arm64
with OpenChamber 2.7.2 and OpenCode 2.3.0. A separate gesture probe verified
a click through the same viewer used to capture the result. This was not a
full GUI onboarding replay and did not supersede the Cua baseline.

## Evidence custody

Only sanitized markdown belongs here. Private screenshots, action traces,
manifests and synthetic outputs remain outside git in the approved temporary
`opencode` directory, with paths in the platform records. They are not durable
repository artifacts and have no automatic preservation guarantee. Owner choice
of a retention deadline or private archive remains pending; do not publish or
silently delete them. No video was required.
