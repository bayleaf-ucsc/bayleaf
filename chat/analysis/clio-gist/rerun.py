# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx"]
# ///
"""Re-run facet extraction for records that came back empty/garbled.

Reads facets.jsonl, finds records with empty/non-string topic or empty summary,
re-extracts them from compact.jsonl, and merges the fixes back into facets.jsonl.
"""

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import facets  # noqa: E402


def is_bad(r):
    t = r.get("topic")
    s = r.get("summary")
    return (
        not isinstance(t, str)
        or not t.strip()
        or not isinstance(s, str)
        or not s.strip()
        or s.startswith("ERROR")
    )


async def main():
    facets_path = Path("facets.jsonl")
    compact_path = Path("compact.jsonl")

    recs = [json.loads(l) for l in facets_path.open()]
    bad_ids = {r["id"] for r in recs if is_bad(r)}

    # skip records with no transcript content (nothing to summarize)
    compact = {json.loads(l)["id"]: json.loads(l) for l in compact_path.open()}
    rerun = [compact[i] for i in bad_ids if i in compact and compact[i]["n_turns"] > 0]
    empty = [i for i in bad_ids if i in compact and compact[i]["n_turns"] == 0]

    print(f"{len(bad_ids)} bad records; {len(rerun)} re-runnable, {len(empty)} empty-transcript", flush=True)

    sem = asyncio.Semaphore(facets.CONCURRENCY)
    async with facets.httpx.AsyncClient() as client:
        results = await asyncio.gather(*[facets.one(client, sem, r) for r in rerun])

    fixed = {res["id"]: res for res, _ in results}
    out = []
    for r in recs:
        if r["id"] in fixed:
            out.append(fixed[r["id"]])
        else:
            out.append(r)
    with facets_path.open("w") as f:
        for r in out:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    still_bad = [r for r in out if is_bad(r)]
    print(f"merged; {len(still_bad)} still bad after re-run", flush=True)
    for r in still_bad:
        print("  ", r["id"][:8], repr(r["summary"])[:60])


if __name__ == "__main__":
    asyncio.run(main())
