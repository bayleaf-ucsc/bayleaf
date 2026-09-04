# Open-weight policy analysis

Reproducible metadata analysis for BayLeaf API's adopted open-weight routing
policy. The current production rule allows OpenRouter inference only when:

1. OpenRouter metadata provides a nonempty `hugging_face_id` for the model.
2. The corresponding `https://huggingface.co/<hugging_face_id>` repository
   resolves successfully.

This is an operational evidence rule, not an independent determination that a
model lacking the metadata is closed-weight. Missing, unmatched, or broken
metadata fails closed and is identified explicitly in the output. The rule
gates every OpenRouter POST path, including Chat Completions, Responses, and the
generic proxy. Positive and definite-negative decisions are cached for 24
hours; indeterminate lookup failures return 403 but are not cached.

This policy is backend-specific. Tinfoil's current catalog lists only open-weight
models, so the encrypted Sealed lane does not apply this OpenRouter metadata
check. BayLeaf cannot inspect Sealed requests to enforce catalog composition
itself; a Tinfoil catalog change requires a policy review.
Vertex and Bedrock mantle are disabled. Mantle's catalog is mostly open-weight
but includes closed-weight entries and exposes no mechanical weights predicate.

The analysis measures which historical OpenRouter spending the current rule
would block; it does not itself configure or enforce routing.

## Running

From the repository root:

```bash
node api/scripts/open-weight-policy/analyze.mjs
node api/scripts/open-weight-policy/analyze.mjs \
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
