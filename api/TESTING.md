# Agentic Manual Testing — BayLeaf API

## Documentation ownership qualification (2026-10-11)

Follow-up deployed as `a54fdc61-c34d-4955-9125-bf59e2c3c364`: removed the added navigation header at Adam's request,
restoring the original plain Scalar shell. Guide/source/support links remain in
the generated overview. The docs test now guards against an added shell header;
the fallback-link checks described below applied to the initial deployed revision.
Live HTML confirms the original Scalar shell without an added header.

Deployed and live-verified as version `d7c46d9c-9ca0-46fa-a85e-abd2aa2ba35a`.
`npm run test:docs` uses real workerd with
synthetic provider metadata to check code-generated grant field descriptions,
management/campus authentication alternatives, registry-only browser authorization,
reciprocal guide/spec/viewer navigation and alternate deployment facts. It also
checks Markdown heading targets and durable HTML/no-JavaScript fallback links.
`npm run test:grants`, `npx tsc --noEmit` and `git diff --check` pass. Astra reviewed
the strategy and implementation; its final corrections clarify sandbox credential
custody, backend-disabled errors and catalog availability semantics.

The synthetic Scalar preview at `http://localhost:8806/docs` was inspected in the
browser at desktop/mobile settings; `#tag/grants` resolves to its protocol narrative.
Live OpenAPI and `llms.txt` checks confirm deployment facts, grant authorization,
authentication alternatives and reciprocal links; the production Scalar viewer
renders the updated overview and Grants anchor. No live inference, login, consent
or provider spend was part of this documentation qualification.
CDN-failure fallback is checked structurally, not
through a simulated browser outage. Start the preview with
`npm run test:docs -- --serve`.

Runbook for agents performing manual smoke tests against the live
BayLeaf API deployment. The user provides a `sk-bayleaf-*` API key;
every test below uses `curl` against `https://api.bayleaf.dev`.

