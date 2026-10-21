# Inboxes operations

Operational reference for the operator-only pilot. [DESIGN.md](DESIGN.md) owns
the contract and rationale; [QUALIFICATION.md](QUALIFICATION.md) owns dated
evidence; [TODO.md](TODO.md) lists unfinished work. Deployment is separate from
publication and campus enablement. Never publish credentials, account generations,
receipt addresses, raw mail or private resource manifests.

## Configuration and deployment

- Receiver `bayleaf-inboxes` owns dedicated D1/R2, Email Routing catch-all and
  apex/wildcard DNS/TLS. Owner operations use only the API `INBOXES` binding.
- Preserve live API `INBOXES_ENABLED=true` and `INBOXES_PILOT_OWNER` together.
  Source API defaults deliberately disable Inboxes: an ordinary default deploy
  disables the pilot. Use `api/scripts/stage-inboxes-deploy.py` and review the
  staged configuration against live settings before any authorized deployment.
- Preserve receiver enablement, browser-arrival/telemetry activation, disabled
  observability and `EMAIL_AUTH_CREATION_ENABLED=false`. Existing email inboxes
  are unrestricted; a disabled creation gate never bypasses a stored policy.
- Default owner quota is 100, including active, expired-awaiting-cleanup and
  destroying rows. Authenticated `GET /inboxes/limits` is authoritative for
  effective settings and usage. Remaining capacity is a snapshot, not a reservation.
  Diagnostic card limits are presentation limits, not quotas.
- Email Routing requires its provider-managed MX/SPF/DKIM records. Do not replace
  required records with an assumed null-sender SPF or add conflicting SPF records.
  Unknown recipients do not create inboxes. Keep R2 private.

For a coordinated release, inspect remote migration ledgers first; apply only
pending migrations in order. Inboxes migrations through `0007` and API `0019`
were applied on 2026-10-21. Collector export vocabulary must precede receiver
export support; receiver migration/build/deploy precedes the matching API.
Run normal build hooks: the pinned mailauth verifier requires `nodejs_compat`
and guarded digest-name/selector patches. See [research/DKIM.md](research/DKIM.md)
and its unshimmed tripwire before upgrading dependencies. Never roll back to a
pre-verifier or pre-fence receiver against databases containing those policies.
Before any future restricted creation, confirm old receiver versions have drained.

### Authentic hosted adapter assets

Current published source revisions (2026-10-21; parent `39bf426`):

| Repository | Published revision |
|---|---|
| `bayleaf-ucsc/opencode-sandbox` | `ebf705d43dfb6088329149619e5a68bf5eff3c28` |
| `bayleaf-ucsc/nanobot-sandbox` | `e1a7d014621f84ca0a0218c3d519bcd48d0f5f11` |

Both have tag `inboxes-limits-2026-10-21`. Earlier published rollback sources
have `inboxes-2026-10-20` and `inboxes-ttl-events-2026-10-21` tags. Preserve
advertised refs: the strict Nanobot builder requires one, not just an old SHA.
Do not ship local unpublished submodule HEADs or test-generated fixture assets.
After tests, rebuild with normal production hooks from clean published sources;
inspect Nanobot provenance (`mode: published`, revision/ref and asset hashes).
Compare candidate modules with fetched live modules and compare all settings and
bindings before/after deployment. Independently read the authenticated
`/sandbox/.well-known/opencode/config` plugin pin. The latest release matched all
four deployed API modules after trailing-whitespace normalization.

Hosted adapters expose limits, explicit TTL create/shorten, finite arrival pages
and bounded reads/quarantined downloads. OpenCode uses native permissions;
Nanobot's narrower authority omits immediate deletion/destruction and credential
tools. SSE is an explicitly requested bounded script workflow; export/HAR remains
direct HTTP/scripts. Chat has no new owner credential path. Never restart an
existing workspace merely to test delivery; running refresh, managed relink and
gateway/browser qualification are still distinct from package/runtime tests.

## Recovery: remain closed until reconciliation is verified

**If both retirement ledgers lose history, remain closed pending an
incident-specific operator decision. No automatic reset is authorized.** The
local negative control proves restored content and reception can resurrect if
both pre-retirement databases are reopened without reconciliation. No automatic
rollback detector or enablement interlock exists.

1. Before restoring rows, set `INBOXES_ENABLED=false` on both API and receiver;
   keep pilot and restricted-creation settings. Verify owner denial (currently
   404), receiver HTTP 503 and email service-unavailable rejection. Stop identity/
   provisioning mutations during API recovery. A pilot mismatch is no receiver
   kill switch.
2. Drain old runtime versions, SSE and admitted requests; keep restored storage
   unavailable to old revisions. If drain cannot be established, stay offline.
   Neither 900-second quiescence nor an empty prefix fences an in-flight remote
   put. Preserve cleanup records and fence generations before late arrivals.
3. Privately record both D1 identifiers, R2 binding, restore bookmarks/times,
   versions and migrations. Preserve the complete available retirement inventory.
   Receiver `0006` owns `retired_owners`/`cleanup_progress`; API `0019` owns
   `inbox_retirements`. Preserve surrounding migrations through receiver `0007`.
4. Freeze writes and build a complete, stably paginated target inventory:
   - Inbox-only restore: replay every surviving API retirement entry, including
     acknowledged entries, plus independently preserved retirement history.
   - API-only restore: preserve receiver fences and reconcile their union with
     restored API entries, restoring API ledger records for future recovery too.
   - Both ledgers rolled back: require complete independent deletion history for
     the rollback interval. Missing/uncertain history means stop, remain closed,
     and obtain the operator's decision. The same old backup is not independent.
