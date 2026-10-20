# Core review resolution, 2026-10-20

Original findings remain unchanged in `qualification/review.md`.
No production action, provisioning, deployment or commit was performed.

- **P1 disguised IP hostnames:** receiver normalizes case/trailing dot, then uses
  WHATWG URL hostname canonicalization to reject standard, short, octal and hex
  IP address forms before DNS policy. Browser ingress regressions assert HTTP 400
  and zero stored observations for disguised IPv4 and IPv6; ordinary DNS with a
  trailing dot remains accepted and normalized.
- **P1 retention resurrection:** local migration 0002 persists four content-free
  class policy rows. TTL ceilings only decrease and retirement cutoffs only
  advance. A reviewed explicit migration is required for a real TTL increase.
  D1 transactions join policy UPSERT with guarded admission, reads or purge.
  Both envelope and every metric point must pass the floor; receipts and status
  obey it too. The same scenario suite runs on real SQLite and actual D1:
  shortening then increasing before purge, old/new mixed metric windows, stale
  concurrent configuration, fresh-event effective expiry, replay with original
  or changed batch UUID after purge, and clock rollback. A separate regression
  covers future-clock-skew expiry anchoring. No permanent per-event tombstones.
- **P2 authority collision:** one credential-map validator gates both service
  writes and private reads. Colliding read/write secrets, duplicate source keys,
  malformed maps and invalid source/token definitions return content-free 503
  configuration failures before privileged work.
- **P2 impossible empty histograms:** internal JSON now shares the OTLP invariant:
  zero count means no min/max and absent or zero sum. Validator plus actual
  normalized JSON route regressions reject impossible statistics, store nothing,
  and accept legitimate empty distributions.
- **Optional hardening:** JSON stream buffering is independently capped at 2048
  chunks, including empty chunks, alongside byte and total-read-deadline bounds.

Collection-disabled scheduled expiry remains unchanged and regression-covered.
See README for exact policy initialization, prospective configuration semantics
and migration caveats for old disposable local databases. The persistent policy
rows are not user-content archives and are deliberately excluded from purge.

Final verification: `npm test` passes 52 Node tests (including the shared
retention scenarios on actual workerd/D1); `npm run test:python` passes 8 tests.

## Approved 90-day policy preparation, 2026-10-20

- Operator approval now covers deployment and live collection of all four
  classes, with 90-day retention, not the earlier proposed 30 days. This local
  policy/disclosure change performs no deployment, production access, credential
  creation, commit or publication.
- Policy version 2 accepts integer 1–90-day settings; schema version 1 and the
  local seven-day default remain unchanged. `validate.js` already delegates the
  bound to `policies.js`; no validator/storage/Worker change was needed.
- Boundary regressions cover 90-day acceptance, exact expiry rejection, invalid
  91-day settings, local default and per-class overrides. A seven-day initialized
  database cannot gain 90 days for new rows. Shared SQLite/actual-D1 scenarios
  now exercise 90-day policy shortened to one day, stale configuration/races,
  replays, clock rollback and permanent class-ceiling protection without resetting
  policy rows. An already initialized browser class retains its smaller ceiling.
- Draft `PRIVACY.md`, `api/RETENTION.md`, `chat/RETENTION.md` and this service's
  guide distinguish approved/planned collection from actual source activation,
  90-day live expiry from bounded physical purge and paid D1 recovery up to 30
  additional days after deletion, and source-lifetime artifact expiry from
  indefinite copies. No automatic export/archive or user-request Sealed
  metadata is introduced. Exact-diff publication and affected-user notice
  approval remain separate gates.
- Verification for this change: `node --test test/*.test.js` passes all **21**
  core/actual-D1 tests; `npm run test:python` passes **8** tests. The first full
  run identified an outside-owned qualification assertion pinned to policy
  version 1; the parent coordinated its change to `POLICY_VERSION`. A subsequent
  full `npm test` passes all **54** tests.
