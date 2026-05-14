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
| **Cloudflare** (Workers for `api.bayleaf.dev` + `courses.bayleaf.dev`, D1, DNS, Registrar for `bayleaf.dev`) | `amsmith@ucsc.edu` | Personal (default account, renamed `bayleaf`) | Partial | Identity correct; needs a second member on the account. |
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

Account renamed to `bayleaf` (from the default `Adam Smith's Account`).
Resources: Workers `bayleaf-api` and the `courses` teaser, D1 `bayleaf-keys`
(`e249d6a6-41cf-4ab7-93d6-b677ac95b524`), zone `bayleaf.dev` (registrar +
DNS), custom domains `api.bayleaf.dev` and `courses.bayleaf.dev`.

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
`/docs/gws-client-secret.json` (API). The OAuth consent screen is set
to *Internal*, so any `@ucsc.edu` user can authorize without manual
allow-listing. No billable APIs are enabled.

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
