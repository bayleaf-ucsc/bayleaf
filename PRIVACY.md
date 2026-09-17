# Privacy

> [BayLeaf](https://bayleaf.dev): a situated counterplatform for Generative AI at UC Santa Cruz

This is a plain-spoken summary of what BayLeaf collects, where it goes, and how
long it lives. The canonical retention policies for each service are kept in the
public repository and linked below. Last updated: September 2026.

## What BayLeaf is, for privacy purposes

BayLeaf is a single-operator, faculty-operated service run by
[Adam Smith](mailto:amsmith@ucsc.edu) (Dept. of Computational Media) for the UC
Santa Cruz campus community. It is *not* a system of record. Anything users want
to keep should be copied into an appropriate destination (Google Drive, email,
Canvas, GitHub, etc.) before retention windows close.

Following a security review by the UC Santa Cruz Information Technology Services
(ITS) office, the campus Chief Information Security Officer (CISO) and his team
cleared BayLeaf, on technical security grounds, to handle data up to
[**Protection Level 3 (P3)**](https://its.ucsc.edu/get-support/it-guides/data-and-it-resource-classification/data-protection-levels/)
under UCSC's data classification policy. That is a *security* determination (how
BayLeaf protects data), which is separate from *legal* authorization to process
specific regulated records. Authorization to use BayLeaf with actual FERPA
student education records is a distinct process, still underway with the
Registrar, and is **not yet granted**. Until it is, do not paste real student
education records (grades joined to names, rosters, accommodation letters); use
de-identified or synthetic stand-ins instead. Never paste P4 data at all (e.g.
health information, payment card data, or personally identifiable information
classified at P4). The review attests to BayLeaf's security posture, not to
institutional adoption: BayLeaf remains a faculty-operated service, not an
ITS-operated or ITS-supported one.

## What gets collected

- **Identity (Chat and API):** CruzID, email, and display name from CILogon at
  sign-in. The email is used to identify your account, route you to the right
  groups, and (for the API) tag upstream requests for per-user rate limiting.
- **Conversations (Chat only):** messages, attachments, and chat metadata are
  stored in BayLeaf Chat's encrypted PostgreSQL database so you can return to
  past conversations. They are accessible only to you and the system
  administrator.
- **Sandbox files (Chat and API, opt-in):** if you use the Code Sandbox, files
  you create live inside a per-user Daytona VM. There is no persistent volume
  backing it: deleting the sandbox is final.
- **Protected previews (Chat and API, experimental and opt-in):** opening a protected
  sandbox URL sends application traffic through Cloudflare to Daytona. The
  gateway stores an encrypted temporary upstream access URL, owner/slot metadata,
  and short-lived login transactions, but does not store HTTP bodies. Owner-name
  reservations and installation identity mappings persist to prevent names being
  reassigned. Browser application state can survive preview expiry. See the
  [preview retention schedule](api/RETENTION.md#owner-authenticated-previews-bounded-poc). ✨
- **Prompt and completion traffic (API and Chat):** not stored by BayLeaf.
  Ordinary requests are streamed through OpenRouter to LLM providers operating
  under [zero-data-retention](https://openrouter.ai/docs/guides/features/zdr),
  which means they do not log or train on your prompts and completions, and
  retain only request metadata. Requests made through the API's optional Sealed
  route are encrypted by your client directly to a verified Tinfoil secure
  enclave; BayLeaf relays ciphertext and cannot read the prompt or completion.
  The [BayLeaf API](https://api.bayleaf.dev) goes further: it keeps no copy of
  this traffic and offers no operator interface to read your request content as
  it passes through (request-tracing is disabled), an approach inspired by
  [zero-operator-access](https://aws.amazon.com/blogs/machine-learning/exploring-the-zero-operator-access-design-of-mantle/)
  designs. Chat is the exception: to let you carry conversations between
  devices, it stores your message history (see below).
- **Web search and page fetch (Chat and API):** queries and URLs you ask
  BayLeaf to look up are forwarded to Tavily and not retained by BayLeaf.
  Tavily does not receive your identity.
- **Edge logs:** standard Cloudflare and DigitalOcean platform logs (IPs,
  status codes, timestamps) are kept by those vendors at their default
  retention (~72 hours for Cloudflare).

## How long things stick around

BayLeaf publishes its full retention schedules in the public source repo,
version-controlled alongside the code that enforces them:

- [Chat retention policy](chat/RETENTION.md): conversations are auto-deleted
  **90 days** after their last activity. Files attached to deleted
  conversations go with them. A daily cleanup job enforces this; logs contain
  only aggregate counts, never identifiers.
- [API retention policy](api/RETENTION.md): prompts and completions are **not
  stored**. Account records (D1) persist while your key is active. Persistent
  sandboxes auto-delete **90 days** after their last activity.

## Your controls

- **Delete on demand.** In Chat, *Settings → Data Controls* lets you delete
  individual conversations or all of them. In the API dashboard you can revoke
  your key and destroy your sandbox.
- **Export.** *Settings → Data Controls → Export Chats* in the Chat interface
  gives you a JSON dump of everything BayLeaf holds for you.
- **Records hold.** If you are subject to a litigation hold, audit, or CPRA
  request, your conversations are exempted from auto-deletion until the hold
  is lifted (see [Chat retention policy §3](chat/RETENTION.md#3-records-hold)).
- **Account closure.** Email [amsmith@ucsc.edu](mailto:amsmith@ucsc.edu) to
  request your account and all associated data be deleted.

## Subprocessors

These are the third-party services that handle data on behalf of BayLeaf.
BayLeaf selects them with privacy in mind: ordinary LLM providers operate under
zero-data-retention via OpenRouter, Sealed inference uses client-verified
confidential computing through Tinfoil, infrastructure vendors are bound by
their own data-protection terms, and authentication is handled by a non-profit
research-and-education identity broker.

- [OpenRouter](https://openrouter.ai/): LLM request routing. BayLeaf restricts
  upstream traffic to ZDR providers; see
  [provider data retention details](https://openrouter.ai/docs/guides/privacy/provider-logging#data-retention--logging).
  OpenRouter receives model, token-count, and timing metadata. For keyed API
  users it also receives the email in each request for rate limiting, but does
  not retain that field under ZDR.
- [Tinfoil](https://tinfoil.sh/): confidential LLM inference for the API's
  optional Sealed route. Prompt and completion bodies are encrypted directly to
  an attested secure enclave. When the client verifies that attestation, the
  route is designed to make the content inaccessible to BayLeaf, Tinfoil, and
  their infrastructure operators. Tinfoil receives operational metadata
  including the user's email, request timing, model, and token counts; see its
  [privacy policy](https://tinfoil.sh/privacy).
- [DigitalOcean](https://www.digitalocean.com/): hosts BayLeaf Chat (the Open
  WebUI application and its encrypted PostgreSQL database).
- [Cloudflare](https://www.cloudflare.com/): hosts BayLeaf API (the Worker and
  its D1 edge database), including the protected preview gateway on
  `bayleaf-proxies.dev`.
- [Daytona](https://www.daytona.io/): sandboxed Linux execution environments
  for the Code Sandbox feature (opt-in).
- [Tavily](https://tavily.com/): web search and page content extraction. No
  conversation data is stored by Tavily.
- [CILogon](https://www.cilogon.org/faq): research-and-education identity
  broker that mediates sign-in via your CruzID Google Account (OIDC). BayLeaf
  does not see your password.

## What BayLeaf does not do

- BayLeaf does not sell or share your data with third parties for advertising
  or marketing.
- BayLeaf does not train models on your conversations.
- BayLeaf does not retain LLM prompts or completions on its own infrastructure.
- BayLeaf does not use cookies for tracking. Session cookies expire in 24
  hours (API login and protected previews), or are managed by
  Open WebUI (Chat).

## Changes and questions

Material changes to this notice are announced via the BayLeaf source repository
and (for changes that meaningfully affect existing data) by email to affected
users. The full revision history of this notice and of the retention policies
is public in this repository ([commit history](https://github.com/bayleaf-ucsc/bayleaf/commits/main/PRIVACY.md)).

Questions about your data, this notice, or BayLeaf's privacy posture are best
routed through [SUPPORT.md](SUPPORT.md): file a public GitHub issue if it is a
general question, or email
[amsmith@ucsc.edu](mailto:amsmith@ucsc.edu) if it concerns your specific
account.
