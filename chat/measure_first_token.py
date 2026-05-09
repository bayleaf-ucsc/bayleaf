#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""
Measure first-token latency on a fresh chat across two OWUI deployments.

Compares chat.bayleaf.dev vs chat.adamsmith.as on:
  (a) Bare base model (openrouter.z-ai/glm-5.1) — isolates infrastructure.
  (b) Default workspace model — what users actually feel.

Times three points per request:
  T0: just before request sent
  T1: HTTP response headers received (TTFB)
  T2: first SSE delta with non-empty content (first content token)

Caveat: hits /api/chat/completions directly with admin JWT. This skips the
browser-side chat-row creation and title-generation steps. It is the
server-side critical path only.
"""

import asyncio
import json
import os
import statistics
import sys
import time
from dataclasses import dataclass, field

import httpx


@dataclass
class Run:
    ttfb_s: float
    first_token_s: float
    total_s: float
    first_chunk_preview: str
    error: str | None = None


@dataclass
class Condition:
    label: str
    base_url: str
    token: str
    model: str
    runs: list[Run] = field(default_factory=list)


PROMPT = "Reply with just the word 'pong'."
N_RUNS = 5
TIMEOUT = 60.0


def load_token(path: str) -> tuple[str, str]:
    url = token = None
    with open(os.path.expanduser(path)) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            if k == "OWUI_URL":
                url = v
            elif k == "OWUI_TOKEN":
                token = v
    if not url or not token:
        raise SystemExit(f"missing OWUI_URL/OWUI_TOKEN in {path}")
    return url, token


async def one_run(client: httpx.AsyncClient, cond: Condition) -> Run:
    payload = {
        "model": cond.model,
        "stream": True,
        "messages": [{"role": "user", "content": PROMPT}],
    }
    headers = {
        "Authorization": f"Bearer {cond.token}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    url = f"{cond.base_url}/api/chat/completions"
    t0 = time.perf_counter()
    ttfb = None
    first_token = None
    first_chunk = ""
    try:
        async with client.stream("POST", url, json=payload, headers=headers, timeout=TIMEOUT) as resp:
            ttfb = time.perf_counter() - t0
            if resp.status_code != 200:
                body = (await resp.aread()).decode("utf-8", "replace")
                return Run(ttfb_s=ttfb, first_token_s=-1, total_s=ttfb, first_chunk_preview="", error=f"HTTP {resp.status_code}: {body[:200]}")
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                # OpenAI-style: choices[0].delta.content
                choices = obj.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                content = delta.get("content") or delta.get("reasoning_content") or ""
                if content and first_token is None:
                    first_token = time.perf_counter() - t0
                    first_chunk = content[:60]
                    break
    except Exception as e:
        return Run(ttfb_s=ttfb or -1, first_token_s=-1, total_s=time.perf_counter() - t0, first_chunk_preview="", error=f"{type(e).__name__}: {e}")
    return Run(ttfb_s=ttfb or -1, first_token_s=first_token or -1, total_s=time.perf_counter() - t0, first_chunk_preview=first_chunk)


def fmt_ms(x: float) -> str:
    return f"{x*1000:6.0f}ms" if x >= 0 else "    err"


def summarize(runs: list[Run], field_name: str) -> str:
    vals = [getattr(r, field_name) for r in runs if getattr(r, field_name) >= 0]
    if not vals:
        return "no data"
    if len(vals) == 1:
        return f"{vals[0]*1000:.0f}ms"
    return f"med={statistics.median(vals)*1000:.0f}ms  min={min(vals)*1000:.0f}ms  max={max(vals)*1000:.0f}ms"


async def main():
    bayleaf_url, bayleaf_tok = load_token("~/.tokens/owui/chat-bayleaf-dev")
    personal_url, personal_tok = load_token("~/.tokens/owui/chat-adamsmith-as")

    conditions = [
        # Apples-to-apples bare base model
        Condition("bayleaf  | bare glm-5.1", bayleaf_url, bayleaf_tok, "openrouter.z-ai/glm-5.1"),
        Condition("personal | bare glm-5.1", personal_url, personal_tok, "openrouter.z-ai/glm-5.1"),
        # Default-experience model
        Condition("bayleaf  | basic (workspace)", bayleaf_url, bayleaf_tok, "basic"),
        # No equivalent "default" workspace model on personal, but use Anthropic Haiku as a comparable user-facing pick
        Condition("personal | claude-haiku-4.5", personal_url, personal_tok, "anthropic_via_openrouter.anthropic/claude-haiku-4.5"),
    ]

    async with httpx.AsyncClient() as client:
        for cond in conditions:
            print(f"\n=== {cond.label} ({cond.model}) ===", flush=True)
            for i in range(N_RUNS):
                run = await one_run(client, cond)
                cond.runs.append(run)
                tag = "COLD" if i == 0 else f"  #{i+1}"
                if run.error:
                    print(f"  {tag}  ERROR: {run.error}", flush=True)
                else:
                    print(
                        f"  {tag}  ttfb={fmt_ms(run.ttfb_s)}  first-token={fmt_ms(run.first_token_s)}  "
                        f"total={fmt_ms(run.total_s)}  preview={run.first_chunk_preview!r}",
                        flush=True,
                    )

    print("\n=== summary ===")
    print(f"{'condition':40s}  {'TTFB':25s}  {'first-token':25s}")
    print("-" * 95)
    for cond in conditions:
        # Exclude cold run (index 0) from summary so we measure warm-path performance
        warm = cond.runs[1:]
        print(f"{cond.label:40s}  {summarize(warm, 'ttfb_s'):25s}  {summarize(warm, 'first_token_s'):25s}")
    print("\n(summary excludes the first/cold run per condition)")


if __name__ == "__main__":
    asyncio.run(main())
