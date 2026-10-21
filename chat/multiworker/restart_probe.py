"""Host-side restart experiment, stdlib only. Run after enabling Redis mode.

Only restarts this lab's two adapters. Valkey and fixtures remain running.
No Docker socket is mounted into the lab containers.
"""

import json
import subprocess
import uuid
from pathlib import Path

compose = ["docker", "compose", "-f", str(Path(__file__).with_name("compose.yaml"))]
chat = "restart-" + uuid.uuid4().hex


def request(worker, method, path, **params):
    code = (
        "import httpx,json; "
        f"r=httpx.request({method!r}, 'http://{worker}:8080{path}', params={params!r}, timeout=10); "
        "print(json.dumps({'status':r.status_code,'body':r.text}))"
    )
    raw = subprocess.check_output(compose + ["exec", "-T", "worker-a", "python", "-c", code], text=True)
    return json.loads(raw)


for worker in ("worker-a", "worker-b"):
    health = request(worker, "GET", "/health")
    assert json.loads(health["body"])["mode"] in {"redis", "upstream"}, "Enable a Redis-capable mode first"

def start():
    result = request("worker-b", "POST", "/gws/init", chat=chat)
    assert result["status"] == 200, result
    return json.loads(result["body"])["state"]


callback = "/api/v1/x/gws_toolkit/oauth/callback"
nonce = start()
assert request("worker-a", "GET", callback, state=nonce, code="synthetic-code")["status"] == 200
pending = start()
subprocess.run(compose + ["restart", "worker-a", "worker-b"], check=True)
subprocess.run(compose + ["up", "-d", "--wait", "--no-recreate", "worker-a", "worker-b"], check=True)
for worker in ("worker-a", "worker-b"):
    result = request(worker, "GET", "/gws/status", chat=chat)
    assert result["status"] == 200 and json.loads(result["body"])["authorized"], result
result = request("worker-b", "GET", callback, state=pending, code="synthetic-code")
assert result["status"] == 200, result
assert request("worker-a", "GET", callback, state=pending, code="synthetic-code")["status"] == 400
request("worker-a", "POST", "/gws/clear", chat=chat)
print(json.dumps({"token_survives_both_worker_restarts": True,
                  "pending_flow_survives_both_worker_restarts": True,
                  "callback_route_present_after_restart": True,
                  "replay_still_rejected": True}, indent=2))
