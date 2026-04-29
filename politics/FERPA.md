# FERPA and BayLeaf

<!-- SEC:HEADER -->
**Service:** BayLeaf AI Playground  
**Operator:** Adam Smith, Associate Professor, Dept. of Computational Media, UC Santa Cruz  
**Status:** Working analysis. Not legal advice. Not reviewed by UCSC Office of
Campus Counsel. The BayLeaf operator is a faculty member of the UCSC AI
Council. This document is an individual faculty analysis, not a Council
position.

<!-- SEC:INTRO -->
This document describes how BayLeaf's architecture relates to FERPA (the
Family Educational Rights and Privacy Act, 20 U.S.C. § 1232g), and what
it would take to bring BayLeaf into the set of campus-approved tools for
FERPA-protected content. It is written for the audience that asks "is
BayLeaf FERPA-compliant?" and deserves a more precise answer than yes or no.

The short version: FERPA compliance for a service like BayLeaf is
primarily a question of **institutional designation**, not technical
architecture. An educational agency or institution may disclose PII from
education records without consent to a "school official with a legitimate
educational interest" (34 CFR § 99.31(a)(1)), and outside parties performing
outsourced institutional services may qualify as school officials under
the three conjunctive conditions in § 99.31(a)(1)(i)(B). Whether UCSC has
made that designation for a given service, and whether the vendor's
subprocessor chain is governed by the redisclosure limits in § 99.33, is
what determines FERPA posture. The technical architecture is in service
of making the designation defensible.

