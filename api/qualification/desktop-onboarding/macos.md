# macOS desktop onboarding evidence: BayLeaf #69

**2026-11-11: isolated guest smoke passed; task guest deleted.** This is qualification evidence, not the common operations playbook.

## Scope and measured versions

- Host was only the controller. No host OpenChamber/OpenCode installation, restart, configuration/auth edit, GUI input/capture, network/VPN/security change, runtime update, or standalone driver installation. Earlier authorized opening of existing Cua Spaces is not guest-install evidence.
- Host: macOS 27.0.1 (26A434), Cua Spaces 0.19.2, bundled `cua` 0.9.0, Lume 0.6.1.
- Task guest: macOS **26.5.2 (25F84), arm64**, 4 CPUs, 8 GiB; guest `cua-spacesd` **0.7.0**, protocol revision 8.
- Guest OpenChamber **2.7.0**, bundled OpenCode **v2.2.6**, measured with `/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode --version`.
- Guest driver registry schemas were discovered live; its build version was not independently measured. Do not substitute the host helper's 0.38.0 version.
- Consult domestic `cua-router`, selected foreign `cua-driver`/sandbox guidance, and installed CLI help. Vendor guidance does not authorize host mutations.

## Owned guest creation and lifetime

Use a fresh unique task name, not the historical name below. Inventory local sandboxes and Lume first; never boot or install into a base or unrelated VM. Installed runtime doctor was healthy; 64 GiB disk was free.

```sh
CUA='/Applications/Cua Spaces.app/Contents/MacOS/cua'
"$CUA" sandbox ls --local --no-size --json
"$CUA" runtime doctor
"$CUA" sandbox create --help
"$CUA" cache prune --dry-run
"$CUA" sandbox create macos:26 --on local --kind vm --runtime lume \
  --name bayleaf-69-macos-diag-20261111b --cpu 4 --memory 8GB \
  --ttl 20m --ready-timeout 60 --keep-on-failure --json
```

The dry run retained the pinned 29.2 GiB `ghcr.io/trycua/macos:26` base; no prune/budget change occurred. Creation failed with `No route to host` but retained the owned guest. Without `--keep-on-failure`, the earlier attempt auto-deleted its clone.

**Local TTL gotcha:** reattached info showed `expires_at: null`, despite `--ttl 20m`. Before create, establish an independent exact-name deletion backstop. This run used an owned sleeping subprocess invoking `cua sandbox rm local:EXACT_NAME --force` after 1,140 seconds. After recovery, replaced only that identified watchdog with a 45-minute one, still inside the authorized absolute two-hour lifetime. Cancel a watchdog only after verified deletion or after establishing its replacement. No broad process killing.

## Working guest-control route, without network changes

Live guest route selected `bridge100`, ARP resolved the guest, and shell probes reached SSH and spacesd. Supported `cua sandbox exec NAME 'sw_vers; uname -m'` worked via Lume SSH fallback. That fallback rejects spacesd-only `--timeout`, `--user`, and `--cwd`; bound the host command runner instead. Pass one shell-script string: `sb exec` joins multiple arguments and can lose quoting.

Daemon-backed `cua do window ls` still failed while direct CLI requests succeeded. Cua logged `bridge100`, LAN `Allowed`, and `LocalNetworkVpn`: current source classifies any reachable-LAN/unreachable-VM combination this way, not just VPN routes. Tailscale stayed connected throughout. **Do not diagnose Tailscale from this label or change permissions/routes to bypass it.** The exact daemon-path defect remains unresolved.

The supported direct route authenticates to the task guest's existing spacesd, then uses its driver registry. Keep its controller token separate from BayLeaf account credentials. Example custody/invocation shapes, executed on the controller with shell tracing disabled:

