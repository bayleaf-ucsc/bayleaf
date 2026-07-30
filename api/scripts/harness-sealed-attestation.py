#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tinfoil", "certifi", "httpx"]
# ///
"""
BayLeaf Sealed: unapproved-attestation test (issue #55, demonstration 3c).

The Sealed lane relays the attestation bundle so a client needs exactly one
network dependency. That is only acceptable if relaying does NOT make BayLeaf
trusted. This test attacks that assumption directly: it stands up a local https
server that serves MUTATED attestation bundles in place of BayLeaf's, and
asserts the SDK refuses to establish a session.

If any mutation were accepted, a malicious relay could substitute its own HPKE
key and read everything.
"""
import copy
import http.server
import json
import os
import ssl
import sys
import threading

_ca = os.environ["SEALED_CA"]
import certifi

_combined = os.path.join(os.path.dirname(os.path.abspath(_ca)), "combined-ca.pem")
with open(_combined, "w") as out:
    out.write(open(certifi.where()).read())
    out.write("\n")
    out.write(open(_ca).read())
os.environ["SSL_CERT_FILE"] = _combined
os.environ["REQUESTS_CA_BUNDLE"] = _combined

import httpx  # noqa: E402
from tinfoil.client import SecureClient  # noqa: E402

BASE = os.environ.get("SEALED_BASE", "https://localhost:8787/sealed")
PORT = int(os.environ.get("SEALED_TAMPER_PORT", "8799"))
CERT = os.path.abspath(_ca)
# The rogue server needs a cert of its own. Defaults to the dev key sitting
# beside the dev cert, which is how the TESTING.md recipe generates them.
KEY = os.environ.get("SEALED_KEY") or os.path.join(os.path.dirname(CERT), "dev-key.pem")

# Pull the genuine bundle through BayLeaf's relay first.
with httpx.Client(verify=_combined, timeout=60.0) as hc:
    GENUINE = hc.get(f"{BASE}/attestation").json()
print(f"genuine bundle: domain={GENUINE['domain']} keys={sorted(GENUINE.keys())}")

# Baseline: the genuine bundle must verify, or the test proves nothing.
sc = SecureClient(base_url=f"{BASE}/v1/", attestation_bundle_url=BASE)
gt = sc.verify()
GENUINE_HPKE = gt.hpke_public_key
print(f"baseline verify OK: enclave={sc.enclave} hpke={GENUINE_HPKE[:16]}...")


def mutate_digest(b):
    b = copy.deepcopy(b)
    d = list(b["digest"])
    d[0] = "0" if d[0] != "0" else "1"
    b["digest"] = "".join(d)
    return b


def mutate_report_body(b):
    b = copy.deepcopy(b)
    body = b["enclaveAttestationReport"]["body"]
    b["enclaveAttestationReport"]["body"] = ("A" if body[0] != "A" else "B") + body[1:]
    return b


def mutate_domain(b):
    b = copy.deepcopy(b)
    b["domain"] = "evil.example.com"
    return b


def strip_sigstore(b):
    b = copy.deepcopy(b)
    b["sigstoreBundle"] = {}
    return b


def strip_cert(b):
    b = copy.deepcopy(b)
    b.pop("enclaveCert", None)
    return b


MUTATIONS = [
    ("flipped digest", mutate_digest),
    ("flipped SEV-SNP report body", mutate_report_body),
    ("substituted domain", mutate_domain),
    ("emptied Sigstore bundle", strip_sigstore),
    ("removed enclave certificate", strip_cert),
]

served: dict = {"bundle": GENUINE}


class Handler(http.server.BaseHTTPRequestHandler):
    def _serve(self):
        payload = json.dumps(served["bundle"]).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):  # noqa: N802
        self._serve()

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        self._serve()

    def log_message(self, *a):  # silence
        pass


ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.minimum_version = ssl.TLSVersion.TLSv1_2
ctx.load_cert_chain(CERT, KEY)
httpd = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
EVIL = f"https://localhost:{PORT}"

failures = []

# Control: the rogue server serving the GENUINE bundle must still verify. This
# proves the rejections below come from bundle contents, not from the fact that
# a different host served it.
#
# Note: do NOT compare the HPKE key against the baseline run. atc's GET is
# non-deterministic about which enclave it returns (observed alternating between
# router.inf6.tinfoil.sh and inference.tinfoil.sh), so two fetches legitimately
# yield different enclaves and therefore different keys.
try:
    sc2 = SecureClient(base_url=f"{BASE}/v1/", attestation_bundle_url=EVIL)
    gt2 = sc2.verify()
    ok = bool(gt2.hpke_public_key)
    print(
        f"  [{'PASS' if ok else 'FAIL'}] control: genuine bundle from a different host still verifies"
        f" (enclave={sc2.enclave})"
    )
    if not ok:
        failures.append("control")
except Exception as exc:  # noqa: BLE001
    print(f"  [FAIL] control: genuine bundle rejected ({type(exc).__name__}: {exc})")
    failures.append("control")

print("\n=== mutated bundles must all be refused ===")
for name, fn in MUTATIONS:
    served["bundle"] = fn(GENUINE)
    try:
        sc3 = SecureClient(base_url=f"{BASE}/v1/", attestation_bundle_url=EVIL)
        gt3 = sc3.verify()
        # Accepted, which is a failure. Report whether the key it handed back
        # differs from the baseline, since a substituted key is the actual harm.
        leaked = gt3.hpke_public_key != GENUINE_HPKE
        print(f"  [FAIL] {name}: ACCEPTED (hpke differs from baseline: {leaked})")
        failures.append(name)
    except Exception as exc:  # noqa: BLE001
        print(f"  [PASS] {name}: refused ({type(exc).__name__})")

httpd.shutdown()

print("\n=== summary ===")
if failures:
    print(f"{len(failures)} failure(s): {failures}")
    sys.exit(1)
print("all mutated attestation bundles were refused client-side")
print("=> relaying the bundle does not make BayLeaf a trusted party")
