# Run evidence: model-swap

Dated record of past runs of [`model-swap.md`](../playbooks/model-swap.md), newest first unless noted.
Consult for diagnosis; current procedure lives in the linked file.

- 2026-11-05: prepared DeepSeek V4.1 Flash recommendations for both API lanes,
  dated 1017 on OpenRouter and upgraded-in-place bare ID on Tinfoil; refreshed
  Kimi companions to K3.1 Pro and removed Gemma/GPT-OSS from Sealed curation.
  Both Sealed candidates passed encrypted ordinary, full tool-round-trip and
  synthetic vision checks. Standard canaries reached an upstream daily-key
  budget 403, not a model-policy denial; do not conflate these or raise caps
  implicitly. Standard inference and isolated OpenCode qualification remain
  pending at that point. After the allowance reset, both standard candidates
  passed ordinary, full tool-round-trip and synthetic vision checks. DeepSeek
  failed the strict exact-text assertion on both lanes in the first post-reset
  run, then passed the unchanged assertion and all remaining checks on retry;
  the initial differing text was not captured, so its cause is unresolved.
  With explicit approval, deployed API `6ea4483b-f610-4d2f-81fc-1e3b3242abd5`
  and probe `083735c9-3233-4407-9f69-26cfbf9d911f`. Live recommended-model,
  both authenticated remote model maps/defaults, Sealed EHBP marker and generated
  llms.txt passed. Live catalog, standard recommendation and Sealed inference
  probes all returned 200/ok, with no missing or deprecated curated models.
  Isolated OpenCode qualification remains unperformed.
  Fixed the probe absence test's stale hardcoded
  model expectation to derive it from the pinned catalog base.

- 2026-10-12: updated the Sealed discovery/onboarding pin and attestation-harness
  literal to `opencode-tinfoil@0.3.1`. OpenCode V2 canaries should use
  `--standalone` to isolate the server as well as temporary configuration and
  state: the default shared server is a confounder when testing CLI environment
  overrides.

- 2026-10-08: reviewed and redeployed the pending Sealed refresh before recording
  it in Git. Discovery and encrypted ordinary/tool-use canaries passed; an ordinary
  response took 108.2 seconds. Successful later probes do not erase this latency
  observation or establish a reliable monitoring deadline.

- 2026-10-07: deployed a Sealed refresh for GLM 5.3 Flash's catalog deprecation
  date (2026-10-09). GLM 5.3 passed default-parameter encrypted
  ordinary-response and full tool-result canaries plus an isolated V2 read-tool
  run using opencode-tinfoil@0.3.0. Discovery previously used only names, ignoring
  deprecation and pricing; added deprecated/non-chat exclusion and price metadata.
  The probe's curated-list mirrors must move with Sealed too. TinfoilAI does not
  accept OpenAI's max_retries constructor argument; the new canary omits it.
  API version d2cd8a38-cddb-4789-b9ab-e97685e3f740 and probe version
  00184ac7-48c2-4a4d-8835-9a62e58ded11 deployed with approval. Live discovery
  confirmed recommendation-first ordering, five priced entries, and EHBP markers;
  the catalog probe reported no missing/deprecated entries. Repeated encrypted
  canaries and an isolated OpenCode run using the fetched production config passed.
  Python urllib received edge 403s on metadata GETs; curl succeeded unchanged.

- 2026-09-07: the new non-admin availability probe found Basic invocation failing
  despite a public preset grant and successful admin use. The running 0.11.3
  code requires a model-table row and read grant for the underlying model too;
  listing does not enforce that same chain. Registering glm-5.3-flash as active,
  public-read, and hidden repaired the non-admin failure. Added a base-grant and
  non-admin inference gate. The failure may date to the September 1 swap, but
  its actual start was not established.

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

## Moved from the playbook body

```text
status: Both paths tested in production (Chat 2026-09-01: basic+help → glm-5.3-flash; API 2026-09-01: glm-5.3-flash)
```

```text
  **configured in OWUI** (OpenRouter as of 2026-09): translate the slug to
```

```text
   **Non-admin access gate (OWUI 0.11.3):** provider discovery and a public
```

```text
   pins an effort the candidate does not support (e.g. `basic` pinned
   `reasoning_effort: none` until the glm-5.3 family made `none` invalid),
   the pin must change: a candidate
```

```text
4. Vision handling (the recurring flip-flop, recorded for honesty): like
```

```text
    disable a capability its new base offers (Help's vision was held off,
    then flipped on the same session by explicit call). Update
```