```sh
set +x
umask 077
VM='local:YOUR_UNIQUE_TASK_NAME'
URL='http://GUEST_IP:3211' # derive from fresh sandbox info, never a remembered IP
TOKEN="$("$CUA" sandbox exec "$VM" 'cat ~/.cua/spacesd/token')"
# Check success/nonempty privately; never print token, put it in argv, or save it in repo.
CUA_ENV_TOKEN="$TOKEN" "$CUA" spacesd caps "$URL" --json
CUA_ENV_TOKEN="$TOKEN" "$CUA" spacesd call "$URL" DriverService/ListTools '{}' --json
CUA_ENV_TOKEN="$TOKEN" "$CUA" spacesd call "$URL" DriverService/CallTool \
  '{"name":"check_permissions","argumentsJson":"{\"prompt\":false,\"session\":\"bayleaf69\"}"}' --json
CUA_ENV_TOKEN="$TOKEN" "$CUA" spacesd call "$URL" DriverService/CallTool \
  '{"name":"list_windows","argumentsJson":"{\"app\":\"OpenChamber\",\"session\":\"bayleaf69\"}"}' --json
unset TOKEN
```

Capture token-read stdout privately and check exit status; do not continue on an empty/error result. Prefer process-local environment/capture, unset afterward, and never log subprocess environment. This reads only the owned guest's already-issued controller token, not host credentials. The temporary helper below implemented this using captured subprocess output and redaction.

Filter `ListTools.tools` to required names and parse each `inputSchemaJson`; do not repeatedly load all descriptions. `CallTool` returns `structuredJson` and `content`; inspect `isError`. Images in `content[].image.data` are base64 encoded: decode only task captures into the approved private temporary directory, then inspect them. A `screenshot_out_file` supplied to the guest tool names a **guest** path, not a host path.

Guest `check_permissions({prompt:false})` reported Accessibility/Screen Recording true for existing Cua Spacesd. No grant flow ran. A supported VNC fallback screenshot was black and unusable; valid exact-window captures came through `DriverService/CallTool`.

Protocol reference: <https://cua.ai/docs/cua-sdk/reference/protocol/env-computer.md>. Installed `cua spacesd call --help` documents `Service/Method` plus proto3-JSON body. No MCP installation/configuration or custom HTTP bridge is required.

## Official installation inside the guest only

Official release API resolved to `openchamber/openchamber` stable `v2.7.0`. Inside the task guest, downloaded/extracted the arm64 ZIP, validated before install, and required `/Applications/OpenChamber.app` to be absent:

```sh
set -eu # Run inside the disposable guest, never on the controller.
curl -fL --max-time 180 -o /tmp/OpenChamber.zip \
  https://github.com/openchamber/openchamber/releases/download/v2.7.0/OpenChamber-2.7.0-mac-arm64.zip
echo 'b5efec944df0173f751eb82e29567d73b29fd76b294b90e96857cbc3c9cb9c2d  /tmp/OpenChamber.zip' | shasum -a 256 -c -
ditto -x -k /tmp/OpenChamber.zip /tmp/openchamber-unpacked
codesign --verify --deep --strict /tmp/openchamber-unpacked/OpenChamber.app
codesign -dv --verbose=2 /tmp/openchamber-unpacked/OpenChamber.app
spctl --assess --type execute --verbose=2 /tmp/openchamber-unpacked/OpenChamber.app
test ! -e /Applications/OpenChamber.app && ditto /tmp/openchamber-unpacked/OpenChamber.app /Applications/OpenChamber.app
```

Each validation passed. Signature: **Developer ID Application: Bohdan Tryapitsyn (5J7WJGPA2Q)**, bundle `dev.openchamber.desktop`, arm64, hardened runtime, stapled ticket; Gatekeeper **accepted**, `Notarized Developer ID`. Stop on any validation failure. Recheck official release/hash rather than treating this historical version as a permanent pin.

## Observed GUI onboarding and proof

