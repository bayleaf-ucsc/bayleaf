#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.28,<0.29", "websockets>=15,<16"]
# ///
"""Issue #86: credential-silent live app/provider probes, without inference.

Default invocation prints the preparation plan and makes no network requests.
After explicit deployment handoff, provision disposable apps as described below,
then run with --live --worker-version VERSION --manifest /private/path.json.
The version is operator-supplied provenance, not independent deployment detection.

Mode-0600 JSON manifest (never commit this file):
{
  "nanobot": {"wrapped": "https://.../", "direct": "https://.../",
    "assertion_header": "X-Authenticated-Owner", "assertion_value": "true",
    "alternate": "https://.../", "cookie": "optional private owner cookie"},
  "dufs": {"wrapped": "https://.../", "direct": "https://.../",
    "authorization": "Basic ...", "proof_path": "/proof.txt",
    "proof_text": "synthetic issue86 proof\n"},
  "short_lease": {"direct": "https://.../", "wrapped": "https://.../",
    "expires_at": 1790000000},
  "forbidden_body_values": ["optional synthetic app password"]
}
Optional alternate URLs must belong to this run's disposable sandbox. short_lease
must target an uncredentialed peer fixture; expiry waits at most 180 seconds.
Only status codes, booleans, and timing are printed, never response bodies,
URLs, headers, exception messages, or authentication tokens. This client does
not provision, revoke, or delete resources: the operator owns that ledger.
"""

import argparse
import asyncio
import json
import os
from pathlib import Path
import stat
import time
from urllib.parse import urlsplit

PLAN = """Preparation only; no live resources launched.
1. Receive deployed Worker version; verify pricing and cap one disposable
   2-vCPU/4-GiB sandbox at 30 minutes, <= $0.25. Use BayLeaf Daytona account
   credentials from existing preview-apps.py's Lathe-valve path, not personal
   Daytona credentials. Record unique name/label BEFORE creation; persist returned
   sandbox ID immediately in a dedicated mode-0600 ledger outside the repository.
2. Install pinned Nanobot v0.3.5 and dufs v0.46.0 only in that sandbox. Keep
   process stdout/stderr discarded, disable access logging, and generate synthetic
   credentials there. Do not copy real provider/inference credentials into it.
   Use unique app ports 18865/18866 and metadata-only peer fixture port 18867.
3. Observe direct TCP peers (ss during held connections, or peer fixture) over
   direct Daytona and BayLeaf-wrapped routes before configuring Nanobot. Trust
   only observed exact /32 or /128 peers for this experiment, never broad private
   ranges. Peer observations are instance-specific, not provider CIDR guarantees.
4. Nanobot config: websocketRequiresToken=true, trustedProxyAuth with observed
   peer CIDRs and X-Authenticated-Owner; nonempty synthetic tokenIssueSecret;
   bind 0.0.0.0 on 18865. Set publicWsUrl to the new wrapped wss origin.
   Confirm /webui/bootstrap and a ready WebSocket frame without sending a message.
   Run dufs on 18866 with a synthetic user/password, read-only synthetic directory,
   --auth user:password@/:ro (dufs accepts Basic). Fetch proof.txt.
5. Register using installation POST /previews/registrations, unique issue86
   subject, amsmith@ucsc.edu, and independent public/private leases. Headers:
   Nanobot X-Authenticated-Owner:true; dufs fixed Authorization:Basic credential.
   Persist EACH returned hostname before checking exact boolean acknowledgement.
   Never use existing helper cleanup(): its disposable-VM branch revokes keyed
   owner ports instead of these installation leases. Do not use owner sandbox.
6. Fill manifest and run this client first on public leases. Repeat wrapped
   checks with private leases and real owner cookies kept only in mode-0600 state;
   anonymous private denial is a separate run without cookie. Never forge session
   cookies to substitute for browser qualification. Test browser navigation too.
7. Metadata fixture supplies HTTP/WS exact-value booleans for case-insensitive
   overwrite and Connection nomination checks. Nanobot checks only nonempty values,
   so its success alone cannot prove injected-value equality. Inspect peers for
   HTTP and WS separately. Fixture output must never echo raw request headers.
8. Direct matrix: no assertion, attacker nonempty assertion, alternate signed
   lease, unsigned provider route, and direct sandbox address if actually reachable.
   Keep provider route credentials in memory/state only. Successful spoof is a
   documented boundary failure, not a gateway injection failure. Do not invent an
   inaccessible alternate route or describe missing tests as denied.
9. Mint a <=120-second signed fixture URL if provider accepts it. Record provider
   expiry, wrap it in a normal 24-hour registration, and compare new HTTP/WS
   handshakes before/after expiry. Hold a separate socket across expiry and report
   whether it survives. Provider credential expiry is not gateway lease expiry.
10. Revoke exact installation hostnames, check each returns 404, delete only the
    labeled disposable sandbox, confirm per-ID 404, independently query D1 for
    tracked hostnames and delete only their pending auth flows. Retain ledger until
    every deletion is confirmed; remove credential manifest after cleanup.
"""


