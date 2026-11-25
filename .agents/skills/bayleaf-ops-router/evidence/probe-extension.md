# Run evidence: probe-extension

Dated record of past runs of [`probe-extension.md`](../playbooks/probe-extension.md), newest first unless noted.
Consult for diagnosis; current procedure lives in the linked file.

- 2026-11-04: OWUI v0.13.0 browser failure at `typed` was a composer replacement
  race between visibility and focus, not selector renaming. Full-probe reproduction
  with a wrapped Puppeteer page isolated the failing operation; simplified paste
  tests passed and missed it. Wrangler `getPlatformProxy` remote setup stalled;
  authenticated Cloudflare CDP with the same SDK reproduced and qualified the source
  fix without changing secrets. Approved deployment then passed actual endpoint
  GET/HEAD with confirmed cleanup; scheduled monitor recovery remains unverified.

- 2026-10-27: Deployed passive `/api/sandbox` and exact probe-owner reaper exemption;
  fresh GET/HEAD passed and independent `lastActivityAt` remained unchanged.
  Adam requested status integration and supplied an authenticated dashboard:
  UI cloning retained email, but not working auth, and inherited a one-hour interval,
  not the historical 15 minutes. Status auto-add included monitor `804453127`.
  No new telemetry vocabulary. Initial timing (576 ms) and public Operational
  status were misleading while the detail card said Preparing: the later check
  failed 401 and saved Auth type was None. Adam pasted/saved the existing password;
  reopened settings confirmed Basic. Check actual recovery in about an hour before
  the authorized monitor-only setup-stat reset. Failure email is recorded sent
  by UptimeRobot; actual inbox delivery and recovery alert remain unverified.

- 2026-10-09: Expired browser JWT caused 503 / `browser_identity` before launch
  while Chat HTTP passed. CLI console via a private PTY enabled container-side
  one-year signing without exporting the signing key or changing global expiry.
  Single-secret upload and focused browser GET/HEAD passed (34.595/21.478s), with
  independently empty account history. Added diagnosis/renewal routing and the
  default-duration, two-secret installer gotcha; monitor recovery remains separate.

- 2026-10-08: redeploy/review passed 46 tests and live mutation checks. The first
  Sealed GET hit the unchanged 25-second first-byte deadline; the next GET/HEAD
  passed. Record failures alongside passes, and separate the expired browser JWT
  and existing local-toolchain audit findings from Sealed qualification.

- 2026-10-07: Sealed backend route is deployed and qualified, monitoring pending. Use the
  pinned verifier and EHBP primitives rather than high-level SDK retries/cache
  persistence; reuse the SSE validator after decryption. Real attestation and five
  mutation checks passed; dedicated-key workerd GET/HEAD passed after approved
  first-use provisioning. Local secret backup lacked the probe BayLeaf key, so
  read only the existing active probe row from D1 into subprocess memory.
  A default-only `worker.mjs` entry fixes local workerd rejection of string
  constants exported for tests. Independent `--sealed-only` qualification avoids
  unrelated Chat sign-in/cleanup; document each state's separate approval gate.
  GPT-6 Astra review found that SDK gzip expansion bypassed the wire-size limit;
  preflight streaming expansion is now capped at 64 KiB without changing signed
  material. Clarified certificate SAN/domain/key consistency (not TLS peer or
  certificate-signature authentication) and preserved HTTP failed-phase diagnostics.
  Astra re-review cleared the fixes (46 tests). Approved deployment version
  2e27f1f2-aeb7-4c19-b127-d4bbc5304f5e passed anonymous denial and authenticated
  GET/HEAD (22.184/2.066s Worker totals), after an initial 25s first-byte stall.
  Do not infer alert reliability from a later pass; manual monitor setup remains
  a human gate. Existing plaintext probe also stalled once then passed (2.451s).
  Adam subsequently confirmed monitor setup; public status inclusion/history was
  observed (Sealed 96.542%, page currently operational). Failure attribution and
  controlled alert delivery remain unverified.

- 2026-09-09: First run used `probe@bayleaf.dev` across services with distinct
  credentials and a `$1/day` API cap. Adam created the 15-minute UptimeRobot
  monitor before deployment, so setup failures can appear in its initial history.
  The full qualification run passed API GET/HEAD but failed on an unrelated
  remote-browser HEAD; adding `--api-only` made layer evidence independent.
  Endpoint qualification passed; initial monitor sampling and controlled
  failure/recovery alert verification remain Adam gates.
- 2026-09-15: Issue #68's recorded VPAT sessions reused the probe identity and
  cleanup discipline but were correctly implemented as an operator-run harness,
  not a monitor route. Cloudflare session recordings are rrweb event archives,
  not videos; producing reference MP4s requires a separately verified replay and
  encoding step.

## Moved from the body

Original wording, verbatim, as it stood in the procedure.

Frontmatter status:

```text
status: First production run completed; monitor sampling and alert verification remain human gates
```

Diagnosis and renewal section opening:

```text
Validated on 2026-10-09. Current credential expiry and deployment evidence belong
in `chat/probe/AGENTS.md` and `README.md` (Credentials), not a second expiry ledger
here.
```
