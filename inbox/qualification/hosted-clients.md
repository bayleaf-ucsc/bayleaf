# Hosted-client qualification: 2026-10-21

**Follow-up:** `hosted-client-adapter-followup.md` records implemented candidate
TTL/event adapters, the successful corrected live-download trial and a disposable
Linux stop/resume qualification. The initial assessment below is historical.

## Outcome

**The installed hosted-client gate remains open.** This run adds real isolated
OpenCode and MCP runtime evidence for the exact published adapters, and a bounded
partial production API trial. It does not establish fresh managed installation,
automatic capability refresh, Daytona sleep/wake, browser permission UX, or GLM
behavioral discovery. No adapter release, runtime change, deployment, commit or
push occurred. Export remains deliberately direct HTTP/scripts, not adapter tools.

## Provenance and deployment observation

An authenticated read of production
`/sandbox/.well-known/opencode/config` returned:

```text
github:bayleaf-ucsc/opencode-sandbox#eb40edabc1e7dd58a6e9be586115779402ccfd23
```

Production `/sandbox/browser/status` reported `phase: stopped`. No start, restart,
session modification or compute wake was requested. A guessed Nanobot status
path (`/sandbox/services/nanobot/status`) returned 404 and provides **no evidence**
about Nanobot installation state.

The Nanobot pin used here is `16ee3c3ba44f6ae64d6847e64a79fa7949c18c2a`, recorded
in `DEPLOYED-INTEGRATED.md`. This run did not independently fetch the deployed
Nanobot embedded module. Both adapters were extracted with `git show` at the
full pins, never from newer checkout contents. Comparing each pin with checkout
HEAD found only `skills/bayleaf-inboxes/SKILL.md` changes: eight changed lines for
OpenCode and twelve for Nanobot. Their executable adapter sources match.

The existing operator key was obtained from the exact authorized owner row into
process memory, never printed or committed. No existing inbox content was read.

## Concrete feature gaps requiring an exposure/release decision

| Capability | Published OpenCode | Published Nanobot | Consequence |
|---|---|---|---|
| Basic receiving discovery | Eight inbox tools and packaged skill | Six inbox tools | Runtime registration verified below, behavioral offering untested |
| Endpoint TTL creation | `type`, `label` only | `type`, `label` only | Neither exposes `ttl_seconds` or `preset` |
| Shorten endpoint TTL | No tool | No tool | Direct API required |
| Endpoint expiry readback | Inbox field allowlist drops `expires_at` | Same omission | A timed inbox can appear without its lifetime; message expiry fields are separate |
| Finite arrival events / live SSE | No tool | No tool | Direct API/script workflow; no adapter cursor persistence/resume evidence |
| Bulk export / HAR | No tool | No tool | Intentional direct API/scripts scope, **not a gap to fill** |
| Native mutation/download approval | Native permission requests | No native approval UI | Nanobot create/archive rely on conversational agreement; destructive and credential tools omitted |
| Attachment download | Exact-path native approval, mode 0600 | Conventional `~/workspace/inbox-downloads` quarantine, mode 0600 | Neither is an OS execution sandbox |

Current checkout executable code has these same TTL/event gaps. A pin refresh
alone cannot add those verbs or expiry readback. Report the proposed adapter scope
to Adam before implementing/publishing a bump. Do not silently add export tools.
The newer skill discovery wording also requires publication and pin/asset delivery
before claiming users receive it.

OpenCode's inbox registration additionally depends on its process environment
`BAYLEAF_INBOXES_ENABLED=true`. A remote package refresh cannot by itself change
that already-running process environment. Qualify pre-feature running clients
separately from ones launched with the feature flag enabled. Nanobot's actual
managed `enabledTools` filter and installed skill files are another boundary;
the adapter's unfiltered MCP list does not prove the installer enabled them.

## Isolated exact-published runtime harness

Run:

```sh
node inbox/qualification/hosted-client-runtime.mjs
```

Environment: macOS, real OpenCode **v2.1.2**, real Node stdio JSON-RPC MCP.
Private temporary HOME/XDG roots, synthetic owner key, loopback synthetic API.
The wrapper invokes actual registered tools through a test-only RPC; it does not
simulate OpenCode's permission service. No inference or user session is involved.

