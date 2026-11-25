# Run evidence: owui-version-bump

Dated record of past runs of [`owui-version-bump.md`](../playbooks/owui-version-bump.md), newest first unless noted.
Consult for diagnosis; current procedure lives in the linked file.

- 2026-11-25 (v0.13.5): Adam waived the full-day soak (release ten hours old).
  One-way chat-history migration: the old image's refusal to boot was proved on a
  synthetic database, and a `pg_dump` was taken just before deployment. Pushing the
  image first with `--dry-run` kept the dump-to-migration gap short. A new
  default-on builtin category would have exposed the user directory; it was
  pre-seeded off. Both builds, export, boot, 16 Chromium cases, deployment
  `5830cd44` and the retention dry run passed. Adam confirmed skill lazy loading
  in the browser; uploads, Sandbox and branching chats were not reported.

- 2026-11-20 (v0.13.4): Direct Connections was already enabled in production.
  After reviewing the expanded Tether model path, Adam chose to keep it opt-in.
  Both builds, amd64 boot, arm64 five-minute metrics, and Chromium arrival
  checks passed. Deployment `9532730e` passed guarded startup, health, version,
  Tether discovery, and Basic/Help API checks. Desktop pairing and human browser
  checks were not exercised. `chat/release.py deploy --dry-run` pushes the
  fingerprint-named image to GHCR but does not alter the app spec.

- 2026-11-10 (v0.13.3 preparation): Upstream guarded sources/package pins were
  unchanged; frontend hashes needed refresh. Both builds, all 16 Chromium cases,
  synthetic existing-PG upgrade, five-minute PG/TLS export and amd64 boot/inference
  passed. Docker disk exhaustion required approved named v0.12.4 image/cache
  cleanup. Docker shutdown and an operator travel abort interrupted qualification;
  resumed sequential checks passed. Refreshed full private snapshots/spec were
  unchanged overnight. Approved source `12927dc` deployed as `4e42953a`, ACTIVE:
  exact checkout, all three migrations, guards/PID 1, health/version and Basic/Help
  inference passed. Full private resource/spec/valve reconciliation is unchanged;
  only new config defaults appeared. Adam confirmed production works and accepted
  the upgrade; individual browser scenarios were not itemized.
  Adam requested a post-upgrade design to restore deploy-before-main publication.

- 2026-11-04 (v0.13.0 preparation): Reviewed v0.12.5 too; its URL-exclusion
  changes required adapting the metrics source patch rather than only repinning
  hashes. Both architecture builds, amd64 boot/inference, full five-minute PG/TLS
  export, all 16 Chromium cases and an actual old-image synthetic PG upgrade
  passed. Docker disk exhaustion required approved removal of named historical
  qualification images and unused build cache. Adam chose the new 1024-round
  limit and default-on notification inbox. Published `364ac9e`, deployment
  `79af5c90` ACTIVE: exact checkout, all three migrations, guards/PID 1 and
  Basic/Help inference passed. App spec unchanged; only true tool activation
  fields and three new config defaults appeared in full private reconciliation.
  `configs show` uses flat dotted keys, not nested sub-agent objects. Adam
  confirmed fresh CILogon sign-in, Sandbox and web-context tools work and accepted
  closure. Upload scenarios were not itemized; the round limit was deliberately
  not exercised.

- 2026-10-27 (v0.12.4 preparation): Python 3.12 / Debian 13 image transition,
  but no migration changes and unchanged telemetry dependencies/adapter sources.
  Requalified actual frontend hashes as well as native source guards. Added an
  output-directory override to preserve historical proofs. Cold Chromium runs
  exposed TLS connection resets in the synthetic proxy's five-connection backlog;
  increased its listen queue to 128 and added synthetic-only failure diagnostics.
  Adam confirmed personal soak and authorized publishing the coordinated OWUI and
  already-deployed Lathe backup after qualification passes.
  Both builds, full arm64 PG/TLS export, amd64 boot/inference and 16 Chromium
  cases passed. Deployment `c63a7deb` reached ACTIVE from `09aeebf`; health/version,
  guards/PID 1 and Basic/Help inference passed. App spec/resources unchanged;
  only inactive new upstream config defaults appeared. `doctl --no-prefix` also
  strips `[bayleaf]`, so match startup message bodies. Browser/tool/upload human
  acceptance remains pending.
  Adam subsequently confirmed the production experience works; individual
  browser/tool/upload scenarios were not itemized.

