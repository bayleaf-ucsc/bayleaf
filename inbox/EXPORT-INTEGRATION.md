# Export integration handoff (2026-10-21)

Historical export-worktree review, now integrated into main's TTL/events/stream/
DKIM baseline. The original review performed no production actions, commits or
pushes. See [integrated hardening](qualification/INTEGRATED-HARDENING.md) for the
merged implementation, local evidence and deployment dependencies. This handoff
does not establish current deployment state; see `QUALIFICATION.md` for that record.
Do not deploy the source worktree's older full Worker or API files.

## Historical merge guidance (integration completed)

1. Keep main's TTL migration `0003_lifetimes.sql` and events migration
   `0004_events.sql`. The copy of `0003` here is an identical local test dependency,
   not a replacement migration. Add only `0005_export_telemetry.sql` from this
   worktree. Update any explicit migration arrays in the merged test harness.
2. In `inbox/src/worker.js`, carry export defaults, export telemetry names/units,
   the portable export/HAR helper block, two RPC methods and two entrypoint methods.
   The shared `activeInbox` and `visibleMessage` helpers are intentionally unchanged
   from this branch's base. Keep main's newer helpers, reception, stored-mark,
   destruction, TTL and event implementations. Export-specific helpers enforce
   main's live predicate using SQL `unixepoch()` and post-await wall-clock checks.
3. Merge API export/HAR routes, schema, binding signatures and CORS cursor exposure
   into main's existing routes/types. Preserve TTL and SSE additions. Append the
   export test sections and merge their harness support rather than replacing main
   test files. Add `test/export-resources.test.mjs` intact.
4. Merge discovery prose and operation pointers as a union: retain main's stream
   operations and add `getInboxMessageHar` and `exportInbox`. Keep the explicit
   distinction between export cursors and event cursors. Merge documentation
   sections rather than replacing main's DESIGN/AGENTS/TODO or llms files.

The original GLM discovery trial reported ambiguity in “Repeat with the header.”
The revised reference says to **read the response header**, then put its value in
the next request's **`?cursor=` query parameter**, never a request header. The
independent trial record belongs to `inbox/qualification/glm-discovery.md` in the
stream worktree. This review incorporates that finding; it does not claim a new
GLM execution or post-deployment trial.

## Deployment dependencies (not deployment evidence)

1. Rerun the integrated baseline's TTL/events/stream tests plus export tests below.
   Do not infer merged-baseline success from the historical isolated run.
2. Apply outstanding Inboxes migrations in sequence through `0007` (TTL `0003`,
   events `0004`, export counters `0005`, qualification hardening `0006`, email
   policy `0007`), checking the remote migration record first. Export depends on
   the TTL column; `0005` rebuilds only
   `telemetry_counts`, preserving existing values and parent windows. It does not
   change the collector database or introduce a collector migration.
3. Deploy telemetry collector policy/validation support for `inbox.export.pages`
   (`1`) and `inbox.export.bytes` (`By`) before any exporting Inboxes Worker.
   Preserve source `inboxes`, transport `http|email`, outcome `emitted`, the exact
   15-minute delta contract, writer isolation, privacy allowlists and 31-series cap.
   Existing policy version 4 remains the approved local extension baseline.
4. Deploy the integrated Inboxes Worker, then the integrated API. Keep the pilot
   owner gate and existing telemetry activation/retention unchanged. Export uses
   the existing telemetry switch; no independent export collection flag is added.
5. Qualify a synthetic HTTP and email export through the real API, validate tar
   hashes and cursor query use, read only the content-free telemetry aggregates,
   and clean up exact synthetic resources through normal lifecycle operations.
   Counters are best effort, repeated downloads count again, and bytes include
   tar/HAR/manifest overhead. Pages and bytes are independent writes and may split
   across windows or fail separately. They are not delivery evidence.
6. A later GLM usability trial should follow the published docs to export at least
   two pages into separate directories, verify payload hashes, attach a referenced
   body manually, and identify unknown timings/responses without inventing them.
   No adapter tool or current GUI importer parity is claimed by this change.

## HAR compatibility decision and actual evidence

The canonical export is exact payload bytes plus the manifest. The derived
`receipts.har` has `log._profile = "bayleaf-inbox-receipt-1"`. It is deliberately
nonstandard: the frozen HAR 1.2 specification requires nonnegative send/wait/receive
and an additive total. No observed durations or response exist in storage. A
conforming transaction projection would require invented values, or dropping
required fields/transactions. Neither is a truthful useful projection here.
Unknown `-1` timings are retained, with no synthetic-zero compatibility mode.
Status 0, HTTP version `unknown`, captured-content size 0 and external `_file`
references have explicitly documented BayLeaf semantics.

Pinned packages were installed in a disposable external directory, not added to
runtime or project dependencies:

- `har-validator@5.1.5` / `har-schema@2.0.0`: the generated fixture **passes**.
  Inspection finds `min` rather than JSON Schema `minimum` for timings and no
  total-sum check. This result is not spec conformance evidence.
- `insomnia-importers@3.6.0` HAR importer: the actual generated request imports
  with its method, URL and inline body preserved. A capped `_file` body imports as
  **empty text**, demonstrating that manual exact-file attachment is necessary.
  This is a legacy library test, not a current Insomnia GUI, Postman or devtools test.

Reproduce those optional tests by setting `HAR_VALIDATOR_MODULE` to the installed
`har-validator/lib/promise.js` and `HAR_IMPORTER_MODULE` to
`insomnia-importers/dist/src/importers/har.js`, then running `npm test` in `inbox/`.
Without those variables the two optional compatibility cases explicitly skip.

## Review fixes and verification

- Reader ownership now starts before the tar header and survives through copying.
  Cancellation interrupts pending reader reads, awaits pending R2 get settlement,
  aborts unfinished digests, observes rejected digest promises and releases locks.
  No direct cancellation of a locked R2 stream.
- Visibility is checked after R2 get and after body copy. Loss before any payload
  header produces an omission; loss after output starts truncates the page. HAR
  has a final visibility check before its Response. Inbox liveness is checked
  after the listing and before derived archive files, including empty pages.
- A separate 4 MiB metadata budget stops pathological many-metadata pages; the
  at-least-one rule keeps cursors advancing. HAR entries are encoded separately
  rather than holding an additional joined whole-page string and byte array.
- Fully omitted pages advance the cursor. Concurrent export is not a snapshot:
  arrivals committed behind a cursor can be missed. Quiesce senders/in-flight
  receipts for a complete export. Headers/query/body redaction boundaries persist.
- Strict US-ASCII declarations reject non-ASCII inline decoding.

Isolated validation passed: **80 inbox tests** including both actual compatibility
cases, **97 telemetry tests**, API facade tests, **65 API E2E checks**, API docs
tests and TypeScript checking. Native R2/digest/tar tests run in workerd; controlled
cancellation/TTL race tests use Node streams, real SQLite and a DigestStream shim.
Neither substitutes for a real client-disconnect production qualification.

## Exposure decision

HTTP API and llms discovery: exposed behind existing keyed owner/pilot authority.
Hosted OpenChamber, Nanobot, Chat and desktop-specific export adapters: deferred
to the integration owner after API usability qualification. Generic authenticated
scripts can use the documented HTTP operations; no new adapter registration is
claimed. Independent GLM discovery feedback informs the docs, not server authority.
