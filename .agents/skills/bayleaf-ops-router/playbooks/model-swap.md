---
source-skill: bayleaf-ops-router
description: Select, evaluate, and deploy a model for Chat's Basic or Help workspace models or a BayLeaf API recommendation.
status: Both paths tested in production (Chat 2026-09-01: basic+help → glm-5.3-flash; API 2026-09-01: glm-5.3-flash)
last-reviewed: 2026-09-01
---

# Model Swap (Chat / API)

## When to use

Selecting, evaluating, and deploying a model in either of two independent roles:

- **BayLeaf Chat:** change `base_model_id` on the `basic` or `help` Open WebUI
  workspace model, including vision capability handling. A private
  `basic-canary` workspace model isolates evaluation from production users.
- **BayLeaf API plaintext:** change the general-use recommendation exposed by
  `/recommended-model`, documentation and dashboard examples, and OpenCode
  onboarding. This does **not** provide a server-side fallback when callers omit
  `model`; callers still choose a model on every inference request.
- **BayLeaf API Sealed:** change the recommended Tinfoil model and curated
  companions exposed in documentation and the OpenCode remote provider.

These roles share selection policy but not deployment state. The API
recommendation does not need to match Chat's Basic or Help model.

## Shared selection gates

- **[HUMAN GATE]** Adam already has personal experience with the candidate
  model (used it himself, not just seen benchmarks). If not, candidates are
  discussion, not deployment. Experience gained through a canary run counts.
- A plaintext candidate must be reachable through a **ZDR provider endpoint** via
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
- **Availability where the swap lands.** Chat does not depend on the BayLeaf
  API, so the operative Chat check is the candidate being served by a provider
  **configured in OWUI** (OpenRouter as of 2026-09): translate the slug to
  OWUI's `openrouter.<owner>/<model>` form and, if the connection curates or
  disables models, ask the admin whether to enable the candidate. The
  open-weight preference still holds as policy. Do not treat presence in
  `GET https://api.bayleaf.dev/v1/models` as passing the gate: that listing
  checks only for a nonempty `hugging_face_id`. Make an authenticated inference
  request through BayLeaf API with the candidate instead. HTTP success proves
  the stronger current gate passed, including successful resolution of the
  reported Hugging Face repository; 403 is a blocker, not a timing deviation.
  Off-campus, source `~/.tokens/bayleaf-api` and use `$BAYLEAF_API_KEY` (same
  recipe as the API canary). This API request is policy evidence even though
  Chat's production traffic routes directly through its OWUI connection.

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
2. **Reasoning effort is a posture decision, not a model constant.** Set it
   from the pair of the underlying model's character and the role it plays
   here. Enumerate the candidate's supported reasoning efforts from its
   OpenRouter listing *before* pushing anything, and if the current model.json
   pins an effort the candidate does not support (e.g. `basic` pinned
   `reasoning_effort: none` until the glm-5.3 family made `none` invalid),
   the pin must change: a candidate that cannot disable reasoning changes the
   production model's character (latency, cost, tone) even with identical
   prompts. For a chat-facing model, prioritize responsiveness over depth:
   glm-5.3-flash is particularly thinky by default, so Chat pins it to `low`.
   Heavy thinking is not a defect — it is what the API path's consumers
   (autonomous coding-agent harnesses) want from the same model, which is why
   one candidate can rationally run hot there and cool here. Record the
   choice either way.
3. Edit `chat/models/<id>/model.json` in the repo: set `base_model_id` to the
   OpenRouter slug (e.g. `openrouter.<owner>/<model>`).
4. Vision handling (the recurring flip-flop, recorded for honesty): like
    reasoning effort, a posture decision, set from the underlying model's
    capabilities and the target's role. If the new model is vision-capable,
    set `meta.capabilities.vision: true` so OWUI
    routes image inputs; if not, `false`. Running without vision is a
    legitimate, cheaper posture we have used repeatedly; the prompt should not
    promise image understanding the model can't do. When swapping several
    models in one pass, decide vision **per target** and record the posture
    call explicitly: a vision-capable base does not obligate every target to
    advertise it, and a target's old minimal posture shouldn't silently
    disable a capability its new base offers (Help's vision was held off,
    then flipped on the same session by explicit call). Update
    `chat/DESIGN.md` §2's model description in the same pass.
