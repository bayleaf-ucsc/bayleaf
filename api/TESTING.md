# Agentic Manual Testing — BayLeaf API

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

`SEALED_OPENCODE=1` additionally points the exact-pinned
`opencode-tinfoil@0.1.0` plugin at a mutated bundle and asserts that an OpenCode
run fails before inference. Omit it to run the SDK-level mutation suite without
requiring OpenCode.

`SEALED_AUTH` defaults to `campus`, which only resolves from a campus IP. Use a
keyed token off-campus, and prefer it regardless: Campus Pass shares an env-held
pool key and exercises none of the minting, CAS, or healing paths.

`SEALED_ENABLED` is `"true"` in production, so no deploy or flag flip is needed
to run this against `api.bayleaf.dev`. Note that the harness mints a real
per-user Tinfoil key and spends real credit, so clean up the row and the key.

## Automated: the key lifecycle harness

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
node scripts/harness-provision.mjs
```

It creates real OpenRouter keys for `*@example.invalid` addresses and deletes
them on the way out. **It refuses to run if the OpenRouter admin key is
rejected**, because a 401 makes every upstream lookup return `null`, which
turns both the assertions and the cleanup check into false greens — that
failure mode leaked two real keys the first time this harness was written.
If it ever aborts mid-run, sweep manually:

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
