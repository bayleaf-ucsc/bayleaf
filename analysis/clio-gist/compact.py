# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Stage 1.5: compact transcripts into a summarizer-safe view.

Two transforms per message, in order:
  1. Drop agent overhead: <details type="reasoning"> (chain-of-thought) and
     <details type="tool_calls"> (tool args + results) blocks.
  2. Mid-truncate long messages to keep head (intent) + tail (outcome), dropping
     the middle.

Reads corpus.jsonl, writes compact.jsonl (identical schema, compacted `text`).
"""

import json
import re
import sys
from pathlib import Path

TOOL_REASONING = re.compile(r'<details type="(?:reasoning|tool_calls)"[^>]*>.*?</details>', re.DOTALL)

HEAD = 600
TAIL = 600


def compact_text(text):
    t = text
    for _ in range(4):  # tolerate a few levels of nesting
        new = TOOL_REASONING.sub("", t)
        if new == t:
            break
        t = new
    t = re.sub(r"\n{3,}", "\n\n", t).strip()
    if len(t) <= HEAD + TAIL:
        return t
    return t[:HEAD] + f"\n...[mid-truncated {len(t) - HEAD - TAIL} chars]...\n" + t[-TAIL:]


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("corpus.jsonl")
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("compact.jsonl")

    n = 0
    with src.open() as fin, dst.open("w") as fout:
        for line in fin:
            rec = json.loads(line)
            rec["turns"] = [
                {"role": t["role"], "text": compact_text(t["text"])}
                for t in rec["turns"]
            ]
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n += 1
    print(f"compacted {n} conversations -> {dst}")


if __name__ == "__main__":
    main()