def emit(case, **fields):
    print(json.dumps({"case": case, **fields}), flush=True)


def origin(url):
    p = urlsplit(url)
    return f"{p.scheme}://{p.netloc}"


def forbidden(manifest):
    values = list(manifest.get("forbidden_body_values", []))
    for name in ("nanobot", "dufs", "short_lease"):
        app = manifest.get(name, {})
        for key in ("direct", "alternate"):
            if app.get(key):
                host = urlsplit(app[key]).hostname
                label = host.split(".")[0]
                values.extend([host, label, label.split("-", 1)[-1]])
        for key in ("authorization", "cookie"):
            if app.get(key):
                values.append(app[key])
    return [v.encode().lower() for v in values if v]


async def http_probe(client, case, url, path, headers, needles, proof=None, bootstrap=False):
    try:
        # Bound response memory. Truncation means incomplete containment evidence.
        async with client.stream("GET", url.rstrip("/") + path, headers=headers) as r:
            data = bytearray()
            complete = True
            async for part in r.aiter_bytes():
                data.extend(part)
                if len(data) > 2 * 1024 * 1024:
                    complete = False
                    break
            result = {"status": r.status_code, "body_scan_complete": complete,
                      "sensitive_body_match": any(n in data.lower() for n in needles)}
            if proof is not None:
                result["proof_matches"] = complete and bytes(data) == proof.encode()
            if bootstrap and r.status_code == 200 and complete:
                try:
                    payload = json.loads(data)
                    result["bootstrap_json"] = isinstance(payload, dict)
                    if isinstance(payload, dict):
                        result["has_bootstrap_token"] = bool(payload.get("token"))
                        result["has_api_token"] = bool(payload.get("api_token"))
                except (ValueError, UnicodeDecodeError):
                    result["bootstrap_json"] = False
            emit(case, **result)
    except Exception:
        emit(case, transport_error=True)


async def ws_probe(case, url, headers, needles):
    from websockets.asyncio.client import connect
    from websockets.exceptions import InvalidStatus
    ws_url = "wss://" + urlsplit(url).netloc + "/"
    try:
        async with connect(ws_url, origin=origin(url), additional_headers=headers,
                           open_timeout=12, close_timeout=3, proxy=None) as ws:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=2)
            except TimeoutError:
                # Nanobot validates this empty ID before any session mutation or
                # agent turn. Distinguish lost initial frames from a failed upgrade.
                await ws.send(json.dumps({"type": "attach", "chat_id": ""}))
                raw = await asyncio.wait_for(ws.recv(), timeout=8)
                p = json.loads(raw)
                emit(case, upgraded=True, ready_timeout=True,
                     invalid_attach_error=p.get("event") == "error" and p.get("detail") == "invalid chat_id")
                return
            wire = raw.encode() if isinstance(raw, str) else raw
            try:
                payload = json.loads(wire)
                ready = isinstance(payload, dict) and payload.get("event") == "ready"
            except (ValueError, UnicodeDecodeError):
                ready = False
            emit(case, upgraded=True, ready=ready,
                 sensitive_body_match=any(n in wire.lower() for n in needles))
            # No chat messages, inference, or chat writes.
    except InvalidStatus as error:
        emit(case, upgraded=False, status=error.response.status_code)
    except Exception:
        emit(case, transport_error=True)


