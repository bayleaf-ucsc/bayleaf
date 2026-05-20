# bayleaf-lti

LTI connector for BayLeaf. Currently exercised against UCSC's sandboxed Canvas instance, but the connector itself is platform-instance-agnostic: each launch carries the platform GUID and consumer key needed to identify the issuer. Tracking issue: [bayleaf-ucsc/bayleaf#42](https://github.com/bayleaf-ucsc/bayleaf/issues/42). Hostname is protocol-named (`lti.bayleaf.dev`) so the connector can serve other LMSes (Moodle, Brightspace) without renaming.

Status: development spike. Live at <https://lti.bayleaf.dev> on DigitalOcean App Platform, accepting real LTI 1.1 launches. LTI 1.3 endpoints are wired but the dev key registration is blocked on UCSC ITS (see DECISIONS.md). Production-grade hardening (multi-tenant key store, persistent nonce cache, key rotation procedure, full LTI Advantage scopes) is deferred.

## What this is

A FastAPI service (`src/connector/`) that authenticates LTI launches from a Canvas LMS. Auto-detects LTI 1.1 vs 1.3 by inspecting the form params on `/lti/launch`. Serves an LTI 1.1 cartridge (`/lti/config.xml`), an LTI 1.3 JWKS (`/lti/jwks`), and an LTI 1.3 Dynamic Registration endpoint (`/lti/register`).

## Local development

```bash
cd lti
uv sync
cp .env.example .env
# edit .env: at minimum, set LTI_DEV_AUTOGEN_KEYS=1 to let main.py
# generate a fresh keypair on first run.
uv run uvicorn connector.main:app --reload --app-dir src
```

The connector binds to `:8000`. Hit `/health`, `/lti/jwks`, `/lti/config.xml` to confirm wiring.

## Production

Deployed as a single-service DigitalOcean App Platform app. Image source: `ghcr.io/bayleaf-ucsc/lti:latest` (public). Spec at `.do/app.yaml`.

Deploy a new image:

```bash
docker buildx build --platform=linux/amd64 \
  -t ghcr.io/bayleaf-ucsc/lti:latest --push \
  -f Dockerfile .
doctl apps create-deployment <APP_ID>
```

Update the app spec (e.g. add an env var):

```bash
doctl apps update <APP_ID> --spec .do/app.yaml
```

Secrets (`LTI_1P1_SHARED_SECRET`, `LTI_PRIVATE_KEY_PEM`, `LTI_PUBLIC_KEY_PEM`, `CANVAS_*`) are set per-app via the DO web console at *Settings → Components → bayleaf-lti → Edit environment variables*; never commit them to `.do/app.yaml`.

`main.py` refuses to start if the keypair env vars and the on-disk PEMs are both missing. Generation-on-disk for first-run local dev requires the explicit `LTI_DEV_AUTOGEN_KEYS=1` opt-in. This makes prod misconfig loud rather than silently rotating the JWKS.

## Credentials

`.env` is the only place credentials live. Never paste them into chat, commits, or issue comments.

The connector authenticates Canvas in one of two ways:

1. **LTI 1.1 shared secret** (`LTI_1P1_CONSUMER_KEY` + `LTI_1P1_SHARED_SECRET`): proves the launch came from Canvas via OAuth 1.0a HMAC-SHA1. Used by the production app today.
2. **LTI 1.3 service credential** (eventual): `client_credentials` JWT bearer flow against Canvas's OAuth2 token endpoint, signed with our RSA keypair (`LTI_PRIVATE_KEY_PEM` / `LTI_PUBLIC_KEY_PEM`). Issued by Canvas after an admin registers our developer key. Endpoints exist; the dev-key registration is blocked on UCSC ITS.

The legacy `CANVAS_SESSION_COOKIE` and `CANVAS_TOKEN_ADMIN` slots in `.env.example` are documented for future read-only Canvas API work; the connector itself doesn't use them.

## Layout

```
lti/
├── pyproject.toml          uv-managed, FastAPI + pylti1.3 + httpx
├── uv.lock                 pinned deps
├── Dockerfile              uv-based image, used by .do/app.yaml
├── .dockerignore           keep secrets out of the image
├── .do/app.yaml            DigitalOcean App Platform spec (no secrets)
├── .env.example            copy to .env, fill in credentials
├── .gitignore              .env, keys/, .venv/
├── README.md               this file
├── AGENTS.md               agent-oriented context
├── DECISIONS.md            append-only log of non-obvious choices
├── src/connector/
│   └── main.py             FastAPI app (single-file by design)
└── keys/                   RSA keypair for local dev (gitignored)
```

## Where this is going

See `DECISIONS.md` for the chronological record of choices made and `AGENTS.md` for the live agent-oriented context. Parent issue (#42) sketches the full eventual architecture.
