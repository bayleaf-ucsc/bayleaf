# BayLeaf Chat

Open WebUI deployment at `chat.bayleaf.dev` — OIDC auth (CILogon), curated
workspace models, custom tools/functions, rate limiting.

**Read `DESIGN.md` before answering questions about this deployment.** It
documents OIDC configuration, user provisioning workflows, group management,
model access control, tool/function architecture, and recovery procedures.
Many operational details (e.g. how placeholder accounts merge on first OIDC
login, how OAuth group sync interacts with manually-managed groups) are only
documented there.

## Infrastructure

DigitalOcean App Platform, in the `BayLeaf / UCSC` team (slug `bayleaf-ucsc`).
Managed via `doctl --context bayleaf`.

- **App ID**: `f1a1e758-62e9-4e99-90cb-212cab12958d`
- **Image**: `ghcr.io/open-webui/open-webui` (version pinned in app spec)
- **Current version**: `v0.9.4` ✨
- **Database**: Managed PostgreSQL 17 (`bayleaf-chat-db`, ID `ea8c7549-e761-44e1-a9c3-e45e478a5202`)
- **Storage**: DO Spaces (`bayleaf-ucsc-storage`, bucket-scoped access key)

## Commands

```bash
doctl apps spec get f1a1e758-62e9-4e99-90cb-212cab12958d --context bayleaf              # View current spec
doctl apps spec get f1a1e758-62e9-4e99-90cb-212cab12958d --context bayleaf > spec.yaml  # Save spec to file
doctl apps spec validate spec.yaml --context bayleaf                                     # Validate (may reject EV[] values on existing apps; update still works)
doctl apps update f1a1e758-62e9-4e99-90cb-212cab12958d --spec spec.yaml --context bayleaf  # Deploy changes
doctl apps logs f1a1e758-62e9-4e99-90cb-212cab12958d --context bayleaf                   # Tail logs
```

## Env Var Changes

Configuration changes (OIDC provider, feature flags, etc.) are made by editing
the app spec YAML and deploying via `doctl apps update`. Secret values are
encrypted in the spec; to change a secret, set `type: SECRET` and provide the
new plaintext value — DO encrypts it on deploy.

## Retention Cleanup Job

Scheduled job `retention-cleanup` (cron `0 6 * * *` America/Los_Angeles) runs
`chat/retention_cleanup.py` against the OWUI admin API. See `RETENTION.md` for
policy; source at `chat/retention_cleanup.py`, image at `chat/Dockerfile.retention`.

**Checking recent runs** (DO's public API is the reliable path; `doctl apps
logs` hangs without `--job-invocation`, because for SCHEDULED jobs there is no
continuously-running pod to attach to):

```bash
# List invocation history (phase, trigger, timestamps)
TOKEN=$(awk '/^  bayleaf:/ {print $2}' "$HOME/Library/Application Support/doctl/config.yaml")
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://api.digitalocean.com/v2/apps/f1a1e758-62e9-4e99-90cb-212cab12958d/job-invocations?component_name=retention-cleanup" \
  | python3 -m json.tool

# Fetch stdout from a specific run (get id from the list above)
doctl apps logs f1a1e758-62e9-4e99-90cb-212cab12958d retention-cleanup \
  --context bayleaf --type run --no-prefix \
  --job-invocation <invocation-id>
```

Each run prints aggregate-only counts (retention_days, cutoff, sunrise,
grace_expires, users_total/held, chats_scanned/expired/deleted, status). No
user identifiers. Until `grace_expires` passes, zero deletions is the correct
outcome.

## OWUI Admin API

Model, tool, function, user, and group management uses
[`owui-cli`](https://github.com/rndmcnlly/owui-cli) — a purpose-built CLI
for the OWUI admin API. Install via `uvx owui-cli`.

```bash
export OWUI_URL=https://chat.bayleaf.dev  # target instance
export OWUI_TOKEN=<bearer-token>          # admin JWT (see §7 in DESIGN.md)
owui-cli tools list                      # list all tools
owui-cli tools pull <id>                 # dump tool source to stdout
owui-cli tools deploy <source.py> [id]   # push tool source to live instance
owui-cli users find <query>              # search users by name/email
owui-cli groups add-user <id> <user-id>  # add user to group
owui-cli --json models show <id>         # full model JSON
```

See `DESIGN.md` §7 for the full sync workflow.

## OWUI Version Upgrades

1. Read the release notes for each version between current and target
   (check the `Current version` line above for the starting point).
2. Flag breaking changes: DB migrations, env var changes, plugin API
   changes, auth endpoint changes.
3. Consider `pg_dump` if DB migrations are involved (DO managed PG has
   built-in PITR, but an explicit backup is belt-and-suspenders).
4. Pull the live spec:
   `doctl apps spec get f1a1e758-62e9-4e99-90cb-212cab12958d --context bayleaf > /tmp/bayleaf-chat-spec.yaml`
5. Edit the image `tag:` in the spec to the target version.
6. Deploy:
   `doctl apps update f1a1e758-62e9-4e99-90cb-212cab12958d --spec /tmp/bayleaf-chat-spec.yaml --context bayleaf`
7. Wait for ACTIVE deployment phase, then verify health:
   `curl -sS -o /dev/null -w '%{http_code}' https://chat.bayleaf.dev/health`
8. Update the `Current version` line in this file.
9. Diff the live spec env vars against DESIGN.md §1 and sync any drift.

## Don'ts

- Don't commit secret values (API keys, OAuth secrets, DB credentials)
- Don't deploy OWUI version upgrades without checking the changelog for breaking changes
- Don't modify tool/function source directly in the OWUI admin UI — edit in this repo and push via API