async def serve_peer(port):
    """Disposable Linux fixture. Expectations enter via env, never argv/logs."""
    import logging
    from websockets.asyncio.server import serve
    logging.getLogger("websockets").setLevel(logging.CRITICAL)
    assertion_name = "X-Authenticated-Owner"
    assertion_value = os.environ.get("QUALIFICATION_ASSERTION", "true")
    authorization = os.environ.get("QUALIFICATION_AUTHORIZATION", "")

    def evidence(connection, request):
        peer = connection.remote_address
        assertions = request.headers.get_all(assertion_name)
        authorizations = request.headers.get_all("Authorization")
        return json.dumps({"peer_ip": peer[0] if isinstance(peer, tuple) else None,
                           "assertion_exact": assertions == [assertion_value],
                           "authorization_exact": bool(authorization) and authorizations == [authorization],
                           "assertion_count": len(assertions),
                           "authorization_count": len(authorizations)})

    async def process_request(connection, request):
        if request.headers.get("Upgrade", "").lower() != "websocket":
            return connection.respond(200, evidence(connection, request))

    async def handler(connection):
        await connection.send(evidence(connection, connection.request))
        async for _ in connection:
            await connection.send(evidence(connection, connection.request))

    async with serve(handler, "0.0.0.0", port, process_request=process_request):
        await asyncio.Future()


async def run(manifest):
    import httpx
    needles = forbidden(manifest)
    async with httpx.AsyncClient(timeout=20, follow_redirects=False, trust_env=False,
                                 headers={"User-Agent": "BayLeaf-Preview-Qualification/1.0"}) as client:
        for name in ("nanobot", "dufs"):
            app = manifest[name]
            path = "/webui/bootstrap" if name == "nanobot" else app["proof_path"]
            for route in ("wrapped", "direct", "alternate"):
                if not app.get(route):
                    continue
                url = app[route]
                base = {"Origin": origin(url)}
                if route == "wrapped" and app.get("cookie"):
                    base["Cookie"] = app["cookie"]
                if name == "nanobot":
                    variants = {"absent": {}, "spoof": {app["assertion_header"].swapcase(): "attacker"}}
                else:
                    variants = {"absent": {}, "wrong": {"aUtHoRiZaTiOn": "Basic d3Jvbmc6d3Jvbmc="}}
                    if route != "wrapped":
                        variants["valid"] = {"Authorization": app["authorization"]}
                for variant, extra in variants.items():
                    headers = {**base, **extra}
                    case = f"{name}.{route}.{variant}"
                    await http_probe(client, case + ".http", url, path, headers, needles,
                                     proof=app.get("proof_text"), bootstrap=name == "nanobot")
                    if name == "nanobot":
                        await ws_probe(case + ".ws", url,
                                       {k: v for k, v in headers.items() if k != "Origin"}, needles)
        lease = manifest.get("short_lease")
        if lease:
            wait = lease["expires_at"] - time.time() + 5
            if not 0 < wait <= 180:
                emit("expiry", skipped=True, reason="deadline_outside_bounded_window")
            else:
                for phase in ("before", "after"):
                    if phase == "after":
                        await asyncio.sleep(max(0, lease["expires_at"] - time.time() + 5))
                    for route in ("direct", "wrapped"):
                        await http_probe(client, f"expiry.{phase}.{route}", lease[route], "/", {}, needles)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--worker-version")
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--serve-peer", type=int, metavar="PORT",
                        help="serve metadata fixture only inside the disposable sandbox")
    args = parser.parse_args()
    if args.serve_peer is not None:
        if not 1024 <= args.serve_peer <= 65535:
            parser.error("fixture port must be 1024–65535")
        asyncio.run(serve_peer(args.serve_peer))
        return
    if not args.live:
        print(PLAN)
        return
    if not args.worker_version or not args.manifest:
        parser.error("live mode requires deployment handoff and private manifest")
    info = args.manifest.stat()
    if stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
        parser.error("manifest must be owned by this user with mode 0600")
    try:
        manifest = json.loads(args.manifest.read_text())
        for name in ("nanobot", "dufs"):
            for key in ("wrapped", "direct"):
                p = urlsplit(manifest[name][key])
                if p.scheme != "https" or not p.hostname or p.username or p.password:
                    raise ValueError()
        # Do not print arbitrary caller-supplied manifest data, even on errors.
        asyncio.run(run(manifest))
    except KeyboardInterrupt:
        emit("run", interrupted=True, cleanup_still_required=True)
    except Exception:
        emit("run", failed=True, cleanup_still_required=True)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
