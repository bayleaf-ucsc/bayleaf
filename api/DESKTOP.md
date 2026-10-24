# Desktop managed app (v1)

Desktop gives a signed-in owner Daytona's own noVNC view of an Xfce desktop
running in their existing sandbox, through the private preview gateway. It is a
"feel it" version: no floor-control indicator. The separately exposed owner
computer-use API is documented in [`COMPUTER-USE.md`](COMPUTER-USE.md).

## Contract

- `SERVICE_DEFS.desktop`: port 6080, slot `__desktop`, always private,
  `credential: false`, 1 GiB memory floor (the stack idles near 450 MB RSS),
  `driver: 'computeruse'`. Port 6080 is reserved from `/sandbox/expose`.
- The stack (Xvfb `:0` at 1024x768, xfce4, x11vnc, noVNC/websockify, pulseaudio,
  at-spi) is Daytona's, supervised by its computer-use plugin. BayLeaf installs
  nothing for it and never creates a sandbox for it: an absent machine fails
  with `sandbox_missing`. Start may wake an existing machine, like other apps.
- Start: discover, credentials, wake, then Toolbox `POST /computeruse/start`
  and `GET /computeruse/status`. `active` proceeds to registration; otherwise
  an inspect step re-posts start up to three times total, then fails with
  `desktop_not_ready`. Start/stop process records are parsed tolerantly:
  PascalCase `Running` (observed) or lowercase `running` (OpenAPI).
- Registration is the ordinary managed signed-preview path. No upstream header
  is injected.
- Status GET stays passive: no Toolbox, wake or activity refresh.
- Stop: revoke access first, then, only if the machine is `started`, Toolbox
  `POST /computeruse/stop` and the uploaded `scripts/desktop-cleanup.py`. A
  sleeping machine is never woken; sleep already ended the stack. The stop
  response adds `processes_reaped` (a count, no identifiers).
- Restart is a clean session: stop plus reap, then start, on a fresh origin.
  Windows open on the desktop close.

## Landing path

websockify serves `/usr/share/novnc` (noVNC 1.6.0, websockify 0.12, Debian 13),
which has `vnc.html` but no `index.html`, so `/` is not a client. The registry's
fixed `landing` is
`/vnc.html?autoconnect=true&resize=scale&reconnect=true&path=websockify`:

- the controller hands the dashboard `https://<host>/vnc.html?...` as the Open link;
- the gateway's post-login callback, which never preserves the requested path,
  redirects `__browser` registrations to `managedLanding(slot)` (`/` for every
  other slot and for Lathe and keyed previews).

The path is operator-defined, never caller-selected. The WebSocket is
`/websockify` with subprotocol `binary`, relayed by the ordinary gateway.

## Embedded live view

The Sandboxes dashboard can show a scaled-down, interactive noVNC view in a
small "screen" in its page hero. Nothing loads, and no code is minted, until
the owner clicks the placeholder (*Connect to your desktop*). If Desktop is
`ready` the view is shown; otherwise the click runs the card's Start action and
shows the view once Desktop becomes ready. The embed request
itself never starts, wakes or registers anything. *Open in new tab* closes the frame
and follows the ordinary Open link; *Hide* closes the frame (and its socket).

Previews live on `*.bayleaf-proxies.dev`, deliberately a different site from
`bayleaf.dev`, so the frame is cross-site and the top-level `SameSite=Lax`
session cookie is never sent. Handoff:

1. The dashboard POSTs `/services/desktop/embed` (same exact-Origin and
   `X-BayLeaf-Action: managed-service` checks as other actions; 404 for any
   other service).
2. The frontend calls `SandboxManagement.desktopEmbed({session})`. The API
   resolves the session owner, re-validates the owner's current `__desktop`
   registration through the gateway's own check (live credential, private
   policy) and mints a random 256-bit code, valid 60 seconds or until the
   registration ends. Only its SHA-256 hash is stored, as an `issued` row in
   `preview_flows` with `broker_hash = 'desktop-embed'` and a discarded
   verifier, so the login callback can never consume it. No migration. Hourly
   preview cleanup removes stale rows.
3. The dashboard frames `https://<host>/__preview/embed?code=...`. The gateway
   requires an iframe navigation (`Sec-Fetch-Dest: iframe`), a `Referer` that
   is absent or exactly the dashboard origin, and atomically deletes the
   matching row (`DELETE ... RETURNING`, bound to hostname and generation). A
   top-level, replayed, expired or other-slot redemption fails.