Today BayLeaf has no such designation. It routes LLM inference through
OpenRouter using zero-data-retention (ZDR) provider endpoints, which is a
strong commercial protection but not an institutional FERPA posture. UCSC
has designated Google as a school official for Workspace services (via
long-standing UC–Google agreements) and has approved Workspace-Gemini and
NotebookLM for use with FERPA-protected data at Protection Level 3, per
the [UCSC AI Council's published guidance](https://campusai.ucsc.edu/faq/).
BayLeaf is not on that list.

Two things would change that:

1. **A written designation of BayLeaf** ([§§ 4](#4-the-designation-question),
   [7](#7-the-approval-pathway), [8](#8-a-draft-designation-memo) of this document)
   as performing institutional services under § 99.31(a)(1)(i)(B), with
   the subprocessor chain governed by § 99.33(b) redisclosure terms. This
   is the lever. It does not require UCSC to separately vet every
   subprocessor; it requires UCSC to designate BayLeaf and hold BayLeaf
   accountable for the chain beneath it.
2. **Architectural choices that make the designation defensible** ([§ 5](#5-the-contract-stack-beneath-bayleaf)).
   A direct Google Cloud integration under UCSC's existing Customer
   Affiliate Agreement would put BayLeaf's Gemini traffic under the same
   UC-signed contracts that cover Workspace-Gemini. Other providers
   (Anthropic, OpenAI, Meta) remain on the OpenRouter-ZDR path, which is
   the best contractual protection available for those models without
   separate UC-signed agreements.

This document focuses on the FERPA frame. The platform layer (DigitalOcean,
Cloudflare, Open WebUI's conversation storage) sits under the same
designation umbrella but is treated in detail in [SECURITY.md](SECURITY.md).
Where platform facts are FERPA-relevant they are summarized here with
pointers.

---

## 1. What FERPA requires

<!-- SEC:FERPA_BASICS -->

### 1.1 The basic prohibition

FERPA protects the privacy of student "education records" held by
institutions that receive federal funding. An education record is any
record directly related to a student and maintained by the institution or
a party acting for the institution.

The statute prohibits institutions from disclosing personally identifiable
information (PII) from education records without the student's written
consent (34 CFR § 99.30), except under the enumerated exceptions in
§ 99.31(a). The exceptions are OR-ed: a disclosure is permitted if it
fits **any one** of the listed conditions.

For AI services, the operative exception is § 99.31(a)(1), the
"school official with a legitimate educational interest" exception.

### 1.2 The school-official exception

The exception has two branches, one for people inside the institution and
one for outside parties performing outsourced functions.

**§ 99.31(a)(1)(i)(A) — internal school officials.** Disclosure is
permitted to "other school officials, including teachers, within the
agency or institution whom the agency or institution has determined to
have legitimate educational interests." This is the branch that covers,
e.g., a faculty member consulting with a colleague about a shared
advisee. No contract is needed; the relationship is internal.

**§ 99.31(a)(1)(i)(B) — outside parties as school officials.** A
contractor, consultant, volunteer, or other party to whom the institution
has outsourced institutional services or functions may be considered a
school official, provided all three of the following conditions are met
(the conditions are conjunctive, joined by "and" in the regulation):

1. The outside party performs an institutional service or function for
   which the agency or institution would otherwise use employees;
2. The outside party is under the **direct control** of the agency or
   institution with respect to the use and maintenance of education
   records; and
3. The outside party is subject to the requirements of § 99.33(a)
   governing the use and redisclosure of PII from education records.

All three must hold. "Direct control" does not mean the institution
operates the vendor's infrastructure; ED guidance (see *Letter to
Wachter* and subsequent FPCO interpretations) treats it as satisfied by
contract terms that bind use to the institutional purpose, prohibit
unauthorized redisclosure, require adequate data security, grant audit
rights, and require return or destruction at contract end.

**§ 99.7 — annual notification.** A separate obligation, sometimes
conflated with the designation itself, requires institutions to specify
in their annual FERPA notice the criteria for who constitutes a school
official and what constitutes a legitimate educational interest. This
is what gives the designation its public, advance-notice character.
UCSC's
[Public Disclosures page](https://registrar.ucsc.edu/calendars-resources/ferpa-privacy/public-disclosures/)
(the "UCSC Administrative Procedures Applying to Disclosure of
Information from Student Records") is the standing document that
discharges this obligation, implementing the Universitywide
[Policies Applying to Disclosure of Information from Student Records](http://www.ucop.edu/ucophome/coordrev/ucpolicies/aos/documents/sec-130.pdf).
Section V defines "legitimate educational interest" as "a campus
official, acting in the student's educational interest, who needs the
information in the course of performing advisory, instructional,
supervisory, or administrative duties for the University." Section
IX.C establishes the operational mechanism: "No campus official or
employee shall have access to records before signing a written form
indicating the legitimate educational interest of the campus official
or employee." This form is the in-practice UCSC artifact that
discharges the (a)(1)(i)(A) side of the designation question for
campus officials and employees.

**§ 99.31(a)(1)(ii) — reasonable methods.** Institutions must use
reasonable methods to ensure school officials access only those
education records in which they have legitimate educational interests.
For outsourced parties this typically translates into scope-of-access
limits in the contract and technical access controls on the institution's
side.

### 1.3 Redisclosure and the subprocessor chain

A designated school official cannot unilaterally extend its designation
downstream. § 99.33(a) states the general prohibition:

> "An educational agency or institution may disclose personally
> identifiable information from an education record only on the
> condition that the party to whom the information is disclosed will
> not disclose the information to any other party without the prior
> consent of the parent or eligible student."

This is the rule that would, read alone, block any vendor from using its
own subprocessors to fulfill the institutional function. Real vendors do
use subprocessors (cloud infrastructure, managed databases, model
providers), so a second provision supplies the necessary mechanism.

§ 99.33(b) — the **"on behalf of" redisclosure exception**:

> "Paragraph (a) of this section does not prevent an educational agency
> or institution from disclosing personally identifiable information
> with the understanding that the party receiving the information may
> make further disclosures of the information on behalf of the
> educational agency or institution if — (1) The disclosures meet the
> requirements of § 99.31; and (2) [either the institution records the
> redisclosure, or the receiving party records it and the institution
> makes it available]."

This is the provision that lets a designated vendor's subprocessor chain
function. The subprocessor disclosures must themselves fit a § 99.31
exception — in practice, each downstream party must itself meet the
(a)(1)(i)(B) criteria *with respect to the vendor's contract with it* —
and the chain must be documented.

This matters for BayLeaf in a specific way. When UCSC designates a
vendor, UCSC is not separately vetting DigitalOcean, Cloudflare, or
Anthropic. UCSC is designating **the vendor as the school official** and
relying on § 99.33(b) plus the vendor's own subcontracts to govern the
chain beneath. This is the same structure that lets Instructure run
Canvas on AWS without UCSC having a separate FERPA agreement with
Amazon. The institution reviews the vendor; the vendor manages the
chain.

### 1.4 What FERPA does not require

FERPA does not require any specific technical architecture, any specific
certification, or any specific data-residency outcome. What it requires
is a contractual framework in which the institution has designated the
school official and the school official has accepted the associated
obligations.

Several concerns commonly get folded into "FERPA compliance" that are
distinct:

- **Data retention.** FERPA does not ban vendor retention of education
  records; it regulates disclosure and redisclosure. Zero-data-retention
  is a *stronger* commitment than FERPA alone would require, for the
  subset of data that enters inference.
- **Training on user data.** FERPA does not specifically regulate
  whether education records can be used to train AI models; it regulates
  whether PII can be disclosed for purposes outside the institution's
  educational interest. Contractual no-training clauses address a real
  concern, but they are not themselves FERPA requirements. They are
  relevant to FERPA because training-on-user-data would ordinarily
  constitute a use beyond the institutional purpose, which would
  violate the § 99.33(a) redisclosure limits.
- **Hosting location.** FERPA does not require U.S.-only hosting. It
  requires appropriate contractual protections regardless of where the
  data physically sits.
- **Specific certifications.** There is no FERPA certification regime.
  SOC 2, ISO 27001, FedRAMP, and similar attestations are evidence that
  a vendor *can* meet the security obligations a FERPA-compliant
  contract would impose, but none of them *is* FERPA compliance.

FERPA is a contract question before it is a technical question.

---

## 2. The "laptop is a cloud" problem

<!-- SEC:LAPTOP_IS_A_CLOUD -->
Here is the intuition pump that motivates the rest of this document.

Suppose a colleague borrows your laptop to finish an advising note about
a shared student. They type a draft, paste in the student's name and ID,
think for a minute, then save and hand the laptop back. No FERPA
question arises. The colleague is a school official under
§ 99.31(a)(1)(i)(A); you are a school official under (a)(1)(i)(A); the
disclosure is teacher-to-teacher inside the institution. Clean.

Now suppose the colleague instead opens BayLeaf Chat on your laptop and
pastes the same content into a prompt, asking for a suggested rewording.
What changed?

Structurally, the colleague-to-you part is unchanged. But the moment the
prompt leaves your laptop it enters a pipeline:

```
BayLeaf Chat (DigitalOcean) → OpenRouter → Anthropic (ZDR)
```

That pipeline is a series of disclosures to subprocessors. § 99.31(a)(1)(i)(A)
covers the disclosure **to you**. It does not cover the disclosures from
the BayLeaf service to DigitalOcean, to OpenRouter, to Anthropic. Each
of those hops needs its own FERPA basis.

There are two ways to provide one:

- Each subprocessor is separately covered by some § 99.31 exception —
  most plausibly by § 99.31(a)(1)(i)(B) conditions satisfied in the
  vendor's contract with UCSC. This is the "transparent chain" reading
  where UCSC would need to look through BayLeaf to every subprocessor.
- BayLeaf itself is designated as the school official, and the chain
  beneath it is governed by § 99.33(b) redisclosure terms propagated
  through BayLeaf's own contracts with its subprocessors. This is the
  "opaque unit" reading.

The second reading is how vendor designation actually works in practice.
UCSC does not separately vet AWS when it designates Instructure for
Canvas. UCSC designates Instructure; Instructure manages the chain. The
institution reviews the vendor; the vendor is accountable for the
subprocessors.

BayLeaf currently has *neither* reading operative. There is no UCSC
designation of BayLeaf, and UCSC has not separately approved
BayLeaf's subprocessor chain. The service runs on faculty authority,
under Adam's individual institutional role, with commercial ZDR
protections that are real but not institutional. This is the gap the
rest of the document addresses.

The key reframing: the question is not "has UCSC approved OpenRouter and
DigitalOcean?" The question is "has UCSC designated BayLeaf as a school
official, and does BayLeaf's posture justify that designation?"

---

## 3. BayLeaf's architecture and data flows

<!-- SEC:BAYLEAF_ARCHITECTURE -->
BayLeaf is a faculty-operated AI service at UCSC. It runs two user-facing
surfaces:

- **BayLeaf Chat** (`chat.bayleaf.dev`): an Open WebUI deployment on
  DigitalOcean, offering curated model access to the UCSC campus
  community.
- **BayLeaf API** (`api.bayleaf.dev`): a Cloudflare Worker that
  provisions OpenRouter-compatible API keys for campus users, with
  routing restricted to ZDR provider endpoints.

The subprocessor chain beneath BayLeaf has two layers:

**Platform layer.** The services that host BayLeaf itself, hold its
state, and terminate user connections:

- **DigitalOcean** (App Platform): runs the Open WebUI container.
- **Cloudflare** (Workers, KV, DNS, TLS): runs the API service and
  fronts the Chat domain.
- **Open WebUI's managed database** (on DigitalOcean): conversation
  histories, user accounts, group memberships.

Platform-layer data handling (what is stored where, for how long, who
has access) is analyzed in detail in [SECURITY.md](SECURITY.md). For the
FERPA frame, the relevant facts are: conversation histories persist
server-side until administratively deleted; DigitalOcean and Cloudflare
both publish DPAs covering their handling of customer data; neither has
a UC-signed FERPA-specific agreement with UCSC for the BayLeaf deployment.

**Inference layer.** Where prompts are processed by a model:

- **OpenRouter** (default): commercial intermediary routing to provider
  endpoints with ZDR flag enabled.
- **NRP / SDSC** ([National Research Platform](https://nrp.ai/)):
  configured alternative, serving open-weight models on NSF-funded
  research infrastructure at UC San Diego.

For the purpose of FERPA analysis, the question is: when a user sends a
prompt to BayLeaf, where does that prompt go, and under what contract is
it processed?

There is **no direct UCSC-to-Google LLM connection** in the current
architecture. When a user selects "Gemini 2.5 Pro" in BayLeaf Chat, the
request goes to OpenRouter, which forwards it to Google's Vertex AI
endpoint under OpenRouter's commercial agreement with Google, not under
any UCSC agreement.

This is the fact that most shapes the designation question in [§ 4](#4-the-designation-question) and
the contract-stack discussion in [§ 5](#5-the-contract-stack-beneath-bayleaf).

---

## 4. The designation question

<!-- SEC:DESIGNATION_QUESTION -->

### 4.1 What designation would mean for BayLeaf

A UCSC designation of BayLeaf as a school official under § 99.31(a)(1)(i)(B)
would have three parts, following the structure of the regulation:

1. A written statement that UCSC has determined BayLeaf to be performing
   an institutional service or function for which the institution would
   otherwise use employees.
2. A written framework placing BayLeaf under the direct control of UCSC
   with respect to the use and maintenance of education records: use
   limited to the institutional purpose, scope of access defined,
   security controls required, audit rights reserved, return or
   destruction at termination specified.
3. A binding acceptance by BayLeaf of the § 99.33(a) redisclosure
   limits, and an undertaking that any subprocessors used by BayLeaf
   will be bound by equivalent limits via BayLeaf's contracts with
   them, consistent with § 99.33(b).

Designation runs to *BayLeaf the service*, not separately to each
subprocessor. This is the "opaque unit" reading from [§ 2](#2-the-laptop-is-a-cloud-problem): UCSC reviews
BayLeaf's posture, determines whether the contracts, technical controls,
and operator discipline are adequate, and designates on that basis.
BayLeaf then carries the obligation to manage the chain beneath it.

This is meaningfully different from the question the prior version of
this document framed, which was "does UCSC have a signed agreement with
each model provider?" That question has "no" as its answer for every
provider reached via OpenRouter and "yes, for Workspace services only"
for Google. The designation question has a different answer: UCSC
*could* designate BayLeaf today, on the strength of the existing
commercial contracts plus a designation memo; the quality of the
designation depends on the contracts beneath.

### 4.2 The three (a)(1)(i)(B) conditions, applied to BayLeaf

**Condition 1: a service the institution would otherwise staff.**
BayLeaf offers AI assistance to faculty, staff, and students for
drafting, analysis, coding, and generic Q&A. The same function is
provided institutionally by UCSC ITS's approved AI tools (Workspace
Gemini, NotebookLM, Zoom AI) for the subset of users covered by those
tools. BayLeaf extends that capability to the API and to non-Google
models. If UCSC were not making AI tools available at all, one could
imagine ITS providing something like BayLeaf directly. The condition is
satisfiable, though the argument is stronger if framed as "extending an
institutional service to models and interfaces not currently covered"
rather than as "duplicating an institutional service."

**Condition 2: direct control.** Under ED guidance, direct control is
established by contract terms that bind use to the institutional
purpose, prohibit unauthorized redisclosure, require adequate security,
grant audit rights, and require return or destruction of records at
termination. For BayLeaf, direct control needs to be established at
each layer:

- *BayLeaf to UCSC.* A designation memo (see [§ 8](#8-a-draft-designation-memo)) establishes the
  operator's commitment to operate BayLeaf on UCSC's behalf under these
  terms.
- *BayLeaf to subprocessors.* BayLeaf's existing subprocessor contracts
  (DigitalOcean, Cloudflare, OpenRouter, provider ZDR terms) must
  propagate these limits. In practice this means: the DPAs must bind
  the subprocessor to use data only for the purpose of providing the
  service, forbid redisclosure and training, require appropriate
  security, and permit termination with data deletion. This is a
  reviewable artifact; [§ 5](#5-the-contract-stack-beneath-bayleaf) summarizes the state of each.

**Condition 3: § 99.33(a) redisclosure limits.** This is the condition
that runs through the chain. BayLeaf, as designated school official,
accepts that it cannot redisclose PII from education records to any
party without either a § 99.31 basis or parent/student consent. When
BayLeaf invokes § 99.33(b) to use a subprocessor, the subprocessor must
itself be constrained by the equivalent limits. The chain is only as
strong as its weakest contractual link.

The condition is satisfiable under the current commercial contracts for
most of the chain (DigitalOcean and Cloudflare's DPAs, OpenRouter's ZDR
terms, provider ZDR flags) but the coverage is not uniform and is not
UC-negotiated. A direct Google Cloud integration would upgrade a large
slice of the inference layer to UC-signed terms ([§ 5.2](#52-inference-layer-proposed-direct-google-cloud)).

### 4.3 Why faculty-operated complicates the vendor frame

BayLeaf is not a vendor. It is a service operated by a UCSC faculty
member using personal contractual relationships with commercial
providers, made available to the campus community at no cost. This
creates a structural mismatch with the (a)(1)(i)(B) frame, which is
written for "a contractor, consultant, volunteer, or other party to
whom an agency or institution has outsourced institutional services."
UCSC has not outsourced to BayLeaf; Adam has built BayLeaf and offered
it to the campus.

Three observations follow:

**Adam is already a school official under (a)(1)(i)(A).** As a UCSC
faculty member acting in institutional capacity, Adam has access to
education records in the normal course of work and is covered by the
internal-school-official branch of the exception. UCSC's administrative
procedure at §IX.C of the
[Public Disclosures page](https://registrar.ucsc.edu/calendars-resources/ferpa-privacy/public-disclosures/)
makes this concrete: a campus official or employee demonstrating
legitimate educational interest signs a written form specifying the
interest, which is the operational record of the (a)(1)(i)(A)
designation. BayLeaf is an instrument Adam operates in that
institutional role. This is analogous to a faculty member developing a
Python tool in their own time to support their teaching: the tool
isn't a vendor relationship, it is an exercise of the faculty member's
existing institutional role.

**The "other party" language in (a)(1)(i)(B) is broad enough to cover
BayLeaf.** The regulation names "contractor, consultant, volunteer, or
other party," and "volunteer" is the closest descriptor for a faculty
member operating an institutional service without compensation. ED has
not published guidance specifically addressing faculty-operated
services, but the regulatory text does not require a paid vendor
relationship. What it requires is that the outside party be performing
an institutional service under the institution's direct control, with
redisclosure limits. Those conditions are substantively meetable here.

**The cleanest framing may be under § 99.33(b) rather than (a)(1)(i)(B).**
If Adam's access to education records in his institutional capacity is
already covered by (a)(1)(i)(A), then the question for BayLeaf is not
"is BayLeaf a school official?" but "does BayLeaf's use of subprocessors
constitute authorized redisclosure on behalf of UCSC under § 99.33(b)?"
The substantive conditions are similar (subprocessors must fit some
§ 99.31 exception, chain must be documented) but the framing matches
the reality: Adam isn't an outside vendor UCSC contracts with; Adam is
a school official using a subprocessor chain to do institutional work.

The designation memo in [§ 8](#8-a-draft-designation-memo) is drafted to work under either framing. It
designates BayLeaf under (a)(1)(i)(B) explicitly, because that is the
path with the clearest regulatory footing and the one UCSC's existing
processes are built to review; it also recites the § 99.33(b) structure
so that the redisclosure logic is documented either way.

### 4.4 What designation does not require

Several things a reasonable reviewer might expect to be prerequisites
for designation are in fact not required by FERPA:

- **Transparent vetting of every subprocessor by UCSC.** As argued
  above, the institution designates the vendor; the vendor manages the
  subprocessor chain under § 99.33(b). UCSC does not need to review
  DigitalOcean's DPA line-by-line; it needs BayLeaf to have done so,
  and to have committed contractually to only using subprocessors whose
  terms are compatible with the designation.
- **A specific technical architecture.** FERPA does not mandate on-prem
  hosting, U.S.-only data residency, particular encryption schemes, or
  specific authentication methods. These may be required by UC IS-3 or
  other institutional policies, but they are not FERPA requirements.
- **Certifications.** SOC 2, ISO 27001, FedRAMP, and similar are
  evidence of security maturity. They are not substitutes for a FERPA
  designation and they are not required to obtain one.
- **Paid vendor status.** As noted in [§ 4.3](#43-why-faculty-operated-complicates-the-vendor-frame), the regulation's "other
  party" language is broad enough to cover non-vendor arrangements.
- **Exclusivity.** BayLeaf's designation for the AI-tool function does
  not conflict with UCSC's existing designations of Workspace-Gemini or
  NotebookLM, or of other vendors for other functions. Multiple school
  officials can be designated for overlapping or complementary
  functions.

What designation does require is articulated in [§ 4.1](#41-what-designation-would-mean-for-bayleaf): a written
determination of institutional service, a framework of direct control,
and acceptance of the redisclosure limits. The designation memo in [§ 8](#8-a-draft-designation-memo)
provides all three in concrete form.

---

## 5. The contract stack beneath BayLeaf

<!-- SEC:CONTRACT_STACK -->
Designation is the lever; the contract stack beneath BayLeaf determines
how strong the lever is. This section walks the inference layer in
detail and references the platform layer briefly.

**Platform layer.** DigitalOcean and Cloudflare both publish standard
Data Processing Addenda that bind them to use customer data only to
provide the contracted service, prohibit unauthorized redisclosure, and
require appropriate security. Neither is a UC-signed, FERPA-specific
agreement; both are commercial DPAs that are substantively compatible
with § 99.33(b) redisclosure terms. See [SECURITY.md](SECURITY.md) for
retention, access, and breach-notification details. For the rest of
this section, the platform layer is taken as background.

The inference layer is where the substantive FERPA variation lives.

### 5.1 Inference layer today: OpenRouter-ZDR

For any BayLeaf model call today (Gemini, Claude, GPT, Llama, etc.),
the contract chain is:

```
User at UCSC
   │
   ▼
BayLeaf Chat (DigitalOcean) or BayLeaf API (Cloudflare)
   │   [operational terms: BayLeaf's own service commitments]
   ▼
OpenRouter
   │   [contract: OpenRouter ZDR commercial terms]
   │   [BayLeaf restricts to ZDR-flagged provider endpoints]
   ▼
Model provider (Anthropic, Google Vertex, OpenAI, Meta, etc.)
       [contract: OpenRouter ↔ provider, commercial terms]
       [UCSC is not a party to this contract]
```

The ZDR commitment on this path is real and enforceable: OpenRouter
routes only to provider endpoints that have contractually agreed to
discard prompts and completions after generating a response. No
training, no retention, no secondary use. This is a meaningful
protection and is substantively compatible with § 99.33(b) redisclosure
terms.

What this path does *not* provide:

- A **UC-signed** agreement with the model provider.
- UC's **Protection Level 4** data-handling commitments (UCSC's
  internal classification tier for FERPA-protected data).
- The **$20M data-breach enhanced liability cap** that UC has
  negotiated directly with Google.
- **UC-negotiated audit rights** against the model provider.

These are the protections that UCSC's existing institutional agreements
provide for Google Workspace (and, through the same agreement stack,
for Google Cloud Platform). BayLeaf does not currently route through
them.

### 5.2 Inference layer proposed: direct Google Cloud

UCSC has a signed **Customer Affiliate Agreement** with Google (executed
August 2024, Google Customer Affiliate ID 7947-1465-9142). This
agreement makes UCSC a ratified affiliate under the parent **UC Regents
↔ Google Cloud Platform License Agreement** (originally 2019) and its
current **Enterprise Addendum** (2025). The affiliate agreement is
administrative plumbing: it does not reopen contract terms, it simply
binds UCSC to the UC-wide agreements already in force.

If BayLeaf adds a direct Google Cloud integration, the contract chain
for Gemini calls becomes:

```
User at UCSC
   │
   ▼
BayLeaf Chat (DigitalOcean) or BayLeaf API (Cloudflare)
   │   [operational terms: BayLeaf's own service commitments]
   ▼
UCSC-managed Google Cloud project
   │   [contract: UCSC Customer Affiliate Agreement, Aug 2024]
   │   [inherits: UC ↔ Google GCP License Agreement, 2019]
   │   [inherits: UC ↔ Google Enterprise Addendum, 2025]
   ▼
Google Vertex AI (serving Gemini)
       [governed by the above]
```

The substantive terms that attach to this path:

- **2025 EA § 15.1(d), No AI/ML training:** "Google will not use data
  provided to Google by Customer or End Users through the GCP Services
  … to train or fine-tune any AI/ML models, or include such data in any
  AI/ML models, each without Customer's prior permission or instruction."
- **UC Protection Level 4 (P4) classification:** UC's internal
  data-handling tier for FERPA-, HIPAA-, and PII-protected institutional
  information. The 2019 GCP agreement explicitly classifies Google's
  services at P4. This maps UC's FERPA-handling standards onto Google's
  obligations.
- **2025 EA § 15.2(c), Data Breach Enhanced Cap:** up to $20M or 3×
  annual minimum commitment, whichever is greater, for breaches of
  security or confidentiality obligations.
- **2025 EA § 15.8(e), Cyber and Privacy Liability Insurance:** $10M
  coverage, including credit monitoring costs for affected parties.
- **Data Processing Addendum** at
  `https://cloud.google.com/terms/data-processing-addendum`, incorporated
  by reference.

Compared to the OpenRouter-ZDR path, a direct Google integration is
contractually stronger on every dimension: the agreement is UC-signed
rather than commercial, the liability caps are institutionally
negotiated rather than per-tier, the data classification is explicit,
and the enforcement mechanisms include audit rights and breach
notification requirements that UC negotiated directly.

For the designation question in [§ 4](#4-the-designation-question), a direct Google integration
strengthens the "direct control" argument for Gemini traffic
specifically. It does not change the posture for non-Google models,
which continue to route through OpenRouter.

### 5.3 The "school official" seam in the Google stack

FERPA's school-official exception, as it applies to Google, sits in two
places in UC's agreement stack — both of which cover Google Workspace
(Gmail, Drive, Docs) but *not* Google Cloud Platform (Vertex AI, Gemini
via API).

**2011 Google Apps for Education Master Agreement, § 10.1
(UC Regents ↔ Google):**

> "To the extent that Google has access to 'Education Records,' it is
> deemed a 'school official,' as each of these terms are defined under
> FERPA, under this Agreement and will comply with its obligations
> under FERPA."

This master covers the Workspace-ancestor services. It defines
"Customer Data" to explicitly include "any Personally Identifiable
Information, as defined in FERPA, of End Users."

**Google Workspace for Education Data Regionalization Amendment, § 5:**

> "The parties acknowledge that (a) Customer Data may include
> information from education records that are subject to FERPA; and
> (b) to the extent that Customer Data includes such information,
> Google agrees to be considered a 'School Official' (as that term is
> used in FERPA) and will comply with FERPA, as applicable to its
> provision of the Services as a School Official."

This amendment covers Google Workspace for Education.

**2025 Google Cloud Enterprise Addendum, § 15.1(d):**

The GCP/Vertex agreement contains the strong no-AI-training clause
quoted in [§ 5.2](#52-inference-layer-proposed-direct-google-cloud) but does **not** use the "school official" formulation.
It instead relies on the no-training commitment, P4 classification, and
the incorporated Data Processing Addendum.

#### The seam

```
Workspace services:           ✓ "school official" named explicitly
                              ✓ FERPA obligations accepted explicitly
                              ✓ Customer Data defined to include FERPA PII

GCP / Vertex AI / Gemini:     ✗ "school official" not named
                              ✓ Contractual no-training commitment
                              ✓ P4 data classification
                              ✓ Data Processing Addendum incorporated
```

Two readings of this seam are possible.

**Strict reading.** FERPA's school-official exception requires an
explicit designation. The 2025 EA's § 15.1(d) is strong data
protection, but it is not a FERPA school-official designation. Under
this reading, Vertex AI under UCSC's GCP project is better-protected
than OpenRouter-routed Gemini, but still not the clean "FERPA-covered"
path. The clean path for FERPA-protected content would be
Gemini-in-Workspace (e.g., the Gemini side panel in Docs), which
inherits the Workspace school-official designation.

**Pragmatic reading.** The no-training clause, combined with P4
classification and the Data Processing Addendum, provides contractually
equivalent protection to what school-official designation is meant to
ensure: that the vendor use education records only for the institutional
purpose and not for its own purposes. Under this reading, Vertex AI
under UCSC's GCP project is suitable for FERPA-protected content, with
a note that the coverage is by equivalent terms rather than by the
"school official" phrase.

#### What UCSC has already said

The UCSC AI Council has **implicitly taken the pragmatic reading for
Google Workspace Gemini**. The Council's
[published FAQ](https://campusai.ucsc.edu/faq/) states (as of February
2026):

> "For staff using either of these tools [Google Gemini, NotebookLM],
> data can be shared securely up to and including [protection level
> P3]. UC Santa Cruz and the UC System have negotiated agreements with
> Google that include protections for university data. The university
> retains control over how data is stored and reused, inputs are not
> used to train AI models, and institutional support is available if
> something goes wrong."

Protection Level 3, per
[ITS's data classification guidance](https://its.ucsc.edu/get-support/it-guides/data-and-it-resource-classification/data-protection-levels/),
explicitly includes "Student education records (these are protected by
FERPA)."

In other words: the campus has already determined that UC's Google
agreements provide sufficient contractual protection for FERPA-covered
content, at least when the vehicle is Google Workspace. That
determination is the authoritative campus-level position as of this
writing.

#### The narrower open question

What the campus has *not* yet determined is whether that same P3
approval extends to Vertex AI / Gemini accessed through the GCP API,
rather than through the Google Workspace interface. Both paths sit
under the same UC–Google agreement stack and inherit the same
§ 15.1(d) no-training commitment, the same P4 data classification, and
the same Data Processing Addendum. The technical difference is that
Workspace-Gemini is a managed Google product built on top of Vertex,
while direct Vertex access is the raw API.

For BayLeaf's designation question ([§ 4](#4-the-designation-question)), this seam matters in a
specific way. Even under the strict reading, Vertex AI under UCSC's GCP
project is substantively better-protected for FERPA purposes than any
other inference path available to BayLeaf. A designation framework that
routes FERPA-sensitive traffic to Gemini-via-UCSC-GCP-project, with
non-FERPA traffic permitted to the OpenRouter-ZDR path, is defensible
under both readings.

### 5.4 Inference layer alternative: NRP / SDSC

The [National Research Platform](https://nrp.ai/), operated out of
UC San Diego and funded by NSF, serves open-weight models on
UC-affiliated research infrastructure. BayLeaf has this configured as
an alternative inference path for open-weight models (currently not the
default).

NRP is UC-operated infrastructure. Traffic to NRP does not leave the UC
system boundary in the same way that traffic to a commercial provider
does. The FERPA posture is different in kind from the commercial paths
above: there is no redisclosure-to-commercial-vendor question, because
there is no commercial vendor. The relevant questions are UC-internal
data-handling and inter-campus agreements, which are substantially
easier to satisfy than external-vendor designation.

For the designation question in [§ 4](#4-the-designation-question), NRP is the strongest inference
path available for the open-weight models it serves. The limitation is
that NRP does not serve the frontier proprietary models (Claude, GPT,
Gemini) that much of BayLeaf's user base relies on.

---

## 6. Protection Levels and what's already approved

<!-- SEC:PROTECTION_LEVELS -->
UC's information-security policy (IS-3) classifies institutional
information into four Protection Levels, P1 (minimum) through P4
(maximum). The classification drives what security controls and
contractual protections are required for handling the data. UCSC's
[data classification guidance](https://its.ucsc.edu/get-support/it-guides/data-and-it-resource-classification/data-protection-levels/)
places FERPA-protected student education records at **Protection
Level 3**.

The UCSC AI Council's [published FAQ](https://campusai.ucsc.edu/faq/)
lists the AI tools approved for use with P3 data. As of the current
guidance:

- **Approved for P3:** Google Gemini (via Google Workspace), NotebookLM,
  Zoom AI (meeting summary and in-meeting questions). All accessed
  through the user's UCSC Google account.
- **Not approved for P3:** consumer AI tools, any tool not covered by a
  UC-signed institutional agreement.

BayLeaf in its current form falls in the "not approved" set. The
OpenRouter inference path is not under a UC-signed agreement, and
BayLeaf has not been separately designated as a school official under
§ 99.31(a)(1)(i)(B). This applies regardless of which model the user
selects, including Gemini (which currently reaches Google via
OpenRouter rather than via UCSC's Google contract).

The question this document raises is whether the designation framework
proposed in [§§ 4](#4-the-designation-question) and [8](#8-a-draft-designation-memo), combined with architectural choices in [§ 5](#5-the-contract-stack-beneath-bayleaf),
would support adding BayLeaf to the P3-approved list — either as a
whole, or specifically for its Google lane under a direct Google Cloud
integration.

---

## 7. The approval pathway

<!-- SEC:APPROVAL_PATHWAY -->

### 7.1 Which UCSC offices are involved

FERPA itself does not name an approver; it requires the institution to
make the designation and to include the criteria in its annual
notification (§ 99.7). At UCSC, the approval authority is distributed
across several offices, and which one matters depends on what is being
asked.

- **Office of Campus Counsel.** Reviews contract terms for FERPA
  sufficiency. Approves the *legal form* of the designation and any
  associated agreements. For BayLeaf, Counsel would review the
  designation memo ([§ 8](#8-a-draft-designation-memo)) and the underlying subprocessor contracts to
  the extent they are material.
- **Privacy Office / Chief Privacy Officer.** Applies UC's privacy
  framework (IS-3, the data classification scheme, the UC Statement of
  Privacy Values and Privacy Principles). Decides whether data-handling
  practices are adequate for the relevant protection level.
- **Information Security Office (ISO).** Applies IS-3's security
  controls. For P3/P4-eligible tools, this is typically a formal
  security review process: vendor risk assessment, security
  questionnaire, review of subprocessor contracts, verification of
  encryption and access-control posture.
- **UCSC AI Council.** The campus body that has taken the operative
  positions on AI tool approvals to date (Workspace-Gemini,
  NotebookLM). For BayLeaf, the Council is the natural venue for the
  policy decision about whether to extend the P3-approved list, but
  the Council typically defers to Counsel, the Privacy Office, and ISO
  for the underlying review.
- **Procurement / Strategic Sourcing.** Executes contracts on UCSC's
  behalf. For a normal vendor, this is the office that signs the DPA
  and FERPA addendum. For BayLeaf, as a faculty-operated service, the
  procurement step is structurally unusual: there is no vendor to
  contract with in the normal sense. The designation memo may be
  signed by an authorized UCSC official without going through
  Procurement, since no purchase is involved.

None of these offices acts as the single approver. The typical path is
a review package circulated among Privacy, ISO, and Counsel, with the
AI Council making the final policy determination once the review is
clean.

### 7.2 The typical sequence for vendor approval

For a standard external vendor being considered for P3 data handling,
the sequence runs roughly:

1. **Intake.** A requesting unit identifies the need and submits a
   vendor to ISO's vendor risk assessment process. The vendor completes
   a security questionnaire (typically Higher Education Community
   Vendor Assessment Toolkit, HECVAT).
2. **Security and privacy review.** ISO evaluates the security posture;
   the Privacy Office evaluates the privacy posture; both review the
   vendor's DPA and any FERPA-specific addendum.
3. **Counsel review.** Campus Counsel reviews the contract form and any
   carve-outs or amendments. For vendors with existing UC master
   agreements (like Google), this step may be short; for new vendors
   it can involve substantive negotiation.
4. **Procurement execution.** Procurement signs on UCSC's behalf; the
   vendor is added to UCSC's approved-vendor list for the specified
   data classifications.
5. **Policy addition (AI tools specifically).** The AI Council adds the
   tool to the published approval list, with guidance on approved
   use cases and any limits.

For BayLeaf this sequence is partially applicable and partially
mismatched:

- **Steps 1–2 (intake and security/privacy review) are applicable.** A
  vendor risk assessment of BayLeaf's architecture, subprocessors, and
  data-handling practices is the right gate. This document, combined
  with [SECURITY.md](SECURITY.md), is the substantive input.
- **Step 3 (Counsel review) is applicable but different in form.**
  There is no contract between UCSC and a vendor to negotiate. What
  Counsel is reviewing is the designation memo ([§ 8](#8-a-draft-designation-memo)) and the adequacy
  of the underlying subprocessor contracts, not a new UCSC-vendor
  contract.
- **Step 4 (Procurement execution) is probably skipped.** The
  designation memo can be signed by an authorized UCSC official
  without a procurement event. Whether this is the Provost, the CIO,
  the Chief Privacy Officer, or another official is a question for
  Counsel.
- **Step 5 (AI Council policy addition) is the visible outcome.**
  Addition to the campus-approved AI tools list is the deliverable
  that matters operationally.

### 7.3 What's weird about running this pathway for a faculty-operated service

Several things are structurally unusual about BayLeaf as a candidate
for designation:

**No vendor counterparty.** UCSC's standard process assumes a
commercial vendor on the other side of the table, with a legal entity
that can sign a DPA and a FERPA addendum, carry insurance, and accept
audit obligations. BayLeaf has no such counterparty. The operator is a
UCSC faculty member; the commercial subprocessors (DigitalOcean,
Cloudflare, OpenRouter) are contracted personally, not institutionally.
What UCSC would designate is the service, and what the operator would
commit to is operational discipline — not a vendor relationship.

**No procurement event.** Because BayLeaf is offered at no cost and
does not involve a UCSC purchase, Procurement has no transaction to
execute. This is unusual but not unprecedented: UCSC periodically
designates volunteer or grant-funded activities that involve education
records without procurement events.

**The operator is already a school official.** As noted in [§ 4.3](#43-why-faculty-operated-complicates-the-vendor-frame), Adam
is already a school official under (a)(1)(i)(A) by virtue of being a
UCSC faculty member. Designating *BayLeaf* doesn't change Adam's
status; it extends the institutional frame to cover the subprocessor
chain BayLeaf uses.

**Scope of benefit is campus-wide.** BayLeaf is offered to the entire
UCSC campus community, not to a single department or unit. This makes
it more like a campus ITS service than like a department-scoped vendor,
and the review process should match that scope.

**Reversibility.** BayLeaf is faculty-operated; if the operator leaves
UCSC, retires, or decides to stop running it, the service goes away.
This is a material fact for the designation: UCSC is designating a
time-limited instrument, not acquiring a permanent capability. The
designation memo should account for this (termination conditions,
transition or shutdown obligations, data-handling at end of service).

These are features, not bugs. The alternative — routing all campus AI
needs through enterprise vendor procurement — is slower, more
expensive, and less responsive to pedagogical needs than faculty-operated
tools can be. What the process has to do is accommodate the shape.

### 7.4 What artifacts the process expects

A complete review package for BayLeaf's designation would include:

1. **FERPA posture document** (this file). The FERPA-frame analysis:
   what FERPA requires, how BayLeaf relates to it, what designation
   would mean, what questions remain open.
2. **Security posture document** ([SECURITY.md](SECURITY.md)). Data
   flows at the platform layer, retention and access, breach response,
   subprocessor inventory with DPAs.
3. **Dependency audit** ([DEPENDENCIES.md](DEPENDENCIES.md)). Full
   inventory of services and libraries on which BayLeaf depends, with
   the ZDR boundary discussion.
4. **Draft designation memo** ([§ 8](#8-a-draft-designation-memo) below). The instrument UCSC would
   sign to designate BayLeaf as a school official under
   § 99.31(a)(1)(i)(B).
5. **Subprocessor appendix.** A table enumerating each subprocessor,
   the category of data it handles, the contract under which it
   handles that data, and the term limits and deletion obligations.
   This appears as part of the designation memo's Appendix A.
6. **HECVAT or equivalent security questionnaire.** Prepared; see
   [`HECVAT.md`](HECVAT.md) in this directory. The questionnaire is
   filled in with answers honest to BayLeaf's posture as a
   faculty-operated service, with a framing memo at the top explaining
   the vendor-shaped questions that do not apply.

Items 1–3 exist in this repository. Item 4 is provided in [§ 8](#8-a-draft-designation-memo). Items 5
and 6 are also in this repository.

---

## 8. A draft designation memo

<!-- SEC:DESIGNATION_MEMO -->
This section provides a working draft of the memorandum UCSC would
execute to designate BayLeaf as a school official under FERPA. It is
written in the form UCSC would sign, with brackets indicating open
choices that Counsel, the Privacy Office, or the signing official
would resolve. The draft is a proposal by the BayLeaf operator; it is
not a UCSC document until an authorized UCSC official signs it.

---

> **Memorandum of Designation: BayLeaf AI Playground as School Official
> under FERPA**
>
> **From:** [UCSC signing official — candidates include the Provost,
> the Chief Information Officer, the Chief Privacy Officer, or another
> official authorized to make FERPA designations on behalf of the
> Regents of the University of California]
>
> **To:** Adam Smith, Associate Professor, Department of Computational
> Media, UC Santa Cruz, in his capacity as operator of the BayLeaf AI
> Playground ("BayLeaf")
>
> **Date:** [to be supplied]
>
> **Subject:** Designation of BayLeaf as a school official under 34
> CFR § 99.31(a)(1)(i)(B)
>
> ---
>
> **1. Designation.**
>
> The University of California, Santa Cruz ("UCSC"), a campus of the
> University of California, hereby designates the BayLeaf AI Playground
> ("BayLeaf") as a school official with a legitimate educational
> interest, as those terms are used in the Family Educational Rights
> and Privacy Act, 20 U.S.C. § 1232g ("FERPA"), and its implementing
> regulations at 34 CFR Part 99, for the purposes and subject to the
> conditions set forth below.
>
> **2. Institutional service or function.**
>
> UCSC has determined that BayLeaf performs an institutional service
> for which UCSC would otherwise use employees or engage vendors:
> specifically, the provision of AI-assisted analysis, drafting, and
> related language tasks in support of UCSC's teaching, research, and
> administrative functions. This service extends and complements
> UCSC's existing AI-tool offerings.
>
> **3. Legitimate educational interest.**
>
> A legitimate educational interest exists when a school official
> needs to review an education record in order to fulfill his or her
> professional responsibility to the institution. BayLeaf, when used
> by UCSC faculty, staff, or other institutional role-holders in the
> course of their institutional responsibilities, processes education
> records on behalf of those officials in support of that fulfillment.
>
> **4. Direct control.**
>
> BayLeaf accepts that it is under the direct control of UCSC with
> respect to the use and maintenance of education records, as required
> by 34 CFR § 99.31(a)(1)(i)(B)(*2*). Specifically, BayLeaf agrees:
>
> (a) To use education records, and personally identifiable
> information derived from them, only for the purpose of providing the
> services described in § 2 of this designation;
>
> (b) To maintain appropriate administrative, technical, and physical
> safeguards to protect the confidentiality, integrity, and
> availability of education records, consistent with UC Electronic
> Information Security Policy IS-3 at the protection level assigned to
> the data;
>
> (c) To limit access to education records to those personnel,
> contractors, and subprocessors whose access is necessary to provide
> the service;
>
> (d) To maintain records of subprocessors with access to education
> records (see Appendix A), to update Appendix A when the subprocessor
> list changes, and to notify UCSC of material changes;
>
> (e) To permit UCSC to audit BayLeaf's compliance with this
> designation on reasonable notice, including by reviewing
> subprocessor contracts, inspecting relevant records, and interviewing
> the operator; and
>
> (f) On termination of this designation, to cease processing education
> records on UCSC's behalf, to return or destroy education records
> held by BayLeaf (including those held by subprocessors as recorded
> in Appendix A), and to provide UCSC with written certification of
> such return or destruction.
>
> **5. Redisclosure.**
>
> BayLeaf agrees to comply with 34 CFR § 99.33(a) governing the use
> and redisclosure of personally identifiable information from
> education records. BayLeaf shall not disclose such information to
> any party except:
>
> (a) As permitted by a specific provision of 34 CFR § 99.31;
>
> (b) As authorized by UCSC through this designation or otherwise in
> writing;
>
> (c) To subprocessors acting on BayLeaf's behalf in the provision of
> the services described in § 2, provided such subprocessors are bound
> by contractual terms substantively equivalent to the limits in this
> § 5, consistent with 34 CFR § 99.33(b); or
>
> (d) As required by law, subject to reasonable advance notice to
> UCSC where permitted.
>
> **6. Subprocessors.**
>
> Appendix A lists the subprocessors BayLeaf uses in providing the
> services described in § 2, the category of data each handles, the
> contractual instrument governing each, and the termination and
> data-disposition obligations applicable to each. BayLeaf agrees not
> to add subprocessors handling education records without notifying
> UCSC and updating Appendix A. UCSC may object to the addition of a
> subprocessor on reasonable grounds, in which case BayLeaf and UCSC
> will in good faith determine an acceptable alternative or treat the
> designation as terminated with respect to the service dependent on
> that subprocessor.
>
> **7. Scope of data.**
>
> This designation applies to education records and personally
> identifiable information derived therefrom that BayLeaf receives in
> the course of providing the services described in § 2. It does not
> expand BayLeaf's access to education records held in UCSC systems;
> BayLeaf does not receive data pushes from the Student Information
> System, Canvas, or any institutional record store, and this
> designation does not authorize any such access.
>
> **8. Protection level.**
>
> The parties acknowledge that FERPA-protected student education
> records are classified as Protection Level 3 under UC IS-3 and
> UCSC's data classification guidance. BayLeaf's designation is
> [limited to Protection Levels 1 and 2 only] / [extended to
> Protection Level 3 data subject to the security controls set forth
> in Appendix B] / [extended to Protection Level 3 data only when
> processed through the Google lane described in § 5.2 of the
> accompanying FERPA posture document]. [The signing official to
> select among these options on the basis of the security and privacy
> review.]
>
> **9. Term and termination.**
>
> This designation is effective on the date of signature below and
> continues until terminated by either party on thirty (30) days'
> written notice, or automatically on the date Adam Smith ceases to
> hold an institutional role at UCSC that includes school-official
> status under 34 CFR § 99.31(a)(1)(i)(A). On termination the
> obligations in § 4(f) and § 5 survive until all education records
> in BayLeaf's possession or control have been returned or destroyed
> and such return or destruction has been certified to UCSC.
>
> **10. Annual notification.**
>
> UCSC shall include BayLeaf in its annual notification of FERPA
> rights pursuant to 34 CFR § 99.7, as a designated school official,
> with a description of the criteria for which BayLeaf has been so
> designated.
>
> **11. Not an employment or agency relationship.**
>
> This designation does not create an employment, agency, partnership,
> or joint venture relationship between UCSC and Adam Smith in his
> capacity as BayLeaf operator beyond his existing UCSC faculty
> appointment. Adam Smith's institutional role and responsibilities as
> a member of the UCSC faculty are governed by his appointment and
> applicable UC policy, independent of this designation.
>
> **12. Amendment.**
>
> This designation may be amended by written agreement of the parties.
> Appendix A (subprocessors) and Appendix B (security controls, if
> applicable) may be updated by BayLeaf on notice to UCSC and do not
> require amendment of the body of the designation.
>
> ---
>
> **Signed:**
>
> _____________________________________
> [UCSC signing official, title]
> For the Regents of the University of California, UC Santa Cruz
>
> **Acknowledged and accepted:**
>
> _____________________________________
> Adam Smith, Associate Professor
> Operator, BayLeaf AI Playground
>
> ---
>
> **Appendix A: Subprocessors**
>
> *[This appendix would list each subprocessor (DigitalOcean,
> Cloudflare, OpenRouter, NRP, and the specific model providers
> reached via OpenRouter's ZDR endpoints, plus Google Cloud if the
> direct integration is added), with the contractual instrument
> governing each, the category of data handled, the retention and
> training posture, and the termination obligations. To be prepared as
> a companion document when the designation memo is submitted for
> review.]*
>
> **Appendix B: Security Controls for Protection Level 3 Data**
>
> *[If the designation extends to P3, this appendix would specify the
> security controls BayLeaf commits to maintain, consistent with IS-3
> at P3. To be prepared in coordination with ISO during the security
> review.]*

---

The draft above is written to be readable by non-lawyers while
retaining the structure and references a reviewing attorney would
look for. Two design choices deserve comment:

**Option structure in § 8 (protection level).** The draft explicitly
offers the signing official three choices for what protection level to
extend the designation to, rather than asserting P3 unilaterally. This
is the substantive policy question and it is not ours to answer; the
memo is structured to surface it for decision rather than to pre-empt it.

**Termination tied to the operator's role (§ 9).** The designation
self-terminates when the operator ceases to hold an institutional role
that includes school-official status. This addresses the reversibility
issue from [§ 7.3](#73-whats-weird-about-running-this-pathway-for-a-faculty-operated-service) and makes the institutional risk bounded: UCSC is not
designating a permanent vendor relationship, it is designating a
faculty-operated service that exists as long as the faculty member
operates it.

---

## 9. What this means in practice

<!-- SEC:WHAT_THIS_MEANS -->

### For a faculty or staff member considering BayLeaf for FERPA-relevant work

The first question is whether the content actually contains
FERPA-protected information. FERPA covers PII from education records
maintained by the institution. A paraphrased question about a student's
behavior, stripped of identifiers, is not a FERPA disclosure. A pasted
advising note with the student's name and ID is.

FERPA-protected student education records are classified as P3 in UC's
data protection levels. Current campus guidance
([campusai.ucsc.edu/faq](https://campusai.ucsc.edu/faq/)) identifies
the AI tools approved for P3 data:

- **Approved for P3:** Google Gemini (Workspace), NotebookLM, Zoom AI.
  All accessed through the user's UCSC Google account.
- **Not approved for P3:** consumer AI tools, and any tool not covered
  by a UC-signed institutional agreement or a UCSC school-official
  designation.

BayLeaf currently falls in the "not approved" set, for the reasons
discussed in [§§ 4](#4-the-designation-question), [5](#5-the-contract-stack-beneath-bayleaf), [6](#6-protection-levels-and-whats-already-approved). This applies regardless of which model you select
in BayLeaf (Gemini included, since today's Gemini-in-BayLeaf goes
through OpenRouter rather than UC's Google contract).

If the content contains FERPA-protected PII, the current options are:

- **Use Gemini-in-Workspace** (the Gemini side panel in Google Docs,
  Gmail, Drive, or gemini.google.com signed in with your UCSC account).
  Campus-approved for P3 data; inherits the explicit Workspace
  "school official" designation.
- **Use NotebookLM** under your UCSC account; also campus-approved
  for P3.
- **Don't use BayLeaf in its current form for P3 content.** Use it for
  P1/P2 content: drafting, brainstorming, code, generic Q&A where no
  student identifiers are involved.
- **Air-gapped paraphrasing** is almost always the right move when the
  task itself is P3. Remove identifiers before the prompt; apply the
  AI's suggestions back onto the identified record yourself. This
  reduces the FERPA surface regardless of which tool you use.

If UCSC executes the designation memo in [§ 8](#8-a-draft-designation-memo), BayLeaf's posture
changes in ways that will be specified in the signed memo itself. At
minimum: UCSC has designated BayLeaf as a school official, and the
subprocessor chain is brought within the § 99.33(b) redisclosure
framework. Whether this carries P3 authorization depends on the
protection-level option selected in § 8 of the memo.

### For a student using BayLeaf

BayLeaf is an opt-in service. You are not submitting education records
to a third party by using it. You are sending your own prompts to an AI
service. FERPA does not regulate what you choose to share about
yourself; it regulates what the institution shares about you.

If you are a student worker handling education records in an
institutional role (e.g., a peer advisor, a teaching assistant with
grade access, a student employee in an administrative office), then
the faculty/staff guidance above applies to you when you are acting in
that role.

### For a reviewer asking "is BayLeaf FERPA-compliant?"

There are two versions of this question:

1. *Can BayLeaf receive FERPA-protected records from an institutional
   role-holder (faculty, staff, advisor) acting in their professional
   capacity?*
   Today, no. BayLeaf has no UCSC designation as a school official and
   is not on the campus-approved AI tools list for P3 data. With
   execution of the designation memo in [§ 8](#8-a-draft-designation-memo), and at the protection
   level selected in § 8 of that memo, yes.

2. *Does BayLeaf hold education records on behalf of UCSC?*
   No. BayLeaf does not receive data pushes from the Student Information
   System, Canvas, or any institutional record store. It processes
   whatever users type into it. It retains conversation histories (in
   Open WebUI's database) accessible only to the system administrator.
   See [SECURITY.md](SECURITY.md) for the full data-handling picture.

The honest one-sentence answer to "is BayLeaf FERPA-compliant?" is:
**"BayLeaf in its current un-designated form is not among the
campus-approved tools for FERPA-protected content, and users should
instead use the Workspace-based Gemini and NotebookLM tools UCSC has
already approved for that purpose; a proposed designation of BayLeaf
as a school official under 34 CFR § 99.31(a)(1)(i)(B), together with
§ 99.33(b) redisclosure terms covering BayLeaf's subprocessor chain,
would bring BayLeaf within the FERPA framework at a protection level
to be specified in the signed designation memorandum."**

---

## 10. Open questions for the AI Council

<!-- SEC:COUNCIL_QUESTIONS -->
These are the questions this analysis cannot resolve on its own, and
that are most naturally addressed by the UCSC AI Council (with input
from Campus Counsel, the Privacy Office, and the Information Security
Office as needed).

1. **The designation itself.** Given the draft designation memo in [§ 8](#8-a-draft-designation-memo),
   is UCSC willing to designate BayLeaf as a school official under
   34 CFR § 99.31(a)(1)(i)(B)? If so, what protection level should the
   designation cover (the option structure in § 8 of the memo)? What
   office is the appropriate signer?

2. **Conditions and controls.** If the designation is extended to P3,
   what security controls does ISO want specified in Appendix B of the
   memo? Are there access-pattern limits, audit-visibility requirements,
   or data-handling conventions beyond those already in this document
   that should be made explicit?

3. **Extending the P3 approval from Workspace-Gemini to
   Vertex/GCP-Gemini.** The Council has approved Workspace-Gemini and
   NotebookLM for P3 data on the strength of UC's negotiated Google
   agreements. Vertex AI accessed through the GCP API sits under the
   same UC–Google agreement stack ([§§ 5.2](#52-inference-layer-proposed-direct-google-cloud), [5.3](#53-the-school-official-seam-in-the-google-stack) of this document). Does
   the P3 approval extend to Vertex-via-UCSC-GCP-project? If BayLeaf
   adds a direct Google Cloud integration, does the Google lane within
   BayLeaf inherit this approval under the designation in [§ 8](#8-a-draft-designation-memo)?

4. **Non-Google providers.** For Anthropic, OpenAI, Meta, and other
   providers reached via OpenRouter's ZDR option, no UC-signed
   institutional agreement exists. Under the designation framework in
   [§ 8](#8-a-draft-designation-memo), does UCSC consider these providers' contractual posture
   sufficient for P3 use when accessed via a designated
   faculty-operated service, or should P3 remain Google-only for the
   foreseeable future?

5. **User-side characterization.** When a UCSC faculty member pastes
   FERPA-protected content into any AI service that is not on the
   campus-approved list, what is the correct characterization under UC
   policy? User violation, institutional gap, or communication problem
   the existing guidance already addresses? This question predates
   BayLeaf; BayLeaf makes it concrete.

6. **Precedent for faculty-operated services.** If BayLeaf is
   designated under [§ 8](#8-a-draft-designation-memo), does that establish a pattern that could
   support designating other faculty-operated services in the future?
   What should that pattern look like (what is the minimum viable
   review package, who is the standing signer, how is the subprocessor
   appendix kept current)?

Answers to these let us replace the conditional language in this
document with definite statements, update user-facing guidance, and
decide whether and how to proceed with a direct Google Cloud
integration.

---

## 11. References

<!-- SEC:REFERENCES -->
### Statute and regulation

- [FERPA, 20 U.S.C. § 1232g](https://www.law.cornell.edu/uscode/text/20/1232g)
- [FERPA Regulations, 34 CFR Part 99](https://www.ecfr.gov/current/title-34/subtitle-A/part-99)
- [34 CFR § 99.7, Annual notification of FERPA rights](https://www.ecfr.gov/current/title-34/subtitle-A/part-99/subpart-A/section-99.7)
- [34 CFR § 99.30, Prior consent for disclosure](https://www.ecfr.gov/current/title-34/subtitle-A/part-99/subpart-D/section-99.30)
- [34 CFR § 99.31, Disclosures without prior consent](https://www.ecfr.gov/current/title-34/subtitle-A/part-99/subpart-D/section-99.31)
- [34 CFR § 99.33, Limitations on redisclosure](https://www.ecfr.gov/current/title-34/subtitle-A/part-99/subpart-D/section-99.33)

### ED guidance on FERPA and outsourced services

- U.S. Department of Education, Family Policy Compliance Office,
  "Letter to Wachter" (and related FPCO guidance on the
  school-official exception as applied to outside service providers).
  Held in FPCO's published letters archive; cited here for the
  "direct control" interpretation.
- U.S. Department of Education, Privacy Technical Assistance Center
  (PTAC), "Protecting Student Privacy While Using Online Educational
  Services: Requirements and Best Practices" (2014).

### UC ↔ Google agreements consulted

Held under UC Procurement; not public. Read for this analysis:

- Google Apps Education Edition Agreement (2011), the UC master:
  establishes FERPA "school official" designation for Workspace-ancestor
  services (§ 10.1).
- Google Cloud Platform License Agreement (2019): establishes GCP
  under UC Protection Level 4.
- UC Enterprise Addendum (2025), current: § 15.1(d) no-AI-training
  clause, § 15.2(c) data-breach enhanced liability cap, § 15.8(e)
  cyber and privacy liability insurance.
- Google Workspace for Education Data Regionalization Amendment: § 5
  FERPA "school official" designation for Workspace.
- UCSC GCP Customer Affiliate Agreement (August 2024): UCSC as
  affiliate under the UC Regents parent agreement.
- BAA for G-Suite: HIPAA-scoped, not FERPA, noted for completeness.

### UC and UCSC policy

- [UC Electronic Information Security Policy, IS-3](https://security.ucop.edu/policies/institutional-information-and-it-resource-classification.html)
  (defines Protection Levels P1 through P4).
- [UCSC ITS: Data and IT Resource Classification, Data Protection Levels](https://its.ucsc.edu/get-support/it-guides/data-and-it-resource-classification/data-protection-levels/)
  (P3 explicitly includes FERPA-protected student education records).
- [UC Responsible AI Principles](https://ai.universityofcalifornia.edu/_files/documents/ai-council-uc-responsible-ai-principles.pdf)
  (the principles the UCSC AI Council applies).
- [UCSC Registrar: Student Privacy (FERPA)](https://registrar.ucsc.edu/records-grades-graduation/student-privacy-ferpa/)
  (landing page for UCSC's FERPA guidance).
- [UCSC Registrar: Public Disclosures](https://registrar.ucsc.edu/calendars-resources/ferpa-privacy/public-disclosures/)
  (UCSC Administrative Procedures Applying to Disclosure of Information
  from Student Records; defines legitimate educational interest,
  notification of rights, and the written-form mechanism in §IX.C).
- [UC Policies Applying to Disclosure of Information from Student Records (§130.00)](http://www.ucop.edu/ucophome/coordrev/ucpolicies/aos/documents/sec-130.pdf)
  (the Universitywide policy UCSC's Public Disclosures page implements).

### UCSC AI Council guidance

- [UCSC AI Council homepage (campusai.ucsc.edu)](https://campusai.ucsc.edu/)
- [UCSC AI Council FAQ](https://campusai.ucsc.edu/faq/)
  (approves Workspace-Gemini and NotebookLM for P3 data).
- [UCSC AI Council charge and membership (ITS)](https://its.ucsc.edu/about/it-governance/artificial-intelligence)

### Related BayLeaf documents

- [SECURITY.md](SECURITY.md): data handling at the platform layer
  (DigitalOcean, Cloudflare, storage, retention, breach response).
- [DEPENDENCIES.md](DEPENDENCIES.md): dependency audit and ZDR boundary
  discussion.
- [POSITION.md](POSITION.md): pedagogical position on institutional
  AI.
