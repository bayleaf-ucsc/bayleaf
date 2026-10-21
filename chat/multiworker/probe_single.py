"""Direct upstream toolkit, one-worker workflow, explicitly no Redis state."""

import json
import uuid

import httpx

A, B = "http://worker-a:8080", "http://worker-b:8080"
chat = "single-" + uuid.uuid4().hex
checks = []


def record(name, passed):
    assert passed, name
    checks.append({"check": name, "passed": True})


with httpx.Client(timeout=10) as client:
    for base in (A, B):
        r = client.get(base + "/health")
        r.raise_for_status()
        record("Upstream memory mode on " + base, r.json()["mode"] == "upstream-memory")
    r = client.post(A + "/gws/init", params={"chat": chat})
    r.raise_for_status()
    nonce = r.json()["state"]
    callback = A + "/api/v1/x/gws_toolkit/oauth/callback"
    params = {"state": nonce, "code": "synthetic-code"}
    record("Same-worker authorization succeeds without Redis", client.get(callback, params=params).status_code == 200)
    record("Nonce replay rejected without Redis", client.get(callback, params=params).status_code == 400)
    r = client.get(A + "/gws/action", params={"chat": chat})
    r.raise_for_status()
    record("Calendar action succeeds without Redis", "Lab Calendar" in r.json()["output"])
    r = client.get(B + "/gws/status", params={"chat": chat})
    r.raise_for_status()
    record("Memory fallback is honestly process-local", not r.json()["authorized"])
    client.post(A + "/gws/clear", params={"chat": chat}).raise_for_status()
    r = client.get(A + "/gws/status", params={"chat": chat})
    r.raise_for_status()
    record("Clearing cached access works without Redis", not r.json()["authorized"])

print(json.dumps({"scope": "upstream single-worker memory compatibility", "results": checks}, indent=2))
