# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx"]
# ///
"""Stage 3: describe each cluster (Clio-gist).

Reads clusters.jsonl (per-conversation cluster labels + summaries), groups by
cluster, and asks a ZDR model to write a title + summary for each cluster from
its members' already-de-personalized summaries. The noise cluster (-1) is the
long tail of one-off queries.

Output: gist.json -> [{cluster, size, title, summary, sample_topics}]
"""

import asyncio
import json
from collections import defaultdict
from pathlib import Path

import httpx

MODEL = "deepseek/deepseek-v4-flash-0731"
CONCURRENCY = 8
MAX_MEMBERS = 40  # cap summaries fed per cluster

TOKENS = dict(
    line.split("=", 1)
    for line in Path.home().joinpath(".tokens/openrouter-api").read_text().strip().splitlines()
    if "=" in line
)
KEY = TOKENS["OPENROUTER_API_KEY"]

SYSTEM = """You are a privacy-preserving usage analyst writing a high-level summary of a
cluster of AI-chat conversations. You are given a list of one-line summaries of
individual conversations (already de-personalized). Write:

- "title": a short noun phrase (2-5 words) naming the theme of this cluster.
- "summary": one or two sentences describing what these conversations have in common
  and what the users are trying to accomplish. Do NOT introduce any names, emails, or
  other identifying detail; keep it abstract.

Respond with ONLY a JSON object:
{"title": "...", "summary": "..."}
"""


async def describe(client, sem, cluster, members):
    text = "\n".join(f"- {m}" for m in members)
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
                content = r.json()["choices"][0]["message"]["content"]
                try:
                    return json.loads(content)
                except json.JSONDecodeError:
                    return {"title": f"cluster {cluster}", "summary": content}
            except Exception as e:
                if attempt == 3:
                    return {"title": f"cluster {cluster}", "summary": f"ERROR: {e}"}
                await asyncio.sleep(2 * (attempt + 1))


async def main():
    recs = [json.loads(l) for l in Path("clusters.jsonl").open()]
    groups = defaultdict(list)
    for r in recs:
        groups[r["cluster"]].append(r["summary"])

    # order clusters by size desc
    ordered = sorted(groups.items(), key=lambda kv: -len(kv[1]))

    sem = asyncio.Semaphore(CONCURRENCY)
    async with httpx.AsyncClient() as client:
        tasks = [
            describe(client, sem, c, members[:MAX_MEMBERS])
            for c, members in ordered
        ]
        results = await asyncio.gather(*tasks)

    out = []
    for (c, members), desc in zip(ordered, results):
        out.append({
            "cluster": c,
            "size": len(members),
            "title": desc.get("title", ""),
            "summary": desc.get("summary", ""),
        })

    with Path("gist.json").open("w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    for o in out:
        label = "LONG TAIL" if o["cluster"] == -1 else f"cluster {o['cluster']}"
        print(f"\n[{label}] ({o['size']} conversations)")
        print(f"  {o['title']}")
        print(f"  {o['summary']}")


if __name__ == "__main__":
    asyncio.run(main())
