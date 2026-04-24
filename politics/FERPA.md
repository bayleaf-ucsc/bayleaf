# FERPA and BayLeaf

<!-- SEC:INTRO -->
**Service:** BayLeaf AI Playground
**Operator:** Adam Smith, Associate Professor, Dept. of Computational Media, UC Santa Cruz
**Status:** Working analysis. Not legal advice. Not reviewed by UCSC Office of General Counsel.

This document describes how BayLeaf's current architecture relates to FERPA (the
Family Educational Rights and Privacy Act, 20 U.S.C. § 1232g), and how it would
relate if BayLeaf added a direct Google Cloud integration. It is written for the
audience that asks "is BayLeaf FERPA-compliant?" and deserves a more precise
answer than yes or no.

The short version: BayLeaf currently routes all LLM inference through OpenRouter
using zero-data-retention (ZDR) provider endpoints. ZDR is a strong technical
and contractual commitment, but it is a commercial ZDR flag, not an institutional
agreement between UC and the model provider. UC's signed agreements with Google
are materially stronger, and in one case use FERPA's "school official" language
explicitly. BayLeaf can access that stronger contractual layer for Google models
by adding a direct Google Cloud integration under UCSC's existing Customer
Affiliate Agreement. Other providers (Anthropic, OpenAI, Meta) remain on the
OpenRouter-ZDR path, which is the best contractual protection available for those
models without separate UC-signed agreements.

The long version follows.

