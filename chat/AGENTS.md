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
- **Current version**: `v0.9.5` ✨
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

## Customization Route

When you need to change OWUI behavior, climb this ladder only as far as
necessary. Each rung adds capability and upgrade-time risk; never skip
ahead without a reason.

1. **Plugins** (filters, tools, functions, pipes). Source in `chat/tools/`
   and `chat/functions/`, deployed via `owui-cli`. Survives version
   upgrades cleanly. Limit: only intercepts what OWUI exposes hooks for.
2. **Env-var configuration**. Many behaviors (log level, OAuth claim
   names, signup gates) are tunable via env vars in the spec. Always
   exhaust this rung before writing code.
3. **`run_command` startup wrapper** in the App Platform spec.
   ⚠️ **Suspect, never verified to work.** This rung is speculative.
   The theory: DO `run_command` overrides the container's `CMD`; the
   upstream OWUI image (`ghcr.io/open-webui/open-webui`) has
   `WORKDIR=/app/backend`, no `ENTRYPOINT`, and `CMD=["bash","start.sh"]`,
   so prepending shell or Python and ending with `exec bash start.sh`
   should insert boot-time logic without forking the image. In practice
   (May 14 2026), three deploy attempts using a multi-line shell-style
   `run_command` block all failed with
   `error finding executable "set" in PATH` — DO appears to pass the
   value as direct argv rather than wrapping with `sh -c`. Before
   relying on this rung, prove it out with a trivial single-line
   `run_command: bash -lc 'echo hello; exec bash start.sh'` first, and
   only then attempt multi-line scripts. If single-line `bash -lc` also
   fails, skip to rung 4. Do not document this rung as working until a
   real deployment has reached ACTIVE with a non-trivial `run_command`.
4. **Custom Dockerfile** that `FROM`s upstream and `COPY`s in patch
   files. Pattern after `chat/Dockerfile.retention`. Worth it when
   patches exceed ~20 lines or need to add files (not just patch
   behavior). Adds a build step and a version-pinning ritual on every
   OWUI upgrade.
5. **Fork OWUI**. Only justified for sustained patches upstream won't
   merge. Avoid.

### Rung-3 sketch (⚠️ never successfully deployed; reference only)

A speculative example of injecting a logging filter that scrubs PII
from the OWUI OAuth callback logger (which dumps the full userinfo
dict on failure modes). The shape below has *not* been verified to
work on App Platform — see the warning on rung 3 above. Drop into the
`open-webui` service block of the spec only after proving the rung is
viable with a trivial test:

```yaml
run_command: |
  set -e
  cat > /tmp/bayleaf_logfilter.py <<'PY'
  import logging
  _SENSITIVE = ("email", "given_name", "family_name", "name")
  class Scrub(logging.Filter):
      def filter(self, r):
          msg = r.getMessage()
          if r.name.startswith("open_webui.utils.oauth") and any(k in msg for k in _SENSITIVE):
              r.msg, r.args = f"[bayleaf: scrubbed {r.name} payload]", ()
          return True
  logging.getLogger().addFilter(Scrub())
  PY
  export PYTHONSTARTUP=/tmp/bayleaf_logfilter.py
  exec bash start.sh
```

Verify after deploy: trigger a no-op OAuth flow and confirm logs show
the scrubbed sentinel string instead of the original payload. Targets
logger names (stable across versions), not internal APIs.

## Vertex Pipe

`chat/functions/vertex_pipe/function.py` is a Rung-1 manifold pipe that
exposes an admin-curated set of Google Vertex AI models as selectable
models in the OWUI picker. It holds a service-account JSON in an admin
valve, mints short-lived access tokens locally (PyJWT), and proxies chat
completions to Vertex's OpenAI-compatible endpoint. No ADC key file on
disk, no image rebuild.

- **Status**: admin-only on chat.bayleaf.dev. Not surfaced to general
  users pending the ZDR posture review (see issue #36).
- **Configured models** are set via the `MODELS` valve as a comma-separated
  list of `publisher/model` (optionally `= Display Name`). Newlines and
  semicolons also work as separators. Discovery: `GET https://aiplatform.
  googleapis.com/v1beta1/publishers/<pub>/models` with `X-Goog-User-Project`
  header. Useful publishers: `google`, `anthropic`, `mistralai`. MaaS open
  models (`zai-org`, `google` Gemma MaaS, etc.) are listed in the docs
  rather than the publisher API.
- **Region**: most Gemini and all MaaS-prefixed open models are served
  from `location=global`. Partner models like Claude-on-Vertex are
  region-pinned and require project-level access grants from the
  publisher's Model Garden tile (a 404 from the OpenAI-compat path means
  "not entitled in this region", not "wrong id").
- **Reference manifold pattern**: the `pipes()` method returns one entry
  per model with id `publisher__model` (the `__` separator avoids OWUI's
  `.` namespace separator, and the embedded `/` of `publisher/model` is
  historically risky in entry ids). On each turn, `body["model"]` arrives
  as `vertex_pipe.<entry_id>`; we strip the function-id prefix from the
  *left* (Gemini ids contain dots) and convert `__` back to `/` before
  forwarding.

## Don'ts

- Don't commit secret values (API keys, OAuth secrets, DB credentials)
- Don't deploy OWUI version upgrades without checking the changelog for breaking changes
- Don't modify tool/function source directly in the OWUI admin UI — edit in this repo and push via API
