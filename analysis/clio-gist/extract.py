# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Stage 0: canonical extractor for BayLeaf Chat -> grounded conversation transcripts.

Reads the OWUI `/api/v1/chats/all/db` dump (JSON). Each row is
    {id, user_id, title, chat: {history: {currentId, messages: {<nid>: node}}, ...}, ...}
We reconstruct each conversation's current branch (root -> leaf along parentId from
currentId) and normalize the assistant-text storage schema drift (content vs output)
into one flat transcript.

Output: a JSONL file, one record per conversation:
    {id, user_id, title, n_turns, turns: [{role, text}]}
"""

import json
import sys
from pathlib import Path

AMS = "5cbb2fa9-feeb-4e6f-9d58-e300f52448f8"


def _text_from_content(content):
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, dict) and p.get("type") == "text" and p.get("text"):
                parts.append(p["text"])
        return "\n".join(parts)
    return ""


def _text_from_output(output):
    """Normalize the `output` field (Anthropic/OpenRouter event stream) to text.

    Newer OWUI parks assistant text here when the response came from an
    Anthropic-compatible path, shaped as:
      [{"type": "message", "content": [{"type": "output_text", "text": "..."}]}]
    """
    if output is None:
        return ""
    if isinstance(output, str):
        return output
    if isinstance(output, dict):
        output = output.get("content", [])
    parts = []
    if isinstance(output, list):
        for ev in output:
            if not isinstance(ev, dict):
                continue
            inner = ev.get("content", [])
            if isinstance(inner, str):
                parts.append(inner)
            elif isinstance(inner, list):
                for blk in inner:
                    if isinstance(blk, dict) and blk.get("text"):
                        parts.append(blk["text"])
    return "\n".join(parts)


def assistant_text(node):
    t = _text_from_content(node.get("content"))
    if t.strip():
        return t
    return _text_from_output(node.get("output"))


def user_text(node):
    return _text_from_content(node.get("content"))


def build_transcript(chat):
    """chat is the ChatForm object (has .history and .messages)."""
    hist = chat.get("history", {})
    messages = hist.get("messages") if isinstance(hist, dict) else {}
    current_id = hist.get("currentId") if isinstance(hist, dict) else None

    if isinstance(messages, dict) and messages and current_id in messages:
        # root -> leaf along the current branch
        chain = []
        nid = current_id
        while nid and nid in messages:
            chain.append(nid)
            nid = messages[nid].get("parentId")
        chain.reverse()
        nodes = [messages[nid] for nid in chain]

    elif isinstance(messages, dict) and messages:
        # no usable currentId: follow the single-child path from a root
        roots = [nid for nid, n in messages.items() if not n.get("parentId")]
        chain = []
        if roots:
            nid = roots[0]
            seen = set()
            while nid and nid in messages and nid not in seen:
                seen.add(nid)
                chain.append(nid)
                kids = messages[nid].get("childrenIds") or []
                nid = kids[0] if kids else None
        nodes = [messages[nid] for nid in chain]

    else:
        # flat .messages list fallback (older schema)
        nodes = chat.get("messages") or []

    out = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        r = node.get("role")
        if r == "user":
            text = user_text(node)
            if text.strip():
                out.append({"role": "user", "text": text})
        elif r == "assistant":
            text = assistant_text(node)
            if text.strip():
                out.append({"role": "assistant", "text": text})
    return out


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/bayleaf_chats.json")
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("corpus.jsonl")

    chats = json.loads(src.read_text())
    n_written = n_turns = n_user = n_assist = 0
    with dst.open("w") as f:
        for row in chats:
            if row.get("user_id") == AMS:
                continue
            turns = build_transcript(row.get("chat", {}))
            n_written += 1
            n_turns += len(turns)
            n_user += sum(1 for t in turns if t["role"] == "user")
            n_assist += sum(1 for t in turns if t["role"] == "assistant")
            f.write(json.dumps({
                "id": row.get("id"),
                "user_id": row.get("user_id"),
                "title": row.get("title"),
                "n_turns": len(turns),
                "turns": turns,
            }, ensure_ascii=False) + "\n")

    print(f"wrote {n_written} conversations")
    print(f"  total turns: {n_turns} (user {n_user}, assistant {n_assist})")
    print(f"  -> {dst}")


if __name__ == "__main__":
    main()