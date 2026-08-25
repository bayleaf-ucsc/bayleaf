---
source-skill: bayleaf-ops-router
description: Change the LLM powering Basic or Help (base_model_id swap, incl. vision capability handling), or evaluate a candidate via the canary first.
status: tested once (dry run)
last-reviewed: 2026-08-25
---

# Model Swap (Basic / Help)

## When to use

Changing `base_model_id` on the `basic` or `help` workspace models (currently
both `openrouter.z-ai/glm-5.2`), including flips of the vision capability.
Also covers evaluating a candidate model beforehand via the `basic-canary`
workspace model without touching production.

## Prerequisites

- **[HUMAN GATE]** Adam already has personal experience with the candidate
  model (used it himself, not just seen benchmarks). If not, candidates are
  discussion, not deployment. Experience gained through a canary run counts.
- The candidate must be reachable through a **ZDR provider endpoint** via
  OpenRouter (platform floor; see root `AGENTS.md`). Do not scrape the
  provider's listing page: the machine-checkable source of truth is
  `GET https://openrouter.ai/api/v1/endpoints/zdr` (filter on model name).
  Beware truncating the list (e.g. `head`): entries are unordered and a
  truncated grep reads as "absent".
- **Provider diversity (strong preference, not a requirement).** Prefer
  candidates served by multiple providers, with at least one domestic
  (US-based) one, to keep exits credible and avoid vendor lock-in. A model
  with exactly one provider — especially a foreign first-party endpoint —
  concentrates both supply risk and exit risk; name that trade-off explicitly
  before swapping a production model onto it. If a single provider *is*
  deemed acceptable, also ask whether paying OpenRouter overhead to reach
  that one provider is a responsible use of funds versus accessing the
  provider directly.
- `GET https://api.bayleaf.dev/v1/models` lists only open-weight entries
  (truthy `hugging_face_id`); Chat curation follows the same open-weight
  preference. Prefer candidates on that list. Note the timing interaction:
  brand-new models appear there only after weights drop on Hugging Face, so
  "not on the list yet" is expected for week-old releases — a deviation to
  acknowledge, not necessarily a blocker.

## Steps

1. **Canary first, always.** Create or retarget `basic-canary` (a private
   clone of `basic`) in `chat/models/basic-canary/model.json` to point at the
   candidate slug, then push it with `models create` / `models update`.
   **Zero grants are invisible even to the admin** — the completions path
   hides ungranted models from everyone, owner included — so the canary
   carries one explicit read grant for Adam's user
   (`5cbb2fa9-feeb-4e6f-9d58-e300f52448f8`). Production models are never the
   first to run a candidate. Delete or retarget the canary after the
   evaluation.
   **Fresh-slug gotcha:** a newly released base model can fail completions
   with "Model not found" even though OpenRouter serves it, because OWUI's
   connection-model cache hasn't picked it up yet. Diagnose by flipping the
   canary to a known-good slug (differential test); if that works, hit
   `GET /api/models` to refresh the cache, point the canary back at the
   candidate, and retest.
2. **Reasoning effort.** Enumerate the candidate's supported reasoning
   efforts from its OpenRouter listing *before* pushing anything. If the
   current model.json pins an effort the candidate does not support (e.g.
   `basic` pins `reasoning_effort: none`, but glm-5.3 is always-on with
   low/high/max only), pick the setting that prioritizes responsiveness
   over depth for user-facing default models, and record the choice. A
   candidate that cannot disable reasoning changes the production model's
   character (latency, cost, tone) even with identical prompts.
3. Edit `chat/models/<id>/model.json` in the repo: set `base_model_id` to the
   OpenRouter slug (e.g. `openrouter.<owner>/<model>`).
4. Vision handling (the recurring flip-flop, recorded for honesty): if the
   new model is vision-capable, set `meta.capabilities.vision: true` so OWUI
   routes image inputs; if not, `false`. Running without vision is a
   legitimate, cheaper posture we have used repeatedly; the prompt should not
   promise image understanding the model can't do. Update
   `chat/DESIGN.md` §2's model description in the same pass.
5. Push: `set -a && source ~/.tokens/owui/chat-bayleaf-dev && set +a && uvx
   owui-cli models update chat/models/<id>/model.json`
6. **[HUMAN GATE]** The user exercises the swapped model in prod: a real
   conversation, an image upload if vision is on, a tool call. Model quality
   judgment is not delegable. The canary exists so this gate runs on the
   candidate *before* production is exposed to it.
7. Record: commit the model.json + DESIGN.md edit as
   `update: swap <model> to <slug>`.

## Verification

- `uvx owui-cli --json models show <id>` returns the new `base_model_id`.
- User confirms conversation quality (manual gate).

## Rollback

```bash
git checkout chat/models/<id>/model.json
uvx owui-cli models update chat/models/<id>/model.json
```

Instant and complete; this is why the repo file is edited first and pushed,
never hand-edited in the OWUI UI. The canary needs no rollback at all:
retarget it or delete it (`owui-cli models delete basic-canary`).

## Refinement log

- 2026-08-25: drafted from issue #65; never yet run as a playbook.
- 2026-08-25: first real run (dry run: glm-5.2 → glm-5.3 evaluation). ZDR
  check passed via the `/api/v1/endpoints/zdr` list (the listing-page scrape
  the draft implied never surfaced a data policy; replaced with the API).
  Two prerequisites the draft lacked: provider diversity (candidate had one
  foreign first-party endpoint → declined the production swap) and the
  open-weight-list timing note (weights not on HF one week post-release).
  Reasoning-effort step added: `basic`'s `reasoning_effort: none` is invalid
  on glm-5.3 (always-on). Canary workflow added: no canary existed, so
  `basic-canary` was created this session. Production models untouched.
  Two mechanics the draft got wrong, fixed above: (a) a zero-grant canary
  is invisible even to the admin caller — it needs an explicit Adam-only
  read grant; (b) a brand-new base model can hit "Model not found" from
  OWUI's stale connection-model cache while OpenRouter itself serves it
  fine — flip to a known-good slug to diagnose, refresh via `/api/models`.