1. Use live guest `launch_app({name:"/Applications/OpenChamber.app",session})`, then filtered `list_windows({app:"OpenChamber",session})`. Select the real main window by identity/title/bounds; reacquire IDs after relaunch. `get_window_state({pid,window_id,max_elements,session})` supplies tree and image. Use fresh snapshot `element_token`s, never guessed indices or historical coordinates.
2. Initial clean guest UI selected Big Pickle. **No prompt was sent there.** Opened the built-in terminal using the observed terminal control, verified its empty shell prompt, then entered `opencode auth login https://api.bayleaf.dev`. Pixel text entry was grounded in that exact window's fresh image; screenshot readback, not AX value echoes, confirmed command entry/execution.
3. Handed the real public claim URL/code immediately to parent. Small terminal text was easy to mistranscribe: verify every character with a private crop. A failed URL's generic “expired” message does not prove actual expiry. Refreshed once via Ctrl-C, verified prompt, reran command. Terminal does not expose exact server expiry; the documented ten-minute limit is not an independently observed timestamp.
4. Parent approved the matching claim through Adam's **real signed-in OpenChamber browser**, normal cookie/CSRF approval. No deployment secret, forged session, or owner-key injection. Guest independently showed **“Connected to api.bayleaf.dev”**, **“Done.”** No credential/private browser page was captured.
5. Fully quit only the guest app, verified its windows disappeared, relaunched via guest Cua, reacquired handles. GUI/AX then showed **`bayleaf-remote` / DeepSeek: DeepSeek V4.1 Flash 1017**. Closing the terminal panel exposed the model name without changing it. AX menu actions can claim success without visible effect: verify pixels; do not blindly repeat.
6. Independently checked `/Users/lume/bayleaf69-proof.txt` absent. Submitted one GUI task: one shell call writes `BAYLEAF_MACOS_69_OK` plus newline, then reads it. GUI showed the tool call and expected answer. Independent guest-shell readback verified **20 bytes**, SHA-256 **`e3c31ce3f40341fb3f10023c9bbf8cca40ef9292b7c3231f140953e6c8502e5d`**. The controller did not create that guest proof file.
7. GUI reported **$0.002**, two steps, 10.3K input/293 output tokens, about 3.7 seconds. This is application-reported cost, not reconciled billing; no further inference ran. Fully quit/relaunched again: conversation, tool result, BayLeaf selection and cost persisted in a fresh window capture.

Use the same public non-default session label on every supported driver call. Refused/unverifiable actions require fresh observation before retry. Foreground delivery, when needed, was confined to the isolated guest, never the host.

## Local logout, deletion and final evidence

Used the bundled guest CLI, never edited auth storage. V2.2.6's one-argument logout URL failed noninteractively: it requires both integration and credential label (`auth logout --help`: `[target] [credential]`). `auth list` revealed labels, not keys. Working cleanup:

```sh
/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode auth logout api.bayleaf.dev api.bayleaf.dev
/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode auth list
```

Observed **“Removed account from api.bayleaf.dev”**, **“Done”**, then **“No authenticated integrations.”** This was guest-local logout, not account-key revocation. Exported verified proof bytes before deletion. Ran `cua sandbox rm local:bayleaf-69-macos-diag-20261111b --force`; then independently verified local sandbox inventory **`[]`** and Lume inventory containing **only the original stopped pinned base**. No stray owned clone remained. Canceled the final owned watchdog after that verification.

Private artifacts: `/private/var/folders/qj/gyqbn5y57956rrqd_g6yfqwr0000gn/T/opencode/`. **`bayleaf69-macos-checkpoints.json`** maps eight landmarks to captures/proof, versions, live handles and capture timestamps. All nine referenced files exist; proof checksum was rechecked. **`bayleaf69-guest-call.py`** is the temporary CLI wrapper, contains no credential literal, and is not an installed integration. Claim screenshots contain public transient codes: do not publish or commit. Only task guest windows were captured.

Limitations: verified ZIP installation, not novice DMG drag-and-drop/first-open prompts; preconfigured Cua guest OS, not Apple OS setup; no broad accessibility, Sealed, model-switching, account-revocation, or post-logout GUI qualification. Daemon-backed control remains unresolved. Host existing-install exploration is not substituted for guest evidence. No commits, pushes, deployments, host software installs, or VPN changes were performed.
