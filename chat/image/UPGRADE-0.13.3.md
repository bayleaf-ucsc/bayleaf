# Open WebUI v0.13.3 qualification

Local qualification completed 2026-11-10 after preparation started 2026-11-09.
Adam confirmed at least a day of issue-free personal-instance use. Production
remains on v0.13.0 until separately approved publication and deployment.

## Release and compatibility review

- Reviewed [v0.13.1](https://github.com/open-webui/open-webui/releases/tag/v0.13.1),
  [v0.13.2](https://github.com/open-webui/open-webui/releases/tag/v0.13.2) and
  [v0.13.3](https://github.com/open-webui/open-webui/releases/tag/v0.13.3).
  v0.13.1 includes security fixes with advisory publication pending CVE assignment.
- Target commit: `b0e6098e940942281d9c83f3529ea117287a3a22`. Standard image index:
  `sha256:46b59158e6558eeb980bc828e0f1b30238ad24d82ed84d5e5eda1dab2a082f14`.
  arm64 manifest: `sha256:c2c9eb42cc8c52e1365fb791069ba38fc87d32e4d778acdc4fc5443e4c1b620d`;
  amd64: `sha256:e731360d9e6eeb25482d90cf3d564ce81a1c4a10e6a84ed9e6c63aa7ac48b0b6`.
- Three migrations follow `e42c8f710a36`: `8bc7e5a902d1` creates renewable
  authentication sessions, `6a23bd107e54` creates private per-user chat view state,
  and `9f6c2a8d1b43` adds channel message/reaction indexes. Image-only rollback
  is not qualified across the new Alembic head.
- The latest managed PostgreSQL backup (`2026-11-10T01:53:18Z`) was verified.
  Database trusted sources still contain only the Chat app. No laptop database
  access was opened. The complete app spec, all four backup resource classes,
  hidden base model, tool/function admin valves and global config/admin exports
  were captured privately before changes. No users, groups or chats were exported.
  Complete private snapshots were refreshed on 2026-11-10 and are byte-identical
  to the previous day's resources/config/valves and app spec.
- All seven guarded upstream reference files, including requirements/project
  metadata and telemetry sources, are byte-identical to v0.13.0. The source
  adapter and six dependency guards need no change. Frontend asset guards were
  refreshed against the actual new image; the stock loader remains empty. Root
  session resolution still precedes routed content and the sign-in card.
- Native function-calling context now carries skills/knowledge/memory as hidden
  tool results to stabilize prompt-cache prefixes. Custom pipes can receive a
  tool message last. Vertex remains disabled; Basic and Brace inlet filters
  prepend system messages rather than assuming the last message is a user.
- Upstream defaults change file preloading, full-text retrieval (50,000-character
  threshold), retrieval counts/chunk size and saved side chats. Existing BayLeaf
  saved retrieval values are 3/3/1000, not the new 10/10/1024 defaults. Check the
  effective model capabilities and retained settings after rollout rather than
  assuming all upstream defaults take effect.
- New auto tool approval and relevance-scoring options can send context/tool
  arguments to a separately configured inference API. They are off by default;
  this upgrade does not authorize enabling them or bypassing the ZDR boundary.
  Existing tool search/permissions are disabled and terminal connections empty.
  Tether/agent integrations are not separately configured by this upgrade.
- Fresh CILogon sign-in, browser tool/skill behavior and upload handling remain
  human acceptance checks, distinct from health and HTTP inference smokes.

## Qualification evidence

Private snapshots and local proofs live under the session temporary directory
`owui-0133/`, outside this public repository.

- Synthetic startup/export qualification passed: exact package pins,
  source/adapter drift refusal, idempotence, unsafe-environment refusal,
  exec handoff, all-four-flags-off mode, five minimized metrics and 99-point paging.
- All 16 decoder and Chat browser-bundle tests passed.
- Pre-upgrade resource comparison found only known metadata/null-default drift
  and the existing Code Sandbox skill decorations. No unrelated live content was
  overwritten or adopted into this upgrade.
- Arm64 and amd64 builds passed using the default multi-platform digest, without
  weakening any source/package/asset guards. Local output indices respectively:
  `sha256:c4e5fd5b066c4e7120aae26328e6f52bdf3c1cfdb6362581fd084a13ee96d366`
  and `sha256:2f7b376126cec6715c7a9302fe0e47e715ea710a680f1349827ab16635c60352`.
  Neither image was pushed.
- An actual v0.13.0 synthetic PostgreSQL database upgraded from `e42c8f710a36`
  to `9f6c2a8d1b43`. Its synthetic tool/source/activation survived; both new tables
  and all three channel indexes were verified. Owned containers/network removed.
  Initial one-off harness attempts omitted the synthetic secret or imported the
  DB module without running config migrations; these harness faults were fixed.
- All 15 enabled-source Chromium arrival cases and the separate disabled-source
  case passed, including signed-in non-collection, unresolved-session refusal and
  credential-free fixed-schema delivery. Both owned browser fixtures removed.
- The initial image pull exhausted Docker disk. Adam approved removal of the
  named historical v0.12.4 qualification/base images and unused build cache,
  reclaiming 12 GB. v0.13.0, database and unrelated project images were preserved.
- Full five-minute arm64 PostgreSQL/TLS export passed on 2026-11-10: all five
  approved native metrics, empty resources, minimized routes/methods, traces/logs
  off and exactly one metrics connection. Pool wait was 100.32 ms, statement
  cancellation 204.10 ms and lock cancellation 103.22 ms. Unavailable-DB backoff
  and recovery passed. Health/version, synthetic auth and JSON/SSE inference passed.
- amd64 boot/inference passed under emulation: exact package/source guards,
  source-drift refusal, idempotence, uvicorn PID 1, synthetic auth and JSON/SSE,
  and read-only PG metrics settings. All owned fixtures were removed. These
  functional tests are not production capacity measurements.
- Docker shutdown interrupted the initial runs. A subsequent retry was aborted
  at Adam's request to leave work; all remaining owned fixtures were removed.
  The successful resumed run used the same pinned PostgreSQL digest through its
  `postgres@sha256:...` reference because Docker no longer resolved `tag@digest`.
- Publication and production deployment remain pending. No commit or push occurred.

## Rollback

Preserve the previous built DigitalOcean deployment and protected app spec.
The old image cannot recognize the new Alembic head. Database restoration or a
tested downgrade requires operator approval and may lose intervening writes.
Never weaken source/configuration guards or enable native metrics on an
unpatched upstream image.
