# Live SSE rollout and agent-experience qualification

The implementation worktree made no production requests. Main integrated and
deployed TTL + events + SSE on 2026-10-21; see `../QUALIFICATION.md` for exact
versions and successful minimal live smoke. The full 15-minute GLM trial remains
separate.
Canonical contract: `../DESIGN.md`; cost evidence: `../research/STREAM.md`.

## Integration gate for the main session

1. Preserve main's current TTL implementation, especially execution-time LIVE
   predicates, async visibleMessage and the in-progress sweep budget/pagination fixes.
   Apply this worktree's event/lease hunks, not a whole-file overwrite. Migration
   `0003_lifetimes.sql` is main's unchanged TTL schema; only `0004_events.sql` is new.
   Payload export is not part of this slice.
2. Run inbox tests, API facade/E2E/docs/typechecks, and `npm run test:inbox-stream`.
   The standalone streaming harness needs no generated adapter manifests; the
   older full-app harnesses and TS need the normal initialized adapter build inputs.
3. The main deployment agent applies the approved migrations and deploys the inbox
   Worker before the API Worker. The stream needs the new private lease/read RPCs.
   This document and client are not authorization for this subagent to deploy.
4. Keep operator/pilot gates, observability disabled and existing source credentials.
   Do not widen the pilot to make a client test succeed.

## Concrete live client (run only after the main session's approved deployment)

Node's built-in fetch is sufficient, no new dependencies. Supply the operator key
privately as `BAYLEAF_API_KEY`, never as an argument, URL, file or transcript literal.
Run from `api/`:

```sh
# Fast smoke: creates one 15-minute-preset HTTP inbox, closes it with a temporary
# sender credential, catches up, self-posts while SSE is open, reconnects across a
# disconnected arrival, then observes explicit destruction. It cleans up only its
# own disposable inbox and prints counts, not addresses, tokens or message content.
node scripts/qualify-inbox-stream.mjs --live

# Full lifetime trial: same protocol, then remains connected/reconnects across
# five-minute stream limits until the real 15-minute endpoint expires. Bounded at
# 20 minutes overall. The live expiry detection must be under five seconds.
node scripts/qualify-inbox-stream.mjs --live --wait-ttl
```

Default origin is `https://api.bayleaf.dev`; `BAYLEAF_API_BASE` can explicitly select
another HTTPS deployment. No inference requests, account-key rotation, existing
inbox reads or destructive operations on resources not created by the client.
Its only stored content is three fixed synthetic self-posts. `finally` destroys
that exact inbox, even if validation fails; destruction remains asynchronous.
Check a non-202/404 cleanup warning separately. A process kill can bypass finally,
so the preset TTL remains the backstop.

For a manual companion client with an already-created disposable inbox:

```sh
API="${BAYLEAF_API_BASE:-https://api.bayleaf.dev}"
curl --no-buffer --max-time 310 \
  -H "Authorization: Bearer $BAYLEAF_API_KEY" \
  "$API/inboxes/$INBOX_ID/events/stream?after=now"
# In a second terminal, while that connection remains open:
curl --fail-with-body -sS -X POST \
  -H "Authorization: Bearer $SENDER_TOKEN" -H 'Content-Type: application/json' \
  --data '{"qualification":"synthetic self-post"}' "$INBOX_URL"
# Reconnect with the last completed event cursor, still keeping auth out of URLs:
curl --no-buffer --max-time 310 \
  -H "Authorization: Bearer $BAYLEAF_API_KEY" -H "Last-Event-ID: $CURSOR" \
  "$API/inboxes/$INBOX_ID/events/stream"
```

Explicit `after` overrides the header. A 410 before streaming means resync the
finite feed; a `cursor_expired` terminal frame means the same. Lifetime/replay-limit
ends are reconnectable; auth_revoked/not_found means stop. Unexpected EOF/network
loss may require backoff/resume, with deduplication. A notification does not promise
that the referenced message still exists when retrieved.

## GLM live AX task, after deployment qualification

Give the user-requested GLM session the goal, existing safe credential access and
public docs, not a pasted bearer. Ask it to monitor a new temporary webhook while
self-posting synthetic data, including a disconnected interval, and observe the
15-minute expiry. It may use the client above and should also assess whether the
published OpenAPI/llms workflow made the operation discoverable and understandable.
Do not rotate/revoke the user's ordinary API key to test reader revocation live.
Local tests already exercise ordinary/sandbox revocation, rotation and generation
change. Do not mistake revoking a sender token for revoking the stream owner.

AX report should separate measured outcome from expectations:

- First ready latency, same-connection self-post latency, receipt counts and stable
  duplicate IDs on resume; any client polling required (it should require none).
- Lifetime reconnect behavior, TTL terminal timing, cleanup warning or success,
  and whether errors made the next action clear.
- Any edge buffering, abrupt close, compression, auth/control-plane timeout or
  denial. Never print owner/sender credentials, receipt URLs or received content.
- Whether the interface felt like passive observation rather than a work queue or
  an always-on agent. No delivery may activate inference or agent execution.

## Still unqualified until those runs

Real Cloudflare edge flushing/abort propagation, the five-minute lifetime on the
deployed runtime, 15-minute real preset expiry, runtime-update reconnection, actual
CPU/D1 metrics, and sustained sandbox-control-plane auth quota behavior. Local
Miniflare evidence does not establish these or installed-client/GLM AX parity.

The minimal main-session live smoke now proves same-connection edge delivery,
catch-up/resume and explicit-destroy termination. Post-smoke D1 showed zero leases
and zero synthetic message/credential rows. Five-minute reconnect and real preset
expiry still require the full trial.
