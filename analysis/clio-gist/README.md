# clio-gist

A Clio-inspired, privacy-preserving analysis of what BayLeaf Chat is used for.
The concept is Anthropic's [Clio](https://www.anthropic.com/research/clio): extract
facets per conversation, cluster them by theme, and describe each cluster, entirely
through LLM calls, so a human only ever reads de-personalized summaries, never the
raw conversations.

This folder holds the machinery only; it produces no persistent output in-repo.

## Pipeline

Each stage is a single `uv run --script` file that reads one artifact and writes the
next. Run them in order:

1. **`extract.py`**: reads an OWUI `/api/v1/chats/all/db` dump, reconstructs each
   conversation's active branch from the message tree (`history.currentId` →
   parentId chain), and normalizes the assistant-text storage drift (`content` vs
   `output`) into one flat transcript per conversation. Writes `corpus.jsonl`.
   It also skips a configured operator account (see the `AMS` constant) so the
   operator's own usage doesn't dominate the corpus.

2. **`compact.py`**: produces a compacted view of each transcript for the summarizer:
   strips agent overhead (`<details type="reasoning|tool_calls">` blocks) and
   mid-truncates long messages to keep head (intent) and tail (outcome). Writes
   `compact.jsonl`.

3. **`facets.py`**: LLM facet extraction: for each conversation, emits
   `{topic, language, summary}`. The summary is written to omit names, emails, IDs,
   and other identifying detail. Routes through OpenRouter with zero data retention
   (`data_collection: deny`). Writes `facets.jsonl`.

4. **`cluster.py`**: embeds each summary (OpenRouter embeddings) and clusters with
   HDBSCAN on cosine distance. Noise points are the long tail; they are kept separate
   rather than forced into a cluster. Writes `clusters.jsonl` (per-conversation
   labels) and `cluster_table.json` (cluster → member topics).

5. **`describe.py`**: LLM cluster description: titles and summarizes each cluster
   from its members' already de-personalized summaries. Writes `gist.json`, the final
   output.

6. **`rerun.py`**: utility that re-runs `facets.py` over the records that came back
   empty or garbled (the LLM occasionally emits prose instead of JSON), then merges
   the fixes back into `facets.jsonl`.

## Running

```bash
source ~/.tokens/openrouter-api                      # exports OPENROUTER_API_KEY
uv run --script extract.py dump.json corpus.jsonl    # dump.json from /api/v1/chats/all/db
uv run --script compact.py corpus.jsonl compact.jsonl
uv run --script facets.py compact.jsonl facets.jsonl
uv run --script rerun.py                             # optional: fix empty/garbled facets
uv run --script cluster.py
uv run --script describe.py
```

The LLM stages (`facets.py`, `describe.py`) default to a DeepSeek chat model over
OpenRouter; `cluster.py` uses a text-embedding model. Each is set at the top of its
file.

## Data hygiene

`corpus.jsonl` and every intermediate artifact contain real conversation text and
must **not** be committed to this public repo. Only the `.py` scripts and this README
live here; run the pipeline in a scratch directory outside the repo.