Inspired by Simon Willison's
[Agentic manual testing](https://simonwillison.net/guides/agentic-engineering-patterns/agentic-manual-testing/)
pattern — have the agent execute real requests and inspect real output,
not hoped-for output.

Run these after any deploy that touches routing, templates, proxy
logic, or sandbox integration. Each section is self-contained — run
them in order because the sandbox tests build on each other and the
final step destroys the sandbox.

---

## Campus Pass availability

```bash
npm run test:campus-pass
npx tsc --noEmit
```

Credential-free full-app HTTP tests use synthetic KV and mocked OpenRouter
metadata in Node (the unrelated Worker RPC base is stubbed). They cover trusted
IP eligibility, IPv6 bucketing, daily quota reads without writes, pool and account
credit, unknown/error states, provider-cache expiry/coalescing, CORS preflight,
generated OpenAPI, and the JS guidance in `llms.txt`. No inference is performed.

After deployment, check `GET /campus-pass` from a real off-campus browser and a
real campus browser. Do not forge client-IP headers as a substitute for the
campus test. Confirm `Cache-Control: no-store`, wildcard CORS, no dollar amounts
or IP disclosure, and the `inspectCampusPass` operation in `/docs/openapi.json`.
Serve `api/examples/campus-pass.html` with an ordinary local static server to
exercise cross-origin JS. Generating deliberately consumes allowance; initial
page load and Check again do not. Provider readings are advisory, not proof of
model health or a reservation of funds.

2026-10-11 qualification: Astra reviewed the complete uncommitted change and
verified the malformed-provider/quota fixes before rollout. Live campus GET,
no-store/CORS headers, JSON POST preflight, generated OpenAPI, agent guidance, and
the card note passed. A real cross-origin browser demo reached keyless inference.
The initial 256-token example returned no visible answer, and disabling reasoning
was rejected by the current recommended model; the example now allows 4096 tokens
with low reasoning effort and treats empty content as an explicit error. Off-campus states are covered by
synthetic tests, not a separately qualified real off-campus connection.

Final deployed version: `a8ab833c-c077-403a-932b-acbfee3c84d0`. The adjusted
cross-origin browser example displayed a real answer and refreshed its allowance;
the full qualification used five network-quota slots (including unsuccessful
inference attempts). Passive checks consumed none. Final live `llms.txt` guidance
and campus availability passed after redeployment.

## Local: transient preview harness

```bash
npm run test:previews
npx tsc --noEmit
```

Runs the bundled Worker in workerd with ephemeral D1, synthetic credentials,
and mock upstreams. No live services or local `.dev.vars` secrets are used.
Tests strict v2 registration, public and private enforcement, the two-host login
handoff, copied-URL rejection, origin checks, forwarding, keyed exposure,
expiry, revocation, and cleanup.
See [PREVIEWS.md](PREVIEWS.md) for the separate real-browser and Daytona
qualification gates. The harness does not prove those gates.

### Running the Sealed harness against a deployed instance

Simpler than the local HTTPS setup below, and now the preferred path: prod
already serves real TLS, so the Tinfoil SDK's https requirement for the
attestation bundle URL is satisfied with no cert generation and none of the two
TLS traps.

```bash
# Seed a throwaway token (backend keys are minted on first use, so a
# token-only row is a valid, complete row).
npx wrangler d1 execute bayleaf-keys --remote --command \
  "INSERT INTO user_keys (email, bayleaf_token) VALUES ('sealed-harness@ucsc.edu','sk-bayleaf-...');"

SEALED_BASE=https://api.bayleaf.dev/sealed \
SEALED_AUTH=sk-bayleaf-... \
  ./scripts/harness-sealed.py

# Attestation-mutation suite still needs a local cert: it stands up its own
# HTTPS server serving tampered bundles and asserts the CLIENT refuses them.
SEALED_CA=<dev-cert.pem> SEALED_BASE=https://api.bayleaf.dev/sealed \
SEALED_TAMPER_PORT=8801 SEALED_OPENCODE=1 \
  ./scripts/harness-sealed-attestation.py

# Clean up: delete the row AND the per-user Tinfoil key the run minted.
```

`SEALED_OPENCODE=1` opts into live inference: an additional OpenCode genuine-bundle
positive control followed by a mutated-bundle check through the same isolated
standalone configuration. The plugin pin lives in `scripts/sealed_opencode_check.py`
(keep it synchronized with `SEALED_PLUGIN` in `src/constants.ts`). The positive
control requires `SEALED_AUTH` or eligible Campus Pass and consumes allowance.
Only recognizable verifier refusal after successful genuine inference is PASS.
Startup/plugin/auth/network failures and unknown diagnostics are INCONCLUSIVE,
with exit 2, not PASS. Raw client output is not printed or persisted by the checker.
Omit the option to run the SDK suite without OpenCode. Offline classification
and same-configuration sequencing checks: `python3 -B scripts/test-sealed-opencode-check.py`.

For OpenCode V2 canaries, use `opencode run --standalone` with temporary
configuration and state so the CLI does not reuse a shared background server
with a different environment. Provider enumeration, plugin loading, successful
inference, and fail-closed behavior are separate checks. An OpenCode attestation
test needs a genuine-bundle positive control through the same client setup,
followed by an identifiable verification rejection for the mutated bundle.
Model-not-found, credential, or plugin-load errors are inconclusive, not proof
that attestation enforcement worked.

`SEALED_AUTH` defaults to `campus`, which only resolves from a campus IP. Use a
keyed token off-campus, and prefer it regardless: Campus Pass shares an env-held
pool key and exercises none of the minting, CAS, or healing paths.

`SEALED_ENABLED` is `"true"` in production, so no deploy or flag flip is needed
to run this against `api.bayleaf.dev`. Note that the harness mints a real
per-user Tinfoil key and spends real credit, so clean up the row and the key.

## Automated: the key lifecycle harness

### Empirical OpenRouter spend-cap response (2026-09-23)

Tested with disposable keys created using the BayLeaf workspace management key
from `api/.env`, direct `POST /api/v1/chat/completions` requests with
`provider.data_collection: "deny"`, and `GET /api/v1/auth/key` with the same
disposable credential. Both keys were deleted after the experiment.

- A key created with `limit: 0, limit_reset: "daily"` returned **HTTP 403**
  for two different paid models, with `error.code: 403` and message
  `Key limit exceeded (daily limit). Manage it using ...`. The key remained
  enabled and `/auth/key` returned 200, with zero remaining.
- A second key at $0.0001/day first completed a paid request. Its cap was
  lowered below the first request's reported cost. Two further requests
  succeeded before the next returned the same **403**. At that point
  `/auth/key` returned 200 with `limit_remaining: 0`. OpenRouter's spend
  accounting and enforcement are not instantaneous; this test does not
  establish a strict per-key dollar ceiling for concurrent or closely spaced
  requests.

The production bug this exposed: treating an OpenRouter 403 as an invalid key
in `sendWithHeal` minted a fresh key with a fresh $5/day cap. An exhausted key
is still valid; only OpenRouter 401 is a healing signal. This is different from
Tinfoil, where 403 remains a possible credential rejection.

`scripts/harness-provision.mjs` is the one part of this file that runs itself.
It exercises every path through `src/provision.ts` (fresh token provision, lazy
backend minting, 409 on double-provision, self-heal after upstream key loss,
revoke/re-provision with retained provider state, both claim-flow entry points,
and concurrent first-use cleanup) against `wrangler dev --local`, asserting on
both the local D1 row and the real OpenRouter key inventory. No prod involvement.

```bash
# .dev.vars has a stale OPENROUTER_PROVISIONING_KEY; override it with the
# working management key from .env for the duration of the run.
python3 -c "import os;e=dict(l.strip().split('=',1) for l in open('.env') if '=' in l);p=os.environ['TMPDIR']+'/or-override.env';open(p,'w').write('OPENROUTER_PROVISIONING_KEY='+e['OPENROUTER_MAINTENANCE_KEY']+'\n');os.chmod(p,0o600)"
npx wrangler dev --port 8799 --local --env-file .dev.vars --env-file "$TMPDIR/or-override.env" &
sleep 12
node scripts/harness-provision.mjs --live
```

Without `--live`, the harness exits 2 before reading credentials/configuration or
making requests. Importing it does not execute it. Offline exception-safety checks:
`node scripts/test-provision-cleanup.mjs`. These normally import the actual runner
with synthetic HTTP, D1 and credential inputs, without VM modules or import/global
replacements. Permission-restricted child processes check the actual CLI guard and
import silence, using `--experimental-permission` on Node 22.0–22.12 and
`--permission` where supported. Both smoke checks retain credential/config-read
and subprocess restrictions; network permissions additionally deny networking on
Node versions that support them. Qualified with Node 26.11.1 only: the older-22
compatibility path has not been executed, and no higher Node minimum is imposed.
Tests cover the original 12 failure scenarios, complete multi-page discovery across
both exact run-owned names, unrelated-resource preservation, and draining late
concurrent mints before cleanup. They do not qualify live providers.

The live harness creates real OpenRouter keys for unique per-run `*@example.invalid`
addresses and cleans up in `finally`. Cleanup rediscovers exact run-owned names,
including keys not yet recorded in D1, then verifies provider and D1 deletion.
Each discovery or absence-verification phase scans the complete paginated provider
inventory once for both exact run-owned names, not once per email. Every deletion
still requires its own fresh provider hash-and-name ownership check.
Cleanup failure is reported separately without replacing an original test exception.
Failures emit bounded `HARNESS_DIAGNOSTIC` JSON records: phase, run ID, a fixed
exception-class label, and, for harness-tagged failures only, literal operation
and reason labels plus numeric HTTP status where available. Cleanup aggregates
include their known safe causes, capped at 12 records plus a truncation marker
per report. Unknown exceptions (including untrusted aggregates) are class-only;
messages, stacks, response bodies, credentials, hashes and provider names are never
included in these diagnostics. Cleanup evidence is additional to the original
failure, whose object and failed exit outcome are preserved.
Every provider deletion first requires a fresh provider lookup with an exact
unique run-owned name and matching hash. D1 hashes and the harness inventory are
only candidates: unowned or unverifiable candidates are not deleted and prevent a
clean-cleanup report. Offline tests include poisoned-D1 and stale unowned inventory
cases and verify that lookup failures issue no DELETE requests.
**It refuses to run if the OpenRouter admin key is
rejected**, because a 401 makes every upstream lookup return `null`, which
turns both the assertions and the cleanup check into false greens — that
failure mode leaked two real keys the first time this harness was written.
Process termination (for example SIGKILL) cannot run `finally`. If interrupted or
cleanup fails, inspect the printed run ID and sweep only its exact owned names:

```bash
# list any survivors before deleting
node -e 'fetch("https://openrouter.ai/api/v1/keys?limit=100",{headers:{Authorization:"Bearer "+process.env.K}}).then(r=>r.json()).then(j=>console.log(j.data.filter(k=>(k.name||"").includes("example.invalid"))))'
```

---

## Automated: the Sealed lane conformance harness

`scripts/harness-sealed.py` and `scripts/harness-sealed-attestation.py` exercise
the BayLeaf Sealed lane (`src/routes/sealed.ts`, issue #55): the EHBP ciphertext
relay that carries end-to-end-encrypted bodies to an attested Tinfoil enclave.
33 checks total, no prod involvement.

Between them they assert the three properties the lane exists to claim:

1. an encrypted completion succeeds end to end through the Worker;
2. the Worker observes only ciphertext, yet still receives usage metadata;
3. plaintext, tampered ciphertext, destination substitution, client-supplied
   provider credentials, and mutated attestation bundles all fail **closed**.

### Why this one needs HTTPS locally

Unlike every other harness here, this cannot run against plain
`http://localhost`. The Tinfoil SDK **hard-requires an `https`
`attestation_bundle_url`** (`_parse_http_url(..., https_only=True)`), because the
bundle is the entire trust root for verification. So `wrangler dev` has to serve
TLS, which means generating a throwaway cert and telling the Python client to
trust it.

```bash
# 1. Throwaway cert for localhost. $TMPDIR, never the work tree.
mkdir -p "$TMPDIR/sealed-tls" && cd "$TMPDIR/sealed-tls"
openssl req -x509 -newkey rsa:2048 -sha256 -days 7 -nodes \
  -keyout dev-key.pem -out dev-cert.pem \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -addext "basicConstraints=critical,CA:TRUE"

# 2. Sealed lane needs its kill-switch on plus a server-side Tinfoil key.
#    SEALED_ENABLED is "true" in wrangler.jsonc, but set it in .dev.vars anyway
#    so local runs do not depend on that file, and supply a server-side key.
#    Get a tk_ from the `bayleaf` Tinfoil org; never commit it.
cd -
grep -q '^SEALED_ENABLED=' .dev.vars || cat >> .dev.vars <<'EOF'
SEALED_ENABLED=true
TINFOIL_API_KEY=tk_...
EOF

# 3. wrangler dev over TLS
npx wrangler dev --port 8787 --local-protocol https \
  --https-cert-path "$TMPDIR/sealed-tls/dev-cert.pem" \
  --https-key-path  "$TMPDIR/sealed-tls/dev-key.pem" &
sleep 14

# 4. Run both harnesses
SEALED_CA="$TMPDIR/sealed-tls/dev-cert.pem" ./scripts/harness-sealed.py
SEALED_CA="$TMPDIR/sealed-tls/dev-cert.pem" ./scripts/harness-sealed-attestation.py
```

**`.dev.vars` is not hot-reloaded.** Flipping `SEALED_ENABLED` requires a
restart of `wrangler dev`, which is easy to mistake for a broken kill-switch.
To verify it fails closed, set it to `false`, restart, and confirm all four
`/sealed/*` endpoints answer `503` (including `/sealed/health`, so a disabled
lane leaks no upstream state).

### Two traps in the client-side TLS setup

Both cost real debugging time; the harnesses handle them, but anything
hand-rolled will hit them.

- **Do not `export` `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE`.** It breaks `uv`'s
  own TLS when it resolves dependencies (`invalid peer certificate:
  UnknownIssuer`). The harnesses set them *inside* the process instead, from
  `$SEALED_CA`.
- **The CA bundle must be certifi's roots PLUS the dev cert, not the dev cert
  alone.** Attestation verification also reaches Sigstore's TUF CDN over real
  TLS; a dev-cert-only bundle fails with `Failed to refresh TUF metadata`, which
  looks like an attestation bug and is not one.

### Known-absent: streaming usage accounting

`harness-sealed.py` reports streaming usage as `ABSENT (trailer not surfaced)`.
That is expected, not a regression. Tinfoil returns usage for streamed responses
as an **HTTP trailer** (it announces `Trailer: X-Tinfoil-Usage-Metrics` and
emits the value after the body), and the Cloudflare Workers `fetch()` API
exposes no trailer accessor. Verified live: a direct request to the enclave
receives the trailer, the same request through the relay does not, and it is
dropped rather than passed to the client. Non-streaming responses report usage
in an ordinary response header and work fine.

Consequence: **token-based quota cannot be enforced in-flight for streaming
traffic.** It does not follow that quota must be request-count based. The
authoritative per-key, per-model dollar cost is available out-of-band from
`GET /api/billing/usage?time=<window>`, it includes streamed usage, and it
reconciles within about 6 seconds. See the cost accounting section of
`AGENTS.md`.

### Non-determinism to expect

`atc.tinfoil.sh/attestation` answers `GET` with whichever router enclave is
current, and it varies between calls (observed alternating between
`router.inf6.tinfoil.sh` and `inference.tinfoil.sh`). Never assert on a specific
enclave hostname, and never compare HPKE public keys across two separate
`verify()` calls: they legitimately differ.

---

## Prerequisites

The user must supply:

- A valid BayLeaf API key (`sk-bayleaf-...`)

Store it in a shell variable for the session:

```bash
KEY="sk-bayleaf-..."
```

---

## 1. LLM Proxy — Chat Completions

Verify caller-controlled system instructions on the `/v1/chat/completions`
endpoint.

```bash
curl -s https://api.bayleaf.dev/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "z-ai/glm-5",
    "messages": [
      {"role": "system", "content": "Reply with exactly CALLER_INSTRUCTIONS_PRESERVED."},
      {"role": "user", "content": "Follow the system instruction."}
    ]
  }' | python3 -m json.tool
```

**Check:**

- Response is valid JSON with `choices[0].message.content`
- `choices[0].message.content` is `CALLER_INSTRUCTIONS_PRESERVED`
- The response does not contain a BayLeaf-added system instruction
- `usage` object is present with `prompt_tokens` and `completion_tokens`

### Open-weight enforcement

OpenRouter inference requires both a nonempty `hugging_face_id` in OpenRouter's
catalog and successful resolution of that Hugging Face repository. The ordinary
request above is therefore also the positive gate test: repeat it to exercise
the 24-hour positive cache.

Request a known proprietary model through every OpenRouter POST path and verify
it is rejected before inference:

```bash
# Dedicated Chat Completions route
curl -i https://api.bayleaf.dev/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-5.4","messages":[{"role":"user","content":"Hello"}]}'

# Dedicated Responses route
curl -i https://api.bayleaf.dev/v1/responses \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-5.4","input":"Hello"}'

# Generic POST catch-all
curl -i https://api.bayleaf.dev/v1/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-5.4","prompt":"Hello"}'

# The generic POST catch-all must also fail closed when model is absent
curl -i https://api.bayleaf.dev/v1/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Hello"}'
```

**Check:** all four requests return HTTP 403 with an error stating that
published open weights could not be verified. Repeat a proprietary-model
request to exercise the 24-hour definite-negative cache. Lookup failures such
as OpenRouter/Hugging Face timeouts also return 403, but are deliberately not
cached; verifying that distinction requires inspecting or controlling
`MODEL_STATUS`, not merely repeating a live smoke test.

The dedicated Chat Completions and Responses schemas require `model`; omitting
it there returns HTTP 400 during schema validation. The explicit missing-model
403 above covers the generic POST path, whose body is parsed by the catch-all.

---

## 2. LLM Proxy — Tool-use conversation

Verify that multi-turn conversations with tool calls pass through
validation. This exercises `role: 'tool'` messages, assistant messages
with `content: null` + `tool_calls`, and extra fields like
`tool_call_id` — all of which must survive schema validation and be
forwarded to OpenRouter.

```bash
curl -s https://api.bayleaf.dev/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "z-ai/glm-5",
    "messages": [
      {"role": "user", "content": "What is the weather in Santa Cruz?"},
      {"role": "assistant", "content": null, "tool_calls": [
        {"id": "call_abc123", "type": "function", "function": {"name": "get_weather", "arguments": "{\"location\": \"Santa Cruz, CA\"}"}}
      ]},
      {"role": "tool", "tool_call_id": "call_abc123", "content": "{\"temperature\": 62, \"condition\": \"sunny\"}"},
      {"role": "user", "content": "Summarize that in one sentence."}
    ]
  }' | python3 -m json.tool
```

**Check:**

- Response is valid JSON (not `"Invalid JSON in request body"`)
- `choices[0].message.content` contains a weather summary referencing
  the tool result (62 degrees, sunny)
- `usage` object is present

---

## 3. LLM Proxy — Responses API

Verify that `/v1/responses` forwards caller-provided `instructions` unchanged
while retaining user-field attribution.

```bash
curl -s https://api.bayleaf.dev/v1/responses \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "z-ai/glm-5",
    "input": "Follow the supplied instruction.",
    "instructions": "Reply with exactly CALLER_INSTRUCTIONS_PRESERVED."
  }' | python3 -m json.tool
```

**Check:**

- Response contains an `instructions` field in the JSON
- That field is exactly the caller-supplied instruction, with no BayLeaf prefix
- The generated output is `CALLER_INSTRUCTIONS_PRESERVED`
- `user` field is set (should be the email associated with the key)

---

## 4. LLM Proxy — Models list

Verify the catch-all GET proxy works.

```bash
curl -s https://api.bayleaf.dev/v1/models \
  -H "Authorization: Bearer $KEY" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin)["data"]; assert d; assert all(m["id"].startswith("openrouter:") for m in d); assert all(isinstance(m.get("hugging_face_id"),str) and m["hugging_face_id"].strip() for m in d); print(f"OK: {len(d)} open-weight candidates")'
```

**Check:**

- Prints `OK: <N> open-weight candidates` where N is a positive number.
- Every listed model is prefixed with `openrouter:` and has a nonempty
  `hugging_face_id`. This listing predicate does not resolve every repository;
  the stronger resolution check happens when a model is used for inference.
- No `vertex:` or `bedrock:` entries appear while those backends are disabled.


---

## 4.5. LLM Proxy — Disabled Vertex Routing

Verify that the disabled Vertex backend fails closed before GCP authentication
or inference.

```bash
curl -i https://api.bayleaf.dev/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "vertex:gemini-2.5-flash",
    "messages": [{"role": "user", "content": "What is the capital of California?"}]
  }'
```

**Check:** HTTP `503`, with an error stating that the Vertex AI backend is
currently disabled and directing the caller to an `openrouter:` model.



## 5. Sandbox — Execute a command

This creates (or reuses) a persistent sandbox tied to the key's user.
The first request may take 10–30 seconds if the sandbox needs to be
provisioned or started.

From the campus network (or local development), first verify that Campus Pass
cannot create a sandbox:

```bash
curl -s -w '\nHTTP %{http_code}\n' \
  https://api.bayleaf.dev/sandbox/exec \
  -H "Authorization: Bearer campus" \
  -H "Content-Type: application/json" \
  -d '{"command": "echo this-must-not-run"}'
```

**Check:** HTTP `403`, with a message directing the caller to provision a free
personal key. Confirm in Daytona that no sandbox was created.

```bash
curl -s https://api.bayleaf.dev/sandbox/exec \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"command": "echo hello-from-sandbox && uname -a && pwd"}' \
  | python3 -m json.tool
```

**Check:**

- `exitCode` is `0`
- `output` contains `hello-from-sandbox`, a Linux kernel version, and
  `/home/daytona/workspace`

---

## 6. Sandbox — Upload a file

```bash
curl -s -X PUT \
  "https://api.bayleaf.dev/sandbox/files/home/daytona/workspace/smoke-test.txt" \
  -H "Authorization: Bearer $KEY" \
  --data-binary "smoke test payload"
```

**Check:**

- Response JSON: `{"success": true, "path": "/home/daytona/workspace/smoke-test.txt", "bytes": 18}`

---

## 7. Sandbox — Download the file

```bash
curl -s "https://api.bayleaf.dev/sandbox/files/home/daytona/workspace/smoke-test.txt" \
  -H "Authorization: Bearer $KEY"
```

**Check:**

- Body is exactly `smoke test payload`

---

## 8. Sandbox — Verify via exec

Cross-check that the uploaded file is visible inside the sandbox.

```bash
curl -s https://api.bayleaf.dev/sandbox/exec \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"command": "cat /home/daytona/workspace/smoke-test.txt"}' \
  | python3 -m json.tool
```

**Check:**

- `exitCode` is `0`
- `output` is `smoke test payload`

---

## 9. Sandbox — Destroy

```bash
curl -s -X DELETE https://api.bayleaf.dev/sandbox \
  -H "Authorization: Bearer $KEY" \
  | python3 -m json.tool
```

**Check:**

- `{"success": true, "message": "Sandbox deleted."}`

Optionally re-run step 5 afterward to confirm a fresh sandbox is
provisioned from scratch (the first request will be slow again).

---

## 10. Key lifecycle — read-only checks

The provision/self-heal path in `src/provision.ts` backs four surfaces: the
dashboard render, all three `/key` verbs, and the claim flow's approve step.
Exercise the non-destructive half here.

**Do not run the revoke/re-provision test below on your own primary key unless
you're willing to have a new `sk-bayleaf-` token minted** — revoking mints a new
token and invalidates the old one everywhere it's configured.

Budget introspection (the canonical, agent-facing endpoint):

```bash
curl -s https://api.bayleaf.dev/v1/auth/key \
  -H "Authorization: Bearer $KEY" | python3 -m json.tool
```

**Check:**

- `data.limit` and `data.limit_remaining` are present, `data.usage` is a number
- `data.bayleaf.openrouter` mirrors those with an `applies_to` naming the
  `openrouter:` prefix
- One block per *enabled* alternate backend (`bedrock`, `vertex`) with
  `requests_today` / `limit` / `resets_at`. A disabled backend must be absent.

Dashboard render for a signed-in user (browser, or with a session cookie):

```bash
curl -s https://api.bayleaf.dev/dashboard -H "Cookie: $SESSION_COOKIE" | rg -o 'Daily spend[^<]*'
```

**Check:**

- The key card shows daily/monthly usage, i.e. `resolveOrKey` found the
  upstream key. If usage is missing but the page still renders, the OR key
  lookup failed — that's the deliberate non-fatal path, worth investigating but
  not a page break.
- No `sk-` value appears anywhere in the HTML (see the "Don'ts" in AGENTS.md).

**Self-heal (destructive to the upstream OR key, safe for the user).** Delete
the user's key on OpenRouter, then load the dashboard. A new OR key should be
created, the D1 row updated in place, and the user's `sk-bayleaf-` token should
keep working unchanged. Confirm the token still authenticates afterward with the
`/v1/auth/key` call above, and note that the new key carries the *global*
`SPENDING_LIMIT_DOLLARS`, not any cohort limit previously set via
`scripts/spend-limits.mjs`.

---

## 11. Error pages (browser-facing)

Verify the JSX error page template renders. No auth needed.

```bash
curl -s -o /dev/null -w "%{http_code}" https://api.bayleaf.dev/nonexistent-page
```

**Check:**

- HTTP status is `404`

Optionally fetch the body and confirm it contains `Not Found` and the
BayLeaf layout (header, footer, API Reference link).

---

## 12. Campus Pass — RPD counter (campus-only)

**Run only from a UCSC IP or `127.0.0.1`.** Verifies the unified per-IP
daily request counter that gates `/v1/chat/completions` and `/v1/responses`
for Campus Pass users.

Inspect the current counter without consuming a request:

```bash
curl -s https://api.bayleaf.dev/v1/auth/key \
  | python3 -m json.tool
```

**Check:**

- Response has `data.bayleaf.campus` with `requests_today`, `limit`,
  `limit_remaining`, `resets_at`, and an `applies_to` describing the
  per-network-address scope.
- `limit` matches `CAMPUS_RPD_LIMIT` (default 100).
- `resets_at` is a future ISO-8601 timestamp at midnight UTC.

Make a billable Campus Pass call:

```bash
curl -i https://api.bayleaf.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openrouter:z-ai/glm-5",
    "messages": [{"role": "user", "content": "ping"}]
  }' | python3 -m json.tool
```

Then re-inspect:

```bash
curl -s https://api.bayleaf.dev/v1/auth/key \
  | python3 -m json.tool
```

**Check:**

- `data.bayleaf.campus.requests_today` incremented by exactly 1.
- `limit_remaining` decremented by exactly 1.

---

## 13. Campus Pass — Disabled Vertex routing (campus-only)

Verify Campus Pass does not bypass the Vertex backend kill-switch.

```bash
curl -i https://api.bayleaf.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "vertex:gemini-2.5-flash-lite",
    "messages": [{"role": "user", "content": "What is the capital of California?"}]
  }'
```

**Check:**

- Response is HTTP `503`, with an error stating that Vertex AI is disabled.
- No GCP inference occurs. The Campus Pass counter may already have incremented:
  its unified limit is enforced before backend-prefix routing.

---

## 14. Campus Pass — Landing page card (campus-only, browser)

Visit `https://api.bayleaf.dev/` from a campus IP in a browser.

**Check:**

- The Campus Pass card shows a usage line: "**N** of 100 requests used
  today by your network address. Resets <time>."
- No raw IP address appears anywhere on the page.
- After making a Campus Pass call, refreshing the page shows the count
  bumped by one.

---

## Notes

- **Don't skip step 9.** The sandbox tests are ordered so that the
  final step cleans up. If you stop mid-sequence, a sandbox is left
  running (it will auto-stop after 15 min idle, but still).
- **Streaming is not tested here.** A `"stream": true` test for chat
  completions would need to inspect SSE chunks, which is awkward in
  `curl`. If streaming behavior is suspect, use `curl --no-buffer` and
  visually inspect the `data:` lines.
- **Campus Pass requires being on the UCSC network** or `127.0.0.1`. The
  Campus Pass tests in §11–§13 cannot run from an arbitrary remote machine.
- **Dashboard and landing pages** are session-authenticated HTML routes.
  They can be spot-checked by visiting `https://api.bayleaf.dev/` in a
  browser and signing in, but are not covered by this curl-based
  runbook.
# Disposable inference grants

`npm run test:grants` runs the grant/PKCE security harness against isolated
workerd and D1, with synthetic identities and mocked providers. It requires no
credentials and makes no live inference calls. It covers issuance, model sets,
auth/scope, quotas, PKCE, revocation, cleanup and HTTP/SSR contracts. It does
**not** execute the dashboard client or establish clipboard/DOM/storage secrecy.
See [GRANTS.md](GRANTS.md) for rollout and verification status.

## Real-browser qualification: synthetic backends, actual application UI

UI qualification is an **agentic manual release check**, not an unattended
browser regression suite. There is no replacement DOM, VM-executed client,
source-mutation calibration, or browser-test framework. HTTP/SSR PASS output
must never be reported as browser PASS. Record the browser/version, commands,
scenarios, observations and any missing evidence for each qualification run.

From `api/`, with dependencies and the pinned submodules initialized, start each
server in its own terminal:

```bash
npm run pretest:grants
node scripts/harness-grants.mjs --serve
node scripts/test-sandbox-policy.mjs --serve
node scripts/test-sealed-dashboard.mjs --serve
```

The first command generates local build inputs using fixture Nanobot assets,
not production credentials. The three servers serve unmodified application
templates and client scripts. Only external backends/identities are synthetic.
`/__harness-login` exists only in the grant harness; `/__fixture/*` exists only
in the loopback sandbox preview. Neither is a production test endpoint. Use
one qualifying browser at a time, since the sandbox scenario is process-wide.
Stop the servers with Ctrl-C when finished.

Use a real browser's DevTools, OpenChamber browser tools, or Rodney:

```bash
uvx rodney --help
uvx rodney start --local
uvx rodney open http://localhost:8789/__harness-login
```

Keep the Rodney profile outside the repository, or exclude its `.rodney/`
directory. No real CILogon, Daytona, Canvas or inference credentials are needed.
Do not follow external links or press unrelated account/provider controls.

### Sandboxes: passive reads, explicit actions, failure and expiry

```bash
curl -s -X POST http://127.0.0.1:8790/__fixture/passive
uvx rodney open http://127.0.0.1:8790
# Choose ready, failure or expired without changing the application's script:
curl -s -X POST http://127.0.0.1:8790/__fixture/ready
uvx rodney click '#openchamber-start'
uvx rodney sleep 6
```

- On initial load all six service cards are idle. Network/preview stdout must
  show six status GETs, no service POST. Bring the window out of and back into
  focus: expect status GETs only. An explicitly dispatched Window focus event
  in the real engine checks the listener, but is not native OS focus evidence.
- A start click issues exactly one `POST /services/openchamber/start`, then
  passive polling. Opening becomes ready after two fixture seconds, observed
  on the next poll. Sibling cards stay idle. Inspect the live Open link:
  HTTPS fixture URL, `_blank`, `noopener noreferrer`. Do not navigate to it.
- Expand `#openchamber-troubleshoot` before clicking `#openchamber-restart`:
  the real browser correctly keeps that button inaccessible when collapsed.
  Expect one restart POST, passive polling and ready again.
- Select `failure`, reload, click start and wait six seconds. Expect failed,
  “Try again”, and collapsed diagnostics. Select `ready` and click Try again
  to qualify retry. Only OpenChamber progresses; other services remain idle.
- Select `expired` before clicking an available start/retry button to exercise
  action-time 401, and reload under `expired` to exercise passive-read 401.
  Inspect signed-out phase, visible sign-in control, hidden/disabled mutation
  buttons and absent Open href. Further focus/polling must not refresh the
  expired service. The other service cards must not be signed out with it.

The preview tests client behavior, not the production controller's passive-read
policy; automatic lifecycle/backend harnesses own that independent contract.

### Temporary tokens: actual clipboard and native DOM/storage

At `http://localhost:8789/__harness-login`, expand Create a token. Check the
qualified model catalog, disabled backend options and recommended selection;
create a token with the real form, then click its Copy token control.

Capture the exact fixture `access_token` from the real `POST /grants` response
using DevTools Network or a read-only CDP observer, not a monkeypatched fetch or
clipboard. Read the actual browser clipboard with its normal permission and
compare the full value byte-for-byte with that response. A “token copied” status
alone does not prove exact clipboard contents. Do not print the credential in
screenshots or commit network captures containing credentials.

Inspect native `document.documentElement.outerHTML`, every input/textarea/select
value, localStorage and sessionStorage for the exact credential. It must be
absent, including attributes, hidden controls and live values. Reload: the
recognition name remains, but Copy token is gone and storage remains clear.
Revoke only tokens created during qualification; preserve the preexisting
fixture inventory. The HTTP harness already tests owner-scoped revoke/cleanup.
Serve `examples/grants/` on a separate loopback port to qualify browser consent
handoff separately; dashboard qualification does not establish that flow.

If clipboard permission/read access is unavailable, mark exact-copy qualification
**incomplete**, even when the Copy button reports success. Never substitute a
clipboard stub, DOM emulator or string inspection as proof.

### Sealed: labels are part of the UI contract

Open each URL in the real browser and inspect the Sealed card's rendered text
and native metric containers, not just unrelated occurrences of numbers in HTML:

| URL (`http://127.0.0.1:8791/`) | Expected labeled values |
| --- | --- |
| `?state=normal` | Today's Requests 91; Remaining 409; Limit 500; Today's Spend $1.8800; Month $5.2500; Tokens 102,345 |
| `?state=unavailable` | Same request allowance; both spends and today's tokens Unavailable, not zero |
| `?state=zero` | Today's Spend $0.0000 and Tokens 0; month still $5.2500; allowance unchanged |
| `?state=exceeded` | Requests 501, Remaining 0, Limit 500; spend and tokens unchanged from normal |
| `?state=unprovisioned` | First-request explanation, unavailable billing rather than fabricated zero |

The request-count allowance and dollar spending must remain separately labeled;
the note says this is not a dollar budget. These browser judgments deliberately
do not run inside `test:sealed-dashboard`. That command retains provider-helper
validation, billing method/body/auth/UTC ranges, failure handling, no billing for
an absent key, disabled-lane/auth behavior and basic SSR smoke checks. Its
test-only view-boundary observer delegates unchanged to the real DashboardPage
and asserts that the actual route passes a stale count as 0 of 500 requests and
a current-day count as 91 of 500, with billing intact. This checks the server's
view-model assembly (including a missing `sealedUsage` prop), not rendered
label/value relationships or browser behavior.

### Qualification record, 2026-10-14

Rodney 0.4.0 drove its headless Chromium binary `chromium-1321438` (CDP
`Browser.getVersion`: Chrome/128.0.6568.0; page UA reported Chrome/114.0.0.0).
The commands above were exercised locally with synthetic identities/backends.
Observed: six passive startup GETs, click-to-opening-to-ready, collapsed repair
disclosure followed by restart-to-ready, failure/Try again-to-ready, both action-time and
passive expiry, and no expired-service refresh after a dispatched Window focus
event. Focus-handler GET count increased from six to twelve before expiry;
native OS window focus was not established in this headless run.

Token creation and real Copy button interaction reported success. A CDP network
observer captured the issued fixture credential; native DOM markup, form values
and local/session storage did not contain it. Reload removed Copy controls while
retaining names; storage was empty. **Exact clipboard equality remains
unqualified:** read permission stayed `prompt`, reads hung, and attempted CDP
permission grants did not resolve the browser context. No clipboard stub was
used. That initial run was not a full browser PASS. The three UI-created fixture tokens were
revoked through the real controls; the preexisting fixture token remained. No
live account was touched.

Real rendered Sealed normal/unavailable/zero/exceeded/unprovisioned labels and values matched
the table. Screenshots of token metadata, sandbox ready and Sealed normal were
captured outside the repository. This run does not qualify live authentication,
provider behavior, unsafe-link variants, mobile layout, reduced-motion rendering,
native focus, exact clipboard equality or browser consent handoff. The focused
headed-browser follow-up below resolves the exact-clipboard gap.

#### Exact clipboard follow-up, 2026-10-14

Launched normal headed Google Chrome **155.0.8059.40** with its own fresh profile
and loopback debug port, not the user's existing tabs or logins:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9237 \
  --user-data-dir="$TMPDIR/opencode/clipboard-qualification-profile" \
  --no-first-run --no-default-browser-check \
  http://localhost:8789/__harness-login
```

A one-off CDP observer enabled `Network`, correlated the fresh `POST /grants`
request with `Network.loadingFinished`, and captured its real response using
`Network.getResponseBody`. Native mouse input (`Input.dispatchMouseEvent`)
opened the disclosure, created one token and clicked that token's Copy control.
Only after the real UI reported that token copied did the observer call native
macOS `/usr/bin/pbpaste`, comparing the returned bytes in memory with the full
response credential. **Exact byte equality passed.** Neither credential nor
clipboard contents were printed; there was no earlier OS clipboard read in this
follow-up, no clipboard stub, no `writeText` spy and no client patch. No browser
read permission or `Browser.grantPermissions` was needed.

The credential was also absent from native DOM markup, live form values and
local/session storage. The fresh token was revoked using its real UI control;
the exact grant inventory returned to its initial single token. An owned blank
tab was brought forward, then the dashboard returned with `Page.bringToFront`:
`document.hasFocus()` changed false then true. This establishes native target
focus switching, not an additional sandbox-network focus qualification.

The isolated browser/server were closed. A metadata-only screenshot, the
one-off observer script and a content-free equality/inventory JSON record were
saved under the approved temporary `opencode` directory, outside this worktree.
The earlier headless clipboard limitation remains historical evidence, not an
outstanding clipboard blocker. Live providers/authentication, unsafe-link
variants, mobile/reduced-motion rendering and browser consent handoff remain
outside this qualification.
## OpenCode curl onboarding regression (2026-10-23)

Deployed through `npm run deploy` as `267b6fe1-0285-4760-b55d-fc2e015869b8`.
Live Standard and Sealed discovery/start checks passed: corrected command,
empty 204, approval URL header, scoped cookie and `no-store`. Two unapproved
smoke-test claims expire normally after ten minutes, with no keys provisioned.
Rollback target: `fa26e040-2fca-4d70-a294-5fd768fc12c3` (restore that Worker
version through Wrangler rollback if needed; no schema/config migration).

Run `npm run test:claim-curl` from `api/` without credentials. It checks the
Standard/Sealed start responses and legacy instruction routes, then runs the
advertised Standard/Sealed/Sandbox curl commands against a local fixture with
stdout/stderr pipes and a synthetic approved-credential sentinel. No login,
provider key, inference request or production database is involved.

The shell-free command requires **curl >= 7.84.0** for `%header{name}`
([curl manual](https://curl.se/docs/manpage.html#-w)). The previous OS-variable
flow required 8.3.0. Start remains an empty 204 with the same scoped HttpOnly
device cookie; `X-BayLeaf-Claim-URL` adds only the existing user-facing approval
URL. `--write-out` sends it to process stderr, not Windows `CON`, so a background
OpenCode service can capture it. `--next` resets write-out before polling;
stdout contains only the approved credential. Old platform instruction routes
remain supported. The retained `/unix` start suffix is compatibility metadata,
not OS detection. The first HTTP fixture missed a native Windows curl 8.8.0
HTTPS failure: any write-out enables certificate-info parsing, which fails on
unrecognized certificate OIDs ([curl #13845](https://github.com/curl/curl/issues/13845),
fixed in 8.9.0). The deployed revision therefore failed Windows GUI onboarding.

### Windows aliases: deployed and browser-qualified (2026-10-23)

`windowsWellKnownRoutes` in `src/routes/wellknown.ts` exports full discovery paths:
`/windows/.well-known/opencode`, `/sealed/windows/.well-known/opencode`, and
`/sandbox/windows/.well-known/opencode`. `src/index.ts` mounts the router before
the broader Sealed relay. Deployed Worker version:
`7943f8a6-831e-41f5-a41c-f39226648257`. No migration or variable changes were needed.

The advertised argv is `['powershell.exe', '-NoProfile', '-NonInteractive',
'-Command', SCRIPT]`, built by `src/windowsClaim.ts`. It derives from the saved
Windows PowerShell 5.1 HTTPS-qualified prototype, with a monotonic 600-second
deadline, bounded credential reading, approval-URL validation, unchanged normal
certificate validation, redirect refusal and memory-only `CookieContainer`.
It prints only the public approval URL on stderr, accepts pending 429 at one-second
intervals, and prints only a validated ordinary BayLeaf token on stdout. Denial,
timeout and protocol/transport errors use fixed stderr messages, never server
error bodies or exceptions. The bootstrap creates no additional child processes
or disk files. Terminating it stops polling, but Ctrl+C in OpenChamber did not
terminate the CLI or service-owned PowerShell process during qualification.
Only those identity-checked test processes were stopped explicitly; normal
services were preserved. Otherwise the helper and claim expire after ten minutes.
No execution-policy bypass or remote code download.

The alias retains `auth.env=BAYLEAF_API_KEY` and points `remote_config.url` at
the existing authenticated Standard/Sealed/Sandbox config path. OpenCode saves
the login URL as connection identity, binds the saved `auth.env` before remote
header substitution, and need not fetch config at that same URL. Use the exact
Windows login URL for logout too. Do not retain both canonical and alias
connections for the same lane: their shared env binding can shadow credentials.
Sandbox aliases retain owner-key requirements; Sealed aliases retain its gate.

Tests assert those config pointers and the inline argv. On Windows the same test
also invokes the generated argv with stdout/stderr pipes against a local HTTP
fixture for pending/approval, denial, error, invalid credential and timeout.
On macOS that execution is explicitly skipped. The exact generated argv passed
native Windows PowerShell 5.1 tests: Standard/Sealed/Sandbox HTTPS start and pending,
synthetic approval with credential-only stdout, denial, malformed/short/long
credentials, pending timeout, and a stalled response body. Test deadlines were
shortened; cancellation also tested the unchanged script with external termination.

In OpenChamber 2.5.1 with bundled OpenCode 2.1.3, the integrated-terminal command
`opencode auth login https://api.bayleaf.dev/windows` displayed a real claim URL.
Following it reached CILogon with UCSC selected, then the empty CruzID Gold login
form. No credentials, approval, real key handoff, or inference were exercised.
Postapproval saved credentials, remote-config loading, restart/model selection,
and reliable Ctrl+C cancellation remain unqualified.

Separate isolated macOS tests displayed the approval URL with curl 8.7.1 and
OpenCode 2.0.32 and 2.1.3, both standalone and shared-service modes. The original
macOS user report remains unexplained; this is not a fresh desktop-app qualification.

Exposure scope for this transport-only fix (no new authority or capability):

| Surface | Decision |
| --- | --- |
| Desktop Standard/Sealed OpenCode/OpenChamber | Curl header transport and explicit Windows aliases deployed; Windows Standard browser handoff qualified, postapproval completion pending. |
| Hosted OpenCode/Sandbox discovery | Shared Standard command corrected; no plugin or installer change. |
| Hosted Nanobot | Not applicable: no OpenCode discovery command. |
| Chat | Not applicable: no OpenCode discovery command. |
| HTTP docs / llms.txt | Local getting-started guide splits Windows commands; publication requires a later approved push. Live llms.txt Windows guidance remains a follow-up. |

Rollout needs no migration. A curl already polling will not acquire new
instructions: cancel and retry login after propagation. Rolling back the Worker
restores the old discovery command, including its Windows background-console
limitation. Claim rows still expire after ten minutes; legacy routes/cookies
remain compatible across versions.

### Fresh macOS desktop qualification (2026-10-23)

A fresh use.computer M4 VM running macOS 26.2 (25C56), arm64, installed the official
notarized OpenChamber 2.5.1 ARM64 app without a Gatekeeper bypass. Its integrated
terminal and backend resolved bundled OpenCode 2.1.3 and system curl 8.7.1.
The exact macOS guide command displayed the approval URL; Safari reached CILogon
with UCSC selected and then the empty CruzID Gold credential form. Control-C
returned to the prompt and both test CLI and curl processes exited.

This exposed terminal noise in the experimental revision: curl's global
`--show-error` persisted across `--next`, printing expected pending HTTP 429s and
eventually hiding the URL. Removing that flag was deployed as
`9aa18a64-9655-4fcc-a5e9-01b782e67a83`. The regression fixture now requires two
pending responses before approval while asserting exact URL-only stderr and
credential-only stdout. A real Mac GUI retry kept the URL visible for twelve
seconds without 429/error noise and cancelled cleanly. Screenshot:
`use-computer-mac/11-clean-auth-wait.png` in the private qualification directory.

No campus credentials, approval, key provisioning or inference were used. This
qualifies fresh desktop browser handoff, not postapproval credential/config
completion, and does not explain the original affected Mac user's environment.

Follow-up version `e35caaff-9608-4fc4-9ffa-497f7954a21d` also publishes Windows
alias guidance and the corrected curl requirement in live `/llms.txt`; the
qualified authentication commands are unchanged from the quiet-polling revision.
The GitHub-served getting-started guide still requires an approved commit/push.

### Single OS-neutral login URL (2026-10-23)

`opencode auth login https://api.bayleaf.dev` (and `/sealed`) now uses one curl
argv on every platform: (1) `start` sets the device cookie and opens an HTTP/1.1
keep-alive connection; (2) `GET /auth/claim/curl/url` repeats the pending claim's
public approval URL as `X-BayLeaf-Claim-URL` (204, no new claim) and `--write-out
%{stderr}` prints it; (3) `--next` resets write-out and polls with credential-only
stdout. `--fail-early` makes a missing URL a visible failure, not a silent wait.

Why the extra transfer: stock Windows curl 8.8.0 (Schannel) enables certificate
info whenever write-out is present and fails with error 43 during a fresh HTTPS
handshake ([curl #13845](https://github.com/curl/curl/issues/13845), fixed in 8.9.0).
On a reused connection there is no handshake, so write-out succeeds. Verified on
the Windows VM with shell-free redirected pipes: write-out on a fresh connection
exits 43; after a successful first transfer, `-v` shows "Re-using existing
connection" and the URL prints with exit 0 and empty stdout. A first transfer
that fails under `-f` closes the connection, so the warm-up must be the 2xx start.

Deployed as `6f48afc8-d1b7-4c50-b72a-cf57450f8447`. Live computer-use
qualification with the unchanged canonical command in OpenChamber 2.5.1 /
OpenCode 2.1.3: fresh Windows (curl 8.8.0, service-spawned curl confirmed) and
fresh macOS 26.2 (curl 8.7.1) both displayed the URL with no error noise after
ten seconds and reached CILogon with UCSC selected. macOS Ctrl+C stopped the
attempt; on Windows, Ctrl+C left the service-owned CLI/curl running (OpenCode
behavior, not BayLeaf's), so those PIDs were stopped explicitly. No credentials,
approval, key handoff or inference. Postapproval completion remains unqualified.

The interim `/windows` PowerShell aliases (described above) were then removed:
`src/windowsClaim.ts`, its routes and tests are gone, and a Windows curl that
cannot reuse the connection now fails visibly via `--fail-early`. If that ever
happens, the PowerShell bootstrap is recoverable from git history (commit 7d1f494).