4. It sets `__Host-bl-preview-embed` (`Secure; HttpOnly; Path=/;
   SameSite=None; Partitioned`, host-only) holding a JWT with the same audience,
   generation and expiry as the new-tab session plus `embed: true`, then
   redirects to the fixed landing path. It never sets the top-level session.

Threat model and limits:

- Clickjacking: Desktop responses send `frame-ancestors https://sandbox.bayleaf.dev`
  and no `X-Frame-Options` (which cannot name a cross-origin parent). Exactly one
  ancestor; keep it that way. The dashboard frames with
  `sandbox="allow-scripts allow-same-origin"`, so the desktop cannot navigate
  or open windows from the dashboard.
- The embed token and the new-tab token are not interchangeable (the `embed`
  claim must match exactly). The embed cookie never authorizes a top-level
  document, so a browser that ignored `Partitioned` still cannot use it
  outside a frame. Other slots reject embed tokens and cross-site frames.
- A stolen code needs the owner's dashboard session to mint, lasts 60 seconds
  and works once. Redeemed under a foreign parent, the landing page is refused
  by `frame-ancestors`, and the gateway's Origin/fetch-metadata checks still
  deny that parent's direct requests and WebSockets.
- Stop, Restart, expiry and credential retirement end the registration or its
  generation. That invalidates the embed session and closes its WebSocket the
  same way as the new-tab session; no separate revocation list.
- The dashboard CSP gains only `frame-src https://*.bayleaf-proxies.dev`, and
  only for signed-in pages.
- Browser support: Chromium/Edge honor `Partitioned` (CHIPS). Firefox partitions
  third-party cookies by default. Safari blocks third-party cookies in frames,
  so the embed is expected to fail there; *Open in new tab* is the fallback.
  Not verified in any real browser yet.
- Accessibility: focus moves to the region's *Hide* button, not into the
  desktop. noVNC captures keys while focused (Tab included), so leaving the
  desktop needs a pointer click outside it. This is a known keyboard-trap risk.
- Fetch Metadata is required for frame navigation and ordinary subresources.
  WebSocket handshakes may omit `Sec-Fetch-Dest`: an exact preview-origin
  `Origin` is still required, as are the valid session and current registration.

## Orphan cleanup

`/computeruse/stop` leaves session daemons reparented to pid 1. The script
reaps a process only if its argv[0] basename is in a fixed allowlist (xfconfd,
ssh-agent, gpg-agent, dconf-service, gvfsd*, gvfs-*-volume-monitor), it has
the script's uid, its environ contains exactly `DISPLAY=:0`, and it is not pid 1,
a Daytona binary, the script or one of its ancestors. SIGTERM, a 2-second wait,
then SIGKILL only after re-checking identity. Requiring the allowlist keeps an
owner who exports `DISPLAY=:0` in a shell profile from losing their agents.
`scripts/test-desktop-cleanup.py` covers selection synthetically.

## Security limits

x11vnc has no password and RFB negotiates security type None. Owner sign-in at
the gateway is the only lock, which is why the slot is fixed private. Inside the
sandbox, x11vnc also listens on 5900/5901 and the Toolbox on 127.0.0.1:2280
without authentication. Any sandbox process can already drive the desktop.

## Operator verification and remaining limits

Deployed on 2026-10-24 with explicit approval. Adam reported roughly 300 ms
interaction latency, working Chromium and terminal, YouTube video without audio,
successful new-tab reconnect and Stop. These are human observations, not a
latency benchmark or qualification of the computer-use HTTP API.
Deployment versions and release checks are recorded in
[`COMPUTER-USE.md`](COMPUTER-USE.md#verification-and-deployment-notes).

The hero embed was deployed but initially failed to connect. The gateway now
accepts embedded WebSocket handshakes without `Sec-Fetch-Dest` while retaining
the exact-Origin gate, with regression coverage. A successful live embedded
connection after that fix remains unconfirmed.

Not yet verified:

- Busy-screen behavior at the 4 MiB message cap and 16-socket host cap.
- Whether a running desktop or viewer traffic delays the 60-minute auto-stop.
- Whether computer use autostarts after a whole-sandbox stop and start. A login
  wake retires ready records, so the dashboard asks for Start again.
- The cleanup script against a live leaked session (the spike killed by pid).
- The embedded view in real browsers: partitioned cookie storage across the
  302, WebSocket cookie delivery in a frame, noVNC scaling in the 4:3 box,
  Safari/Firefox behavior, and the keyboard-focus experience.
