#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tinfoil", "certifi", "httpx"]
# ///
"""
BayLeaf Sealed conformance harness (issue #55).

Exercises the three demonstrations the issue asked for, plus the negative tests
that make the lane's claim falsifiable rather than merely asserted:

  1. A normal encrypted completion succeeds through the relay.
  2. The Worker observes only ciphertext, yet still receives usage metadata.
  3. Plaintext, tampered ciphertext, and destination substitution fail closed.

Run against a local `wrangler dev` over https (the Tinfoil SDK hard-requires an
https attestation bundle URL, so plain http localhost will not work):

    npx wrangler dev --local-protocol https \
      --https-cert-path <cert> --https-key-path <key>

    SEALED_CA=<cert> ./harness-sealed.py

Exit code is nonzero if any check fails.
"""
import binascii
import json
import os
import sys

# Local dev trust. Must combine certifi's roots WITH the dev cert: attestation
# verification also reaches Sigstore's TUF CDN over real TLS, and a
# dev-cert-only bundle fails with "Failed to refresh TUF metadata". Set inside
# the process, never exported, or uv's own dependency resolution breaks.
_ca = os.environ.get("SEALED_CA")
if _ca:
    import certifi

    _combined = os.path.join(os.path.dirname(os.path.abspath(_ca)), "combined-ca.pem")
    with open(_combined, "w") as out:
        out.write(open(certifi.where()).read())
        out.write("\n")
        out.write(open(_ca).read())
    os.environ["SSL_CERT_FILE"] = _combined
    os.environ["REQUESTS_CA_BUNDLE"] = _combined

import httpx  # noqa: E402
from tinfoil import TinfoilAI  # noqa: E402
from tinfoil.client import SecureClient  # noqa: E402
from ehbp.identity import ServerIdentity  # noqa: E402

BASE = os.environ.get("SEALED_BASE", "https://localhost:8787/sealed")
RELAY = f"{BASE}/v1/chat/completions"

# How the harness authenticates TO BayLeaf (distinct from the credential BayLeaf
# uses upstream, which the client never sees). Defaults to Campus Pass, which is
# what works against a local `wrangler dev` with DEV_LOOPBACK_AUTH.
#
# Set SEALED_AUTH=sk-bayleaf-... to exercise the KEYED path instead. That matters
# because the two modes resolve their upstream credential differently: a keyed
# caller gets a per-user Tinfoil key minted on first use of the lane, while Campus
# Pass shares an env-held pool key. Only the keyed path exercises minting, the
# compare-and-swap, and healing. It is also the only mode that works against a
# deployed instance from off-campus.
AUTH = os.environ.get("SEALED_AUTH", "campus")

# A distinctive string we can search for in the bytes that traverse the relay.
CANARY = "PINEAPPLE-QUASAR-7734"

results: list[tuple[bool, str, str]] = []


def check(passed: bool, name: str, detail: str = "") -> None:
    results.append((passed, name, detail))
    mark = "PASS" if passed else "FAIL"
    print(f"  [{mark}] {name}" + (f" — {detail}" if detail else ""), flush=True)


# ─────────────────────────────────────────────────────────────────────────────
# Setup: verify attestation through the relay and grab the enclave HPKE key.
# ─────────────────────────────────────────────────────────────────────────────
print("\n=== setup: attestation via the relay ===")
sc = SecureClient(base_url=f"{BASE}/v1/", attestation_bundle_url=BASE)
ground_truth = sc.verify()
ENCLAVE = sc.enclave
HPKE_HEX = ground_truth.hpke_public_key
check(bool(ENCLAVE), "attestation bundle verified client-side", f"enclave={ENCLAVE}")
check(bool(HPKE_HEX), "enclave exposed an HPKE public key", f"{HPKE_HEX[:16]}...")


def seal(payload: dict) -> tuple[bytes, str]:
    """HPKE-seal a JSON payload to the attested enclave key."""
    identity = ServerIdentity.from_public_key_hex(HPKE_HEX)
    enc = identity.encrypt_request_body(json.dumps(payload).encode())
    return enc.body, enc.encapsulated_key.hex()


def sealed_headers(encap: str, **over: str) -> dict:
    h = {
        "Authorization": f"Bearer {AUTH}",
        "Content-Type": "application/json",
        "Ehbp-Encapsulated-Key": encap,
        "X-Tinfoil-Enclave-Url": f"https://{ENCLAVE}",
    }
    h.update(over)
    return h