- 2026-10-22: not a version bump, but it exposed stale steps. Moving the image
  from `telemetry/otlp/` to `chat/image/` changed `dockerfile_path` via plain
  `doctl apps update`; DO rebuilt the last deployed commit (2026-10-20), which
  lacked the new path, and the build failed while the old deployment kept
  serving. Steps 1 and Rollback still described editing the spec image `tag:`,
  obsolete since the rung-4 custom image. Now: push, then `--update-sources`,
  and check the checked-out SHA in the build log.

- 2026-10-18: v0.12.3 incident recovery used verified managed backup and a
  preserved spec when the expired admin JWT and unresponsive UI prevented fresh
  resource pulls. Do not make recovery depend on the broken admin UI: defer
  authenticated checks/pulls explicitly, then complete them after recovery.
  The upstream reconnect fix stopped sustained CPU/auth-query amplification in
  initial samples; no custom diagnostics or scaling was needed. Both migrations
  completed; image-only rollback remains unqualified. After token renewal,
  Basic/Help inference and all four private resource pulls passed. Unrelated
  decorative skill-text drift was left for confirmation; browser sign-in passed,
  while full browser/tool acceptance remains outstanding.

- 2026-10-12: v0.12.0 reached ACTIVE using monitored `doctl --wait`; all six
  migrations, startup harness, health/version and admin Basic/Help smokes passed.
  Full private pulls differed only by version-history IDs, kept private rather
  than adding instance-specific lineage to portable definitions. Verified today's
  managed DB backup; corrected image-only rollback guidance for Alembic revisions.
  Adam subsequently confirmed the browser experience feels good.

- 2026-08-25: drafted from issue #65 and chat/AGENTS.md; never yet run as a
  playbook.
- 2026-09-01: first live run to v0.11.3. Perk polling reached ACTIVE precisely;
  health, migration, harness, and authenticated Basic/Help/Canary curl checks
  passed. Browser automation was explored but not relied on; add it only after
  a dedicated cultivation run.
- 2026-09-25: v0.11.4 upgrade passed the personal-instance soak gate, reached
  ACTIVE, and passed health, startup-harness, and authenticated Basic/Help API
  smokes. Backup pull contained only v0.11.4 schema defaults and pre-existing
  metadata drift, not changed prompts or grants. Corrected rollback step references;
  Adam reported the skill system seems okay in the browser. The inactive
  role-scoped skills were not exercised.
- 2026-11-10 (after v0.13.3): Chat moved off DigitalOcean source builds so the
  repo can lag production again. `chat/release.py` builds amd64 locally,
  pushes to public GHCR (free; no pull credential) and deploys by tag; the
  first push uploaded the full base, later pushes reuse it. Proven by redeploying
  the accepted v0.13.3 code unchanged: health and Basic/Help smokes passed, and
  the spec diff was only the `open-webui` source. The retention job moved the same day, so DigitalOcean builds nothing from GitHub.
  DigitalOcean `doctl apps update` rejected a not-yet-deployed GHCR digest ("the
  repository is known but this specific version is not") although `apps propose`
  accepted it; a new tag deployed fine, so `release.py` deploys by
  fingerprint-named tag. `open-webui` stays on its first digest until its next deploy.

## Moved from the playbook body

```text
   Since 2026-10-20 the version lives in the repo, not the spec: update
   `chat/image/Dockerfile` (base digest) and requalify `chat/image/upstream/`
   hashes and the startup patch (`../telemetry/qualification/otlp-rollout.md`),
   then run `chat/release.py deploy open-webui` (monitored background command); no
   commit or push first. It builds amd64 locally, pushes to GHCR and deploys by
   tag. Then
```

```text
2. Grep deploy logs for `[bayleaf] v0.12.4 metrics source minimization verified`
    (adjust the version), printed only after the entrypoint's version,
    environment and source-hash guards pass, and confirm `Started server
    process [1]` appears after it. The earlier `[bayleaf] guarded Chat startup`
    line (v0.12.4 onward) is printed *before* the guards run, so it does not prove
    the patch succeeded. Older images used `[bayleaf] rung-3 harness alive`.
```
