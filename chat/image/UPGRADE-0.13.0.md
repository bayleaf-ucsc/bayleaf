# Open WebUI v0.13.0 qualification

Prepared 2026-11-04. Adam confirmed personal-server soak. **Not deployed.**

## Release and compatibility review

- Reviewed both intervening releases: [v0.12.5](https://github.com/open-webui/open-webui/releases/tag/v0.12.5)
  and [v0.13.0](https://github.com/open-webui/open-webui/releases/tag/v0.13.0).
  Both contain security fixes with advisory publication pending CVE assignment.
- Target source commit: `c38885a1a737da4968f157092f304f3b5481d0bf`.
  Standard image index:
  `sha256:2272b0fb7c8783a016bcc179abb467cfa34590c99c5e6560fe0e9155b4820a09`.
  amd64 manifest: `sha256:321595ca87042d6b8418ab19fc287cd6957ac9808bde15d1329fc016ceedbf50`;
  arm64: `sha256:afb34868a25c819667cba798fa1705db5d02964ddfff78c94940092478de3a15`.
- Three new migrations follow `0bd252b206fb`: `c41f8d9e2a10` adds resource
  comments/reactions; `6f8c2a91d4e7` adds `tool.is_active` with a true default;
  `e42c8f710a36` adds notifications. Changes to five older migrations are comments
  only. No production migration has run in this preparation.
- Today's managed PostgreSQL backup (`2026-11-04T01:53:17Z`) was verified. App-only
  trusted-source restrictions remain intact. App spec, complete tools/functions/
  skills/models, hidden underlying model and global config/admin settings were
  privately captured before preparation. No user/group/chat exports were pulled.
- Backend requirements, project metadata and all six guarded telemetry package
  pins are unchanged. Installed arm64 packages and all source hashes passed
  build-time verification without weakening guards.
- OAuth provider registration now initializes asynchronously during startup and
  loads saved provider configuration. Preserve the environment-authoritative
  CILogon domain gate and test fresh sign-in after deployment.
- Existing tools default active after migration. Verify the new active state as
  well as source/schema/grants and valves after rollout.
- Model/tool APIs changed, and model selection now retains user tool/skill picks.
  Basic/Help tool, skill and upload browser acceptance remains a human gate.
- Upstream adds comments, notifications, side chats, tool creation and terminal
  workspace features. This upgrade does not authorize enabling new integrations,
  Python-tool creation privileges, comments or sub-agents. Existing sub-agents
  are disabled; saved limits are 20 concurrent, 20 async, 30 iterations and
  30,000 output characters. Their saved config must survive the bump.
- Native tool-call default increases from 256 to 1024. Adam explicitly chose to
  adopt 1024 rounds and the new default-on notification inbox. No additional
  environment overrides are needed. Comments remain off. Notification storage
  is part of Chat's stored-content boundary, not the aggregate telemetry lane.
- Accessibility release claims do not establish new BayLeaf conformance evidence.

## Guarded telemetry adaptation

v0.12.5 adds full-URL exclusions to upstream native metrics; v0.13.0 removes the
literal-path fallback from native metric attributes. BayLeaf retains its existing
five-route/seven-method-plus-OTHER collection policy and pure-ASGI adapter. The
hash-locked source patch now recognizes the new tagged middleware and removes its
unused URL-exclusion imports/setup. It still refuses unknown source bytes and
keeps resources empty, traces/logs off, bounded read-only PG gauges, cumulative
export paging and the independent signed-out arrival switch.

## Qualification evidence

Proofs and private snapshots are under the session temporary directory
`owui-0130/`, not in this public repository.

- Synthetic startup/export qualification passed: source/adapter drift refusal,
  idempotence, unsafe-environment refusal, PID handoff contract, all-four-flags-off
  mode, actual package pins, five minimized metrics and 99-point paging.
- Decoder and Chat browser bundle tests: 16 passed.
- Browser asset installer unit test: passed. Actual tagged HTML/config/start
  script and root/auth compiled-node hashes were refreshed; the stock loader is
  still empty. Root session resolution still precedes routed content, and auth
  session resolution precedes the sign-in card used by the arrival gate.
- Arm64 and amd64 guarded image builds: passed using the unchanged Dockerfile
  default multi-platform digest. Local output indices are respectively
  `sha256:9b14756869300138072ab178121652837c7051ed6d75953aca2cd8f1d8daa7c5`
  and `sha256:76d69a2e006a4566ed80e019c74bb65ad504cd6d90b36b19962f26648a58e40e`.
  Neither local image was pushed.
- Synthetic PostgreSQL upgrade from the actual v0.12.4 image/revision to
  `e42c8f710a36`: passed. A pre-existing synthetic tool retained its source and
  defaulted active; comment/reaction/notification tables were present. Owned
  migration containers/network were removed. This is not a downgrade test.
- Real Chromium arrivals: all 15 enabled cases and the separate disabled-source
  case passed, including signed-in non-collection and credential-free delivery.
  Both owned local browser fixtures were removed.
- amd64 guarded boot, health/version, synthetic authentication, JSON/SSE inference,
  idempotent source checks, source-drift refusal, uvicorn PID 1 and read-only PG
  metrics connection settings: passed under local emulation. Owned fixtures were
  removed. Emulated CPU/RSS is not a production capacity measurement.
- Full arm64 PostgreSQL/container qualification passed at the actual five-minute
  production cadence. All five approved metrics arrived over synthetic TLS;
  unknown routes/methods were minimized, resources stayed empty, traces/logs
  remained off and exactly one metrics connection was present. Pool wait was
  100.23 ms, statement cancellation 203.18 ms and lock cancellation 101.52 ms.
  Unavailable-DB backoff and healthy recovery passed. Owned fixtures were removed.
- Initial Docker pull failed because
  the daemon was stopped, then because its disk filled. Adam approved removing
  only named historical qualification images and unused build cache. Existing
  v0.12.4 images, database images and unrelated project images were preserved.
- Production publication/deployment and authenticated acceptance: pending approval.

## Rollback

**Do not simply roll back the image after migrations.** The old release does not
recognize the new Alembic head, even though these migrations are additive. A
database restore or tested downgrade requires explicit operator approval and may
lose writes or new comment/notification records. Preserve the previous built DO
deployment and protected spec. Never weaken the startup guard or enable metrics
on an unpatched upstream image.