PAYLOAD = {
    "model": "gpt-oss-120b",
    "messages": [{"role": "user", "content": f"Reply with exactly: {CANARY}"}],
    "max_tokens": 128,
    "temperature": 0,
}

# ─────────────────────────────────────────────────────────────────────────────
# 1. A normal encrypted completion succeeds, via the real SDK.
# ─────────────────────────────────────────────────────────────────────────────
print("\n=== 1. encrypted completion succeeds ===")
client = TinfoilAI(api_key=AUTH, base_url=f"{BASE}/v1/", attestation_bundle_url=BASE)
resp = client.chat.completions.create(**PAYLOAD)
content = (resp.choices[0].message.content or "").strip()
check(CANARY in content.upper(), "SDK round trip returned the expected completion", repr(content))
check(resp.usage.total_tokens > 0, "client saw token usage", f"total={resp.usage.total_tokens}")

# ─────────────────────────────────────────────────────────────────────────────
# 2. The relay carries ciphertext, but still gets usage metadata.
#
# These are the exact bytes the Worker handles. If a malicious revision logged
# the request body, this is what it would capture.
# ─────────────────────────────────────────────────────────────────────────────
print("\n=== 2. relay sees ciphertext, not content ===")
body, encap = seal(PAYLOAD)
with httpx.Client(timeout=120.0) as hc:
    r = hc.post(RELAY, headers=sealed_headers(encap, **{"X-Tinfoil-Request-Usage-Metrics": "true"}), content=body)
raw_resp = r.content

check(r.status_code == 200, "relay returned 200", f"status={r.status_code}")
check(
    CANARY.encode() not in body,
    "prompt canary absent from the request bytes crossing the relay",
    f"{len(body)} bytes, first4={binascii.hexlify(body[:4]).decode()}",
)
check(
    b'"messages"' not in body and b'"model"' not in body,
    "no JSON request structure visible in the relayed bytes",
)
check(
    CANARY.encode() not in raw_resp,
    "completion canary absent from the response bytes crossing the relay",
    f"{len(raw_resp)} bytes",
)
check(
    b'"choices"' not in raw_resp,
    "no JSON response structure visible in the relayed bytes",
)
# Framing sanity: length-prefixed AES-GCM chunk, per EHBP body framing.
frame_len = int.from_bytes(raw_resp[:4], "big") if len(raw_resp) >= 4 else -1
check(frame_len == len(raw_resp) - 4, "response is a well-formed EHBP frame", f"frame={frame_len}")

usage = r.headers.get("x-tinfoil-usage-metrics")
check(bool(usage), "relay received usage metadata without decrypting", usage or "absent")
check(
    r.headers.get("x-bayleaf-sealed-relay") == "ciphertext",
    "relay self-reports ciphertext mode",
)
check(
    r.headers.get("content-encoding") == "identity",
    "compression suppressed so ciphertext stays byte-exact",
    r.headers.get("content-encoding") or "absent",
)