5. Push: `set -a && source ~/.tokens/owui/chat-bayleaf-dev && set +a && uvx
   owui-cli models update chat/models/<id>/model.json`
6. **[HUMAN GATE]** The user exercises the swapped model in prod: a real
    conversation, an image upload if vision is on, a tool call. Model quality
    judgment is not delegable. Exercise this gate **on the canary first** —
    production models are never the first to run a candidate — and push
    production only on a canary pass; a prod spot-check closes the cycle.
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
   `api/TESTING.md` rather than duplicating them here. The request must return
   an actual successful inference response: catalog presence alone does not
   prove that the Hugging Face repository resolves, and HTTP 403 fails the
   open-weight gate.
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

## API Sealed path (recommended and curated models)

1. Confirm each candidate is present in `GET /sealed/models`, has the required
   chat endpoint and capabilities, and remains consistent with BayLeaf's
   open-weight policy. Tinfoil does not provide a mechanical weights field, so
   do not automatically expose its entire future catalog.
2. Canary the candidate through `opencode-tinfoil` and the production Sealed
   relay before changing discovery. Use the candidate's bare Tinfoil ID and an
   explicit temporary provider if it is not yet curated.
3. Update `SEALED_RECOMMENDED_MODEL` and `SEALED_CURATED_MODELS` in
   `api/wrangler.jsonc`. Keep the recommendation out of the companion list;
   `buildSealedModelEntries` injects it first and removes duplicates.
4. Update current Sealed examples, run `npx tsc --noEmit`, and deploy.
5. Verify the authenticated OpenCode config contains the recommendation first,
   all intended companions, and the complete Tinfoil marker. Leave
   `enclaveURL` unset for the standard router: the verifier derives it from the
   signed attestation bundle. Set it only when deliberately targeting a specific
   enclave, paired with any non-default `configRepo`.
6. Run a real request through the deployed `bayleaf-sealed-remote/<model>`
   provider in an isolated OpenCode configuration. This avoids mistaking local
   auth or plugin-version drift for a production failure.
7. Record `api/wrangler.jsonc`, synchronized examples, and this refinement log
   as `update: recommend <model> for BayLeaf Sealed`.

### API Sealed rollback

Restore the previous recommendation and companion list, redeploy, and repeat
the remote-config and encrypted-inference checks. Explicit model requests remain
available whenever Tinfoil still serves the model.

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
- 2026-09-01: first production Chat run — `basic` and `help` swapped together
  (glm-5.2 → glm-5.3-flash, effort low; canary passed first). Adam's
  clarification rewritten into the gates: Chat availability is about the
  OWUI-configured provider (slug translation, possibly enabling a disabled
  model), not the API-served open-weight list, which moved to API-path status
  and gained its auth caveat (unauthenticated GET returns empty — a silently
  vacuous check). Vision decided per target (basic on; help initially held
  off per its minimal posture, then flipped on the same session by explicit
  call); step 4 now says so. Human gate re-sequenced to run on the
  canary before any production push. Fresh-slug cache gotcha did not trigger;
  slug translation to `openrouter.z-ai/glm-5.3-flash` was the only
  OWUI-specific transform needed. Adam generalized both settings afterward:
  `reasoning_effort` and vision are posture decisions from model character ×
  deployment role — flash is thinky by default, which suits autonomous agent
  harnesses (the API path) rather than chat latency, hence the `low` pin on
  the chat-facing models.
- 2026-09-02: real policy-documentation run after the API adopted live
  Hugging Face repository resolution. The prior availability step treated
  `/v1/models` presence as the machine check and allowed a fresh-model timing
  deviation; reality contradicted that because listing checks metadata only,
  while inference enforces repository resolution. The gate now requires an
  actual successful BayLeaf API inference request and treats 403 as a blocker.
- 2026-09-03: first Sealed recommendation run (`glm-5-2` →
  `glm-5-3-flash`, adding `glm-5-3` as a premium companion). The playbook had
  no Sealed path, so one was added. A faulty canary combined `configRepo` with
  an obsolete `enclaveName`, briefly producing the wrong conclusion that relay
  configurations require explicit `enclaveURL`; inspection of the SDK showed
  the standard router is correctly inferred from the signed bundle. Normal
  local verification also proved unreliable when the machine lacked a
  well-known auth registration, so the new path calls for an isolated
  fetch-and-run check.
