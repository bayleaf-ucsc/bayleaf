#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""One bounded, measured H200 snapshot boot. Creates and deletes its own sandbox."""

import argparse
import json
import os
from pathlib import Path
import time
from datetime import datetime, timezone

import httpx

API = "https://app.daytona.io/api"
TOOLBOX = "https://proxy.app.daytona.io/toolbox"
HERE = Path(__file__).resolve().parent
MODEL = "cyankiwi/Qwen3.8-27B-AWQ-INT4"
REVISION = "6e134bae811fb5adac50ee042ae5f029ac6779aa"


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", help="Named Daytona snapshot")
    parser.add_argument("--weights-in-snapshot", action="store_true")
    parser.add_argument("--spot", action="store_true", help="Default is on-demand")
    parser.add_argument("--eager", action="store_true", help="Separate startup optimization; changes serving configuration")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    token = os.environ.get("DAYTONA_API_KEY")
    token_file = Path.home() / ".tokens/daytona-api"
    if not token and token_file.exists():
        for line in token_file.read_text().splitlines():
            if line.startswith("DAYTONA_API_KEY="):
                token = line.split("=", 1)[1].strip().strip("\"'")
                break
    if not token:
        parser.error("DAYTONA_API_KEY unavailable")
    record = {"snapshot": args.snapshot, "spot": args.spot, "eager": args.eager,
              "weights_in_snapshot": args.weights_in_snapshot, "events": {}, "id": None}
    args.output.parent.mkdir(parents=True, exist_ok=True)

    def event(name, value=None):
        record["events"][name] = {"at": now(), "value": value}
        args.output.write_text(json.dumps(record, indent=2) + "\n")
        print(name, record["events"][name], flush=True)

    with httpx.Client(headers={"Authorization": f"Bearer {token}"}, timeout=45) as api:
        def execute(sid, command, timeout=120):
            r = api.post(f"{TOOLBOX}/{sid}/process/execute",
                         json={"command": command, "cwd": "/workspace", "timeout": timeout},
                         timeout=timeout + 30)
            r.raise_for_status()
            result = r.json()
            if result.get("exitCode") != 0:
                raise RuntimeError(f"remote command exited {result.get('exitCode')}: {result.get('result', '')[-1000:]}")
            return result.get("result", "")

        boot_start = time.monotonic()
        event("wake_requested")
        r = api.post(f"{API}/sandbox", json={
            "name": "bayleaf-qwen38-measured-" + str(int(time.time())),
            "snapshot": args.snapshot, "spot": args.spot,
            "autoStopInterval": 15, "autoDeleteInterval": 0,
        })
        r.raise_for_status()
        sid = r.json()["id"]
        record["id"] = sid
        event("allocated", {"state": r.json().get("state"), "gpuType": r.json().get("gpuType")})
        try:
            deadline = time.monotonic() + 900
            while time.monotonic() < deadline:
                r = api.get(f"{API}/sandbox/{sid}")
                r.raise_for_status()
                state = r.json()["state"]
                if state == "started":
                    event("started", {"gpuType": r.json().get("gpuType")})
                    break
                if state in ("error", "destroyed", "build_failed"):
                    raise RuntimeError(f"sandbox {state}: {r.json().get('errorReason')}")
                time.sleep(5)
            else:
                raise TimeoutError("sandbox did not start in 15 minutes")

            record["gpu"] = execute(sid, "nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader").strip()
            event("gpu_verified", record["gpu"])
            for filename in ("serve.sh", "bench.py"):
                with (HERE / filename).open("rb") as file:
                    r = api.post(f"{TOOLBOX}/{sid}/files/upload-v2",
                                 params={"path": f"/workspace/{filename}"},
                                 files={"file": (filename, file)})
                    r.raise_for_status()
            model_dir = "/models/model" if args.weights_in_snapshot else "/workspace/model"
            if args.weights_in_snapshot:
                event("weights_ready", execute(sid, "du -sh /models/model").strip())
            else:
                event("weight_transfer_start")
                execute(sid, f"hf download {MODEL} --revision {REVISION} --local-dir {model_dir} > /workspace/download.log 2>&1", 900)
                event("weights_ready", execute(sid, f"du -sh {model_dir}").strip())
            event("server_launch")
            execute(sid, f"nohup env EAGER={int(args.eager)} bash /workspace/serve.sh {model_dir} > /workspace/server.log 2>&1 < /dev/null & echo $!")
            deadline = time.monotonic() + 600
            while time.monotonic() < deadline:
                health = execute(sid, "if curl -fsS -m 2 http://127.0.0.1:8000/v1/models >/dev/null 2>&1; then echo READY; elif grep -q 'Engine core initialization failed' /workspace/server.log; then echo FAILED; else echo WAIT; fi", 10)
                if "READY" in health:
                    event("health_ready")
                    break
                if "FAILED" in health:
                    raise RuntimeError(execute(sid, "tail -n 15 /workspace/server.log"))
                time.sleep(5)
            else:
                raise TimeoutError("vLLM did not become healthy in 10 minutes")
            result = execute(sid, "python3 /workspace/bench.py", 600)
            record["bench"] = [json.loads(line) for line in result.splitlines() if line.startswith("{")]
            event("benchmark_complete", record["bench"])
            record["metrics"] = execute(sid, "nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader; df -h /workspace | tail -1").strip()
            event("resource_sample", record["metrics"])
        except Exception as exc:
            event("failure", str(exc))
            raise
        finally:
            event("teardown_requested")
            r = api.delete(f"{API}/sandbox/{sid}")
            r.raise_for_status()
            for _ in range(60):
                if api.get(f"{API}/sandbox/{sid}").status_code == 404:
                    event("deleted_confirmed")
                    record["estimated_billed_lifetime_s"] = round(time.monotonic() - boot_start, 1)
                    record["estimated_usd"] = round(record["estimated_billed_lifetime_s"] / 3600 *
                                                    (3.33864 if args.spot else 5.26864), 4)
                    args.output.write_text(json.dumps(record, indent=2) + "\n")
                    break
                time.sleep(2)
            else:
                event("deletion_unconfirmed", sid)


if __name__ == "__main__":
    main()
