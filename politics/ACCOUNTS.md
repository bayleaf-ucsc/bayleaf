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
two members has bus factor 2 — enough to survive the handover.

---

## Current state

| Account | Login identity | Structure | Handover-ready? | Notes |
|---|---|---|---|---|
| **Cloudflare** (Workers for `api.bayleaf.dev` + `courses.bayleaf.dev`, D1, DNS, Registrar for `bayleaf.dev`) | `amsmith@ucsc.edu` | Personal (default account) | Partial | Identity correct; needs a Cloudflare *account* with a second member. |
| **OpenRouter** | `amsmith@ucsc.edu` | Personal | Partial | No native Org concept. Mitigations below. |
| **Daytona** | `amsmith@ucsc.edu` | Personal | Partial | Teams feature exists; not yet used. |
| **Google Cloud** (project `gws-cli-playground-ucsc`) | `amsmith@ucsc.edu` | GCP project | Mostly | Project is the unit of sharing; just needs a second IAM member at Owner. |
| **Tavily** | `amsmith@ucsc.edu` | Personal | Partial | Small-vendor dashboards often have no team tier; API-key rotation is the handover path. |
| **Jina** | `amsmith@ucsc.edu` | Personal | Partial | Same shape as Tavily. |
| **DeepInfra** | `amsmith@ucsc.edu` | Personal | Partial | Same. |
| **CILogon** | Institutional registration via UCSC | Client registration | Ready | Already institutionally scoped; admin contact is `amsmith@ucsc.edu`. |
| **GitHub** (`rndmcnlly/bayleaf`) | Personal account | Personal user namespace | **No** | Repo lives under a personal user, not an Org. Pages site `bayleaf.dev` is served from here. |
| **DigitalOcean** (App `7d0addd4-…`, Postgres `bayleaf-chat-db`, Spaces `bayleaf-chat-space`) | Personal | Personal team | **No** | DO has a Team tier; current state is a single-person team under a personal identity. |

"Ready" means *nothing more to do*. "Partial" means the identity is correct
but the structure is single-seat. "No" means both need to change.

---

## Migration plan

### 1. GitHub → `bayleaf-ucsc` Organization (or similar name)

Why: GitHub has no mechanism to share a *personal* account. The only unit that
can accept a second owner is an Organization. Transfers are non-destructive:
old URLs 301-redirect to the new namespace, clones keep working, Pages custom
domains survive.

Scope: **only the `bayleaf` repo**. The three BayLeaf-adjacent tools live in
this project but are not BayLeaf-specific:

- `rndmcnlly/lathe` — general-purpose OWUI code-sandbox toolkit. Any OWUI
  operator could use it.
- `rndmcnlly/owui-cli` — general-purpose OWUI admin CLI. Any OWUI operator
  could use it.
- `rndmcnlly/gws-toolkit` — general-purpose OWUI Google Workspace toolkit.
  Any OWUI operator could use it.

These are *upstream dependencies* of BayLeaf, not parts of BayLeaf, and
belong in the same category as Open WebUI itself: third-party open source
that BayLeaf consumes. Folding them into a `bayleaf-ucsc` Org would falsely
narrow their scope and would saddle a BayLeaf successor with governance of
tooling that isn't theirs. They stay under `rndmcnlly` (or move to their
own homes at Adam's discretion, independent of BayLeaf's governance).

This mirrors the upstream/downstream split that
[DEPENDENCIES.md](DEPENDENCIES.md) already draws for other layers of the
stack: OpenRouter is a dependency, not a BayLeaf asset.

Steps:

1. Create GitHub Org tied to `amsmith@ucsc.edu`. Pick a name that can outlive
   Adam's ownership: `bayleaf-ucsc`, `bayleaf-dev`, or similar.
2. Transfer `rndmcnlly/bayleaf` → `<org>/bayleaf`. Verify Pages keeps serving
   `bayleaf.dev` afterward (the `docs/CNAME` file does the work; the custom
   domain verification needs re-running at the org level).