5. Replay each target through trusted binding-only `InboxManagement.retireOwner`,
   which works with exposure off. Require `{retired:true}` per target and retain
   private acknowledgements. Independently verify complete set equality in D1:
   fences exist, no target active inboxes/credentials/event leases survive, and
   cleanup prefixes exist. Retain API ledger entries after acknowledgement.
6. While closed, clear stale stream leases and rotate `event_feed.epoch` if
   retaining inboxes after D1 rollback. Clients must resynchronize; old cursor
   coordinates can otherwise be reused. This does not replace owner fencing.
7. Reopen only after complete inventory verification, synthetic access canaries,
   runtime drain and explicit operator approval. An interrupted reconciliation
   stays closed and resumes idempotently. Preserve pilot scope and bounded cleanup.

Routine `cleanupRetiredInboxes` is not a restore completion certificate: it visits
bounded batches, `pending=0` excludes acknowledged entries still needing replay,
and `checked_at` precedes the RPC. There is no production recovery CLI. The local
`qualification/recovery-check.mjs` drill must never target live storage.

### Emergency invalidation, only after explicit incident authorization

If the operator chooses destructive reset rather than recovering sufficient
history, inventory the union of restored API generations, inbox owners (including
orphans), and surviving retirement records. Malformed generations stop review.
Persist the complete inventory outside the rollback domain. Insert every target
into the API ledger and replay/verify every receiver fence while closed. Then
assign retained API identities fresh independent UUIDs with compare-and-swap and
an idempotent old/new transition manifest. Never reattach old inboxes to fresh
generations. All restored endpoints are retired, including surviving accounts'
endpoints. Coordinate reauthentication for generation-bound sessions/sandboxes;
generation rotation does not revoke every ordinary key or email-bound login.
Complete the normal reopening gate above. This option is locally tested, not
standing permission, and no independent deletion-ledger service is promised.

Any future one-shot operator runner should default to dry-run, pin both databases,
receiver version/binding, inventory digest and closed state, reject partial
pagination, retain per-target acknowledgements and never toggle enablement itself.
It needs no public admin endpoint or new database.

## Troubleshooting and evidence handling

- Plain-text Cloudflare 403/error 1010 can precede the API when Python uses its
  default urllib user agent. Use an honest client UA such as
  `BayLeafInboxClient/1.0`; distinguish edge responses from JSON API errors.
- Owner credentials authorize management/events/export; sender credentials only
  authorize delivery to their closed inbox. Neither substitutes for the other.
  First sender credential permanently closes reception, including after revocation.
- A 409 create limit can persist after destruction: destroying rows retain quota
  until finalization. Consult `/inboxes/limits`, use bounded backoff, never force
  cleanup or raise quotas to make a test pass.
- SSE `ready` precedes a deliberate self-post with `after=now`. Save complete
  cursors and deduplicate on resume. Explicit `after` overrides `Last-Event-ID`.
  410/`cursor_expired` requires resync; lifetime/replay-limit permits reconnect;
  `auth_revoked`/`not_found` means stop. Edge buffers can hide a stalled reader;
  the 300-second lifetime still bounds every connection.
- Export has one page manifest under `manifests/`, not `manifest.json` or one per
  receipt. Send the response next-cursor as the next request's `?cursor=`. Keep
  pages separate and verify exact payload hashes. Legacy importers ignore `_file`:
  attach the exact file manually. HAR unknown timings/status are not observations.
- Destroy acknowledgement, zero message rows and physical finalization are
  different evidence. Verify exact known inbox/child rows and R2 prefixes after
  quiescence/sweeps. Opaque reconciliation records and provider recovery history
  remain; never infer one unidentified trial's cleanup from aggregate counters.

### Isolated SMTP fixture

The reusable `qualification/smtp-route-preflight.mjs` fixture has no storage;
its generic `throw` mode is not a storage fault. The full SMTP/storage matrix is
in [qualification/smtp-runbook.md](qualification/smtp-runbook.md). Every live
send/deploy requires explicit scope; Gmail guard tickets belong to the sending
session and must not be delegated. Keep raw evidence outside the repository.

Set explicit `CLOUDFLARE_ACCOUNT_ID`, `INBOX_QUALIFICATION_DOMAIN` and optionally
`CLOUDFLARE_PROFILE` (default `ucsc`). Choose a private external `$EVIDENCE` path:

```sh
node inbox/qualification/smtp-route-preflight.mjs --deploy-route-delete \
  --settle-seconds 60 --window-seconds 180 --mode pin-fail \
  --output "$EVIDENCE/pin-fail.json"
```

Wait for **ready**, then the authorized sender submits one synthetic message to
the private send manifest recipient. Management readback alone does not establish
route propagation; even 60 seconds is no SLA. Preserve resource/send manifests
through cleanup. Negative evidence must match the exact fixture rule with fixed
`5.7.1 DKIM domain authorization required` (or a fixture rejection trace), not
the production catch-all's `5.1.1 Address not found`. Normalize rule-tag hyphens.
Cloudflare authentication pass is not BayLeaf policy authorization.

If the exact-recipient activity query is rate limited, do not resend/reprovision.
After the provider interval (observed five minutes), make one read-only query:

```sh
python3 inbox/qualification/smtp-activity-readback.py \
  --private-dir "$PRIVATE_RUN" --output "$EVIDENCE/activity.json"
```

If still limited, defer. Verify exact temporary rule/Worker/tail removal and
unchanged prior rules/catch-all. Gmail submission, provider `dropped` and HTTP
benchmark statuses are not final numeric SMTP replies or sender queue evidence.
