# AGENTS.md (lti)

Agent-oriented context for working in this subdirectory. Read this before
making changes.

## Project shape and intent

A development spike for an LTI connector. The connector itself is
platform-agnostic — every launch carries `tool_consumer_instance_guid`
(LTI 1.1) or the equivalent `tool_platform.guid` claim (LTI 1.3) plus
the consumer key / client_id, so multi-tenant deployments are an
extension of the credential lookup, not a rewrite. Currently exercised
against UCSC's sandbox at `https://ucscdev.instructure.com/`. Live at
<https://lti.bayleaf.dev>. Tracking issue: [#42](https://github.com/bayleaf-ucsc/bayleaf/issues/42).

This is *running* but is *not yet the production connector*. Pedagogical
clarity and architectural agility outrank production hardening: bias
toward single-file modules (`main.py`), split only when a real second
concern shows up.

What's working today (see `DECISIONS.md` for the chronological story):

- LTI 1.1 launches verified end-to-end via OAuth 1.0a HMAC-SHA1.
- LTI 1.3 endpoints (`/lti/jwks`, `/lti/login`, `/lti/register`) wired
  but not exercised yet, blocked on UCSC ITS registering a developer key.
- Deployed on DigitalOcean App Platform from a public GHCR image.

What's not yet there:

- LTI 1.3 fully verified launches (requires Canvas-issued client_id).
- OWUI toolkit half (the chat side that calls into this connector).
- Persistent multi-instance nonce cache (currently single-instance
  in-memory; `instance_count: 1` in the App Spec is load-bearing).
- Canvas write paths. The connector is read-only.

## What we have access to

- `ucscdev.instructure.com`: UCSC sandbox, provisioned by Adonis Hamad
  (`ashamad@ucsc.edu`) on 2025-12-01. Two test accounts confirmed working:
  `amsmith@ucsc.edu` (admin role) and `adam@adamsmith.as` (non-admin).
- The admin role is **scoped, not full root.** Personal access tokens are
  disabled, the Developer Keys admin page isn't visible, and the modern
  `/api/v1/accounts/:id/lti_registrations` POST returns 422 even on root.
  See DECISIONS.md for the full enumeration.

## Trust boundaries

The eventual production connector has two:

| Boundary | Credential | Purpose |
|---|---|---|
| Canvas ⇄ connector | RSA keypair (LTI 1.3) or shared secret (LTI 1.1) | Authenticity of launches and service-token requests |
| OWUI toolkit ⇄ connector | HMAC + OWUI-supplied email | Authorize toolkit calls and identify the requesting user |

Today only the first is implemented. The second is deferred to the
toolkit phase.

## Never do

- **Never paste credentials into chat** (or commits, or issue comments).
  `.env` is the only place they live. The agent reads `.env` from disk.
- **Never commit** `.env`, `keys/*.pem`, or `notes/api-shapes/*.json`
  without manual review for PII / identifiers.
- **Never write to Canvas.** All probes and the launch handler are
  read-only. No assignment submissions, announcement posts, grade
  changes, enrollment edits.
- **Never bypass the User-Agent requirement.** Canvas rejects API
  requests without a `User-Agent` header (effective 2026-01-17).
- **Never commit secrets to `.do/app.yaml`.** The committed spec uses
  empty placeholder values; real values are set per-app via the DO web
  console (or `doctl apps update --spec` from a temp file that is then
  removed).

## Common operations

```bash
# Install / update deps
cd lti
uv sync

# Run the connector locally (env-var-driven keypair OR LTI_DEV_AUTOGEN_KEYS=1)
uv run uvicorn connector.main:app --reload --app-dir src

# Lint
uv run ruff check src
```

Production deploy:

```bash
# Build and push image
docker buildx build --platform=linux/amd64 \
  -t ghcr.io/bayleaf-ucsc/lti:latest --push \
  -f Dockerfile .

# Trigger redeploy (image is :latest so DO repulls)
doctl apps create-deployment <APP_ID>

# Tail runtime logs
doctl apps logs <APP_ID> --type=run --tail=50
```

App ID is in `DECISIONS.md` (deliberately not duplicated here).

## Useful references

- Issue #42 (architecture sketch): <https://github.com/bayleaf-ucsc/bayleaf/issues/42>
- `pylti1.3` library: <https://github.com/dmitry-viskov/pylti1.3>
- Canvas LTI 1.3 implementation guide: <https://canvas.instructure.com/doc/api/file.lti_dev_key_config.html>
- Canvas REST API: <https://canvas.instructure.com/doc/api/>
- DO App Platform App Spec: <https://docs.digitalocean.com/products/app-platform/reference/app-spec/>
- Mirroring template for the eventual toolkit half: `chat/tools/gws_toolkit/tool.py` in this monorepo.
