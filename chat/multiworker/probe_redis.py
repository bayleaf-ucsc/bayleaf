"""Positive GWS state checks. Run inside worker A, with GWS_MODE=redis."""

import json
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx

A, B = "http://worker-a:8080", "http://worker-b:8080"
chat = "redis-probe-" + uuid.uuid4().hex
results = []
mode = None
CALLBACK = "/api/v1/x/gws_toolkit/oauth/callback"


def record(name, passed, **details):
    results.append({"check": name, "passed": passed, **details})
    assert passed, results[-1]


with httpx.Client(timeout=10) as client:
    def init(base=A, cid=chat, user="synthetic-user"):
        r = client.post(base + "/gws/init", params={"chat": cid, "user": user})
        r.raise_for_status()
        return r.json()["state"]

    def callback(base, nonce):
        return client.get(base + CALLBACK, params={"state": nonce, "code": "synthetic-code"})

    def status(base, cid=chat, user="synthetic-user"):
        r = client.get(base + "/gws/status", params={"chat": cid, "user": user})
        r.raise_for_status()
        return r.json()["authorized"]

    for base in (A, B):
        r = client.get(base + "/health")
        r.raise_for_status()
        mode = r.json()["mode"]
        record("Redis-capable mode and Valkey healthy on " + base,
               mode in {"redis", "upstream"} and r.json()["redis"])

    # Never initialize a flow on B before this callback: exercises eager routes.
    nonce = init()
    r = callback(B, nonce)
    record("A init, cold B callback succeeds", r.status_code == 200)
    for base in (A, B):
        record("Shared token visible on " + base, status(base))
        r = client.get(base + "/gws/tool-status", params={"chat": chat})
        r.raise_for_status()
        record("Actual authorize status method reads shared token on " + base,
               "Authorized in this chat: calendar.readonly" in r.json()["output"])
        r = client.get(base + "/gws/action", params={"chat": chat})
        r.raise_for_status()
        record("Actual calendar action uses shared token on " + base,
               "Lab Calendar" in r.json()["output"])
    record("Replay rejected on other worker", callback(A, nonce).status_code == 400)
    record("Separate chat remains unauthorized", not status(B, cid=chat + "-other"))
    record("Separate user remains unauthorized", not status(B, user="other-user"))
    r = client.get(B + "/gws/action", params={"chat": chat, "user": "other-user"})
    r.raise_for_status()
    record("Calendar action denies another user", r.json()["output"].startswith("AUTH_REQUIRED:"))

    # Delimiter-bearing identities must not collide in the Redis key encoding.
    alias_chat = "c-" + uuid.uuid4().hex
    alias = init(cid=alias_chat, user="u:v")
    record("Delimiter-bearing identity authorizes", callback(B, alias).status_code == 200)
    record("Identity tuple cannot alias via colon", not status(A, cid="v:" + alias_chat, user="u"))

    racing = init(cid=chat + "-race")
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda base: callback(base, racing), (A, B)))
    codes = sorted(r.status_code for r in responses)
    record("Concurrent callbacks consume nonce exactly once", codes == [200, 400], statuses=codes)

    expiring = init(cid=chat + "-expire")
    r = client.post(A + "/lab/expire", params={"kind": "pending", "nonce": expiring})
    r.raise_for_status()
    record("Pending nonce has bounded ten-minute TTL", r.json()["changed"] and
           0 < r.json()["before_ms"] <= 600_000)
    time.sleep(0.15)
    record("Expired nonce rejected cross-worker", callback(B, expiring).status_code == 400)

    r = client.post(A + "/lab/expire", params={"kind": "token", "chat": chat})
    r.raise_for_status()
    record("Token TTL honors provider expiry minus safety margin", r.json()["changed"] and
           3_500_000 < r.json()["before_ms"] <= 3_540_000)
    time.sleep(0.15)
    record("Expired token absent on both workers", not status(A) and not status(B))

    # Restore a valid token, then simulate a client/network outage on B.
    nonce = init()
    record("Reauthorization succeeds", callback(B, nonce).status_code == 200)
    outage_nonce = init(cid=chat + "-outage")
    try:
        client.post(B + "/lab/redis-fault", params={"unavailable": "true"}).raise_for_status()
        r = client.get(B + "/gws/status", params={"chat": chat})
        record("Redis outage fails closed on token lookup", r.status_code == 503)
        r = client.get(B + "/gws/action", params={"chat": chat})
        record("Redis outage blocks calendar action", r.status_code == 503 or
               (r.status_code == 200 and r.json()["output"].startswith("AUTH_UNAVAILABLE:")))
        r = client.post(B + "/gws/init", params={"chat": chat + "-fault"})
        record("Redis outage fails closed on flow creation", r.status_code == 503)
        record("Redis outage fails closed on callback", callback(B, outage_nonce).status_code == 503)
        record("Healthy worker continues using shared token", status(A))
    finally:
        client.post(B + "/lab/redis-fault", params={"unavailable": "false"}).raise_for_status()
    record("Recovery reads original shared token", status(B))
    record("Unconsumed nonce survives failed Redis access", callback(B, outage_nonce).status_code == 200)

    client.post(B + "/gws/clear", params={"chat": chat}).raise_for_status()
    record("Clearing token on B revokes cached access on A", not status(A))

print(json.dumps({"scope": "GWS shared-state path", "mode": mode, "results": results}, indent=2))
