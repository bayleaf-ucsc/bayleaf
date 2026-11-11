# Scoped tokens

Design for generalizing temporary inference tokens ([GRANTS.md](GRANTS.md), issue #76)
into tokens that reach bounded slices of the BayLeaf API. **Status: steps 1–2 and the
first slice of step 3 (usage, identity and web scopes, scope storage and consent)
deployed 2026-11-10; evidence in [GRANTS.md](GRANTS.md). Inbox and sandbox-file
scopes are next.**

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
  already do. Check this still holds whenever a family is added (inbox and
  sandbox-file scopes especially): a scope must never exceed the minting
  credential's own reach.

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

## Sandbox files

**Root.** Bound dirs are slugs (`[a-z0-9][a-z0-9-]{0,62}`), never paths. The root is
fixed and visible: `/home/daytona/bayleaf-apps/<slug>/`. Being visible lets visitors
browse, back up and delete what apps stored about them.

**Path check**, in the Worker, before any sandbox call. A request path is allowed
only if, for some bound slug:

- it starts with `/home/daytona/bayleaf-apps/<slug>/` (the trailing slash matters:
  `journal-old` must not match `journal`);
- after that prefix it has at least one segment, and no segment is empty, `.` or
  `..`;
- it contains no NUL, control characters or backslashes.

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
for v1; documented on the consent screen's help text, not mitigated with a realpath
check.

**Wake and create.** Token calls may wake a sleeping sandbox and may create one if
the grantor has none (today's `ensureSandbox` behavior). The consent screen says
"may create your BayLeaf Sandbox" when the grantor has none. Risk is bounded: a
leaked token can create at most one machine, the grantor's own. A breached app
backend holding many visitors' tokens could create one per visitor who consented to
that app. Token use counts as activity and postpones the 90-day reaper.

**Untrusted data.** Files an app writes are untrusted input for the owner's own
coding agents (a possible prompt-injection channel). The visible, clearly named
root makes their origin legible to people and agents.

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
holds `[]` for grants without inference scopes. `resources_json` (inboxes, sandbox
dirs) is left for the families that need it.

## Exposure decisions

Per the capability playbook (`bayleaf-powered-agent-capabilities.md`), recorded
for the usage/identity/web slice:

| Surface | Decision | Reason |
|---|---|---|
| Hosted OpenChamber | No dedicated tool | Sandbox agents mint app tokens with ordinary HTTP calls (`POST /grants`) using their sandbox credential; grant management still requires the owner's ordinary key to be current |
| BayLeaf Chat (including Lathe agents) | Not applicable | Chat agents hold no sandbox credential or personal key |
| Desktop skills | Expose | The `bayleaf-platform` skill mentions scoped app tokens and points to `llms.txt` |
| `llms.txt` / OpenAPI | Expose | Orientation in `llms.txt`; exact contract in the Grants workflow and schemas |

Consequential defaults: narrow default plus backfill (above). `identity.read`
email disclosure and `scopes_json` storage approved as designed.

## Naming

User-facing "temporary inference token" becomes **app token**. The
`sk-bayleaf-grant-` prefix and the "grant" protocol term are unchanged.

## Open questions

- Consent wording per scope and per binding (inbox display names, dir slugs).

## Order of work

1. Fix the `mkdir` interpolation in `uploadFile`, standalone. (Done.)
2. Declared route scopes and gate, behavior-identical: inference scopes only. (Done.)
3. Remaining families one at a time, each with tests: usage/identity/web (deployed
   2026-11-10, with scope storage and per-scope consent), inboxes, sandbox files.