# ─────────────────────────────────────────────────────────────────────────────
# 3. Negative tests. Every one of these must fail CLOSED, never downgrade.
# ─────────────────────────────────────────────────────────────────────────────
print("\n=== 3. failure modes ===")
with httpx.Client(timeout=120.0) as hc:
    # 3a. Plaintext body with no EHBP headers. The single most important test:
    # this is what "no plaintext fallback" means operationally.
    r = hc.post(RELAY, headers={"Authorization": f"Bearer {AUTH}", "Content-Type": "application/json"}, json=PAYLOAD)
    check(r.status_code == 400, "plaintext request rejected", f"status={r.status_code}")
    check(CANARY not in r.text, "rejection did not echo the prompt back")

    # 3b. Bodyless GET. Must not be served: without an encrypted request body
    # the encapsulated key is unauthenticated and an intermediary could
    # substitute its own, making the response readable to the relay.
    r = hc.get(RELAY, headers={"Authorization": f"Bearer {AUTH}"})
    check(r.status_code == 405, "bodyless GET on the ciphertext route rejected", f"status={r.status_code}")

    # 3c. Malformed encapsulated key.
    body, encap = seal(PAYLOAD)
    r = hc.post(RELAY, headers=sealed_headers("not-hex"), content=body)
    check(r.status_code == 400, "malformed Ehbp-Encapsulated-Key rejected", f"status={r.status_code}")

    # 3d. Missing encapsulated key entirely, with a genuinely encrypted body.
    h = sealed_headers(encap)
    del h["Ehbp-Encapsulated-Key"]
    r = hc.post(RELAY, headers=h, content=body)
    check(r.status_code == 400, "missing Ehbp-Encapsulated-Key rejected", f"status={r.status_code}")

    # 3e. Destination substitution: non-Tinfoil host.
    body, encap = seal(PAYLOAD)
    r = hc.post(RELAY, headers=sealed_headers(encap, **{"X-Tinfoil-Enclave-Url": "https://evil.example.com"}), content=body)
    check(r.status_code == 400, "unapproved enclave host rejected", f"status={r.status_code}")

    # 3f. Destination substitution: lookalike domain suffix.
    r = hc.post(RELAY, headers=sealed_headers(encap, **{"X-Tinfoil-Enclave-Url": "https://tinfoil.sh.evil.example.com"}), content=body)
    check(r.status_code == 400, "lookalike enclave host rejected", f"status={r.status_code}")

    # 3g. Downgrade to plaintext transport for the upstream hop.
    r = hc.post(RELAY, headers=sealed_headers(encap, **{"X-Tinfoil-Enclave-Url": "http://inference.tinfoil.sh"}), content=body)
    check(r.status_code == 400, "non-https enclave URL rejected", f"status={r.status_code}")

    # 3h. Missing enclave header.
    h = sealed_headers(encap)
    del h["X-Tinfoil-Enclave-Url"]
    r = hc.post(RELAY, headers=h, content=body)
    check(r.status_code == 400, "missing X-Tinfoil-Enclave-Url rejected", f"status={r.status_code}")

    # 3i. Client tries to supply its own Tinfoil credential. BayLeaf must not
    # launder an unmetered provider key.
    body, encap = seal(PAYLOAD)
    r = hc.post(RELAY, headers=sealed_headers(encap, Authorization="Bearer tk_bogus_client_supplied"), content=body)
    check(r.status_code == 403, "client-supplied Tinfoil credential rejected", f"status={r.status_code}")

    # 3j. Tampered ciphertext. BayLeaf cannot detect this and does not try; the
    # enclave is the authority. What matters is that it does NOT succeed and
    # does NOT fall back to a readable path.
    body, encap = seal(PAYLOAD)
    tampered = bytearray(body)
    tampered[len(tampered) // 2] ^= 0xFF
    r = hc.post(RELAY, headers=sealed_headers(encap), content=bytes(tampered))
    check(r.status_code >= 400, "tampered ciphertext rejected upstream", f"status={r.status_code}")
    check(CANARY not in r.text, "tampered request produced no plaintext leak")

    # 3k. Truncated ciphertext frame.
    r = hc.post(RELAY, headers=sealed_headers(encap), content=body[: len(body) // 2])
    check(r.status_code >= 400, "truncated ciphertext rejected", f"status={r.status_code}")

# ─────────────────────────────────────────────────────────────────────────────
# 4. Streaming. Usage for streamed responses arrives in an HTTP trailer, which
# the Workers runtime may not surface. Recorded rather than asserted.
# ─────────────────────────────────────────────────────────────────────────────
print("\n=== 4. streaming ===")
try:
    chunks = []
    stream = client.chat.completions.create(**{**PAYLOAD, "stream": True})
    for event in stream:
        if event.choices and event.choices[0].delta.content:
            chunks.append(event.choices[0].delta.content)
    streamed = "".join(chunks).strip()
    check(CANARY in streamed.upper(), "streamed encrypted completion succeeded", repr(streamed[:60]))
except Exception as exc:  # noqa: BLE001
    check(False, "streamed encrypted completion succeeded", f"{type(exc).__name__}: {exc}")

body, encap = seal({**PAYLOAD, "stream": True})
with httpx.Client(timeout=120.0) as hc:
    r = hc.post(RELAY, headers=sealed_headers(encap, **{"X-Tinfoil-Request-Usage-Metrics": "true"}), content=body)
    _ = r.content
    stream_usage = r.headers.get("x-tinfoil-usage-metrics")
    visible = r.headers.get("x-bayleaf-sealed-usage-visible")
print(f"  [INFO] streaming usage header: {stream_usage or 'ABSENT (trailer not surfaced)'}")
print(f"  [INFO] relay usage visibility: {visible}")

# ─────────────────────────────────────────────────────────────────────────────
print("\n=== summary ===")
failed = [name for ok, name, _ in results if not ok]
print(f"{len(results) - len(failed)}/{len(results)} checks passed")
if failed:
    for name in failed:
        print(f"  FAILED: {name}")
    sys.exit(1)
print("all checks passed")
