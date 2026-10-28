# Open WebUI v0.12.4 qualification

Prepared 2026-10-27. Production deployment pending. Adam confirmed personal-server
use satisfies the upgrade gate. This follows the separate live Lathe 1.3.3 bump.

## Release and compatibility review

- Release: <https://github.com/open-webui/open-webui/releases/tag/v0.12.4>,
  source commit `33c1978d5bad52a31df75ea55143025dfad18d16`.
- Standard image index:
  `sha256:a5b9e403d19154796850679c8c5d1295301cee954be8b84ddd62af92426558f7`.
  amd64 manifest: `sha256:c5354e4a8e83ae6e0c75521c494e7ca0e66ccd88421dcd625d618518cab181f1`;
  arm64: `sha256:786e62045b4f621526ab3d4947b0328cd2a961dfe7a92c8bbeb16cf3625cb31c`.
- Recursive source-tree comparison found no migration changes from v0.12.3.
  Existing managed PostgreSQL backups and the current app/spec were privately
  snapshotted. No production database writes were needed for preparation.
- Container changes from Python 3.11 / Debian 12 to Python 3.12 / Debian 13.
  Reviewed requirements include MCP 2.3.0, Pillow 13, uvicorn 0.54.0 and security
  dependency updates. The six guarded telemetry dependencies are unchanged and
  were verified in the actual arm64 image, which runs Python 3.12.15.
- Native metrics/setup/instrumentor sources are byte-identical. Exact env,
  requirements and project references were refreshed without weakening guards.
  The minimized metrics adapter and collection policy are unchanged.
- Sharing changes now require Access endpoints; ordinary resource saves no longer
  update grants. Post-upgrade operations must read back grants rather than assume
  model/tool update payloads change access. Same-named tool dispatch is fixed.
- Direct Integrations off now actually disables saved per-user connections.
  This upgrade does not enable it or any other feature. Native audit logging and
  user-info forwarding must not be enabled implicitly.
- Reviewed auth diffs introduce LDAP fallback-domain support and prefer a
  secret-bearing OAuth method for MCP; no CILogon configuration migration found.
- Upstream includes security fixes with advisories pending CVE assignment,
  substantial accessibility improvements and skill/file handling fixes. Those
  release claims are not fresh BayLeaf accessibility conformance evidence.

## Guarded startup and arrivals

The v0.12.4 stock loader remains empty. The actual HTML, compiled root/auth nodes,
config and start-script hashes were refreshed. Session resolution still precedes
routed content; OAuth resolution precedes `auth-login-card`. Collection remains
limited to initial signed-out public-root arrivals, with no policy or payload change.

The obsolete pre-guard rung-3 sentinel is replaced with
`[bayleaf] guarded Chat startup (boot logic: chat/image/startup_patch.py)`.
Only `[bayleaf] v0.12.4 metrics source minimization verified` proves all startup
checks passed. Qualification assertions track the new marker.

Qualification scripts accept `BAYLEAF_QUALIFICATION_OUTPUT` to keep new generated
proofs outside the repository rather than overwrite historical v0.12.3 evidence.
Local proofs are under the session's approved temporary directory, `owui-0124/`.
Private production rollback/config/resource snapshots are under
`~/.tokens/bayleaf-owui-0124-20261027/`.

## Acceptance

- Arm64 guarded image build: passed.
- Python 3.12 synthetic startup/export qualification: passed, including drift
  refusal, idempotence, five-metric source minimization and 99-point export paging.
- Browser adapter and bundle checks: 22 passed; installer unit check: passed.
- Real Chromium arrivals: all 15 enabled cases and the separate disabled-source
  case passed. Cold asset loads initially reset connections in the test proxy,
  producing Svelte's error page. Increasing only the synthetic TLS listen backlog
  from five to 128 fixed the fixture; no production workaround was introduced.
  Both owned local arrival containers were removed after qualification.
- amd64 build, guarded boot, synthetic authentication, JSON/SSE inference,
  source-drift refusal and read-only metrics connection settings: passed.
- Full arm64 PostgreSQL/container periodic-export qualification: passed at the
  production five-minute cadence. All five approved metric names arrived over
  synthetic TLS; unknown routes/methods minimized correctly, traces/logs stayed
  off and exactly one metrics connection was present. Pool wait was 101.17 ms,
  statement cancellation 202.05 ms and lock cancellation 100.49 ms. Unavailable-DB
  backoff and healthy recovery passed. All owned containers/networks were removed.
- Production source deployment, startup/health/version, Basic/Help inference,
  post-upgrade resource reconciliation and human browser/tool acceptance: pending.

## Rollback

No migration change was found, but verify the deployed database revision and
current recovery coverage before rollback. Prefer the saved prior DigitalOcean
deployment image, preserving all environment settings, rather than weakening
startup checks or substituting an unpatched upstream image. Database restoration
needs separate operator approval and can lose later writes.
