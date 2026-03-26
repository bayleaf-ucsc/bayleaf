# BayLeaf Chat

Open WebUI deployment at `chat.bayleaf.dev` — OIDC auth (CILogon), curated
workspace models, custom tools/functions, rate limiting. See `DESIGN.md` for
full architecture and recovery docs.

## Infrastructure

DigitalOcean App Platform. Managed via `doctl`.

- **App ID**: `7d0addd4-85db-4fe3-b931-501ae88d7f7f`
- **Image**: `ghcr.io/open-webui/open-webui` (version pinned in app spec)
- **Database**: Managed PostgreSQL 17 (`bayleaf-chat-db`)
- **Storage**: DO Spaces (`bayleaf-chat-space`)

## Commands

```bash
doctl apps spec get 7d0addd4-85db-4fe3-b931-501ae88d7f7f          # View current spec
doctl apps spec get 7d0addd4-85db-4fe3-b931-501ae88d7f7f > spec.yaml  # Save spec to file
doctl apps spec validate spec.yaml                                  # Validate changes
doctl apps update 7d0addd4-85db-4fe3-b931-501ae88d7f7f --spec spec.yaml  # Deploy changes
doctl apps logs 7d0addd4-85db-4fe3-b931-501ae88d7f7f               # Tail logs
```

## Env Var Changes

Configuration changes (OIDC provider, feature flags, etc.) are made by editing
the app spec YAML and deploying via `doctl apps update`. Secret values are
encrypted in the spec; to change a secret, set `type: SECRET` and provide the
new plaintext value — DO encrypts it on deploy.

## OWUI Admin API

Model, tool, and function management uses the OWUI API with a bearer token.
See `DESIGN.md` §6 for the sync workflow and `scripts/owui.py` for the CLI.

## Don'ts

- Don't commit secret values (API keys, OAuth secrets, DB credentials)
- Don't deploy OWUI version upgrades without checking the changelog for breaking changes
- Don't modify tool/function source directly in the OWUI admin UI — edit in this repo and push via API
