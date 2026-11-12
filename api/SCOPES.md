# Scoped tokens

Design for generalizing temporary inference tokens ([GRANTS.md](GRANTS.md), issue #76)
into tokens that reach bounded slices of the BayLeaf API. **Status: steps 1–2 and the
first slice of step 3 (usage, identity and web scopes, scope storage and consent)
deployed 2026-11-10; evidence in [GRANTS.md](GRANTS.md). Inbox scopes deployed
2026-11-10 too (migration `0021`). Sandbox-file scopes deployed
2026-11-11 (migration `0022`). Rooms scopes deployed 2026-11-11 with the Rooms
facade (issue #159; API version `70e0ea4b`, migration `0023`).**

## Why

Two uses motivate this:

1. **Community apps on visitors' own BayLeaf resources.** One community member
   publishes an app; others authorize it, through the existing consent and S256 PKCE
   handoff, to draw on their own allowance, inboxes or sandbox storage. Nobody hands
   over an ordinary key.
2. **CI secrets.** A GitHub Actions secret should hold a token that can do one job
   for up to 30 days, not an ordinary key that never expires and can do everything.

Each scope below is here because a realistic application needs it. Coverage of the
whole API is not a goal.

## Shape

Scopes are dotted verbs. Resources are bound separately, never encoded in the scope
string (model slugs already contain `:`, `/` and `.`):

```json
{
  "scopes": ["inference.chat", "inboxes.messages.read", "sandbox.files.write"],
  "models": ["openrouter:…"],
  "inboxes": ["<inbox id>"],
  "sandbox_dirs": ["journal"],
  "expires_in": 2592000
}
```

- No scope implies another. `inboxes.messages.manage` does not imply `.read`.
- Unknown scope names get `400 invalid_scope`. An empty or non-string `scopes`
  array is `400 invalid_request` at `POST /grants` (schema validation runs first)
  and `400 invalid_scope` at `GET /grants/authorize` (JSON query value).
- A scope family that needs a resource type requires a non-empty binding of it:
  `inference.*` needs `models`, `inboxes.*` needs `inboxes`, `sandbox.files.*`
  needs `sandbox_dirs`. A binding with no scope that uses it is rejected, not ignored.
- Every binding is checked at issuance, consent, exchange and request time, as
  `models` is today.
- **Defaults (owner decision):** a request that omits `scopes` gets
  `inference.chat` only; Responses and decisions must be requested explicitly.
  Existing grants keep today's authority by backfill (see Storage), not by a NULL
  default: NULL `scopes_json` fails closed. Visitor apps that relied on implicit
  decisions or Responses authority get `insufficient_scope` on new tokens until
  they request those scopes.
- **Minting is attenuation.** A credential may mint only authority it already
  holds. Today every scope is something an ordinary key or sandbox credential can
  already do, including the inbox scopes (both credentials already read and
  archive their owner's inboxes) and the sandbox-file scopes (both already read and
  write any file in their owner's sandbox). Check this still holds whenever a family
  is added: a scope must never exceed the minting credential's own reach.

## Scopes

| Scope | Binding | Routes | Motivating application |
|---|---|---|---|
| `inference.chat` | models | `POST /v1/chat/completions` | Course CI review bot; visitor-funded chat apps (exists today) |
| `inference.responses` | models | `POST /v1/responses` | Same, Responses-shaped clients (OpenRouter only) |
| `inference.decisions` | models | `POST /v1/decisions` | Classification/triage apps (exists today) |
| `web.search` | none | `POST /web/search` | A student's research-assistant page usable off campus |
| `web.fetch` | none | `POST /web/fetch` | GitHub Action checking a course site for link rot |
| `usage.read` | none | `GET /usage` | App or Action checks remaining allowance and fails fast before a long batch |
| `identity.read` | none | `GET /whoami` | "Sign in with BayLeaf" for community apps: a more convenient opt-in "give me your email" field |
| `inboxes.messages.read` | inbox IDs | `GET /inboxes/{id}`, `…/events`, `…/events/stream`, `…/messages`, `…/messages/{mid}` and its `text`, `body`, `attachments/{index}`, `har`, `…/export` | A peer's form-responses dashboard over your webhook inbox; a nightly Action pulling submissions into a repo |
| `inboxes.messages.manage` | inbox IDs | `PATCH /inboxes/{id}/messages/{mid}` (archive/unarchive) | The same Action archives what it processed: an at-least-once pipeline with no state of its own |
| `sandbox.files.read` | sandbox dirs | `GET /sandbox/files/*` under each bound dir | An app persisting a visitor's data in that visitor's own sandbox |
| `sandbox.files.write` | sandbox dirs | `PUT /sandbox/files/*` under each bound dir | Same |
| `rooms.read` | none (all the grantor's rooms) | `GET /rooms/limits`, `/rooms`, `/rooms/{id}`, `/rooms/{id}/export` | A nightly Action archiving a class board's export into a repo |
| `rooms.manage` | none (all the grantor's rooms) | `POST /rooms`, `PATCH`/`DELETE /rooms/{id}`, `/rooms/{id}/credentials` (issue, list, revoke) | A CI job or script that sets up each week's room and participant links |

Web search and fetch run on BayLeaf's shared Tavily account, as they do for keys and
Campus Pass: there is no per-user web budget to spend or exhaust. The scope extends
shared operator spend to whoever holds the token, so a leaked `web.*` token gives
off-campus web access until it expires or is revoked.

### Never or not yet

- `sandbox.exec`: deferred. Execution is total authority over the machine and
  whatever credentials it holds.
- `directory.*`: excluded. It would turn the grantor's daily cap into someone else's
  people-lookup tool, and rosters are FERPA-adjacent.
- Inbox creation, destruction, lifetime changes, message deletion and sender
  credentials: excluded. They involve quota, irreversible destruction, or
  capabilities (sender tokens) that already have their own scheme.
- Minting or attenuating grants from a grant: excluded for v1. Revocation stays
  one hop.
- Key management, previews, computer use, Desktop, diagnostics: excluded.
- `sealed.inference`: deferred. BayLeaf cannot read the encrypted model field, so
  this scope could not be bound to `models`; consent would have to say "any Sealed
  model".

## Identity

`identity.read` returns the grantor's email and credential kind `grant`. The consent
screen names the app and states that it will learn the visitor's BayLeaf email.
Without this scope, `/whoami` keeps refusing grants, so an app cannot learn who funds
it unless the visitor agreed to that.

Political note: this scope makes BayLeaf a lightweight campus identity provider for
community apps, a role the university's IAM normally holds. App authors learn who
uses their apps; visitors decide that per app.

## Inboxes

**Binding.** `inboxes` is 1–16 handles (`ibx_…`) of the grantor's own active
inboxes. Ownership is checked against the inbox Worker at issuance, consent and
exchange; anything else is `403 inbox_not_allowed`. `inboxes` without an
`inboxes.*` scope, or an `inboxes.*` scope without `inboxes`, is
`400 invalid_request`. At request time the facade admits a token only on an `{id}`
it is bound to (`403 insufficient_scope` otherwise). The inbox Worker is unchanged:
it still sees only the grantor's `account_generation`. `GET /grants/inboxes` lists
bindable inboxes for direct issuance.

**Visitors choose at consent.** An app cannot know a visitor's inbox handles, so
visitor authorization requests only the scope: an `inboxes` query parameter is
rejected, and the consent page lists the visitor's active inboxes as checkboxes
(approval is disabled when there are none). The exchanged token reports the chosen
`inboxes`. This differs from `models`, which an app can name because the catalog is
public. Requesting an inbox scope while Inboxes is unavailable is
`403 inbox_not_allowed` before consent.

**What approval means.** Inbox content is stored (not ZDR) and sender-controlled. An
approved app can read everything a bound inbox has stored or will receive until
expiry or revocation; the consent page says so. Tokens are revalidated on every
inbox call, including each stream reauthorization, so a live event stream ends with
`auth_revoked` once the token is revoked or expires. App tokens can never list,
create, change or destroy inboxes, delete messages, or manage sender credentials.

## Sandbox files

**Status: deployed 2026-11-11** (Worker `ee81bde1-12cf-4344-b4c3-541bbea6a500`, migration `0022` applied). The
owner's stated goal is a semi-working implementation, revised as real-world uses
appear, not a finished design: expect practice to settle the open questions below.

**Scopes.** `sandbox.files.read` admits `GET /sandbox/files/*` and
`sandbox.files.write` admits `PUT /sandbox/files/*`, each only inside the token's
bound folders. Neither implies the other. There is no listing route (apps keep their
own index file) and no exec, status, poke (keep-alive) or delete.

**Root.** `sandbox_dirs` is 1–16 folder names (`^[a-z0-9][a-z0-9-]{0,62}$`, duplicates
collapsed), never paths. The root is fixed and visible: each name grants
`/home/daytona/bayleaf-apps/<name>/` and everything below it. Being visible lets
visitors browse, back up and delete what apps stored about them. `sandbox_dirs`
without a `sandbox.files.*` scope, or the reverse, is `400 invalid_request`.

**Apps name the folders.** Unlike inbox handles, folder names are the app's own
namespace, not something the visitor already owns, so the grammar is the only check
at issuance, consent and exchange. Direct issuance names `sandbox_dirs` in
`POST /grants`; visitor authorization names them in the `/grants/authorize` query as
a JSON array. The consent page shows each exact path, notes that another app using
the same name would share the folder, discloses that the app can read any file there
whoever wrote it (read) or create and overwrite files (write), and says that using the
token wakes the visitor's sandbox and creates one if none exists. The exchanged token
and `GET /grants` report `sandbox_dirs`.

**Path check** (`insideSandboxDirs` in `src/grants.ts`), in route middleware before
any sandbox call. It is lexical, on the path as Hono has already percent-decoded it
(so `%2E%2E` arrives as `..` and is refused). A request path is allowed only if, for
some bound name:

- it starts with `/home/daytona/bayleaf-apps/<slug>/` (the trailing slash matters:
  `journal-old` must not match `journal`);
- after that prefix it has at least one segment, and no segment is empty, `.` or
  `..`;
- it contains no NUL, control characters, backslashes or single quotes (quotes
  match what `uploadFile` can pass safely).

Anything else is `403 insufficient_scope`. Ordinary keys and sandbox credentials
skip the check.

The bare directory `…/journal/` is rejected by the empty-segment rule: it is not a
file. No listing route is added; apps keep their own index file.

**Prerequisite fix (step 1, deployed 2026-11-10).** `uploadFile` in `daytona.ts`
created parent directories by sending `mkdir -p ${parent}` unquoted to Toolbox
`/process/execute`. That endpoint splits argv shell-style but runs no shell, so this
was argument injection, not command execution: a path with spaces became several
`mkdir` arguments, creating directories outside a bound root (and, for owners, the
wrong directories for any path with a space). The parent is now one single-quoted
argument after `--`; paths containing a single quote or control characters get 400
before the sandbox is resolved. `npm run test:sandbox-upload` covers it. The
assumption that Toolbox honors single quotes was confirmed in production: an upload
to `…/my dir/$(id)/a.txt` created exactly that one directory, with no strays.

**Symlinks.** Uploads cannot create symlinks, so escaping the root needs one that
the owner (or the owner's agent) already placed inside it. Accepted residual risk
for v1, not mitigated with a realpath check. The consent page does not currently
mention it.

**Wake and create.** Token calls may wake a sleeping sandbox and may create one if
the grantor has none (today's `ensureSandbox` behavior). The consent page says so
for every sandbox-file request, whether or not the visitor already has a sandbox.
Risk is bounded: a
leaked token can create at most one machine, the grantor's own. A breached app
backend holding many visitors' tokens could create one per visitor who consented to
that app. Token use counts as activity and postpones the 90-day reaper.

**Untrusted data.** Files an app writes are untrusted input for the owner's own
coding agents (a possible prompt-injection channel). The visible, clearly named
root makes their origin legible to people and agents.

## Rooms

**Unbound, unlike inboxes (decision, 2026-11-11).** `rooms.*` scopes bind no
resource: a token reaches every room the grantor has or later creates. Reasons:

- Creation and listing are account-wide by nature, and `rooms.manage` exists for
  the workflow that creates rooms. A room-id binding would make those two
  operations impossible to grant, or require a second, unbound scope anyway.
- Rooms are short-lived (at most 90 days), so a bound id list would go stale
  between issuance and use more often than an inbox list.
- Per-room delegation already has a better mechanism: the `rk_` capability link,
  with its own presence/append/manage scopes, expiry and revocation. To let someone
  into one room, issue a room link, not an app token.

Consequences the consent page states: `rooms.read` exports everything participants
stored in every room; `rooms.manage` can delete rooms and mint participant links,
including writing ones. Every participant link can read and export its room, so
`rooms.manage` effectively grants read of every room too; only `rooms.read` grants
read without the power to change or share. Minting remains attenuation:
ordinary keys and sandbox credentials already hold both. Requesting a `rooms.*`
scope while Rooms is unavailable is `400 invalid_scope` at issuance, consent and
exchange. No migration: there is no binding column. The facade resolves the
grantor's `account_generation` exactly as for an ordinary key.

## Enforcement

`guardGrant` (`src/grants.ts`) used to hardcode three inference paths. Now
(step 2, deployed 2026-11-10, behavior-identical):

- A route admits app tokens by listing `requireScope('<scope>')` in its
  `createRoute` middleware (or `.use` for plain handlers). The middleware is a no-op
  at request time; it carries a tag.
- The global gate reads Hono's `matchedRoutes(c)` before any handler runs and
  admits a grant only if exactly one declared scope matched and the grant holds it.
  No declaration, or conflicting declarations, fails closed. Matching is the
  router's own (method plus registered pattern), so the gate never re-parses URLs.
- Sub-apps with their own `onError` are mounted with wrapped handlers; the gate
  unwraps `COMPOSED_HANDLER` to find the tag (`decisions.ts` is one).
- Resource checks (model membership in the body, inbox `{id}` param, sandbox path)
  belong to each family's route middleware, where Hono has already parsed params.
  The inference families keep `enforceGrantModel` in their handlers, after body
  validation.
- Grants still never resolve to an unrestricted owner identity: handlers receive the
  grant and its owner, as `inferenceGrant`/`grantOwner` do today.
- Not yet: surfacing declared scopes in the OpenAPI spec and having
  `npm run test:docs` require a declaration (or explicit `never`) on every route.
  `test:grants` covers denial on 18 representative routes, and removing a
  declaration was confirmed to fail that harness.

## Storage

Migration `0020` adds `scopes_json` to `inference_grants` and
`grant_transactions` and backfills existing rows with the three inference scopes.
Unlike `0016`, it preserves rows. NULL fails closed, so roll out as: apply `0020`,
deploy the Worker, then re-run the two backfill UPDATEs once (idempotent) to cover
rows the old Worker inserted in between. `models_json` stays the model authority and
holds `[]` for grants without inference scopes.

Migration `0021` adds nullable `inboxes_json` to both tables: NULL without an inbox
scope, and on transactions NULL until the visitor approves. NULL or malformed binds
nothing, which fails closed. It is an explicit column per resource type, like
`models_json`, not the generic `resources_json` once proposed here. Roll out as:
apply `0021`, then deploy (the old Worker ignores the column; the new one needs it).

Migration `0022` (applied 2026-11-11) adds nullable `sandbox_dirs_json` to both tables
on the same pattern: NULL without a sandbox-file scope, and NULL or malformed binds
nothing. Unlike `inboxes_json`, transactions hold it from initiation, because the app
names the folders. Roll out the same way: apply `0022`, then deploy.

## Exposure decisions

Per the capability playbook (`bayleaf-powered-agent-capabilities.md`), recorded
for the usage/identity/web slice:

| Surface | Decision | Reason |
|---|---|---|
| Hosted OpenChamber | No dedicated tool | Sandbox agents mint app tokens with ordinary HTTP calls (`POST /grants`) using their sandbox credential; grant management still requires the owner's ordinary key to be current |
| BayLeaf Chat (including Lathe agents) | Not applicable | Chat agents hold no sandbox credential or personal key |
| Desktop skills | Expose | The `bayleaf-platform` skill mentions scoped app tokens and points to `llms.txt` |
| `llms.txt` / OpenAPI | Expose | Orientation in `llms.txt`; exact contract in the Grants workflow and schemas |

For the inbox slice: no hosted tool (sandbox agents already
hold a credential that reads their own inboxes); the `bayleaf-inboxes` desktop skill
and `llms.txt` mention bounded app tokens for apps, scripts and CI jobs.

For the sandbox-file slice (deployed 2026-11-11): no hosted tool (sandbox agents
already read and write their own files and can mint with `POST /grants`); the
`bayleaf-platform` desktop skill names the scope family; `llms.txt` describes folder
binding, app-named folders and the wake/create effect, and the OpenAPI file routes
note app-token access.

For the rooms slice (deployed 2026-11-11): no hosted tool and no MCP tools (rooms are
skills-only by decision; sandbox agents call `/rooms` with `curl`); the hosted and
desktop `bayleaf-rooms` skills and `llms.txt` mention room scopes for scripts and CI
jobs, and steer per-room sharing to capability links.

Consequential defaults: narrow default plus backfill (above). `identity.read`
email disclosure and `scopes_json` storage approved as designed.

## Naming

User-facing "temporary inference token" becomes **app token**. The
`sk-bayleaf-grant-` prefix and the "grant" protocol term are unchanged.

## Open questions

- Consent wording per scope and per binding. Inbox choices show each inbox's label
  (or handle) and address or URL; sandbox folders show exact paths.

Sandbox files, to be settled by real uses rather than in advance:

- **Shared folder names across apps.** Two apps asking for `journal` share one
  folder and can read or clobber each other's files. The consent page says so; a
  per-app prefix or registry would prevent it but adds the app identity BayLeaf has
  avoided.
- **Visitor confirmation or renaming.** The visitor currently accepts the app's
  names as-is. Should consent let them rename a folder (and the token report the
  chosen name), or require explicit confirmation when a folder already exists?
- **Listing.** No listing route: apps keep their own index file. A bound
  `sandbox.files.list` may be needed if real apps keep losing track of files.
- **Symlink realpath check.** Accepted residual risk today; a realpath check would
  cost a Toolbox call per request.
- **Size limits.** The upload route sets no body limit of its own (Cloudflare's
  request ceiling applies) and there is no per-token or per-folder quota, so a
  leaked write token can fill the grantor's disk until expiry or revocation.
- **Consent mentions of symlinks.** The page does not mention the symlink caveat.

## Order of work

1. Fix the `mkdir` interpolation in `uploadFile`, standalone. (Done.)
2. Declared route scopes and gate, behavior-identical: inference scopes only. (Done.)
3. Remaining families one at a time, each with tests: usage/identity/web (deployed
   2026-11-10, with scope storage and per-scope consent), inboxes (deployed
   2026-11-10, with consent-time inbox selection), sandbox files (deployed
   2026-11-11 with app-named folders, Worker `ee81bde1-12cf-4344-b4c3-541bbea6a500`, `0022` applied).
