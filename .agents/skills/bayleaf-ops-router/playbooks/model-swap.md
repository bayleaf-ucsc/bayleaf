---
source-skill: bayleaf-ops-router
description: Select, evaluate, and deploy a model for Chat's Basic or Help workspace models or the BayLeaf API recommendation.
status: Chat path tested once (dry run); API path tested once (production)
last-reviewed: 2026-09-01
---

# Model Swap (Chat / API)

## When to use

Selecting, evaluating, and deploying a model in either of two independent roles:

- **BayLeaf Chat:** change `base_model_id` on the `basic` or `help` Open WebUI
  workspace model, including vision capability handling. A private
  `basic-canary` workspace model isolates evaluation from production users.
- **BayLeaf API:** change the general-use recommendation exposed by
  `/recommended-model`, documentation and dashboard examples, and OpenCode
  onboarding. This does **not** provide a server-side fallback when callers omit
  `model`; callers still choose a model on every inference request.

These roles share selection policy but not deployment state. The API
recommendation does not need to match Chat's Basic or Help model.

## Shared selection gates

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

### API recommendation criteria

The API recommendation is specifically for general-purpose coding-agent
harnesses running on users' local machines. It is not BayLeaf's answer to every
inference workload, and narrow jobs such as bulk classification may rationally
select a different model.

- Published open weights are required, not merely preferred.
- The model should be extremely inexpensive at its sustainable list price while
  remaining strong at coding, tool use, instruction following, and long-running
  agent work. Do not justify the choice from a temporary discount alone.

#### Interpreting DeepSWE

Consult [DeepSWE](https://deepswe.datacurve.ai/) as a recurring comparative
signal for coding-agent capability and cost. The leaderboard ranks runs, not
bare model names, and changes over time. Interpret its metrics as follows:

- **Score:** an estimate of the probability that an agent driven by this
  configuration can satisfactorily complete a task. The benchmark tasks are
  software engineering, so transfer to other general-purpose work is an
  informed extrapolation, not a measured probability.
- **Average cost per task:** the provider inference cost of getting work done,
  not merely the price of one token or request.
- **Agent steps:** a proxy for human oversight cost. High-step agents tend to be
  clumsy (creating mistakes they later repair) or unwise (acting before enough
  context exists or taking unnecessary actions). More steps also give a human
  observer more activity to inspect and understand.
- **Output tokens:** a weak diagnostic here. Providers generate tokens at
  different rates for a given model, and most are hidden reasoning tokens a
  human usually does not review.

Compare score, average task cost, and agent steps at equivalent reasoning
effort. A candidate that improves all three is an easy swap. A candidate that
sacrifices one to improve the others may still win, but requires explicit debate
rather than an automatic weighted score. DeepSWE remains one input, not a
deployment gate: triangulate it with Adam's sustained use, live ZDR/provider
facts, and the API canary below.

Record which role is changing and apply these gates before following that
role's path below. Passing the gates for one role does not imply that both roles
should move together.

## Chat path (Basic / Help)

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

### Chat verification

- `uvx owui-cli --json models show <id>` returns the new `base_model_id`.
- User confirms conversation quality (manual gate).

### Chat rollback

Restore the prior `base_model_id`, capability fields, and any model-specific
parameters in `chat/models/<id>/model.json`, then run `models update` again.

Instant and complete; this is why the repo file is edited first and pushed,
never hand-edited in the OWUI UI. The canary needs no rollback at all:
retarget it or delete it (`owui-cli models delete basic-canary`).

## API path (recommended model)

1. **Canary by explicit request.** No separate API deployment or canary object is
   needed: callers already select arbitrary model slugs. Send representative
   requests to the production API with the candidate's full namespaced slug
   (`openrouter:<owner>/<model>`), without changing `RECOMMENDED_MODEL`.
   On Adam's machine, load the credential with `set -a && source
   ~/.tokens/bayleaf-api && set +a`, then use `$BAYLEAF_API_KEY`. The file is a
   shell assignment, not a raw token; passing its complete contents as the
   Bearer value produces a misleading 401. Use the request shapes in
   `api/TESTING.md` rather than duplicating them here.
2. Test the behavior that recommendation consumers will actually receive:
   omit optional reasoning/provider parameters unless the integration normally
   supplies them. At minimum, run one ordinary response and one agentic tool-use
   workload. Add multimodal input when that capability contributes to the
   selection. Confirm valid responses, tool-call shape, latency, and plausible
   usage accounting; quality judgment remains Adam's human gate.
3. Edit `api/wrangler.jsonc`: set `RECOMMENDED_MODEL` to the full namespaced
   slug. Decide explicitly whether the displaced recommendation belongs in
   `OPENCODE_CURATED_MODELS`; do not retain or remove it accidentally. The
   recommended slug is injected into OpenCode's model list automatically, so it
   need not also appear in the curated companion string.
4. Run `npx tsc --noEmit` from `api/`, then deploy with `npm run deploy`.
5. Verify after Cloudflare propagation:
   - `GET https://api.bayleaf.dev/recommended-model` returns the candidate slug
     and display name.
   - An authenticated `GET /.well-known/opencode/config` contains the candidate
     in the provider model map and sets top-level `model` to it.
   - Repeat the ordinary and tool-use canary requests against the deployed API.
   The inference route itself is unchanged, but these checks catch upstream
   drift and malformed model metadata at the moment of promotion.
6. **[HUMAN GATE]** Adam confirms the promoted recommendation behaves as
   expected in a real agent session. This is distinct from changing Chat's
   Basic model.
7. Record: commit `api/wrangler.jsonc` and any playbook refinement as
   `update: recommend <slug> for BayLeaf API`.

### API rollback

Restore the prior `RECOMMENDED_MODEL` and curated-list decision in
`api/wrangler.jsonc`, redeploy, and repeat the endpoint and OpenCode-config
checks. Inference requests that explicitly named either model are unaffected.

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
- 2026-09-01: first production API run (`deepseek-v4-flash-0731` →
  `glm-5.3-flash`). Split shared selection gates from independent Chat and API
  paths. Adam supplied the quality gate from sustained use and clarified that
  this role targets cheap, strong, open-weight models for local coding-agent
  harnesses; DeepSWE is a recurring comparison source, not a universal ranking.
  Explicit-slug ordinary and forced-tool canaries passed before and after
  deployment; `/recommended-model` and the authenticated OpenCode config
  reflected the promotion. Initial probes returned 401 because the local token
  file was consumed as raw text rather than sourced as a shell assignment; the
  credential recipe now records that distinction. DeepSWE made this promotion
  unusually clear: GLM 5.3 Flash improved score while reducing both inference
  cost and agent steps. Adam identified steps as a human oversight cost and
  output tokens as a weak diagnostic; the selection rubric now preserves that
  interpretation for future, less dominant tradeoffs.
