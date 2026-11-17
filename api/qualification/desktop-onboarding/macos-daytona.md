# Hosted macOS desktop smoke: Daytona v2

Observed 2026-11-17; companion to the [onboarding playbook](../../../.agents/skills/bayleaf-ops-router/playbooks/desktop-onboarding-smoke.md) and [local Cua baseline](macos.md).

## Route and spending

- Daytona's v2 dashboard at `app.daytona.com` reserved a Boston M4 Pro
  with 24 GiB RAM. The checkout quoted $60.08 for 24 hours; the cheaper
  $32.43 M4 was sold out. These are observed offers, not enduring prices.
  On the next run, confirm price, stock, authority and available funds.
- Select the exact approved reservation in the macOS guest creation form.
  Do not accept **Automatic** placement or a purchase prompt. Turn off renewal
  on the reservation and verify the result; avoid changing organization defaults.
- Read the actual guest lifetime and idle fields. The first ephemeral guest
  showed **Delete after 5m**, with no idle timeout, and disappeared after
  initial SSH success. The persistent replacements showed **Stop after 5m**.
  Persistence is a disk safeguard, not a longer run. Prefer a verified longer
  lifetime for interactive tests; otherwise use short stages, and do not restart
  a guest if placement or a new purchase cannot be ruled out.

## What passed

- In macOS 26.6.2 (25G83) arm64, downloaded the official OpenChamber 2.7.2
  Apple silicon DMG and matched the published SHA-256. Verified the app
  signature and Gatekeeper acceptance as a notarized Developer ID app. Mounted
  the DMG and installed via guest SSH, then saw the composer in the desktop
  viewer. This did not exercise Finder drag-and-drop.
- Used the verified bundled OpenCode 2.3.0 to start the Standard BayLeaf claim
  via guest SSH. The operator approved it in a trusted browser; no institutional
  sign-in or operator key entered the guest. The first claim showed `Cancelled`
  despite browser approval, with no BayLeaf registration. A retry kept the client
  in a separate guest process session; the guest then showed `Connected` and
  `Done` and listed BayLeaf credentials and models. Verify guest completion
  before relaunching.
- After relaunch, the guest desktop showed the configured DeepSeek model.
  The bundled CLI performed one BayLeaf tool call to create `proof.txt`.
  A separate guest shell compared the exact `DAYTONA_BAYLEAF_OK` plus newline
  (19 bytes; SHA-256
  `d9bce66fc0943ec33ce45a027f9e58ef2e4d27787e106a6d45d9e41bb0ee870d`).
  A controller timeout did not imply failure: read the guest result before retrying.
- On a separate guest pinned to the same reservation, SSH only staged a local
  Safari page. Once the viewer was connected and its canvas had nonzero bounds,
  a screenshot showed the target covering its center. One browser-panel click
  on the canvas changed the guest page from purple “Waiting for guest click” to
  green “Click received in guest,” confirmed in a second capture. No host
  keyboard or clipboard was used for this successful path.

## Limits and cleanup

Scoped SSH and the dashboard desktop viewer worked without a Daytona project
key or a host-side driver. An earlier attempt to use browser-terminal typing and
the shared clipboard interfered with the operator's windows; do not repeat it.
The click probe did not qualify arbitrary coordinates, typing, dragging,
the integrated terminal, composer submission, or GUI conversation persistence.
Do not claim Sealed, OS reboot, or a fully GUI-driven onboarding pass.

Screenshots remained private outside git. The ephemeral guest was already
deleted; both persistent test guests were explicitly deleted. The reservation
showed zero sandboxes and auto-renew **Off**. No second reservation was purchased.
