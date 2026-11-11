# Linux desktop onboarding qualification: issue #69

Date: **2026-11-11 (UTC)**. Result: **passed with environment-specific workarounds**.
Actual OpenChamber desktop installation, browser-approved BayLeaf login, model
selection, one tool-using task and desktop relaunch persistence were exercised.
Both owned Daytona allocations are gone; replacement deletion was explicit.
This is dated exploratory evidence, not a claim of universal Linux compatibility.

## Environment, release and cost

- Daytona `daytona-large`, **container**, not VM: shared host kernel, 4 vCPU,
  8 GiB RAM, 10 GiB writable disk; Debian 13.7 trixie, x86_64, user daytona.
- Snapshot `daytonaio/sandbox:0.9.0`; observed daemon **0.225.2**. Computer Use
  supplied Xvfb/Xfce/noVNC at 1440×900. curl **8.14.1** supported claim discovery.
- Current account availability exposed Linux containers, not Linux VM allocation.
  Active VM snapshot inventory alone did not establish allocation eligibility.
- Official stable desktop **OpenChamber 2.7.0**, release published November 8;
  bundled **OpenCode 2.2.6**, measured from its executable.
- Sources: [download](https://openchamber.dev/download/),
  [install](https://docs.openchamber.dev/install/), [release](https://github.com/openchamber/openchamber/releases/tag/v2.7.0),
  [Linux](https://www.daytona.io/docs/en/linux-sandboxes/) and [Computer Use](https://www.daytona.io/docs/en/computer-use/).
- Pricing checked at <https://www.daytona.io/pricing>: $0.0504/vCPU/hour,
  $0.0162/GiB RAM/hour, $0.000108/GiB disk/hour. Conservatively charging all
  disk gives **$0.33228/hour**, or $0.66456 for two hours, before credits/taxes.
  User authorized $5 combined Windows/Linux, Linux <=$2 and <=120min per machine.
  Replacement runtime ~4m14s implies ~$0.0235, not measured provider billing.

## Validated installation and login route

Commands below ran **inside the throwaway guest**, not on the laptop. A current
run should recheck stable release metadata rather than assume this pin stays latest.

```sh
set -eu
curl -fsSL https://downloads.openchamber.dev/desktop/stable/OpenChamber-2.7.0-linux-amd64.deb \
  -o /home/daytona/OpenChamber-2.7.0-linux-amd64.deb
echo 'c9a47ee59841c670e8322448b6f53c9e4756de7a6df885660e821402b5d1829d  /home/daytona/OpenChamber-2.7.0-linux-amd64.deb' | sha256sum -c -
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y /home/daytona/OpenChamber-2.7.0-linux-amd64.deb
DISPLAY=:0 /opt/OpenChamber/openchamber
```

The 235,459,652-byte installer matched the release SHA-256 on both runs.
Initial launch aborted: root-owned Electron sandbox helper had mode 755.
After verifying that condition on the checksum-verified installed package,
`sudo chmod 4755 /opt/OpenChamber/chrome-sandbox` repaired launch; then relaunched
the same desktop command. **No `--no-sandbox`**. This is package/environment-specific,
not advice for unknown executables. The application menu also uses the full
`/opt/OpenChamber/openchamber` path; no `openchamber` PATH command existed.

Open the desktop's integrated terminal, then run:

```sh
/opt/OpenChamber/resources/opencode-cli/opencode auth login https://api.bayleaf.dev
```

The guide's plain `opencode` command instead resolved snapshot-preinstalled
OpenCode **1.19.4** and failed: “Database is not empty and has no session table.”
No database was removed or repaired. Explicit bundled-path login succeeded.
Desktop startup briefly displayed an install-OpenCode screen, then advanced
automatically; another CLI installation was not needed.

The human approved the public claim in their own browser. Approval requires a
real signed-in browser session and CSRF form token, not an ordinary API key.
Claims last ten minutes; no expired code was reused. The integrated terminal
displayed “Connected to api.bayleaf.dev” and “Done” by **22:43:47Z**, without
displaying credentials. No guest institutional-login inputs were captured.

## Model, task and persistence evidence

After terminating the identity-checked desktop process and relaunching it, the
model picker explicitly showed **BayLeaf** and selected **DeepSeek: DeepSeek
V4.1 Flash 1017**. GLM 5.3 Flash, Qwen3.8 27B and Kimi K3.1 Pro also appeared.
Remote-config loading is inferred from this catalog and successful inference,
not a captured HTTP trace. Provider selection was verified before the test prompt.

One synthetic message requested one shell tool call to write and read
`/home/daytona/bayleaf-smoke/result.txt`, then stop. The visible result and an
independent Toolbox byte check both matched `BAYLEAF_LINUX_DESKTOP_OK\n` exactly.
GUI reported one shell tool card, two model steps, 2.9s elapsed and **~$0.005**
cost ($0.0048 context subtotal), not authoritative provider billing. No extra
inference followed. A second identity-checked desktop relaunch preserved the
completed conversation, exact visible result and selected model.

**Accidental default-provider request:** during replacement startup, a click
intended for a transient setup control raced the automatic screen transition
and activated a starter suggestion. Big Pickle showed a generated-skills read
card and “Free usage limit reached.” No personal input was supplied. This was
an unintended failed request, not zero default-provider traffic or a successful
test. Reobserve settled UI before clicking; do not reuse startup coordinates.

## Lifecycle correction and verified cleanup

Original allocation `1225e730-77b6-4685-bb85-b37939646041` started **22:14:15Z**.
Its 20-minute idle stop plus `autoDeleteInterval:0` deleted it before delayed
approval. At **22:41:02Z**, exact-ID GET returned 404 and complete inventory
confirmed absence. No explicit DELETE occurred; exact deletion time is unknown.
Rejected create attempts with `queueTimeout` returned 403 because that feature
was not enabled for this organization; the successful request omitted it.

Replacement `9b944571-cf8b-4fd1-b036-df322629135a` started **22:41:33.879Z**.
Verified settings: `autoStopInterval:60`, `autoPauseInterval:0`,
**`autoDeleteInterval:-1`**, private preview and creation `ttlMinutes:120`.
An explicit TTL119 setter accepted HTTP201 at **22:42:17.752Z**, bounding lifetime
to approximately **00:41:17Z**, within the original two-hour cap. Negative
auto-delete disables deletion on stop; zero means delete immediately on stop.
Human approval waits need preservation/resume plus an independent hard deadline.

After output export, local-only logout succeeded with the bundled CLI:
`auth logout https://api.bayleaf.dev api.bayleaf.dev`. URL-only noninteractive
logout had requested a credential ID/label; `auth list` supplied labels/status
only. Final listing said **No authenticated integrations**. No auth-store content
was read and the owner's shared ordinary BayLeaf key was never revoked.
Ownership rechecked before DELETE: HTTP200 at **22:45:47.747Z**. At
**22:45:54.660Z**, exact-ID GET was 404 and complete inventory confirmed absence.
No unrelated resource was changed. No further cleanup is outstanding.

## Local evidence manifest and limitations

Evidence base, outside the repository:
`/private/var/folders/qj/gyqbn5y57956rrqd_g6yfqwr0000gn/T/opencode/bayleaf-69-linux/`.
`result.txt` is 25 bytes, independently verified after download; SHA-256:
`a3836d1c4bbae35893709ad037d10f6c0f84da775fe6879c237e76c96588f0fa`.
Screenshots are under `computer-state/sessions/linux-69-replacement/`:

- `0001-first-ready-desktop.png`, 22:42:09Z: Xfce and geometry.
- `0002-first-ready-openchamber.png`, 22:42:22Z: transient setup, not ready UI.
- `0003-custom-binary-expanded.png`, 22:42:29Z: transition, not expanded control.
- `0004-login-bundled-public-claim.png`, 22:42:44Z: claim and unintended failure.
- `0005-approval-handoff-result.png`, 22:43:47Z: connected/done, no secret.
- `0006-post-login-relaunch.png`, 22:44:04Z; `0007-new-session-bayleaf-model.png`,
  22:44:17Z: reloaded model and clean composition view.
- `0008-connected-provider-model.png`, 22:44:27Z: explicit BayLeaf selection.
- `0009-project-picker.png`, 22:44:39Z: generic Chat location only.
- `0010-synthetic-task-progress.png`, 22:44:55Z; `0011-verified-synthetic-task.png`,
  22:45:06Z: shell execution, final output, app-reported usage.
- `0012-persistence-after-relaunch.png`, 22:45:23Z: persisted task and model.

Original session `computer-state/sessions/linux-69/` retains installer/checksum,
sandbox-permission failure and old-PATH-CLI screenshots. Sanitized `events.jsonl`
gives precise timestamps. Filenames can describe intent rather than outcome.
No video, credentials, personal login inputs or screenshots were committed.

Unqualified: clean workstation installation, literal guide command without PATH
workaround, OS/container reboot or full background-service cold start, project
bookmark/permission boundaries (task used generic Chat and an absolute synthetic
path), graphical logout, accessibility, sustained workloads and final billing.