3. Re-add any GitHub Actions secrets at the org level.
4. Update local clones: `git remote set-url origin …`.
5. Leave the three tool repos alone. Their `github.com/rndmcnlly/…` URLs in
   live system prompts, tool source, and docs stay correct.

### 2. DigitalOcean → Team with a second owner

Why: DO's Team is the shareable unit. Apps, databases, and Spaces all belong
to a team. Moving resources between teams is supported but is not atomic, so
the lower-friction path is to convert the existing personal team into a
shared team by adding a second owner and renaming.

Steps:

1. Rename the current team (Settings → Team → name) to something like
   `BayLeaf / UCSC`.
2. Invite a second owner when the moment comes. In the meantime, this is a
   structural no-op but makes the billing/ownership story read clearly.
3. Document the critical resource IDs (already done in `chat/DESIGN.md §1`)
   so that if the team must be reconstructed from scratch, the recovery
   procedure in §6 there is sufficient.

Resources: App `7d0addd4-85db-4fe3-b931-501ae88d7f7f`, PG
`bayleaf-chat-db`, Spaces `bayleaf-chat-space`. All would follow the team.

### 3. Cloudflare → named account with a second member

Why: A Cloudflare *account* (the entity that holds the Worker, the D1
database, and the `bayleaf.dev` zone) can have multiple members with
role-based access. The domain registrar portion is also scoped to the
account, so transferring the account transfers the domain.

Steps:

1. Verify the current account name is descriptive (Dashboard → Manage
   Account → Configurations). Rename to `bayleaf` if it currently reads
   `Adam Smith's Account` or similar.
2. Add a second member at the Administrator role when the moment comes.
3. Keep the Worker, D1, and zone where they are; no resource migration
   needed.

Resources: Workers `bayleaf-api` and the `courses` teaser, D1 `bayleaf-keys`
(`e249d6a6-41cf-4ab7-93d6-b677ac95b524`), zone `bayleaf.dev` (registrar +
DNS), custom domains `api.bayleaf.dev` and `courses.bayleaf.dev`.

### 4. Google Cloud → add a second Project Owner

Why: The project `gws-cli-playground-ucsc` is already the correct unit. GCP
projects are shared via IAM role grants.

Steps:

1. Add a second principal at the `roles/owner` level in IAM.
2. Ensure billing is attached to a billing account that is also shared (GCP
   billing accounts are separate from projects and separately owned).

Resources: OAuth client used by the `gws_toolkit` (Chat) and the
`gws-cli-playground-ucsc` credentials served at
`/docs/gws-client-secret.json` (API).

### 5. OpenRouter, Daytona, Tavily, Jina, DeepInfra → key rotation is the handover

These vendors either don't offer a Team tier, or offer one that's not worth
the current overhead for a solo operator. The handover path is the same for
all of them:

1. Credentials are held as secrets in the runtime account (Cloudflare secret
   for the Worker, DO App Platform encrypted env var for Chat, OWUI admin
   panel "valves" for per-toolkit keys).
2. On handover, the successor logs into each vendor dashboard (with the
   shared `amsmith@ucsc.edu` identity), rotates the keys, and updates the
   secrets in the runtime accounts. No resource migration.
3. If any vendor adds a Team tier later, migrate then.

This path works because these vendors hold no durable state that matters.
The spend history is a billing artifact; the keys are just credentials. The
state that matters lives in the DO Postgres (user accounts, conversations)
and the Cloudflare D1 (key mappings) — both of which are covered by the
structural migrations above.

---

## Post-migration credential graph

After the migrations above, every piece of BayLeaf's runtime state is held
in an account that:

1. Is rooted in `amsmith@ucsc.edu` (so recovery goes through UCSC IT, not a
   personal Gmail),
2. Has at least one other UCSC-tied owner (so bus factor ≥ 2), and
3. Uses the vendor's Team / Org / Project tier where available (so that
   adding or removing a member is a dashboard operation, not a credential
   reset).

This is what "UCSC could adopt this tomorrow" concretely means. The
architecture claim in [DEPENDENCIES.md](DEPENDENCIES.md) needs this
operational backing to be real. Without it, the system is architecturally
open and operationally captive — a worse position than an honest vendor
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
