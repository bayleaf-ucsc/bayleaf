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

### 2026-11-11 deployed qualified subset

Issue #98 is reopened: OpenRouter now documents media parts in the top-level
`state` array at `/api/alpha/decisions`. Its ZDR endpoint catalog lists Cloudflare
for Clef, Clef Flash and Clef Omni, and all three public weight repositories resolve.
The qualified subset was deployed as Worker
`9d290e2c-00f8-4c2e-a51f-a628d5d6470b`, with synthetic-media production checks
and a $1 maximum live-test budget. Unsupported formats/combinations remain denied.

Exposure scope for this revision: expose HTTP/OpenAPI and llms.txt guidance;
retain the existing dashboard/model-set consent (no new authority). Hosted
OpenChamber, Chat and desktop adapters remain deferred to the operator until a
separately approved adapter qualification. Sealed is unchanged and has no claimed
media parity. No uploads, retained media, new credentials for users or new budgets.

Optional `images`, `audio`, `videos` retain BayLeaf's embedded data URL or
`{content_type, base64}` envelope. `decisionMedia.ts` translates it into OpenRouter's
top-level `state` array: text first, images in array order, audio in array order,
then videos in array order. Structured text state is JSON-serialized to one string.
OpenRouter does **not** accept our top-level media fields directly. Its
[multimodal guide](https://openrouter.ai/docs/guides/community/multimodal-decisions)
now documents `image_url`, `input_audio`, and `video_url` parts, provider adapters,
and explicit capability failures rather than dropping unsupported bytes.

The adapter permits only exact Clef/Clef Flash/Clef Omni slugs, pinned to
`provider.only=["cloudflare"]`, `allow_fallbacks:false`, `zdr:true`, and
`data_collection:"deny"`. Alternate provider routing is rejected, not silently
overridden. Each media request checks the model's live modalities and a healthy
Cloudflare entry in `/api/v1/endpoints/zdr` with `safety_retention:false`. Published
weight checks and operation checks remain mandatory. No separate enable switch.

Initial, intentionally narrower bounds:

| Input | Deployed support / limits |
|---|---|
| Images | PNG/JPEG, valid signature/dimension headers, ≤16 megapixels each, ≤4 images. Combined decoded bytes: Flash ≤24 KiB; Clef/Omni ≤128 KiB. |
| Audio | Omni only; PCM16 RIFF/WAVE, mono/stereo, 8–48 kHz, ≤4 clips, ≤8 MiB and 300 seconds each. |
| Video | Omni only; conventional MP4, ≤2 clips, ≤16 MiB and 60 seconds per movie/track. Reject fragments, edit lists and version-1 duration headers. |
| Combined | Audio/video ≤16 MiB decoded; encoded body ≤36 MiB. State ≤1,800 UTF-8 bytes and state+questions ≤12,000 bytes. Conservative media+text token estimate ≤60,000. |

Strict canonical base64, decoded sizes, MIME/header matching and duration metadata
are checked before inference. Header checks bound conventional inputs, not prove
that an arbitrary codec stream is valid or will decode. No remote URLs, nested
media parts in state/questions, assets, uploads, retained media, implicit OCR or
transcription fallback. Unsupported formats fail explicitly. Small image limits
leave conservative headroom for Workers AI's base64-length preflight and Flash's
smaller live context; resize/recompress locally. WebP and compressed audio remain
unqualified, despite upstream support. Arbitrary provider/model media parity is
not claimed. Text-only requests retain their prior routing and size behavior,
except that native media parts in JSON context are explicitly denied.

Cloudflare documents roughly 2K text-state truncation on Clef/Clef Flash; the media
state byte ceiling avoids relying on that truncation. Omni samples video at 2 fps.
Cloudflare's direct contract says video soundtracks are heard only when **every**
video has a soundtrack. The adapter rejects mixing videos with and without audio.
It also rejects still images together with videos: the live mixed-input test
confused the red still image with the blue video. Separate these requests.

### Live compatibility evidence (2026-11-11)

`scripts/smoke-decision-media.mjs --live` runs the actual local workerd route with
real OpenRouter/Hugging Face fetches, not a direct-provider substitute. It creates
one disposable $0.25 lifetime-capped OpenRouter key, allows at most 12 serial
inference attempts, uses synthetic local fixtures, and deletes/verifies absence of
the exact key in `finally`. The existing management key worked after correcting
the runner to extract a token from a shell-assignment file; an initial malformed
Authorization request spent nothing and was not evidence of key expiry.

- First run: 11 successful inference responses, reported cost **$0.000731806**.
  PNG/JPEG red/blue discrimination passed on all three models; standalone spoken
  pineapple/elephant and red/blue video discrimination passed on Omni. A three-media
  request read video and speech, but confused the still image, so that combination
  was subsequently blocked.
- Final candidate run: 12/12 successful responses, reported cost **$0.000807256**.
  Repeated image/audio/video checks passed, spoken video soundtrack was recognized,
  and mixed separate WAV + video retained the spoken word and video color.
  All calls returned Cloudflare and typed Noul/Choice/Score answers; Omni returned
  revision `cloudflare/clef-omni-20261009`. Wrong modality, remote URL, alternate
  routing and still-image/video mixing returned 400 without an inference call.
- Total reported inference cost: **$0.001539062**. Both disposable keys were deleted
  and exact deletion verified. Immediate upstream aggregate usage lagged the sum
  of response costs: this is not proof of completed spend settlement. The two
  lifetime caps totaled $0.50, below the approved $1 ceiling.

### Production smoke (2026-11-11)

`node scripts/smoke-decision-media.mjs --live --production` passed against
`https://api.bayleaf.dev` after deployment:

- Six ordinary-key PNG/JPEG discrimination requests passed across all three models.
- Six `inference.decisions` app-token requests passed: two contrasting speech clips,
  two contrasting videos, a spoken video soundtrack and separate audio+video.
- Every success returned Cloudflare and all requested typed answers. Production
  reported inference cost was **$0.000807256**, bringing all local/live + production
  testing to **$0.002346318**. The runner limits attempts and sets provider maximum
  input price to $0.30/M with free output; production reuses the owner's allowance,
  not the local runner's disposable upstream key.
- Wrong modality, remote media, alternate routing and still-image/video mixing
  returned 400. Selecting a model outside the token's set returned 403. The exact
  test app token was revoked, absent from the owner list, and rejected with 401.
- The existing $5 allowance was unchanged. Immediate aggregate usage did not yet
  reflect response costs, so spend settlement remains unqualified.
- This machine was off-campus. Campus Pass assessment returned `campus_network:false`
  and keyless media returned 401. Positive on-campus media is **not** claimed.

These simple contrasting fixtures establish transport compatibility and some
content sensitivity, **not** calibration, representative accuracy, video temporal
reasoning, maximum-boundary decoder behavior, multiple-video soundtrack fidelity,
or installed client adapter parity. Synthetic HTTP tests cover byte-preserving
translation, input bounds, endpoint/ZDR uncertainty, and no silent media fallback;
the grant harness covers scoped inference and shared allowance behavior. Positive
on-campus media, broader format/provider qualification and deferred client adapters
remain explicit exclusions, not blockers to this bounded release. Tracking and
completion evidence: [issue #98](https://github.com/bayleaf-ucsc/bayleaf/issues/98).

## Exposure decision (approved: API first)

| Surface | Decision | Delivery and follow-up |
|---|---|---|
| HTTP/OpenAPI and llms.txt | Exposed | Production typed route, schemas and workflow guidance |
| Dashboard and consent | Exposed | Production creation/revocation and explicit two-model consent/PKCE verified |
| Hosted OpenChamber/OpenCode | Defer | Operator: adapter and package qualification after API rollout |
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
