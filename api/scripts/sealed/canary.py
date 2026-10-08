#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tinfoil"]
# ///
"""Explicit-model canary through the attested EHBP relay, not plaintext inference.

Source ~/.tokens/bayleaf-api, then run with BAYLEAF_API_KEY exported.
Prints only synthetic assertions, latency, and token usage, never credentials.
No recommendation or provider state is changed.
"""
import json
import os
import time

from tinfoil import TinfoilAI

base = os.environ.get("BAYLEAF_SEALED_URL", "https://api.bayleaf.dev/sealed").rstrip("/")
model = os.environ.get("SEALED_CANARY_MODEL", "glm-5-3")
client = TinfoilAI(
    api_key=os.environ["BAYLEAF_API_KEY"],
    base_url=f"{base}/v1/",
    attestation_bundle_url=base,
    timeout=180,
)


def request(label, messages, **kwargs):
    start = time.monotonic()
    response = client.chat.completions.create(
        model=model, messages=messages, max_tokens=20000, **kwargs
    )
    assert response.usage and response.usage.total_tokens > 0
    assert response.choices[0].finish_reason != "length", "Truncated canary"
    print(json.dumps({"check": label, "model": model, "seconds": round(time.monotonic() - start, 2),
                      "tokens": response.usage.total_tokens}), flush=True)
    return response.choices[0].message


ordinary = request("ordinary", [{"role": "user", "content": "Reply with exactly SEALED-CANARY-OK."}])
assert (ordinary.content or "").strip() == "SEALED-CANARY-OK"
messages = [{"role": "user", "content": "Use add to calculate 17 + 25, then report the result."}]
tools = [{"type": "function", "function": {"name": "add", "description": "Add two integers.",
          "parameters": {"type": "object", "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
                         "required": ["a", "b"], "additionalProperties": False}}}]
call = request("tool-call", messages, tools=tools, tool_choice={"type": "function", "function": {"name": "add"}})
assert call.tool_calls and len(call.tool_calls) == 1
tool = call.tool_calls[0]
assert tool.function.name == "add"
assert json.loads(tool.function.arguments) == {"a": 17, "b": 25}
messages.append(call.model_dump(exclude_none=True))
messages.append({"role": "tool", "tool_call_id": tool.id, "content": "42"})
answer = request("tool-result", messages, tools=tools)
assert "42" in (answer.content or "") and not answer.tool_calls
print("PASS: attested encrypted ordinary response and complete tool-use round trip", flush=True)
