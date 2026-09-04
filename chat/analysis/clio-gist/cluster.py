# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "numpy", "scikit-learn", "hdbscan"]
# ///
"""Stage 2: semantic clustering of conversation summaries (Clio-gist).

Embeds each de-personalized summary via OpenRouter, then clusters with HDBSCAN
(cosine distance on L2-normalized vectors). Noise points are folded into their
nearest cluster so every conversation lands somewhere.

Output:
  clusters.jsonl  -> {id, topic, summary, cluster, ...}
  cluster_table.json -> [{cluster, size, topics: [...]}]
"""

import asyncio
import json
from pathlib import Path

import httpx
import numpy as np

EMBED_MODEL = "openai/text-embedding-3-small"
CONCURRENCY = 12

TOKENS = dict(
    line.split("=", 1)
    for line in Path.home().joinpath(".tokens/openrouter-api").read_text().strip().splitlines()
    if "=" in line
)
KEY = TOKENS["OPENROUTER_API_KEY"]


def is_bad(r):
    t = r.get("topic")
    s = r.get("summary")
    return (
        not isinstance(t, str) or not t.strip()
        or not isinstance(s, str) or not s.strip()
        or s.startswith("ERROR")
    )


async def embed(client, sem, text):
    async with sem:
        for attempt in range(4):
            try:
                r = await client.post(
                    "https://openrouter.ai/api/v1/embeddings",
                    headers={"Authorization": f"Bearer {KEY}"},
                    json={"model": EMBED_MODEL, "input": text},
                    timeout=60,
                )
                if r.status_code == 429:
                    await asyncio.sleep(3 * (attempt + 1))
                    continue
                r.raise_for_status()
                return r.json()["data"][0]["embedding"]
            except Exception:
                if attempt == 3:
                    raise
                await asyncio.sleep(2 * (attempt + 1))


async def main():
    recs = [json.loads(l) for l in Path("facets.jsonl").open()]
    good = [r for r in recs if not is_bad(r)]
    print(f"{len(good)} conversations to cluster", flush=True)

    sem = asyncio.Semaphore(CONCURRENCY)
    async with httpx.AsyncClient() as client:
        vecs = await asyncio.gather(*[embed(client, sem, r["summary"]) for r in good])

    X = np.array(vecs, dtype=np.float32)
    X = X / np.linalg.norm(X, axis=1, keepdims=True)  # L2 normalize -> cosine

    import hdbscan
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=3, min_samples=1, metric="euclidean", cluster_selection_epsilon=0.15
    )
    labels = clusterer.fit_predict(X)

    n_clusters = len(set(labels)) - (1 if -1 in labels else 0)
    n_noise = int((labels == -1).sum())
    print(f"clusters: {n_clusters}, noise: {n_noise}", flush=True)

    with Path("clusters.jsonl").open("w") as f:
        for r, lab in zip(good, labels):
            r["cluster"] = int(lab)
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    from collections import defaultdict
    table = defaultdict(list)
    for r, lab in zip(good, labels):
        table[int(lab)].append(r["topic"])
    out = [
        {"cluster": k, "size": len(v), "topics": v}
        for k, v in sorted(table.items(), key=lambda kv: -len(kv[1]))
    ]
    with Path("cluster_table.json").open("w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    for c in out:
        print(f"\ncluster {c['cluster']} ({c['size']}):")
        for t in c["topics"][:12]:
            print(f"    - {t}")


if __name__ == "__main__":
    asyncio.run(main())
