# Registration headers: live app/provider qualification

2026-10-08, issue [#86](https://github.com/bayleaf-ucsc/bayleaf/issues/86). ✨

## Result

The deployed gateway injected and overwrote configured headers over real Daytona
HTTP and WebSocket paths. Real Nanobot trusted-proxy bootstrap and real dufs Basic
authentication worked through public registrations. Anonymous private access
remained denied.

**Nanobot's tested trusted-peer configuration does not prevent direct bypass.**
Anyone possessing a live signed Daytona URL can supply a nonempty assertion and
authenticate directly. A separate signed URL reproduced this, as did the ordinary
provider preview URL with its provider preview token. This is not evidence that an
anonymous visitor without a provider capability can guess or reach that route.

**Initial run: Nanobot's initial WebSocket `ready` frame was not received through the gateway.**
The upgrade succeeded and subsequent non-inference request/response traffic worked.
Direct connections received `ready`. Full Nanobot browser compatibility is therefore
not established by that run. The location of the initial-frame loss was not proven
by that run. The narrow follow-up below confirms the deployed fix restores this frame.

## Scope and provenance

- Worker: `d150ca87-5fd8-4925-bb60-f35d1ee26022`, supplied in the deployment handoff.
- Published plugin: `ba62f515c5b1001b9562f2351286de004a1ce1b7`, supplied in the same
  handoff. This run used installation registration, not the plugin tool or keyed
  `/sandbox/expose`; it supplies no independent plugin execution evidence.
- One disposable 2-vCPU/4-GiB/10-GiB Linux sandbox in the BayLeaf Daytona account.
  The local development Daytona credential was verified by read-only existing
  BayLeaf deployment-label metadata; the expired Chat admin credential was not used.
- Real `nanobot-ai==0.3.5`, dufs `v0.46.0`, plus a metadata-only HTTP/WS fixture.
  Nanobot trusted only `127.0.0.1/32`, required WebSocket authentication, used
  `X-Authenticated-Owner`, and advertised the public wrapped WebSocket origin.
- Only synthetic data and application credentials. Nanobot's provider configuration
  used a fake key and loopback port 9. No chat messages or inference requests were
  sent. Existing owner applications were not started, restarted, or modified.
- Six installation leases: public/private Nanobot, public/private dufs, public
  injection fixture, and a public fixture backed by a short-lived signed URL.

Current [Daytona pricing](https://www.daytona.io/pricing), checked before creation:
$0.0504/vCPU-hour, $0.0162/GiB-hour, and $0.000108/GiB-hour storage after the first
5 GiB. This shape is about $0.083 for 30 minutes, below the approved $0.25 ceiling.
Creation through cleanup verification took 6.24 minutes: approximately $0.018 at
those rates, not a reconciled provider bill.

## Observations

### Injection and application access

| Check | Live result |
| --- | --- |
| Registration acknowledgements | Exact boolean acknowledgement on the five header-bearing leases; short-expiry fixture intentionally headerless |
| Nanobot wrapped `/webui/bootstrap`, absent or spoofed client assertion | HTTP 200; JSON; no bootstrap token or API token issued |
| Nanobot wrapped WS, absent or spoofed assertion | Upgrade succeeds; no initial `ready` within 2–8 seconds; empty-ID attach validation returns expected error |
| Dufs wrapped `proof.txt`, absent or wrong client Basic | HTTP 200; exact synthetic contents |
| Dufs direct, absent or wrong Basic | HTTP 401 |
| Dufs direct, correct synthetic Basic | HTTP 200; exact contents |
| Fixture HTTP and WS, absent or mixed-case spoofed assertion/Authorization | Exactly one configured value for each header, both exact comparisons true |
| Fixture HTTP and WS, client Connection nominates both injected headers | Both configured values still arrive exactly once |
| Foreign-origin public HTTP and WS | HTTP 403 / rejected handshake 403 |
| Private anonymous HTTP/WS, including attempted app-header spoof | HTTP 401 / rejected handshake 401 |
| Private anonymous browser-style navigation (Fetch Metadata) | HTTP 302 to gateway login |

The fixture compared header values internally and returned only booleans, counts,
and the immediate peer address. Nanobot itself checks only assertion presence and
nonemptiness, so its success is not the evidence for exact replacement.

### Provider topology and alternate routes

The fixture observed **127.0.0.1** for HTTP and WS over both direct Daytona and
wrapped BayLeaf routes. Independent `ss` inspection of established sockets at the
actual Nanobot listener also showed **127.0.0.1** for both routes. This is an
instance observation, not a provider-wide stable CIDR commitment. In this topology
the application trusts the provider's last local hop, which does not distinguish
a BayLeaf request from another holder of a provider preview capability.

| Nanobot route | No assertion | Attacker nonempty assertion |
| --- | --- | --- |
| First signed Daytona URL | HTTP and WS 401 | HTTP 200; WS upgrade and `ready` |
| Separately minted signed Daytona URL | HTTP and WS 401 | HTTP 200; WS upgrade and `ready` |
| Ordinary unsigned provider preview URL, no provider token | HTTP 401 | HTTP 401 |
| Ordinary provider preview URL with its preview token | Not separately tested | HTTP 200 bootstrap |

No external direct-IP route was tested. A header is not visitor identity, and a
loopback trusted-peer rule in this provider topology does not establish that the
BayLeaf owner gate was traversed. Public visitors deliberately exercise the fixed
injected credential without authenticating as the owner.

### Signed URL expiry and socket lifetime

A fixture URL was minted with `expiresInSeconds=60`, then wrapped in an ordinary
gateway registration. HTTP and WS worked directly and through the wrapper before
expiry. At 67–68 seconds after issuance:

- New direct HTTP requests: 401; new direct WS handshakes: 401.
- New wrapped HTTP requests: 401; new wrapped WS handshakes: 502, the gateway's
  existing sanitized upstream-handshake failure behavior.
- Already-established direct **and wrapped** sockets still exchanged a fresh
  synthetic request and response after expiry. Queued initial fixture frames were
  drained before this check.

The gateway's registration expiry and the upstream credential's handshake deadline
are distinct. This run does not establish a 24-hour soak or prompt shutdown of
existing sockets when only the provider signed credential expires.

Explicit gateway revocation of the ordinary fixture registration did close an
already-open wrapped socket; the retired URL independently returned 404.

### Successful-body containment

The checked Nanobot bootstrap JSON, Nanobot root HTML (7,498 bytes), dufs root HTML
(7,289 bytes), synthetic file contents, and checked WS frames contained none of the
tested upstream hostname/label/credential strings or synthetic Basic/password
secrets. The fixture never reflected raw request headers.

This is route-specific evidence. It does not qualify all Nanobot assets, project
operations, application-generated absolute URLs, or arbitrary successful bodies.
Successful bodies are not sanitized by the gateway.

## Cleanup and limitations

- All six tracked installation hostnames were revoked by installation DELETE;
  each independently returned HTTP 404.
- Only the uniquely labeled disposable sandbox was deleted. Its per-ID Daytona
  lookup independently returned HTTP 404.
- Independent D1 query: zero remaining tracked registrations. Cleanup and a second
  query established zero pending authentication flows for those exact hostnames.
- Application processes, synthetic files, and remote credentials disappeared with
  the sandbox. Local credential-bearing ledger and manifest were removed after
  verification; a credential-free cleanup receipt remains under `~/.tokens/`.
- No real owner-browser login or non-owner authenticated-browser test was performed.
  Fetch Metadata probes are HTTP-client tests, not real-browser authentication
  evidence. No cookies were forged.
- No Chat toolkit upgrade, model-mediated tool call, keyed expose, or managed
  plugin invocation was part of this run. No commits, pushes, or issue comments.

## Reproduction helpers

`scripts/qualify-preview-app-boundary.py` prints the plan by default. Its live mode
requires an operator-supplied Worker version and a mode-0600 manifest. It reports
status/boolean observations rather than treating all observations as passing.
`--serve-peer PORT` supplies the metadata-only fixture inside a disposable sandbox.

`scripts/preview-boundary-live-ops.py` contains the credential-silent create,
install, registration, and revocation/deletion helpers used here. Its state is
private and external to the repository. Nanobot configuration/startup, the bounded
expiry/held-socket experiment, ordinary provider-token probe, and independent D1
cleanup were explicit operator steps in this session, not automated by that helper.
The old `preview-apps.py cleanup()` must not be reused for installation leases:
its disposable-sandbox cleanup path attempts keyed owner-port revocation instead.

## Narrow initial-frame fix retest

2026-10-08, Worker `b814079b-4391-4fc0-95eb-10009c7b6b18`. ✨

The implementation session reported a race: accepting the upstream socket before
an awaited database check and listener installation could lose its first frames.
Its fix installs listeners before accepting and explicitly closes rejected pending
upstreams. That session reported a pre-fix reproducer and 35 passing post-fix
workerd tests. These implementation results were supplied in the handoff, not
independently rerun by this live qualification.

One fresh disposable sandbox ran actual `nanobot-ai==0.3.5` with the same bounded
trusted-peer configuration and a single public, header-bearing installation lease.
Each of **three fresh wrapped connections** received `ready` as its first frame,
before the client sent any application message. Connection-start-to-ready times
were **0.860, 0.457, and 0.645 seconds**. Each then received the expected
`error` / `invalid chat_id` response to an empty-ID attach request. The empty ID is
rejected before session mutation or an agent turn. No inference occurred.

**The initial-frame regression is now live-qualified as fixed for this Nanobot
path.** A direct control was unnecessary because all three wrapped attempts passed.
This narrow retest does not change the prior direct-bypass or provider-expiry
findings and does not establish full browser UI compatibility or owner login.
The broader topology/expiry suite was not repeated. The concurrent Chat rollout
and its fixtures were not touched.

Cleanup: the one lease was revoked and independently returned HTTP 404; the
uniquely labeled disposable sandbox was deleted and its per-ID lookup returned
HTTP 404. Independent D1 checks found zero tracked registrations and zero tracked
pending flows. The local credential-bearing ledger was removed; no manifest was
created. A metadata-only receipt remains at
`~/.tokens/bayleaf-issue86-ready-retest-cleanup.json`.

Creation through final cleanup verification took **1.26 minutes**, approximately
**$0.0035** at the pricing above, below the approved 30-minute/$0.25 ceiling.
This is a rate-based estimate, not a reconciled provider bill.

## Keyed-path qualification preflight: blocked

2026-10-08, targeting deployed Worker
`b814079b-4391-4fc0-95eb-10009c7b6b18`. ✨

A read-only `GET /sandbox` using the operator key from
`~/.tokens/bayleaf-api` returned `state: "none"` and no sandbox ID. Consequently,
there was no already-running owner sandbox available under that key for the
requested keyed `/sandbox/expose` test. Per the bounded authorization, no sandbox
was created or awakened, and no existing service was changed. No fixture, process,
file, or lease was created, so there are no cleanup obligations from this attempt.

Live keyed header acknowledgement, HTTP/WS injection and spoof replacement,
headerless replacement, and keyed revocation/socket closure remain **unqualified**
by this evidence. The successful installation-path tests above do not substitute
for them. Resume with an ordinary owner key whose existing sandbox is running, or
with explicit authorization for the required sandbox lifecycle action.

## Live keyed endpoint: passed; shared sandbox preserved

2026-10-08, Worker `b814079b-4391-4fc0-95eb-10009c7b6b18`. This supersedes the
keyed preflight blocker above. ✨

After explicit authorization to create a temporary keyed sandbox, another
successful `GET /sandbox` confirmed `state: "none"` and no ID. A normal keyed
`POST /sandbox/exec` created a 2-vCPU/4-GiB/8-GiB sandbox and an exclusive fixture
marker. The exact sandbox ID and creation timestamp were recorded before testing;
the timestamp confirmed it was newly created. No lookup error was treated as absence.

The first fixture port was outside the endpoint's 3000–9999 range and registration
correctly returned sanitized HTTP 400. Only that fixture was restarted on unused
port 8552, after confirming it had no existing keyed registration. The successful
checks used the real keyed `/sandbox/expose` endpoint, not installation registration:

- Public exposure with `X-Authenticated-Owner` and synthetic Basic Authorization
  returned exact boolean `upstream_headers_applied: true`.
- HTTP and WS both delivered each configured value exactly once, with no client
  header and with mixed-case attacker replacements. Comparisons happened inside
  the fixture; output contained only booleans/counts and the observed loopback peer.
- Re-exposing the same port without `upstream_headers` returned no header-applied
  acknowledgement, closed the old socket, and made the previous URL return 404.
  The replacement's HTTP and WS observations both showed zero assertion and
  Authorization headers: the old configuration was removed.
- Keyed DELETE closed an active replacement socket and its URL returned 404.
- A new private keyed exposure with headers returned exact true acknowledgement.
  Anonymous HTTP with attempted application-header spoof and anonymous WS both
  received 401. Browser-style navigation received 302 to gateway login. This was
  not a real owner-browser login and no cookies were fabricated.
- The private exposure was revoked. All three URLs independently returned 404.
  Independent D1 queries found zero tracked registrations and zero tracked auth
  flows after exact-hostname flow cleanup.

### Cleanup guard caught concurrent work

Before sandbox deletion, the guard compared the original user-file metadata,
listeners, and process inventory. It found newly created
`/home/daytona/workspace/headercheck.py`, a new listener on **8765**, and a new Lathe
command session/processes. These were not this fixture's work. The shared sandbox
was therefore **preserved**, as required by the concurrent-work safeguard.

Only this run's exact marked process and unique `/tmp/bayleaf-issue86-keyed-*`
directory were removed, after verifying the PID's command line, marker, and owned
directory entries. Independent checks confirmed process termination, directory
absence, and port 8552 free. The concurrent file, listener, and Lathe session were
not altered. Local synthetic credential state was removed; the metadata-only
handoff receipt is `~/.tokens/bayleaf-issue86-keyed-cleanup.json`.

Keyed qualification and this fixture's cleanup are complete. **Final coordination
decision: preserve the shared sandbox and concurrent work.** No whole-sandbox
teardown is claimed or required for this fixture's cleanup. The receipt retains
the exact sandbox ID. The subsequent Chat smoke also cleaned only its own fixtures
and leases; see `../chat/DESIGN.md`. Creation through this handoff took **4.54
minutes**, approximately **$0.0126** at the published rates; ongoing shared-sandbox
cost is not included. No inference was requested by these keyed tests.
