# Open-weight policy analysis

Reproducible metadata analysis for BayLeaf API's proposed open-weight routing
policy. It measures which OpenRouter spending would be blocked by this rule:

1. OpenRouter metadata provides a nonempty `hugging_face_id` for the model.
2. The corresponding `https://huggingface.co/<hugging_face_id>` repository
   resolves successfully.

This is an operational evidence rule, not an independent determination that a
model lacking the metadata is closed-weight. Missing, unmatched, or broken
metadata fails closed and is identified explicitly in the output.

## Running

From the repository root:

```bash
node analysis/open-weight-policy/analyze.mjs
node analysis/open-weight-policy/analyze.mjs \
  --start=2026-08-01 --end=2026-09-01
```

The default interval is the previous completed UTC calendar month. `--start` is
inclusive and `--end` is exclusive. Authentication uses
`OPENROUTER_MAINTENANCE_KEY` from the environment or `api/.env`.

The script writes two mode-0600 CSVs under the gitignored `api/reports/`:

- `openrouter-model-weights-<start>-to-<end>.csv`: OpenRouter metadata and live
  Hugging Face validation for every model used in the interval.
- `openrouter-model-spend-<start>-to-<end>.csv`: per-model spending and shares,
  split between email-attributable personal keys, shared keys, and all keys.

The all-key denominator includes Campus Pass and BayLeaf OWUI. Use it for claims
about total BayLeaf OpenRouter inference spending. The personal-key denominator
answers a different question and should be labeled as such.

No prompts or completions are requested or retained. The analysis reads only
OpenRouter's request metadata. Generated reports may contain operational data
and must not be committed.
