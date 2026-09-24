"""Synthetic local vLLM benchmark. No user content or credentials."""

import concurrent.futures
import json
import time
import urllib.error
import urllib.request
import sys
from datetime import datetime, timezone

BASE = "http://127.0.0.1:8000"
MODEL = "cyankiwi/Qwen3.8-27B-AWQ-INT4"
PREFIX = "You are a concise assistant for a fictional botanical catalog. " * 200


def request(i, prefix=True):
    body = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": PREFIX if prefix else "Answer briefly."},
            {"role": "user", "content": f"Write exactly 100 words describing a fictional plant whose name starts with {chr(65 + i)}. Include habitat, leaves, and pollination."},
        ],
        "max_tokens": 160,
        "temperature": 0,
        "stream": True,
        "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"enable_thinking": False},
    }).encode()
    start = time.monotonic()
    start_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    first = None
    first_at = None
    chunks = 0
    usage = None
    try:
        with urllib.request.urlopen(urllib.request.Request(
            BASE + "/v1/chat/completions", body,
            {"Content-Type": "application/json"},
        ), timeout=180) as response:
            for line in response:
                if not line.startswith(b"data: ") or line.strip() == b"data: [DONE]":
                    continue
                data = json.loads(line[6:])
                if data.get("usage"):
                    usage = data["usage"]
                if any(choice.get("delta", {}).get("content") or choice.get("delta", {}).get("reasoning_content")
                       for choice in data.get("choices", [])):
                    if first is None:
                        first = time.monotonic()
                        first_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
                    chunks += 1
        return {"request_at": start_at, "first_token_at": first_at,
                "ttft_s": round(first - start, 3) if first else None,
                "total_s": round(time.monotonic() - start, 3), "chunks": chunks, "usage": usage}
    except urllib.error.HTTPError as error:
        return {"status": error.code, "total_s": round(time.monotonic() - start, 3),
                "error": error.read(500).decode(errors="replace")}


if __name__ == "__main__":
    if "--over-limit" in sys.argv:
        body = json.dumps({"model": MODEL, "messages": [{"role": "user", "content": "botanical " * 14000}],
                           "max_tokens": 16, "stream": False, "chat_template_kwargs": {"enable_thinking": False}}).encode()
        try:
            with urllib.request.urlopen(urllib.request.Request(BASE + "/v1/chat/completions", body,
                                                                {"Content-Type": "application/json"}), timeout=60) as response:
                print(json.dumps({"over_limit_status": response.status}))
        except urllib.error.HTTPError as error:
            print(json.dumps({"over_limit_status": error.code, "reason": error.read(400).decode(errors="replace")}))
        sys.exit()
    for n in (1, 1, 2, 4):
        start = time.monotonic()
        with concurrent.futures.ThreadPoolExecutor(max_workers=n) as pool:
            results = list(pool.map(request, range(n)))
        print(json.dumps({"concurrency": n, "wall_s": round(time.monotonic() - start, 3),
                          "results": results}), flush=True)