Measured checks:

- Eight OpenCode inbox tools and the packaged inbox skill register from the
  exact published package. Registered creation schema has no TTL input.
- Create, archive, delete-message, destroy, and save each use the real native
  permission service. Reject denies the action; `once` permits it. No mutation
  or attachment fetch happens before approval. Destroy's preliminary metadata
  GET is deliberately excluded from that side-effect count.
- Exact synthetic HTML attachment bytes are saved with mode 0600, not rendered
  or executed. Incoming fake closing instruction markers are neutralized.
- Explicit location reload preserves subsequent tool use in the existing test
  session. Process stop/start retains the session and tool registration. These
  are **not** automatic ten-minute refresh or Daytona sleep/wake tests.
- Published Nanobot MCP advertises six inbox tools. Create and archive execute
  without a native permission round trip, matching its intentional boundary.
- Attachment bytes land exactly in its quarantine with mode 0600. Traversal,
  instruction/configuration paths and overwriting an existing file are denied.
- A fresh MCP process after shutdown rediscovers tools and reads synthetic data.
  This is not a managed Nanobot application update or resumption test.

Harness development exposed missing test environment setup and empty HTTP 204
response handling, then a cleanup wait on an already signal-terminated process.
The latter run completed behavioral assertions but timed out in cleanup, so it
was not counted as a completed pass. Its exact synthetic directory was removed
after identifying the wrapper, and the process-exit check was corrected.
The final rerun exited successfully with all checks above and
`CLEANUP isolated runtime files and processes removed; failures=0`.

## Partial live Nanobot MCP trial

`hosted-client-live.mjs --live` requires `BAYLEAF_API_KEY` privately in the
environment. The one executed trial used one synthetic HTTP inbox and one sender
credential. It sent no mail, made no inference calls, and did not wake compute.

Passed before the failure:

1. Fresh exact-published MCP tool discovery and actual adapter inbox creation.
2. Direct owner API assigned a 60-second TTL (the adapter cannot request one).
3. Sender bearer on owner read returned **401**; ordinary owner key on the closed
   receiver returned **401**; the sender bearer successfully delivered a receipt.
4. Adapter read returned the synthetic payload under untrusted-content markers.
5. Live body response carried `Content-Disposition: attachment`,
   `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: sandbox`.

The next adapter download failed: the test layout put `workspace/` under the
adapter's managed-root parent, which the quarantine correctly forbids. The
fixture is corrected to sibling `managed/` and `workspace/` directories. **The
corrected live harness was not rerun**, preserving the small one-client-resource
scope. Live adapter save/archive, process-off delivery/restart and real TTL
denial were therefore **not reached** in this trial. Its finally block received
an accepted exact-inbox destruction response and removed private local credential
files and received bytes. Physical finalization remains asynchronous, not verified.

## Exact remaining work

1. Agree TTL/expiry and event/SSE hosted exposure. Existing published and current
   source adapters cannot demonstrate those operations natively. Export stays
   direct API/scripts. Publish any approved discovery/adapter changes separately,
   then build clean parent assets while preserving the operator pilot.
2. In a designated disposable hosted installation, verify the actual workspace,
   process feature flag, installed package/asset hashes, skill text and Nanobot
   `enabledTools`. Provisioning was authorized but not undertaken in this run.
3. Exercise a running pre-update client through the documented update path,
   including a subsequent turn in an existing synthetic session. Do not substitute
   explicit local reload for the real automatic refresh claim.
4. Stop only that disposable machine, deliver a synthetic receipt while stopped,
   verify passive reads do not wake it, deliberately resume, and check installed
   capabilities plus cursor reconciliation. Local process restart does not close
   this gate.
5. Rerun the corrected live download workflow within an agreed disposable-resource
   allowance. Pair synthetic MIME attachments with live HTTP-body evidence rather
   than send real mail or read an existing user's attachment.
6. Run a fresh natural-language GLM trial inside the actual hosted client. This
   harness performs no model inference and supplies no GLM AX evidence. No
   `functions.subagent` tool was available in this session, so no substitute model
   or impersonated user session was used.

The parent session should keep #97's installed-client gate open. These are
runtime/API measurements with explicit limits, not installed-client parity.
