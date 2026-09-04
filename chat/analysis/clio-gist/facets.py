# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx"]
# ///
"""Stage 1: facet extraction over the BayLeaf corpus (Clio-gist).

Reads corpus.jsonl, sends each conversation transcript to a ZDR OpenRouter model,
and extracts {topic, language, summary} per conversation. The summary is the
privacy-bearing step: instructed to abstract away any names, emails, or other
identifying detail before it ever leaves the local machine.

Output: facets.jsonl (parallel to corpus.jsonl), one record per conversation.
"""

import asyncio
import json
import sys
from pathlib import Path

import httpx

MODEL = "deepseek/deepseek-v4-flash-0731"
MAX_CHARS = 24000  # cap on the assembled transcript (already per-message compacted)
CONCURRENCY = 8

TOKENS = dict(
    line.split("=", 1)
    for line in Path.home().joinpath(".tokens/openrouter-api").read_text().strip().splitlines()
    if "=" in line
)
KEY = TOKENS["OPENROUTER_API_KEY"]

SYSTEM = """You are a privacy-preserving usage analyst, part of a Clio-style pipeline for
understanding what an AI chat service is used for.

For each conversation you are shown, extract three facets. Return ONLY valid JSON.

- "topic": a short, de-personalized noun phrase (2-6 words) naming the subject of the
  conversation (e.g. "debugging JavaScript", "sea otter biology", "course syllabus draft").
- "language": the primary language the user writes in, as an ISO 639-1 code (e.g. "en", "es").
- "summary": one or two sentences describing what the user is trying to accomplish. This is
  read by a human analyst. It must NOT contain any identifying information: no names, emails,
  IDs, account numbers, institutions that identify a specific person, or any other detail
  that could single out an individual. Describe the task in the abstract (roles and subject
  matter are fine; specific individuals are not).

Respond with exactly:
{"topic": "...", "language": "...", "summary": "..."}

Output ONLY the JSON object and nothing else. No markdown fences, no prose, no
explanation, no preamble. If the conversation has no substantive content, still
return the JSON with empty strings for topic and summary.
"""


def transcript_text(rec):
    parts = []
    for t in rec["turns"]:
        label = "USER" if t["role"] == "user" else "ASSISTANT"
        parts.append(f"{label}: {t['text']}")
    return "\n\n".join(parts)


async def one(client, sem, rec):
    text = transcript_text(rec)
    truncated = len(text) > MAX_CHARS
    if truncated:
        # mid-truncate the whole conversation: keep opening + closing turns
        text = text[: MAX_CHARS // 2] + "\n...[mid-truncated]...\n" + text[-MAX_CHARS // 2 :]
    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": text},
        ],
        "response_format": {"type": "json_object"},
        "provider": {"data_collection": "deny"},
    }
    async with sem:
        for attempt in range(4):
            try:
                r = await client.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    headers={"Authorization": f"Bearer {KEY}"},
                    json=body,
                    timeout=90,
                )
                if r.status_code == 429:
                    await asyncio.sleep(3 * (attempt + 1))
                    continue
                r.raise_for_status()
                data = r.json()
                content = data["choices"][0]["message"]["content"]
                usage = data.get("usage", {})
                cost = float(usage.get("cost", 0.0) or 0.0)
                try:
                    facet = json.loads(content)
                except json.JSONDecodeError:
                    # one retry with a hard nudge to emit JSON only
                    body["messages"].append({"role": "assistant", "content": content})
                    body["messages"].append(
                        {"role": "user", "content": "That was not valid JSON. Output ONLY the JSON object now, nothing else."}
                    )
                    r2 = await client.post(
                        "https://openrouter.ai/api/v1/chat/completions",
                        headers={"Authorization": f"Bearer {KEY}"},
                        json=body,
                        timeout=90,
                    )
                    r2.raise_for_status()
                    content2 = r2.json()["choices"][0]["message"]["content"]
                    try:
                        facet = json.loads(content2)
                    except json.JSONDecodeError:
                        facet = {"topic": "", "language": "", "summary": content2}
                return {
                    "id": rec["id"],
                    "user_id": rec["user_id"],
                    "title": rec["title"],
                    "n_turns": rec["n_turns"],
                    "truncated": truncated,
                    "topic": facet.get("topic", ""),
                    "language": facet.get("language", ""),
                    "summary": facet.get("summary", ""),
                }, cost
            except Exception as e:
                if attempt == 3:
                    return {
                        "id": rec["id"], "user_id": rec["user_id"], "title": rec["title"],
                        "n_turns": rec["n_turns"], "truncated": truncated,
                        "topic": "", "language": "", "summary": f"ERROR: {e}",
                    }, 0.0
                await asyncio.sleep(2 * (attempt + 1))


async def main(src, dst):
    recs = [json.loads(l) for l in Path(src).open()]
    sem = asyncio.Semaphore(CONCURRENCY)
    total_cost = 0.0
    done = 0
    out = Path(dst).open("w")
    try:
        async with httpx.AsyncClient() as client:
            tasks = [asyncio.ensure_future(one(client, sem, r)) for r in recs]
            for fut in asyncio.as_completed(tasks):
                res, cost = await fut
                total_cost += cost
                done += 1
                out.write(json.dumps(res, ensure_ascii=False) + "\n")
                out.flush()
                if done % 25 == 0:
                    print(f"  {done}/{len(recs)} done, cost ${total_cost:.4f}", flush=True)
    finally:
        out.close()
    print(f"extracted facets for {done} conversations -> {dst}")
    print(f"total estimated cost: ${total_cost:.4f}")


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "compact.jsonl"
    dst = sys.argv[2] if len(sys.argv) > 2 else "facets.jsonl"
    asyncio.run(main(src, dst))