This document focuses on LLM inference only. It does not address the platform
layer (DigitalOcean, Cloudflare, conversation storage in Open WebUI's database);
that is covered in [SECURITY.md](SECURITY.md).

---

## 1. What FERPA requires

<!-- SEC:FERPA_BASICS -->
FERPA protects the privacy of student "education records" held by institutions
that receive federal funding. An education record is any record directly related
to a student and maintained by the institution or a party acting for the
institution.

The statute forbids the institution from disclosing personally identifiable
information (PII) from education records without the student's written consent,
except under a small set of enumerated exceptions (34 CFR § 99.31). The relevant
exception for AI services is the **"school official with legitimate educational
interest"** exception (34 CFR § 99.31(a)(1)).

A third-party vendor can be treated as a school official if four conditions are
met (34 CFR § 99.31(a)(1)(i)(B)):

1. The vendor performs a service for which the institution would otherwise use
   employees.
2. The vendor is under the **direct control** of the institution with respect
   to the use and maintenance of education records.
3. The vendor is subject to the FERPA requirements that govern use and
   redisclosure of PII.
4. The institution has designated the vendor as a school official in writing.

The "direct control" and "designated in writing" pieces are the ones that matter
for AI. A vendor cannot decide on its own to be a school official; the institution
has to say so, and the contract has to reflect the vendor's obligations.

What FERPA does *not* require: it does not require any specific technical
architecture, any specific certification, or any specific data-residency outcome.
What it requires is a contractual framework in which the institution can designate
the vendor as a school official and the vendor accepts the associated
obligations.

This matters for BayLeaf because the FERPA conversation is frequently conflated
with adjacent but distinct concerns:

- **Data retention.** FERPA does not ban vendor retention of education records;
  it regulates disclosure and redisclosure. ZDR is a *stronger* commitment than
  FERPA alone would require, for the subset of data that enters inference.
- **Training on user data.** FERPA does not specifically regulate whether
  education records can be used to train AI models; it regulates whether PII can
  be disclosed for purposes outside the institution's educational interest.
  Contractual no-training clauses address a real concern but are not themselves
  FERPA requirements.
- **Hosting location.** FERPA does not require U.S.-only hosting. It requires
  appropriate contractual protections regardless of where the data physically
  sits.

FERPA is a contract question before it is a technical question.

---

## 2. BayLeaf's current architecture

<!-- SEC:BAYLEAF_ARCHITECTURE -->
BayLeaf is a faculty-operated AI service at UCSC. It runs two user-facing
surfaces:

- **BayLeaf Chat** (`chat.bayleaf.dev`): an Open WebUI deployment on
  DigitalOcean, offering curated model access to the UCSC campus community.
- **BayLeaf API** (`api.bayleaf.dev`): a Cloudflare Worker that provisions
  OpenRouter-compatible API keys for campus users, with routing restricted to
  ZDR provider endpoints.

For the purpose of FERPA analysis, the question is: when a user sends a prompt
to BayLeaf, where does that prompt go, and under what contract is it processed?

Today the answer is one of two paths, depending on the model:

1. **OpenRouter → model provider (Anthropic, OpenAI, Google, Meta, etc.)**,
   restricted to ZDR provider endpoints. This is the default path.
2. **NRP / SDSC** ([National Research Platform](https://nrp.ai/) at UC San Diego),
   serving open-weight models on NSF-funded research infrastructure. This is a
   configured alternative, not the default.

There is **no direct UCSC-to-Google LLM connection** in the current architecture.
When a user selects "Gemini 2.5 Pro" in the BayLeaf Chat model list, the request
goes to OpenRouter, which forwards it to Google's Vertex AI endpoint under
OpenRouter's commercial agreement with Google, not UCSC's.

This is the fact that most shapes what FERPA.md has to say.

---

## 3. The contract chain, today

<!-- SEC:CONTRACT_CHAIN_TODAY -->
For a Gemini call in BayLeaf today:

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
Google Vertex AI (serving Gemini)
       [contract: OpenRouter ↔ Google, commercial terms]
       [UCSC is not a party to this contract]
```

For an Anthropic call today, replace "Google Vertex AI" with "Anthropic API" and
the upstream contract is OpenRouter ↔ Anthropic. Same structure.

The ZDR commitment on this path is real and enforceable: OpenRouter routes only
to provider endpoints that have contractually agreed to discard prompts and
completions after generating a response. No training, no retention, no
secondary use. This is a meaningful protection.

What this path does *not* provide:

- A **UC-signed** agreement with the model provider.
- A **FERPA "school official"** designation for the provider.
- UC's **Protection Level 4** data-handling commitments (UCSC's internal
  classification tier for FERPA-protected data).
- The **$20M data-breach enhanced liability cap** that UC has negotiated directly
  with Google.

These protections are available for some providers through UCSC's existing
institutional agreements, but BayLeaf does not currently route through them.

---

## 4. The contract chain, with a direct Google integration

<!-- SEC:CONTRACT_CHAIN_DIRECT -->
UCSC has a signed **Customer Affiliate Agreement** with Google (executed August
2024, Google Customer Affiliate ID 7947-1465-9142). This agreement makes UCSC a
ratified affiliate under the parent **UC Regents ↔ Google Cloud Platform
License Agreement** (originally 2019) and its current **Enterprise Addendum**
(2025). The affiliate agreement is administrative plumbing: it does not
reopen contract terms, it simply binds UCSC to the UC-wide agreements already in
force.

If BayLeaf adds a direct Google Cloud integration, the contract chain for Gemini
calls becomes:

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

- **2025 EA § 15.1(d), No AI/ML training:** "Google will not use data provided
  to Google by Customer or End Users through the GCP Services … to train or
  fine-tune any AI/ML models, or include such data in any AI/ML models, each
  without Customer's prior permission or instruction."
- **UC Protection Level 4 (P4) classification:** UC's internal data-handling
  tier for FERPA-, HIPAA-, and PII-protected institutional information. The
  2019 GCP agreement explicitly classifies Google's services at P4. This maps
  UC's FERPA-handling standards onto Google's obligations.
- **2025 EA § 15.2(c), Data Breach Enhanced Cap:** up to $20M or 3× annual
  minimum commitment, whichever is greater, for breaches of security or
  confidentiality obligations.
- **2025 EA § 15.8(e), Cyber and Privacy Liability Insurance:** $10M coverage,
  including credit monitoring costs for affected parties.
- **Data Processing Addendum** at `https://cloud.google.com/terms/data-processing-addendum`,
  incorporated by reference.

Compared to the OpenRouter-ZDR path, a direct Google integration is
contractually stronger on every dimension: the agreement is UC-signed rather
than commercial, the liability caps are institutionally negotiated rather than
per-tier, the data classification is explicit, and the enforcement mechanisms
include audit rights and breach notification requirements that UC negotiated
directly.

There is one contractual seam, which is the subject of the next section.

---

## 5. Where "school official" lives (and where it doesn't)

<!-- SEC:SCHOOL_OFFICIAL_SEAM -->
FERPA's school-official exception requires the institution to **designate** the
vendor as a school official in writing, and requires the vendor to accept
FERPA obligations. UC's agreement stack handles this designation in two places,
both of which cover Google Workspace (Gmail, Drive, Docs) but **not** Google
Cloud Platform (Vertex AI, Gemini via API):

**2011 Google Apps for Education Master Agreement, § 10.1 (UC Regents ↔ Google):**

> "To the extent that Google has access to 'Education Records,' it is deemed a
> 'school official,' as each of these terms are defined under FERPA, under this
> Agreement and will comply with its obligations under FERPA."

This master covers the Workspace-ancestor services (Gmail, Drive, Docs). It
defines "Customer Data" to explicitly include "any Personally Identifiable
Information, as defined in FERPA, of End Users."

**Google Workspace for Education Data Regionalization Amendment, § 5:**

> "The parties acknowledge that (a) Customer Data may include information from
> education records that are subject to FERPA; and (b) to the extent that
> Customer Data includes such information, Google agrees to be considered a
> 'School Official' (as that term is used in FERPA) and will comply with
> FERPA, as applicable to its provision of the Services as a School Official."

This amendment covers Google Workspace for Education.

**2025 Google Cloud Enterprise Addendum, § 15.1(d):**

The GCP/Vertex agreement contains a **strong no-AI-training clause** but does
**not** use the "school official" formulation. It instead relies on the
no-training commitment + P4 classification + the incorporated Data Processing
Addendum.

### The seam

```
Workspace services:           ✓ "school official" named explicitly
                              ✓ FERPA obligations accepted explicitly
                              ✓ Customer Data defined to include FERPA PII

GCP / Vertex AI / Gemini:     ✗ "school official" not named
                              ✓ Contractual no-training commitment
                              ✓ P4 data classification
                              ✓ Data Processing Addendum incorporated
```

Two reasonable readings of this seam are possible.

**Strict reading.** FERPA's school-official exception requires an explicit
designation. The 2025 EA's § 15.1(d) is strong data protection, but it is not a
FERPA school-official designation. Under this reading, Vertex AI under UCSC's
GCP project is better-protected than OpenRouter-routed Gemini, but still not
the clean "FERPA-covered" path. The clean path for FERPA-protected content
would be Gemini-in-Workspace (e.g., the Gemini side panel in Docs), which
inherits the Workspace school-official designation.

**Pragmatic reading.** The no-training clause, combined with P4 classification
and the Data Processing Addendum, provides contractually equivalent protection
to what school-official designation is meant to ensure: that the vendor use
education records only for the institutional purpose and not for its own
purposes. Under this reading, Vertex AI under UCSC's GCP project is suitable
for FERPA-protected content, with a note that the coverage is by equivalent
terms rather than by the "school official" phrase.

**We do not know which reading UCSC's Office of General Counsel takes.** Both
are defensible. The question is listed in § 8 below. Writing to OGC is the next
step after this document.

In either reading, a direct Google integration is *strictly better* for FERPA
than the current OpenRouter-Gemini path. The question is whether it is
*sufficient* for FERPA without additional measures, or whether sensitive uses
should be directed to Gemini-in-Workspace instead.

---

## 6. The two lanes

<!-- SEC:THE_TWO_LANES -->
If BayLeaf adds a direct Google integration, the model selection in BayLeaf
Chat effectively offers two contractual lanes, and users should be able to see
which one they are in:

| | **Google lane** (proposed) | **OpenRouter lane** (current default) |
|---|---|---|
| **Models** | Gemini family | Anthropic, OpenAI, Meta, xAI, others |
| **Contract path** | UCSC Customer Affiliate → UC-Google EA | OpenRouter commercial ZDR |
| **Who UC has signed with** | Google LLC | OpenRouter (intermediary) |
| **No-training commitment** | 2025 EA § 15.1(d), UC-negotiated | Per-provider ZDR flag |
| **FERPA "school official"** | Not in GCP contract (see § 5) | Not present |
| **Data classification** | UC Protection Level 4 | Not institutionally classified |
| **Breach liability cap** | $20M / 3× annual commitment | Per OpenRouter commercial terms |
| **UC audit rights** | Yes, via EA | No |

Both lanes are acceptable for non-FERPA use. Both lanes prohibit training on
user inputs. The Google lane adds UC-negotiated institutional protections that
the OpenRouter lane, by design, cannot match. OpenRouter is a commercial
broker, not a party to UC's institutional agreements.

A user choosing a model for FERPA-sensitive content should prefer the Google
lane under the pragmatic reading in § 5, and should prefer Gemini-in-Workspace
(outside BayLeaf) under the strict reading.

---

## 7. What this means in practice

<!-- SEC:WHAT_THIS_MEANS -->
### For a faculty or staff member considering BayLeaf for FERPA-relevant work

The first question is whether the content actually contains FERPA-protected
information. FERPA covers PII from education records maintained by the
institution. A paraphrased question about a student's behavior, stripped of
identifiers, is not a FERPA disclosure. A pasted advising note with the
student's name and ID is.

If the content does contain FERPA-protected PII:

- **Do not use the current OpenRouter-default path.** The ZDR commitment is
  real, but UCSC has not designated OpenRouter or its upstream providers as
  school officials, and there is no UC-signed agreement covering the disclosure.
- **If BayLeaf's direct Google integration is available**, this is the best
  path within BayLeaf, and § 5's pragmatic reading probably applies. Whether
  your specific use qualifies is a question to confirm with UCSC's Privacy
  Office or OGC.
- **Gemini-in-Workspace** (e.g., the Gemini side panel in Google Docs under
  your UCSC account) is the cleanest path under § 5's strict reading, because
  it inherits the explicit Workspace "school official" designation.
- **Air-gapped paraphrasing** is almost always the right move. Remove
  identifiers before the prompt; apply the AI's suggestions back onto the
  identified record yourself. This reduces the FERPA surface regardless of
  lane.

### For a student using BayLeaf

BayLeaf is an opt-in service. You are not submitting education records to a
third party by using it. You are sending your own prompts to an AI service.
FERPA does not regulate what you choose to share about yourself. It regulates
what the institution shares about you.

### For a reviewer asking "is BayLeaf FERPA-compliant?"

There are two versions of this question:

1. *Can BayLeaf receive FERPA-protected records from an institutional role
   (faculty, staff, advisor) acting in their professional capacity?*
   Today, no: there is no UC-signed agreement covering that data flow, and
   we do not recommend this use. With a direct Google integration, Google-lane
   models could receive such records under UC's signed GCP agreement, subject
   to OGC's read of the school-official seam (§ 5). The OpenRouter lane remains
   inappropriate for this use regardless.

2. *Does BayLeaf hold education records on behalf of UCSC?*
   No. BayLeaf does not receive data pushes from the Student Information
   System, Canvas, or any institutional record store. It processes whatever
   users type into it. It retains conversation histories (in Open WebUI's
   database) accessible only to the system administrator. See
   [SECURITY.md](SECURITY.md) for the full data-handling picture.

The honest one-sentence answer to "is BayLeaf FERPA-compliant?" is: **"BayLeaf
is not in a position to receive FERPA-protected records under current
architecture; with a direct Google integration, Google-lane models would be a
contractually defensible lane for such content, pending OGC confirmation that
UC's GCP terms satisfy FERPA's school-official requirement."**

---

## 8. Outstanding questions for OGC

<!-- SEC:OGC_QUESTIONS -->
These are the questions that this analysis cannot resolve from the contract
text alone, and that should be directed to UCSC's Office of General Counsel
and/or the UCSC Privacy Office.

1. **School-official coverage for Vertex AI.** Under the 2024 UCSC GCP
   Customer Affiliate Agreement and the 2025 UC Enterprise Addendum § 15.1(d),
   when UCSC faculty or staff use Vertex AI (including Gemini models) through
   a UCSC-administered GCP project, does Google's contractual no-AI-training
   commitment combined with Protection Level 4 classification satisfy FERPA's
   "school official" requirements, given that the explicit "school official"
   designation in § 10.1 of the 2011 master agreement and § 5 of the Google
   Workspace for Education Data Regionalization Amendment is scoped to
   Workspace/Apps services rather than GCP?

2. **Preferred channel for FERPA content.** If BayLeaf offers two lanes
   (Google via direct integration, other providers via OpenRouter ZDR), what
   guidance should we give users about which lane to use for FERPA-protected
   content? Specifically: is the Google lane acceptable, or should FERPA
   content be directed to Gemini-in-Workspace instead?

3. **Designation in writing.** If the Google-lane answer to (1) is "yes,
   equivalently protected," does UCSC need to take any additional formal step
   to designate Google as a school official for GCP/Vertex specifically
   (beyond the existing Workspace designation), or is this covered by the
   existing agreement stack?

4. **Non-Google providers.** For Anthropic, OpenAI, Meta, and other providers
   reached via OpenRouter's ZDR option, we understand that no UC-signed
   institutional agreement exists. Is there a category of BayLeaf use for
   which this is nevertheless acceptable under FERPA (for example, uses where
   no FERPA-protected PII is disclosed, with appropriate user guidance), or
   should these providers be excluded from any workflow that touches
   education records, full stop?

5. **User-side designation.** When a UCSC faculty member pastes FERPA-protected
   content into BayLeaf's OpenRouter-default lane, what is the correct
   characterization? (The institution has not designated any provider as a
   school official for this data flow; the user has chosen to disclose it to
   BayLeaf; BayLeaf has disclosed it to OpenRouter under a commercial ZDR
   agreement; OpenRouter has disclosed it to the provider.) Is this a FERPA
   violation by the institution, by the user, neither, or does it depend on
   facts we have not specified?

Answers to these questions will let us replace the conditional language in
this document with definite statements, update user-facing guidance, and
decide whether to add or omit a direct Google integration.

---

## 9. References

<!-- SEC:REFERENCES -->
### Statute and regulation

- [FERPA, 20 U.S.C. § 1232g](https://www.law.cornell.edu/uscode/text/20/1232g)
- [FERPA Regulations, 34 CFR Part 99](https://www.ecfr.gov/current/title-34/subtitle-A/part-99)
- [34 CFR § 99.31, Disclosures without prior consent](https://www.ecfr.gov/current/title-34/subtitle-A/part-99/subpart-D/section-99.31)

### UC ↔ Google agreements consulted

Held under UC Procurement; not public. Read for this analysis:

- Google Apps Education Edition Agreement (2011), the UC master: establishes
  FERPA "school official" designation for Workspace-ancestor services (§ 10.1).
- Google Cloud Platform License Agreement (2019): establishes GCP under
  UC Protection Level 4.
- UC Enterprise Addendum (2025), current: § 15.1(d) no-AI-training clause,
  § 15.2(c) data-breach enhanced liability cap.
- Google Workspace for Education Data Regionalization Amendment: § 5 FERPA
  "school official" designation for Workspace.
- UCSC GCP Customer Affiliate Agreement (August 2024): UCSC as affiliate
  under the UC Regents parent agreement.
- BAA for G-Suite: HIPAA-scoped, not FERPA, noted for completeness.

### UC policy

- [UC Electronic Information Security Policy, IS-3](https://security.ucop.edu/policies/institutional-information-and-it-resource-classification.html)
  (defines Protection Level 4).

### Related BayLeaf documents

- [SECURITY.md](SECURITY.md): data handling at the platform layer
  (DigitalOcean, Cloudflare, storage, retention).
- [DEPENDENCIES.md](DEPENDENCIES.md): dependency audit and ZDR boundary
  discussion.
- [POSITION.md](POSITION.md): pedagogical position on institutional AI.
