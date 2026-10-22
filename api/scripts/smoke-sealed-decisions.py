#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tinfoil>=0.15.0"]
# ///
"""Sealed decision qualification with synthetic content.

The Tinfoil SDK verifies attestation through BayLeaf and EHBP-encrypts the
decision request; the relay at /sealed/v1/* forwards ciphertext unchanged.
Source ~/.tokens/bayleaf-api first (or BAYLEAF_API_KEY=campus on campus).
Never prints or persists credentials.
"""
import os

import httpx
from tinfoil import TinfoilAI

BASE = os.environ.get("SEALED_BASE", "https://api.bayleaf.dev/sealed").rstrip("/")
KEY = os.environ["BAYLEAF_API_KEY"]
MODELS = os.environ.get("SEALED_DECISION_MODELS", "decision-small,decision-medium,decision-large").split(",")
INPUT = "Synthetic test: checkout returns HTTP 503 for every customer right now."
QUESTIONS = [
    {"type": "predicate", "name": "outage", "instructions": "Is a service currently unavailable?"},
    {"type": "choice", "name": "team", "instructions": "Which team should investigate?",
     "choices": [{"value": "engineering"}, {"value": "accounts"}]},
    {"type": "score", "name": "severity", "instructions": "Rate the current service disruption.",
     "levels": [{"label": "none"}, {"label": "some users affected"}, {"label": "all users blocked"}]},
]
results = []


def check(passed: bool, name: str, detail: str = "") -> None:
    results.append(passed)
    print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f": {detail}" if detail else ""), flush=True)


catalog = httpx.get(f"{BASE}/models", timeout=30).json()["data"]
listed = {m["id"] for m in catalog if "/v1/decisions" in m.get("endpoints", [])}
check(set(MODELS) <= listed, "catalog lists decision models with /v1/decisions", ", ".join(sorted(listed)))

client = TinfoilAI(api_key=KEY, base_url=f"{BASE}/v1/", attestation_bundle_url=BASE)
check(bool(client.enclave), "attestation verified through the relay", client.enclave)

for model in MODELS:
    raw = client.decisions.with_raw_response.create(model=model, input=INPUT, questions=QUESTIONS)
    decision = raw.parse()
    answers = {a.name: a for a in decision.answers}
    check(raw.headers.get("x-bayleaf-sealed-relay") == "ciphertext", f"{model}: relayed as ciphertext")
    check(set(answers) == {"outage", "team", "severity"}, f"{model}: all three typed answers",
          f"p(outage)={answers['outage'].probability:.3f} team={answers['team'].choice} "
          f"severity={answers['severity'].score:.2f}")
    # What the relay could see: token metadata only, never the answers.
    check(bool(raw.headers.get("x-tinfoil-usage-metrics")), f"{model}: usage metadata visible to relay",
          raw.headers.get("x-tinfoil-usage-metrics", "none"))

# Plaintext must be refused, not downgraded.
r = httpx.post(f"{BASE}/v1/decisions", headers={"Authorization": f"Bearer {KEY}"},
               json={"model": MODELS[0], "input": INPUT, "questions": QUESTIONS[:1]}, timeout=30)
check(r.status_code == 400, "plaintext decision request rejected", str(r.status_code))

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
