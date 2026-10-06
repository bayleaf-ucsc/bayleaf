# Account Audit

Dual power requires a handover path. If UCSC IT decides to adopt BayLeaf
formally (or if Adam steps away), the running system must be transferable
without resorting to credential exports or personal-account recovery flows.
That means every account holding production state should either (a) already
be tied to `amsmith@ucsc.edu`, or (b) be structured (Team, Org, Project) such
that a UCSC IT staff member can be added as owner and Adam's personal
credential removed, without downtime.

This document inventories the accounts that back BayLeaf's running services
and records which ones meet the criterion, which need migration, and how.

Companion to [DEPENDENCIES.md](DEPENDENCIES.md), which audits the *software*
dependencies. This file audits the *account* dependencies: the credential graph
underneath the software graph.

---

## Criterion

An account is "handover-ready" if **both** of these are true:

1. The primary login identity is `amsmith@ucsc.edu` (or an InCommon-federated
   equivalent), so that UCSC controls the root of recovery, not Google or a
   personal mailbox.
2. The account is organized such that a second human can be added as an owner
   without re-provisioning resources. For most providers this means using the
   Team / Organization / Project tier, not the Individual tier.

The second criterion is what the literature on
[bus factor](https://en.wikipedia.org/wiki/Bus_factor) is about. A personal
account on a UCSC email still has bus factor 1. A UCSC-email-owned Team with
two members has bus factor 2: enough to survive the handover.

---

## Current state

| Account | Login identity | Structure | Handover-ready? | Notes |
|---|---|---|---|---|
| **Cloudflare** (Workers for `api.bayleaf.dev`, D1, DNS, Registrar for `bayleaf.dev`) | `amsmith@ucsc.edu` | Named account `BayLeaf` | Partial | Adam is the sole member by choice for now. No UCSC ITS collaborators have been added; a second administrator remains a future handover step. |
| **OpenRouter** | `amsmith@ucsc.edu` | Personal | Partial | No native Org concept. Mitigations below. |
| **Daytona** | `amsmith@ucsc.edu` | Personal | Partial | Teams feature exists; not yet used. |
| **Google Cloud** (projects `bayleafchat` and `gws-cli-playground-ucsc`) | `amsmith@ucsc.edu` | GCP projects | Mostly | The project is the unit of sharing; each just needs a second IAM member at Owner. `bayleafchat` hosts Vertex AI inference (see §4); `gws-cli-playground-ucsc` hosts the OAuth client used by the `gws_toolkit`. |
| **Tavily** | `amsmith@ucsc.edu` | Personal | Partial | Small-vendor dashboards often have no team tier; API-key rotation is the handover path. |
| **DeepInfra** | `amsmith@ucsc.edu` | Personal | Partial | Same. |
| **CILogon** | Institutional registration via UCSC | Client registration | Ready | Already institutionally scoped; admin contact is `amsmith@ucsc.edu`. |
| **GitHub** (`bayleaf-ucsc/bayleaf`) | `rndmcnlly` (verified for `amsmith@ucsc.edu`) is org owner | GitHub Organization | Partial | Org exists and is verified to `ucsc.edu`; awaits a second Owner when a UCSC IT counterpart steps in. |
| **DigitalOcean** (App `f1a1e758-…`, Postgres `bayleaf-chat-db` cluster `ea8c7549-…`, Spaces `bayleaf-ucsc-storage`) | `adam@adamsmith.as` (account), `amsmith@ucsc.edu` invited as second owner on the team | Team `BayLeaf / UCSC` (slug `bayleaf-ucsc`) | Partial | Dedicated BayLeaf team cleanly separates service from personal hosting; root account is still `adam@adamsmith.as` (see §2 for why that's a documented compromise). |

"Ready" means *nothing more to do*. "Partial" means the identity is correct
but the structure is single-seat. "No" means both need to change.

---

## Migration plan

### 1. GitHub → `bayleaf-ucsc` Organization *(done 2026-04-28)*

GitHub has no mechanism to share a personal account. The only unit that can
accept a second owner is an Organization. Transfers are non-destructive: old
URLs 301-redirect to the new namespace, clones keep working, Pages custom
domains survive.

Scope: **only the `bayleaf` repo**. The three BayLeaf-adjacent tools
(`rndmcnlly/lathe`, `rndmcnlly/owui-cli`, `rndmcnlly/gws-toolkit`) are
general-purpose OWUI tooling. They're upstream dependencies of BayLeaf, not
parts of BayLeaf, and belong in the same category as Open WebUI itself:
third-party open source that BayLeaf consumes. Folding them into a
`bayleaf-ucsc` Org would falsely narrow their scope. This mirrors the
upstream/downstream split that [DEPENDENCIES.md](DEPENDENCIES.md) draws for
other layers of the stack.

Done: org `bayleaf-ucsc` created (Free tier, billing `amsmith@ucsc.edu`,
owner `rndmcnlly`); `rndmcnlly/bayleaf` transferred to `bayleaf-ucsc/bayleaf`;
all tracked source updated; `ucsc.edu` domain verified. Pending: add a second
Owner when a UCSC IT counterpart exists.

### 2. DigitalOcean → dedicated team `BayLeaf / UCSC` *(done 2026-04-29)*

**DO's constraint.** Apps, managed databases, and Spaces buckets cannot be
transferred between DO teams. DO documents this explicitly
([PG import docs](https://docs.digitalocean.com/products/databases/postgresql/how-to/import-databases)).
Droplet snapshots are the only cross-team-transferable resource. So
"move BayLeaf out of the personal team" is not a configuration change; it's
a rebuild.

**What we did.** Created a new `BayLeaf / UCSC` team (slug `bayleaf-ucsc`)
under the existing `adam@adamsmith.as` DO account, with `amsmith@ucsc.edu`
invited as second owner. Provisioned fresh Postgres, Spaces, and App Platform
app in the new team. `pg_dump`/`pg_restore` migrated the database;
`rclone sync` copied Spaces contents. Custom domain `chat.bayleaf.dev`
detached from the old app and attached to the new one; DO's edge re-routed
the hostname without any Cloudflare DNS changes. OAuth and all data verified
end-to-end.

Opportunistic hardening during the rebuild: Spaces access key is now scoped
(Read/Write/Delete on the one bucket), and S3 credentials in the app spec
are now `type: SECRET` rather than plaintext.

**Handover ceiling on DO.** The root of the account tree is still
`adam@adamsmith.as`. A full identity-root migration would require a
cross-*account* rebuild (another full data migration). We chose not to do
it. The `BayLeaf / UCSC` team is owned by both identities, so a UCSC
successor can be promoted to team owner (and Adam demoted) without a
rebuild. The `adam@adamsmith.as` account continues to exist as a DO customer
record but holds no BayLeaf resources after team-ownership transfer.

**Old resources.** The pre-migration app, Postgres cluster, Spaces bucket,
and associated access keys still exist in the `Just Adam` team as a
rollback option. Destruction is tracked in
[issue #34](https://github.com/bayleaf-ucsc/bayleaf/issues/34) (earliest
2026-05-06).

Live resource IDs are in [chat/DESIGN.md §1](../chat/DESIGN.md), which is
the source of truth for recovery procedures.

### 3. Cloudflare → named account with a second member

A Cloudflare account holds the Workers, D1 database, and `bayleaf.dev` zone
(including registrar). Multiple members can be added with role-based access,
so no resource migration is needed; just a second Administrator when a UCSC
IT counterpart exists.

The existing account is named `BayLeaf` (from the default `Adam Smith's
Account`), ID `1a49fb69291d42e23c4ed4dcffce5bbc`. It will remain the home
of BayLeaf, including Brace and Bracken, so its production resources do not
need to move. The sharing boundary is potential UCSC ITS stewardship, not
whether a resource has "BayLeaf" in its name.

**Production account separation, 2026-10-04.** Two additional accounts were
created under the UCSC identity:

- `Democlips`, ID `e727caaa72d3165beaebe896f2e7cb83`: the research project's
  domain, gallery Worker and D1 database, scripts Pages project, and Stream
  video library. This is a separate collaborator boundary from BayLeaf.
- `Adam's Misc University Stuff`, ID `53f07be82ff2cb49a463d7ce32c26817`:
  `designreasoning.org` and `peerpressure.dev`.

**BayLeaf stays in place; misc DNS and Democlips production have moved.**
BayLeaf's production services need no migration or deployment changes.
Both misc zones are active in their destination account following nameserver
changes at Squarespace to `itzel.ns.cloudflare.com` and
`sean.ns.cloudflare.com`. Their source-zone entries in BayLeaf are marked
`moved` and remain as migration residue, not active service dependencies.
The existing DNS records and editable settings were copied and verified.
`designreasoning.org` is an inactive historical site, not a service requiring
restoration. The peerpressure apex and `www` retain their existing upstream
redirect to `http://play.peerpressure.dev`. At Adam's request, the missing
`play` DNS record was added as a DNS-only CNAME to `rndmcnlly.github.io`.
GitHub Pages already configures that hostname for `rndmcnlly/peerpressure`,
with HTTPS enforced. The authoritative CNAME and an HTTPS 200 response from
GitHub's edge using the custom hostname were verified. The site demonstrates
Phaser games on GitHub Pages and PeerJS use within those games.

Democlips' registration and active DNS zone now belong to its own account.
The gallery Worker uses its destination D1 database and Stream library, and
`scripts.democlips.dev` serves the destination Pages project
(`democlips-scripts-58f.pages.dev`). Both scripts assets match the local source.
All 230 ready Stream videos were copied and playback-verified. The imported
database preserved 159 users, 230 video records, and 10 stars, with 227 redirects
keeping old shared clip URLs usable. Three existing gallery records reference
errored source videos; they were preserved, not counted as transfer failures.
A real Google sign-in and authenticated gallery checks passed after cutover.
Existing sessions need a fresh sign-in because the session signing key changed.

A new $5/month Stream Starter Bundle is active with approval. The gallery's
account-owned token is limited to Stream Read/Write in Democlips; access against
BayLeaf was rejected. The Democlips collaborator accepted Administrator access.
BayLeaf has only Adam's membership, with no ITS collaborators for now.
The former Democlips collaborator's BayLeaf membership was removed, and the old
all-account Democlips Stream token was revoked and verified to reject access.

**Approved source retirement, 2026-10-04.** Original Democlips D1 and Pages
resources were deleted from BayLeaf. The old $5/month Stream subscription is
canceled at period end (2026-10-11), with no renewal; the destination plan
remains active. All 238 source Stream assets were deleted against the saved
inventory; the destination's 230 migrated ready videos remain intact.

**Final Democlips retirement, 2026-10-06.** After more than 48 hours from
October 4 at 21:47 UTC, the source `democlips-gallery` forwarding Worker and
its moved `democlips.dev` zone were deleted only from BayLeaf. The destination
Worker was deployed with `workers_dev:false` and `preview_urls:false`; the
former destination `workers.dev` endpoint returns HTTP 404. Destination
registration and active-zone ownership, parent DNS delegation to
`elijah.ns.cloudflare.com` and `gina.ns.cloudflare.com`, and the deployed D1
binding were verified. Post-deploy HTTPS checks passed for the gallery,
OAuth redirect/callback configuration, signed-session access, old clip redirects,
login enforcement, and hidden-clip visibility. These cleanup checks used
short-lived signed operator test sessions, not another complete Google sign-in.
Both scripts-site assets still match their source. Destination D1 counts remain
159 users, 230 videos, 10 stars, and 227 redirects; all 230 destination Stream
videos are ready. The source subscription still has `cancel_at_period_end:true`
and ends October 11 at 00:00 UTC; no subscription or membership was changed.
BayLeaf Workers, BayLeaf/Brace/Bracken zones, and moved misc-zone residue remain
in place. ✨

Private SQL exports and the video-ID mapping remain outside the repositories.
The migration does not authorize sharing BayLeaf with Democlips collaborators. A second
BayLeaf administrator for ITS handover remains a separate future step.

Confirmed BayLeaf production resources include Workers `bayleaf-api` and
`bayleaf-probe`, D1 `bayleaf-keys`
(`e249d6a6-41cf-4ab7-93d6-b677ac95b524`), KV `CAMPUS_RPD` and
`MODEL_STATUS`, and Durable Objects `PreviewConnections` and
`SandboxBrowser`. The `bayleaf.dev` and `bayleaf-proxies.dev` zones are live
dependencies. Keep `bayleaf.chat`, `brace.tools`, and `bracken.chat` in this
account as well. `bayleaf-courses` and `CLAIM_CODES` remain in place pending
a separate assessment of legacy state. ✨

### 4. Google Cloud → add a second Project Owner on each project

BayLeaf uses two GCP projects, each scoped to a distinct concern. GCP
projects are shared via IAM role grants; a second principal at
`roles/owner` on each project is all that's required when a UCSC IT
counterpart exists. Billing is separately scoped from projects and will
need the same treatment at its billing-account level.

**Project `bayleafchat`** (project number `47286725529`, created
2025-03-31). Hosts the Vertex AI inference path: a service account
`bayleaf-chat-vertex@bayleafchat.iam.gserviceaccount.com` with
`roles/aiplatform.user` is used by the `vertex_pipe` function in
[chat/functions/vertex_pipe/](../chat/functions/vertex_pipe/) to call
Gemini models on the OpenAI-compatible Vertex endpoint. Billing is
attached. This is the project whose contract chain is described in
[FERPA.md §5.2](FERPA.md#52-inference-layer-proposed-direct-google-cloud);
moving institutional Vertex traffic to a UCSC-ITS-managed GCP project
is a separate, future conversation.

**Project `gws-cli-playground-ucsc`** (project number `412068790611`).
Hosts the OAuth client used by the `gws_toolkit` (Chat) and exposes the
`gws-cli-playground-ucsc` credentials served at
`/docs/gws-oauth-client.json` (API). The OAuth consent screen is set
to *Internal*, so any `@ucsc.edu` user can authorize without manual
allow-listing. The project grants `domain:ucsc.edu` the
project-local `gwsQuotaConsumer` role, containing only
`serviceusage.services.use`, so campus users can consume its API quota. Each
user's OAuth token remains the authority for their own Workspace data, and the
quota permission grants no product-specific access to other project resources.

### 5. OpenRouter, Daytona, Tavily, DeepInfra → key rotation is the handover

These vendors either don't offer a Team tier or offer one that isn't worth
the current overhead for a solo operator. Credentials are held as secrets
in the runtime accounts (Cloudflare Worker secrets, DO App Platform
encrypted env vars, OWUI admin "valves"). On handover, the successor logs
into each vendor dashboard with the shared `amsmith@ucsc.edu` identity,
rotates the keys, and updates the runtime secrets. No resource migration.
If any vendor adds a meaningful Team tier later, migrate then.

This path works because these vendors hold no durable state that matters.
The spend history is a billing artifact; the keys are credentials. The
state that matters lives in the DO Postgres (user accounts, conversations)
and the Cloudflare D1 (key mappings), both covered by the structural
migrations above.

---

## Post-migration credential graph

After the migrations above, every piece of BayLeaf's runtime state is held
in an account that:

1. Is rooted in `amsmith@ucsc.edu` (so recovery goes through UCSC IT, not a
   personal Gmail), **with one exception: DigitalOcean, whose root account
   is `adam@adamsmith.as` with `amsmith@ucsc.edu` as second owner on the
   service-scoped team**. See §2 for why a full identity-root migration was
   declined.
2. Has at least one other UCSC-tied owner reachable (so bus factor ≥ 2, or
   becomes ≥ 2 as soon as a UCSC IT counterpart accepts an invitation), and
3. Uses the vendor's Team / Org / Project tier where available, so that
   adding or removing a member is a dashboard operation, not a credential
   reset.

This is what "UCSC could adopt this tomorrow" concretely means. The
architecture claim in [DEPENDENCIES.md](DEPENDENCIES.md) needs this
operational backing to be real. Without it, the system is architecturally
open and operationally captive: a worse position than an honest vendor
contract, because it looks transferable but isn't.

---

## What this is *not*

- Not a commitment to hand the project over. Dual power means the option
  exists, not that it will be exercised.
- Not a security model. Credentials on shared accounts still need
  per-member MFA, audit logs, and rotation discipline. Those live in
  [SECURITY.md](SECURITY.md).
- Not vendor-neutral. A handover-ready DigitalOcean account is still on
  DigitalOcean. Substituting the underlying vendor is what DEPENDENCIES.md
  tracks; making the current vendor's account transferable is what this
  document tracks.
