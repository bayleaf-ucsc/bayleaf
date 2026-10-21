# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx==0.28.1"]
# ///
"""Run inside worker-a with docker compose exec. Expected failures are asserted."""

import json
import uuid

import httpx

A, B = "http://worker-a:8080", "http://worker-b:8080"
chat = "probe-" + uuid.uuid4().hex
results = []


def record(name, passed, **details):
    results.append({"check": name, "passed": passed, **details})
    assert passed, results[-1]


with httpx.Client(timeout=30) as client:
    for base in (A, B):
        response = client.get(base + "/health")
        response.raise_for_status()
        record("Baseline mode and Valkey available on " + base,
               response.json()["mode"] == "baseline" and response.json()["redis"])

    def init(base):
        r = client.post(base + "/gws/init", params={"chat": chat})
        r.raise_for_status()
        return r.json()["state"]

    def callback(base, nonce):
        return client.get(base + "/api/v1/x/gws_toolkit/oauth/callback",
                          params={"state": nonce, "code": "synthetic-code"})

    nonce = init(A)
    r = callback(B, nonce)
    record("Cold worker has no callback route", r.status_code == 404,
           observed_status=r.status_code)
    init(B)
    r = callback(B, nonce)
    record("Warm worker cannot consume A's nonce", r.status_code == 400 and
           "Expired or invalid state" in r.text, observed_status=r.status_code)
    r = callback(A, nonce)
    record("Origin worker completes same authorization", r.status_code == 200,
           observed_status=r.status_code)
    r = callback(A, nonce)
    record("Consumed nonce rejects replay", r.status_code == 400)
    for base, expected in ((A, True), (B, False)):
        r = client.get(base + "/gws/status", params={"chat": chat})
        r.raise_for_status()
        record("Token visibility on " + base, r.json()["authorized"] == expected,
               authorized=r.json()["authorized"])

    def interpret(base, code):
        r = client.post(base + "/lathe/interpret", json={"chat": chat, "code": code})
        r.raise_for_status()
        return r.json()

    first = interpret(A, "x = 35")
    record("Lathe initializes interpreter on A", first["ok"])
    same = interpret(A, "print(x)")
    record("Same-worker interpreter retains x", same["ok"] and same["output"].strip() == "35")
    other = interpret(B, "print(x)")
    record("Cross-worker interpreter silently forks", not other["ok"] and
           "not defined" in other["output"] and other["context"] != first["context"] and
           "session was reset" not in other["output"], output=other["output"])
    back = interpret(A, "print(x)")
    record("Original interpreter still retains x", back["ok"] and back["output"].strip() == "35")

print(json.dumps({"scope": "unchanged toolkit internals, synthetic services", "results": results}, indent=2))
