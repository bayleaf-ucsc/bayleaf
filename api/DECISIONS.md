# Typed decision inference

Deployed 2026-10-13, version `a923004f-c34b-4876-ab72-a433fe08f420`.
`POST /v1/decisions` accepts
text/structured JSON state and named Choice, Noul and Score questions, returning
typed answers and upstream usage. Exact contracts are generated from `schemas.ts`.

## Policy and discovery

Decision inference is an operation on existing standard backends, not a separate
provider or enabled lane. Backend enablement, credentials, budgets and ZDR policy
remain shared. Vertex and Bedrock currently expose zero decision models.

OpenRouter discovery requests `output_modalities=text,decisions&zdr=true` because
the default catalog includes text outputs only. Eligibility still requires a
nonempty `hugging_face_id` and a resolving public repository. Weight-verdict cache
keys use v2 to invalidate previous text-only negatives. Inference verifies operation
capability against the ZDR-filtered catalog and enforces `zdr:true` and
`data_collection:"deny"` on submission. Model-set grants authorize slugs, not types.

The 2026-10-13 scan found Clef, Clef Flash, Drex v1.5, Tev1-4B experimental and Kev-4B
with published repository evidence and ZDR endpoints. This is metadata evidence,
not a compatibility or accuracy test. Jev lacks qualifying weight evidence.

## Multimodal contract

Optional `images`, `audio`, `videos` accept embedded data URLs or objects with
`content_type` and `base64`. Remote URLs, tracing and broadcast fields are rejected.
Encoded requests are limited to 36 MiB before JSON parsing. Counts reserve Clef
Omni's documented maximum of four images, four audio clips and two videos.

**Nonempty media currently returns 400 without forwarding.** OpenRouter's published
DecisionsRequest schema does not include these fields. Adding a model's advertised
input modalities is not proof that a route forwards its bytes. Before enabling
media, implement and verify a backend adapter against synthetic and live fixtures,
validate modality-specific MIME/base64 and decoded-size bounds, and qualify
per-endpoint support under enforced ZDR. Unsupported media must never be dropped.
Do not add persistent upload storage or provider-side files as an implicit fallback.

Remaining qualification is tracked in [issue #98](https://github.com/bayleaf-ucsc/bayleaf/issues/98).

Cloudflare's direct Clef Omni contract documents size/duration limits, possible text
state truncation and conditional handling of video soundtracks. Its contract is not
proof of OpenRouter compatibility. ZDR availability must be discovered, not predicted.

## Exposure decision (approved: API first)

| Surface | Decision | Delivery and follow-up |
|---|---|---|
| HTTP/OpenAPI and llms.txt | Exposed | Production typed route, schemas and workflow guidance |
| Dashboard and consent | Exposed | Production creation/revocation and explicit two-model consent/PKCE verified |
| Hosted OpenChamber/OpenCode | Defer | Operator: adapter and package qualification after API rollout |
| Hosted Nanobot | Defer | Operator: MCP adapter qualification after API rollout |
| BayLeaf Chat | Defer | Operator: identity/allowance mapping and toolkit consent after API rollout |
| Desktop clients | Defer | Operator: opt-in tool/skill distribution after API rollout |

No claims of installed adapter discovery or runtime parity. Sealed remains excluded
from grants because its encrypted model field cannot be checked by BayLeaf.

## Sealed decisions

Tinfoil serves `decision-small`, `decision-medium` and `decision-large` (vllm-sr d3
family, marked experimental) at `/v1/decisions`, so the existing path-generic relay
`POST /sealed/v1/decisions` carries them as EHBP ciphertext with no relay code change.
This is the confidential analogue of `/v1/decisions`, not a variant of it: clients use
a Tinfoil SDK (Python `tinfoil>=0.15.0`, JavaScript `tinfoil>=1.3.0`) and Tinfoil's
native schema (`input`; a `questions` list of `predicate`, `choice` with up to 26
`choices`, and `score` with `levels`). BayLeaf does not translate the standard
`state`/`noul` shape because the relay must never parse the body. Sealed limits,
per-user Tinfoil keys and grant exclusion apply unchanged. The local proxy at
`scripts/sealed/proxy.py` also serves `/v1/decisions`.

2026-10-22 evidence: `scripts/smoke-sealed-decisions.py` with an ordinary key passed
12/12 against production using synthetic content. All three models returned predicate,
choice and score answers relayed as ciphertext; plaintext was rejected with 400. The
relay saw only the usage header, which now includes `cost_usd` (323 prompt tokens:
small $0.0000065, medium $0.0000194, large $0.000129). No calibration claim.

## Qualification and rollout

Run decision, grant and documentation synthetic tests and TypeScript. Apply the
model-set grant migration before deploying. Both production grant tables were
empty in a read-only check on 2026-10-13. The migration removes singular model
storage and requires empty tables when applied, rather than silently discarding
new grants or transactions. With approval, use a capped provisioned
OpenRouter key to verify all three primitives, shared spend limits, 401 healing,
and fail-closed ZDR. No production calls or deployments are part of local tests.
Probabilities require domain-specific calibration; distribution confidence is not
an authorization or safety guarantee.

### Production evidence (2026-10-13)

Migration 0016 applied after reconfirming both tables empty; production schema
inspection confirms required `models_json` and no singular `model` columns.
`uv run --script scripts/smoke-decisions.py` (with an environment-supplied ordinary
BayLeaf key) passed against production using synthetic content:

- Clef and Clef Flash each returned valid Choice, Noul and Score answers.
- One model-set token supported decision inference plus Gemma 4 text inference.
- Valid ordinary-key fallback routing worked; decision/closed-weight fallbacks
  were denied on chat, Responses and the generic completions passthrough.
- Wrong operation/model, out-of-scope model, and all three media fields were denied.
- Keyless decision inference worked from this machine's eligible Campus Pass network.
- Exact test tokens were revoked, rejected immediately, and verified absent.

Provider-reported Clef Flash cost was $0.000006636 for 316 input tokens; Clef was
$0.000013272 for the same input. Both reported zero output tokens. The existing
owner allowance remained $5; immediate aggregate usage readings had zero delta,
so this does not establish out-of-band spend settlement timing or dollar-cap
exhaustion. Shared accounting and 401 healing are additionally covered by the
synthetic integration tests, not by deliberately exhausting a live user's budget.

After human UCSC sign-in, production dashboard creation/revocation passed without
displaying credentials. `scripts/smoke-grant-browser.py` verified explicit consent
listing Clef Flash and Gemma 4, exact loopback callback plus state/S256 PKCE exchange,
real decision and text inference with the same visitor-funded token, and exact
revocation with immediate rejection. The dashboard then showed no active temporary
tokens. Both live smoke scripts retain credentials in memory only. No media
inference or agent adapter qualification is claimed; issue #98 remains open.
