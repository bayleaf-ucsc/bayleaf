# FERPA and BayLeaf

<!-- SEC:INTRO -->
**Service:** BayLeaf AI Playground  
**Operator:** Adam Smith, Associate Professor, Dept. of Computational Media, UC Santa Cruz  
**Status:** Working analysis. Not legal advice. Not reviewed by UCSC Office of
Campus Counsel. The BayLeaf operator is a faculty member of the UCSC AI
Council. This document is an individual faculty analysis, not a Council
position.

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
explicitly. UCSC has already applied this stronger layer to Gemini-in-Workspace
and Notebook LM: the [campus AI Council's published guidance](https://campusai.ucsc.edu/faq/)
approves both tools for use with data up to **Protection Level 3**, which
explicitly includes FERPA-protected student education records. That approval is
scoped to the Google Workspace form of Gemini, not to Vertex AI via the GCP API.

BayLeaf could access the same contractual layer for programmatic use by adding a
direct Google Cloud integration under UCSC's existing Customer Affiliate
Agreement. Whether the campus's P3 approval for Workspace-Gemini *extends* to
Vertex-API-Gemini (both of which sit under the same UC–Google agreement stack)
is the narrower question this document now poses. Other providers (Anthropic,
OpenAI, Meta) remain on the OpenRouter-ZDR path, which is the best contractual
protection available for those models without separate UC-signed agreements.

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

Two readings of this seam are possible.

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

### What UCSC has already said

The UCSC AI Council has **implicitly taken the pragmatic reading for Google
Workspace Gemini**. The Council's [published FAQ](https://campusai.ucsc.edu/faq/)
states (as of February 2026):

> "For staff using either of these tools [Google Gemini, NotebookLM], data can
> be shared securely up to and including [protection level P3]. UC Santa Cruz
> and the UC System have negotiated agreements with Google that include
> protections for university data. The university retains control over how data
> is stored and reused, inputs are not used to train AI models, and
> institutional support is available if something goes wrong."

Protection Level 3, per [ITS's data classification guidance](https://its.ucsc.edu/get-support/it-guides/data-and-it-resource-classification/data-protection-levels/),
explicitly includes "Student education records (these are protected by FERPA)."

In other words: the campus has already determined that UC's Google agreements
provide sufficient contractual protection for FERPA-covered content, at least
when the vehicle is Google Workspace. That determination is the authoritative
campus-level position as of this writing.

### The narrower open question

What the campus has *not* yet determined is whether that same P3 approval
extends to Vertex AI / Gemini accessed through the GCP API, rather than through
the Google Workspace interface. Both paths sit under the same UC–Google agreement
stack and inherit the same § 15.1(d) no-training commitment, the same P4 data
classification (UC's handling tier for GCP overall), and the same Data
Processing Addendum. The technical difference is that Workspace-Gemini is a
managed Google product built on top of Vertex, while direct Vertex access is
the raw API. The contractual difference, such as it is, is whatever additional
protections the Workspace amendments provide beyond the base GCP agreement.

**This is the question that BayLeaf's proposed direct Google integration
raises.** This document presents the analysis as a faculty contribution toward
that eventual campus determination, not as a Council position.

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

FERPA-protected student education records are classified as P3 in UC's data
protection levels. Current campus guidance for P3 data and AI tools
([campusai.ucsc.edu/faq](https://campusai.ucsc.edu/faq/)):

- **Approved for P3:** Google Gemini (Workspace), NotebookLM, Zoom AI (meeting
  summary, in-meeting questions). All accessed through your UCSC Google account.
- **Not approved for P3:** consumer AI tools, any tool not covered by a
  UC-signed institutional agreement.

BayLeaf currently falls in the "not approved" set, because the OpenRouter path
does not sit under a UC-signed institutional agreement. This applies regardless
of which model you select (Gemini included, since today's Gemini-in-BayLeaf
goes through OpenRouter rather than UC's Google contract).

If the content contains FERPA-protected PII, the current options are:

- **Use Gemini-in-Workspace** (the Gemini side panel in Google Docs, Gmail,
  Drive, or gemini.google.com signed in with your UCSC account). This is
  campus-approved for P3 data and inherits the explicit Workspace
  "school official" designation in the UC–Google agreements.
- **Use NotebookLM** under your UCSC account, also campus-approved for P3.
- **Don't use BayLeaf in its current form** for P3 content. Use it for P1/P2
  content: drafting, brainstorming, code, generic Q&A where no student
  identifiers are involved.
- **Air-gapped paraphrasing** is almost always the right move when the task
  itself is P3. Remove identifiers before the prompt; apply the AI's suggestions
  back onto the identified record yourself. This reduces the FERPA surface
  regardless of which tool you use.

If BayLeaf adds a direct Google Cloud integration (under UCSC's existing
Customer Affiliate Agreement), the Google lane within BayLeaf would enter the
same UC–Google contractual envelope as Workspace-Gemini, and the question of
whether that warrants the same P3 approval is the one flagged in § 5 for the AI
Council.

### For a student using BayLeaf

BayLeaf is an opt-in service. You are not submitting education records to a
third party by using it. You are sending your own prompts to an AI service.
FERPA does not regulate what you choose to share about yourself. It regulates
what the institution shares about you.

### For a reviewer asking "is BayLeaf FERPA-compliant?"

There are two versions of this question:

1. *Can BayLeaf receive FERPA-protected records from an institutional role
   (faculty, staff, advisor) acting in their professional capacity?*
   Today, no: there is no UC-signed agreement covering BayLeaf's data flow to
   OpenRouter, and campus guidance accordingly excludes it from P3-approved
   tools. With a direct Google integration, BayLeaf's Google lane would sit
   under the same UC–Google contracts that underpin the already-approved
   Workspace-Gemini and NotebookLM tools, and the AI Council would need to
   decide whether to extend the P3 approval. The OpenRouter lane remains
   inappropriate for P3 content regardless.

2. *Does BayLeaf hold education records on behalf of UCSC?*
   No. BayLeaf does not receive data pushes from the Student Information
   System, Canvas, or any institutional record store. It processes whatever
   users type into it. It retains conversation histories (in Open WebUI's
   database) accessible only to the system administrator. See
   [SECURITY.md](SECURITY.md) for the full data-handling picture.

The honest one-sentence answer to "is BayLeaf FERPA-compliant?" is: **"BayLeaf
in its current OpenRouter-routed form is not among the campus-approved tools
for FERPA-protected content, and users should instead use the Workspace-based
Gemini and NotebookLM tools UCSC has already approved for that purpose; a
proposed direct Google Cloud integration would bring BayLeaf's Google lane
under the same UC–Google contracts as those approved tools, which would raise
the question of whether to extend the P3 approval accordingly."**

---

## 8. Open questions for the AI Council

<!-- SEC:COUNCIL_QUESTIONS -->
These are the questions that this analysis cannot resolve on its own, and that
are most naturally addressed by the UCSC AI Council (with input from the Office
of Campus Counsel and the Privacy Office as needed).

1. **Extending the P3 approval from Workspace-Gemini to Vertex/GCP-Gemini.**
   The Council has approved Google Workspace Gemini and NotebookLM for use with
   P3 data (which includes FERPA-protected education records) on the strength
   of UC's negotiated Google agreements. Vertex AI accessed through the GCP API
   sits under the same UC–Google agreement stack (2019 GCP License, 2025 EA
   § 15.1(d), UCSC Customer Affiliate Agreement, P4 data classification). Does
   the P3 approval extend by reason of contractual coverage, or should it be
   conditioned on additional factors (access patterns, audit visibility, UCSC
   project ownership, etc.)?

2. **Designation mechanism.** If the answer to (1) is "extends," is any formal
   action needed (a written designation of Google as school official for
   GCP-hosted services specifically, a security exception, a data-use agreement
   review) beyond the existing agreement stack? Or is the existing stack
   sufficient on its own?

3. **Scope of the extension.** If GCP-Gemini is approved for P3, does the
   approval extend to:
   - Faculty-operated services like BayLeaf routing through a UCSC-owned GCP
     project?
   - Any UCSC faculty or staff making direct GCP API calls under a campus
     project?
   - Only specific patterns approved case by case?

4. **Non-Google providers.** For Anthropic, OpenAI, Meta, and other providers
   reached via OpenRouter's ZDR option, no UC-signed institutional agreement
   exists. The current campus guidance implicitly excludes these providers from
   P3 use. Should there be a path to approve specific providers (e.g., those
   with enterprise ZDR commitments, specific contract language, or separately
   negotiated UC agreements) for P3, or should P3 remain Google-only for the
   foreseeable future?

5. **User-side characterization.** When a UCSC faculty member pastes
   FERPA-protected content into any AI service that is not on the campus's
   approved list, what is the correct characterization under UC policy? Is it a
   user violation, an institutional gap, or (more realistically) a
   communication problem that the existing guidance already addresses but users
   do not always follow?

Answers to these questions will let us replace the conditional language in
this document with definite statements, update user-facing guidance, and
decide whether and how to add a direct Google integration to BayLeaf.

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

### UC and UCSC policy

- [UC Electronic Information Security Policy, IS-3](https://security.ucop.edu/policies/institutional-information-and-it-resource-classification.html)
  (defines Protection Levels P1 through P4).
- [UCSC ITS: Data and IT Resource Classification, Data Protection Levels](https://its.ucsc.edu/get-support/it-guides/data-and-it-resource-classification/data-protection-levels/)
  (P3 explicitly includes FERPA-protected student education records).
- [UC Responsible AI Principles](https://ai.universityofcalifornia.edu/_files/documents/ai-council-uc-responsible-ai-principles.pdf)
  (the principles the UCSC AI Council applies).

### UCSC AI Council guidance

- [UCSC AI Council homepage (campusai.ucsc.edu)](https://campusai.ucsc.edu/)
- [UCSC AI Council FAQ](https://campusai.ucsc.edu/faq/)
  (approves Workspace-Gemini and NotebookLM for P3 data; the starting point for
  this document's narrower open question).
- [UCSC AI Council charge and membership (ITS)](https://its.ucsc.edu/about/it-governance/artificial-intelligence)

### Related BayLeaf documents

- [SECURITY.md](SECURITY.md): data handling at the platform layer
  (DigitalOcean, Cloudflare, storage, retention).
- [DEPENDENCIES.md](DEPENDENCIES.md): dependency audit and ZDR boundary
  discussion.
- [POSITION.md](POSITION.md): pedagogical position on institutional AI.
