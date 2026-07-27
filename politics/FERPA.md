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

The short version: BayLeaf is not a vendor selling a service to UCSC. It
is an **instrument operated by a UCSC school official** (Adam Smith, in
his faculty capacity) on behalf of the campus community. Adam is already
a school official under 34 CFR § 99.31(a)(1)(i)(A), via the standard UCSC
mechanism: §IX.C of the
[Public Disclosures page](https://registrar.ucsc.edu/calendars-resources/ferpa-privacy/public-disclosures/),
which requires campus officials and employees to sign a written form
indicating their legitimate educational interest before accessing student
records. That status applies to Adam's institutional work whether he uses
a pen, a Python script, or a fleet of cloud subprocessors.

The FERPA question for BayLeaf is therefore not "is BayLeaf a school
official?" but a narrower one: **does Adam's use of subprocessors
(DigitalOcean, Cloudflare, OpenRouter, model providers) constitute
authorized redisclosure on behalf of UCSC under 34 CFR § 99.33(b)?** That
provision permits redisclosure "on behalf of" the institution if the
downstream disclosures themselves fit a § 99.31 exception and the chain
is documented. The technical architecture and contract stack exist to
make that chain defensible.

Today, the chain is governed by commercial Data Processing Addenda
(DigitalOcean, Cloudflare) and OpenRouter's zero-data-retention (ZDR)
provider routing. These are real protections but they are not under
UC-signed agreements, and there is no written UCSC instrument
acknowledging BayLeaf as operating under § 99.33(b). UCSC has approved
Workspace-Gemini and NotebookLM for use with FERPA-protected data at
Protection Level 3 per the
[UCSC AI Council's published guidance](https://campusai.ucsc.edu/faq/);
BayLeaf is not on that published list, though see the July 2026 status
note immediately below, which reports that the responsible campus
officers assess BayLeaf as having reached the same risk threshold as the
tools that are.

> **Status note (June 2026): security controls.** The UCSC Information
> Security Office completed a security review of BayLeaf against the
> [HECVAT](HECVAT.md) and determined that **P3-classified data may be
> used in the BayLeaf system** (review by Brian Hall and Mike Ware,
> reported to the AI Council June 2026). That determination answers the
> UC IS-3 *controls* question: is BayLeaf's architecture secure enough
> to hold data at this tier. The AI Council co-chair then referred the
> separate question of processing FERPA-level data to the University
> Registrar (Tchad Sanger) and, subsequently, the Office of Campus
> Counsel.

> **Status note (July 2026): the referral came back, and it reframed the
> question.** The Registrar and the Vice Provost and Dean of
> Undergraduate Education and Global Engagement (Richard Hughey)
> responded jointly in June 2026 (per correspondence with the operator,
> 22 and 30 June 2026). Their position departs from this document's
> original premise in three ways, and readers should carry that
> departure through the sections below.
>
> 1. **The certification frame was rejected as a category error, not
>    declined on the merits.** Because FERPA is a prohibitory statute
>    (it constrains disclosure rather than granting permissions), the
>    Registrar's office does not regard "certifying a tool as
>    FERPA-compliant" as a coherent act, though tools and practices can
>    certainly be identified as *non*-compliant. There is accordingly no
>    affirmative FERPA authorization instrument for the Registrar to
>    execute. The draft memorandum in [§ 8](#8-a-draft-acknowledgment-memo)
>    is retained as an analytical artifact, not as the operative
>    pathway; see [§ 7.2](#72-what-the-registrars-office-actually-does).
> 2. **The operative campus mechanism is procurement-style data-security
>    review, not a FERPA determination.** Campus exposure is managed
>    through training, development of best practices, and the UC
>    purchasing review processes (**Appendix DS**) that assessed Google's
>    tools and Canvas/Instructure. See
>    [§ 7.3](#73-appendix-ds-the-mechanism-this-document-originally-missed).
> 3. **BayLeaf was assessed as having reached the same risk threshold as
>    the already-approved Google tools.** Treating BayLeaf's HECVAT
>    response as the substantive equivalent of an Appendix DS review, and
>    adding the student-data steward's own input, the Registrar's office
>    characterized BayLeaf as an *internal tool* at the same low risk
>    threshold as Gemini, in the same status as Gemini, and suggested it
>    could be announced in a similar way. Hughey went further, observing
>    that BayLeaf's local origination and operator commitment could make
>    it a better choice for student data than Gemini.
>
> **What this does and does not settle.** It is a considered position
> from the two campus officers to whom the AI Council referred the
> question, and it is the most authoritative statement available on the
> matter. It is also **email correspondence, not a signed determination
> or a published listing**: BayLeaf does not appear on the AI Council's
> published P3-approved tools list at
> [campusai.ucsc.edu/faq](https://campusai.ucsc.edu/faq/), and Principal
> Campus Counsel (Jessica Espinoza), added to the thread on 30 June 2026,
> has not responded as of this writing. This document therefore no longer
> asserts a distinct "FERPA-authorization gate" that BayLeaf has failed
> to clear, because the officers responsible for that gate say it does
> not exist in that form. User-facing guidance in
> [§ 9](#9-what-this-means-in-practice) nonetheless stays conservative
> until the published list changes, since the published list is what a
> user can actually check.
>
> The next step identified in that correspondence is **communication
> rather than execution**: joint outreach on how the three campus tools
> (Workspace-Gemini, NotebookLM, BayLeaf) can be used in teaching,
> paired with recurring reminders about student-records privacy, business
> need to know ([§ 4.6](#46-business-need-to-know-the-user-level-control)),
> and IRB review where use crosses into research
> ([§ 4.7](#47-the-ferpairb-boundary)).

Two things would close the remaining distance between that assessment
and a listing a user can check:

1. **Inclusion in published campus guidance** ([§ 7](#7-the-approval-pathway)).
   This is the lever, and it is a communication artifact rather than a
   legal one. Earlier versions of this document named a *written
   acknowledgment from UCSC* here, on the theory that an affirmative
   FERPA instrument was the missing piece; the Registrar's office has
   since made clear that no such instrument exists to be executed
   ([§ 7.2](#72-what-the-registrars-office-actually-does)). What is
   actually missing is BayLeaf's appearance in the AI Council's
   P3-approved tools list and in the campus outreach that tells faculty
   which tools may be used for which work. The analysis in
   [§ 4](#4-bayleafs-ferpa-basis) and the draft memo in
   [§ 8](#8-a-draft-acknowledgment-memo) remain useful for showing *why*
   the posture is sound, and would support such an instrument if a
   reviewer wanted one, but they are no longer presented as the gate.
2. **Architectural choices that make the chain defensible** ([§ 5](#5-the-contract-stack-beneath-bayleaf)).
   A direct Google Cloud integration under UCSC's existing Customer
   Affiliate Agreement (now demonstrated in private preview via the
   `vertex_pipe` function) puts BayLeaf's Gemini traffic under the same
   UC-signed contracts that cover Workspace-Gemini. AWS Bedrock has been
   identified as a second institutional back-end with a wider model
   catalog (Anthropic, Meta, Mistral, Amazon Nova) under terms parallel
   to GCP's. Models not available through these institutional back-ends
   remain on the OpenRouter-ZDR path, which is the best contractual
   protection available without separate UC-signed agreements.

A caution about proportion, added in July 2026. The subprocessor-chain
analysis that occupies [§§ 4.3](#43-how-the--9933b-chain-is-bound) and
[5](#5-the-contract-stack-beneath-bayleaf) is the most technically
developed material in this document, and it is not what the campus
reviewers engaged. No reviewer in the referral thread raised OpenRouter,
ZDR routing, DigitalOcean, Cloudflare, Vertex, Bedrock, § 99.33(b), or
§ 99.31. What proved load-bearing was the HECVAT response, the
student-data steward's consult, and the characterization of BayLeaf as an
*internal tool*. Readers preparing material for campus review should
weight accordingly: the chain analysis establishes that the posture is
sound, but the artifacts that move a campus process are the
security-review response and the institutional characterization.

This document focuses on the FERPA frame. The platform layer (DigitalOcean,
Cloudflare, Open WebUI's conversation storage) sits under the same
umbrella but is treated in detail in [SECURITY.md](SECURITY.md).
Where platform facts are FERPA-relevant they are summarized here with
pointers.

A note on framing: where prior versions of this document treated
§ 99.31(a)(1)(i)(B) (outside parties as designated school officials) as
the primary path, this version treats § 99.31(a)(1)(i)(A) plus § 99.33(b)
as primary, because the operator's pre-existing school-official status is
the most accurate description of how BayLeaf actually relates to UCSC.
The (B) framing is preserved as an alternative in [§ 4.4](#44-an-alternative-framing-under-a1ib)
in case a reviewer prefers a vendor-shaped instrument. The campus
officers who reviewed BayLeaf independently reached the *internal tool*
characterization without reference to either subsection, which is
external support for the (A) framing over the vendor-shaped one.

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
one for outside parties performing outsourced functions. For BayLeaf, the
internal branch is primary, because the operator already has school-
official status. The outside-party branch is presented for completeness
and as an alternative framing some reviewers may prefer ([§ 4.4](#44-an-alternative-framing-under-a1ib)).

**§ 99.31(a)(1)(i)(A): internal school officials.** Disclosure is
permitted to "other school officials, including teachers, within the
agency or institution whom the agency or institution has determined to
have legitimate educational interests." This is the branch that covers,
e.g., a faculty member consulting with a colleague about a shared
advisee. No contract is needed; the relationship is internal.

**§ 99.7: annual notification.** A separate obligation, sometimes
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
campus officials and employees, and is the document the BayLeaf
operator has signed in the normal course of UCSC employment.

**§ 99.31(a)(1)(i)(B): outside parties as school officials.** A
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

This branch is the natural fit for an enterprise vendor (Instructure,
Canvas, Zoom). It is an awkward fit for a faculty-operated tool whose
operator is already inside the institution; see [§ 4.4](#44-an-alternative-framing-under-a1ib).

**§ 99.31(a)(1)(ii): reasonable methods.** Institutions must use
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

§ 99.33(b), the **"on behalf of" redisclosure exception**:

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
exception (in practice, each downstream party must itself meet the
(a)(1)(i)(B) criteria *with respect to the vendor's contract with it*),
and the chain must be documented.

This matters for BayLeaf in a specific way. Whether the school official
on UCSC's side is the operator personally (under (a)(1)(i)(A)) or a
designated outside party (under (a)(1)(i)(B)), the chain of subprocessors
beneath that school official is governed the same way: each downstream
disclosure must fit a § 99.31 exception, and the chain must be documented.
The institution reviews the school official; the school official manages
the chain.

### 1.4 What FERPA does not require

FERPA does not require any specific technical architecture, any specific
certification, or any specific data-residency outcome. What it requires
is a contractual and operational framework in which the school official
on the institution's side has authority to handle the records, and any
redisclosure to subprocessors is governed by § 99.33(b). A more detailed
list of common misconceptions appears in [§ 4.5](#45-what-acknowledgment-does-not-require).

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

Structurally, the colleague-to-you part is unchanged. Both parties remain
school officials under (a)(1)(i)(A); a school official is still consulting
a tool operated by another school official. But the moment the prompt
leaves your laptop it enters a pipeline:

```
BayLeaf Chat (DigitalOcean) → OpenRouter → Anthropic (ZDR)
```

That pipeline is a series of disclosures to subprocessors. § 99.31(a)(1)(i)(A)
covers the disclosure **from your colleague to you**. It does not cover
the disclosures from the BayLeaf service to DigitalOcean, to OpenRouter,
to Anthropic. Each of those hops needs its own FERPA basis.

The applicable basis is § 99.33(b), the **"on behalf of" redisclosure
exception**: the institution may permit a party (here, the school official
operating the tool) to make further disclosures on the institution's
behalf, provided each downstream disclosure itself fits a § 99.31
exception and the chain is recorded. In practice, each downstream party
must be contractually bound to use the data only for the purpose of
providing the service, prohibit further unauthorized redisclosure,
forbid training on the data, and provide adequate security. These are
substantively the same conditions that establish "direct control" under
(a)(1)(i)(B); the difference is which side of the chain they attach to.

Stated more plainly: BayLeaf the tool is not a school official.
BayLeaf the tool is the chain of subprocessors that a school official
(Adam, in his UCSC institutional capacity) uses to do institutional
work. The FERPA question for that chain is whether each link is bound
by terms compatible with § 99.33(b).

BayLeaf currently has *no* UCSC acknowledgment of this arrangement. The
operator is a school official; the subprocessor chain runs on commercial
ZDR contracts that are real but not UC-signed; the campus has not yet
written down that the chain qualifies as authorized § 99.33(b) redisclosure
for any particular protection level. This is the gap the rest of the
document addresses.

The key reframing: the question is not "has UCSC approved OpenRouter
and DigitalOcean?" and it is not "has UCSC designated BayLeaf as a
school official?" The question is "**does UCSC acknowledge that the
school official operating BayLeaf may use this subprocessor chain to
process records up to a specified protection level under § 99.33(b)?**"

---

## 3. BayLeaf's architecture and data flows

<!-- SEC:BAYLEAF_ARCHITECTURE -->

### 3.1 Subprocessor chain and inference paths

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

**Inference layer.** Where prompts are processed by a model. Three
back-ends are now relevant:

- **OpenRouter** (current default for most models): commercial
  intermediary routing to provider endpoints with ZDR flag enabled.
- **Direct Google Cloud / Vertex AI** (private admin-only preview today;
  productionization scoped by AI Council designation work): UCSC-managed
  GCP project under UCSC's August 2024 Customer Affiliate Agreement,
  which inherits the UC ↔ Google master agreements. See
  [§ 5.2](#52-inference-layer-proposed-direct-google-cloud).
- **AWS Bedrock** (identified as a second institutional back-end with a
  wider model catalog: Anthropic Claude, Meta Llama, Mistral, Amazon
  Nova): under UC's enterprise AWS agreements. See
  [§ 5.3](#53-inference-layer-proposed-aws-bedrock).
- **NRP / SDSC** ([National Research Platform](https://nrp.ai/)):
  configured alternative serving open-weight models on NSF-funded
  research infrastructure at UC San Diego. Currently disabled because
  NRP's policy is to log prompts.

For the purpose of FERPA analysis, the question is: when a user sends a
prompt to BayLeaf, where does that prompt go, and under what contract is
it processed?

For most of BayLeaf's user-facing traffic today, there is **no direct
UCSC-to-provider LLM connection**. When a user selects "Gemini 2.5 Pro"
or "Claude Sonnet" in BayLeaf Chat, the request goes to OpenRouter,
which forwards it to the provider's endpoint under OpenRouter's
commercial agreement, not under any UCSC agreement. The Vertex AI demo
exists in private preview; productionizing it (and adding a Bedrock
sibling) is the architectural change that pairs with the FERPA
acknowledgment described in this document.

This is the fact that most shapes [§ 4](#4-bayleafs-ferpa-basis) and the contract-stack
discussion in [§ 5](#5-the-contract-stack-beneath-bayleaf).

### 3.2 Data taxonomy: FERPA categories BayLeaf would handle

The FERPA-basis analysis in [§ 4](#4-bayleafs-ferpa-basis) is abstract about *what* education
records flow through BayLeaf. This subsection makes the data concrete.
It is organized by entry path (how the data arrives at BayLeaf) rather
than by FERPA sub-classification, because the entry path is what
determines which subprocessors see the data and under what contract.

The categories below are written to be read by reviewers from Counsel,
the Privacy Office, and ISO who need to know what the acknowledgment
would actually cover. Some of this data already transits BayLeaf today
(via user copy-paste and existing tools); some is speculative under
the BayLeaf Courses redesign tracked in
[GitHub issue #5](https://github.com/bayleaf-ucsc/bayleaf/issues/5).

#### 3.2.1 Data already transiting BayLeaf today

These flows exist now, regardless of any Courses redesign or expanded
tooling. They are the floor of the FERPA surface.

- **Account identity tied to enrollment status.** OWUI accounts on
  `chat.bayleaf.dev` are keyed by UCSC SSO (CruzID + email). The mere
  existence of an account is a weak FERPA signal (the account-holder
  is a current or recent UCSC affiliate); group membership is a
  stronger one. The invite-code-gated user groups described in
  [chat/AGENTS.md](../chat/AGENTS.md) function in practice as a
  derived enrollment list for each course that uses BayLeaf, even
  though no Canvas integration pushes the data: students self-select
  into the group, and the group membership becomes a record of "these
  people are in CMPM-X-fall-2026."
- **Conversation histories.** Open WebUI persists every chat in its
  Postgres database on DigitalOcean until administratively deleted.
  Whatever a faculty member, TA, or advisor pastes into a prompt
  becomes durable state at the platform layer, before any inference-
  provider ZDR boundary applies. Real examples already observed
  include pasted advising notes, draft assignment feedback, screenshots
  of SpeedGrader, exported gradebook CSVs, and lists of students who
  have not submitted. Retention is governed by
  [chat/RETENTION.md](../chat/RETENTION.md); the FERPA point is that
  OWUI's database is itself an education-records store the moment a
  user pastes one in.
- **Tool-call return values cached in conversation history.** When a
  tool like the campus directory or Google Workspace toolkit returns
  results, those results are serialized into the message stream and
  persisted with the rest of the conversation. Tool returns inherit
  the storage and retention posture of conversation histories. As
  agent autonomy grows (more tools, longer tool chains), the volume
  of FERPA-relevant data deposited via this path scales accordingly.
- **Workspace model definitions.** Course-specific system prompts
  authored by teachers may name students, reference accommodation
  status, or embed roster-derived norming examples. These live in
  OWUI's model-configuration tables, not in chat history, and have
  different access patterns (admin-readable, exported in backups).
  Today this is rare; under the Courses redesign it becomes routine
  ([§ 3.2.2](#322-data-plausible-under-the-courses-redesign)).
- **Derived outputs that become FERPA on departure.** Agent-generated
  drafts of feedback, recommendation letters, advising emails, or
  conduct referrals are not FERPA records inside BayLeaf, but the
  moment a user pastes them into Canvas, an advising file, or
  institutional email, they become education records. The boundary
  moves with the artifact's destination, not its origin. This matters
  for designation because the upstream prompt that produced the draft
  often did contain FERPA inputs (the student's prior work, grades,
  or accommodation context), and the draft itself was held in OWUI
  during its creation.

#### 3.2.2 Data plausible under the Courses redesign

The redesign tracked in
[GitHub issue #5](https://github.com/bayleaf-ucsc/bayleaf/issues/5)
keeps BayLeaf Courses itself stateless (Canvas and OWUI are sources
of truth) but introduces flows of FERPA data through prompts and tool
returns that do not exist today. The list below names the categories
the acknowledgment should anticipate.

**Roster and section-level enrollment.** A student-facing course
agent that gives section-aware advice ("you are in Section B, your TA
holds office hours Tuesday at 3pm") needs section-of-enrollment data
in its context. Today this is approximated by invite-code groups; the
redesign makes it a direct Canvas-API read. The data class is
unambiguously FERPA: enrollment is an education record, and
section-of-enrollment joined with name is sufficient to re-identify.

**Assignment-level academic record.** A course agent that helps a
student interpret feedback on a past submission needs read access to:
the rubric, the student's submission, the grader's comments, and the
score (whether published or still provisional in SpeedGrader).
Provisional grades are an extra-sensitive sub-category: they are
records the institution holds about the student that the student has
not yet been told about. A grading-automation agent operated by
teaching staff reads the same data class for the entire roster in a
loop, with proportionally larger blast radius.

**Disability accommodation status (DRC letters).** The single
highest-policy-weight FERPA sub-category. If a course agent is asked
to "tailor advice" or if a teacher-side agent is asked to design
section-appropriate quizzes, the prompt context can naturally pull in
"three students in Section B have extended-time accommodations." DRC
data is FERPA, classified P3 under UC IS-3, and additionally subject
to UC accessibility-policy redisclosure conventions.

**Attendance and engagement signals.** Canvas analytics (page views,
last-login timestamps, participation rates) are records "directly
related to a student and maintained by the institution," squarely
inside FERPA's definition. A "student check-in" agent or a
teacher-side "who is at risk" agent leans on these.

**Behavioral, conduct, and academic-integrity context.** A course-
admin agent helping a teacher draft an academic-integrity referral,
a late-add petition response, or a SOAR follow-up will be exposed to
FERPA records that carry additional release restrictions (Title IX
redaction conventions, conduct-office handling rules). The data
class is FERPA at its core; the policy stack on top is heavier than
for, e.g., assignment scores.

**Letters of recommendation and underlying records.** Faculty using
BayLeaf to draft an LOR will paste transcripts, GPA, prior course
performance, and comments from past instructors. Note the FERPA
waiver consideration: a student waiver authorizing release of
education records to a *named recipient* (e.g., a graduate program)
does not authorize redisclosure to OpenRouter, Anthropic, or any
inference subprocessor. The drafting workflow needs FERPA cover from
the institutional designation, not from the student's recipient-
specific waiver.

**Advising notes and degree-progress data.** Major declarations,
holds, prerequisite completion, registration restrictions, advisor
session notes. The student-facing "tailored advice" use case bleeds
into this surface as soon as the agent knows enough to say "you have
not yet completed the prerequisite for X."

**RAG corpora of prior student work.** If teachers attach exemplary
past submissions, grader-norming exemplars, or canonical-mistake
collections to a course agent's knowledge base, those are student
work products. Even with originating-student permission, redisclosure
to model-provider subprocessors is governed by § 99.33; the
permission was given to the institution, not to the subprocessor
chain.

**Lecture recordings and transcripts naming students.** Class
recordings and Q&A transcripts contain student utterances and names.
Zoom AI is already P3-approved campus-side, but feeding transcripts
into a course agent for "make a study guide from last week's class"
re-disclosures the student utterances inside through BayLeaf's
inference path.

**Discussion-board posts and group-work records.** Canvas discussions,
group submissions, and peer-review records all name students. A
teacher-side agent summarizing class participation reads across all
of these.

**Quiz-attempt logs and timing data.** Quiz answer logs with
timestamps, attempt counts, and per-question response times are
education records. They are also the data class most frequently
involved in academic-integrity questions, which links this category
to the conduct sub-category above.

**Joins across categories.** The cross-product is often more
sensitive than any individual column. Name + section is mild; name +
section + assignment scores + attendance + accommodation status
becomes a re-identifiable academic profile even if any one column
looks innocuous on its own. Course-specific agents that "know which
section the student is in" are constructing exactly this join inside
the prompt, and the acknowledgment needs to cover the join, not just
the columns.

#### 3.2.3 Inbound paths from the Canvas API

The teacher-staff use case is the highest-volume and highest-risk
flow, both today and under the redesign. Today, teaching
staff use the BayLeaf Code Sandbox feature with command-line tools
like [`canvaslms`](https://github.com/dbosk/canvaslms) to manipulate
student data via the Canvas API. The status of this practice was
restated in July 2026: BayLeaf is ISO-cleared for P3 security controls
(June 2026) and was assessed by the Registrar's office as an internal
tool at the same risk threshold as the campus's approved Google tools,
but BayLeaf is not on the published P3-approved list, so a cautious
reading has this practice running ahead of what the *published* guidance
covers. Earlier versions of this document called it "policy-violating"
and awaiting an acknowledgment; that overstated both the prohibition and
the remedy, since no tool-level FERPA authorization is issued
([§ 7.2](#72-what-the-registrars-office-actually-does)).

The sharper question for this flow is not which service processes the
prompt but whether the operating user has a business need to know the
records their agent reaches
([§ 4.6](#46-business-need-to-know-the-user-level-control)). A faculty
member automating work on their own course's Canvas data is inside the
boundary the campus actually polices. The same tooling pointed at data
reached through broader institutional access is not, whatever tool is
used and whatever list it appears on.
The data classes that flow through this
path include all of [§ 3.2.2](#322-data-plausible-under-the-courses-redesign), with two architectural
notes:

- **The data transits the inference provider's context window.** Tool
  results from Canvas API calls are appended to the conversation
  before the next model turn. Whatever ZDR posture the inference
  provider has, the data passes through.
- **The data also transits the sandbox runtime.** If the Code Sandbox
  feature is the execution venue, student data is written to a
  Daytona / Lathe sandbox file system and stdout, which has its own
  retention and access posture distinct from the OWUI database.

#### 3.2.4 Blast-radius asymmetry between user and teacher use cases

Student-facing course agents handle a small cone of data per student
per session: one student's enrollment, one student's submissions, one
student's prior feedback. Teacher-facing course-administration agents
read the entire roster's data in a loop. The volume difference is two
to three orders of magnitude, and the contractual exposure scales
with volume even when the per-record posture is identical.

This asymmetry matters for the protection-level decision in § 7 of
the acknowledgment memo ([§ 8](#8-a-draft-acknowledgment-memo)). An acknowledgment that authorizes
BayLeaf for P3 in the student-facing use case but is silent on the
teacher-facing automation case leaves the highest-volume flows
uncovered. An acknowledgment that authorizes both should include a
corresponding expectation in Appendix B (security controls) about the
handling of high-volume teacher-side flows specifically: rate limits on
automation, logging requirements, and review of agent-driven Canvas
API usage patterns.

#### 3.2.5 Data BayLeaf does not and would not handle

For completeness, the categories the acknowledgment memo's § 6
("Scope of data") already disclaims:

- **Direct Student Information System pushes.** BayLeaf does not
  receive AIS / Banner / SIS data feeds. It does not maintain a
  shadow registrar's database.
- **Pre-enrollment applicant data.** Admissions records are not in
  scope.
- **Financial-aid records.** Not in scope; covered by separate
  federal frameworks (GLBA, plus FERPA's financial-aid carve-outs)
  that the acknowledgment does not cross.
- **Health records covered by HIPAA.** UCSC's BAA stack covers
  Workspace for HIPAA, not BayLeaf. Health information that happens
  to also be FERPA-protected (some DRC documentation) is in scope as
  FERPA, but the acknowledgment does not extend to HIPAA-only categories.

---

## 4. BayLeaf's FERPA basis

<!-- SEC:FERPA_BASIS -->

### 4.1 The operator is the school official; BayLeaf is the chain

BayLeaf's FERPA basis has two pieces, mapped onto the structure
established in [§§ 1.2](#12-the-school-official-exception)–[1.3](#13-redisclosure-and-the-subprocessor-chain):

1. **The school official on UCSC's side is Adam, under § 99.31(a)(1)(i)(A).**
   Adam is a tenured UCSC faculty member acting in his institutional
   capacity. He has access to education records in the normal course of
   his teaching, advising, and administrative work, on the same basis as
   any other UCSC faculty member: §IX.C of the
   [Public Disclosures page](https://registrar.ucsc.edu/calendars-resources/ferpa-privacy/public-disclosures/)
   requires a written form indicating legitimate educational interest
   before any campus official accesses student records, and that form
   is the standing UCSC artifact discharging the (a)(1)(i)(A)
   designation. Adam has signed it as a condition of employment. This
   designation applies to the work, not to the tool: it covers Adam
   whether he writes notes by hand, runs a Python script, or uses a
   chain of cloud subprocessors.
2. **The subprocessor chain BayLeaf uses is governed by § 99.33(b).**
   When Adam, in his capacity as a school official, uses a chain of
   subprocessors (DigitalOcean, Cloudflare, OpenRouter, model providers)
   to perform that institutional work, each disclosure to a subprocessor
   must fit a § 99.31 exception and the chain must be documented.
   § 99.33(b) is the provision that permits this: the institution may
   permit "further disclosures … on behalf of the educational agency or
   institution" if the downstream disclosures meet § 99.31 and the chain
   is recorded. Substantively, this requires each subprocessor to be
   bound by terms equivalent to the (a)(1)(i)(B) "direct control"
   conditions: use limited to the institutional purpose, no
   unauthorized redisclosure, no training on the data, adequate
   security, and termination with deletion.

This framing matches the way BayLeaf actually operates. UCSC has not
outsourced to BayLeaf, and Adam is not a vendor with whom UCSC
contracts. Adam is a school official already; BayLeaf is the
sub-processor chain that exists because the work it supports is
unavoidably cloud-mediated.

### 4.2 What UCSC's acknowledgment would say

What BayLeaf needs from UCSC is not a designation in the (a)(1)(i)(B)
vendor sense (which presupposes an outside party UCSC has outsourced to,
which Adam is not). It is a written acknowledgment that:

1. UCSC recognizes BayLeaf as an instrument operated by a UCSC school
   official under § 99.31(a)(1)(i)(A), in support of teaching, research,
   and administrative functions UCSC would otherwise staff directly.
2. The subprocessor chain BayLeaf relies on (Appendix A of the memo in
   [§ 8](#8-a-draft-acknowledgment-memo)) is governed by § 99.33(b) redisclosure terms, propagated
   through the operator's contracts with each subprocessor.
3. The acknowledgment is scoped to a specified UC IS-3 protection level,
   and the controls and conditions appropriate to that level are set
   out in Appendix B.
4. The arrangement is bounded by the operator's continued institutional
   role: if Adam ceases to hold an appointment that includes
   school-official status, the acknowledgment terminates and remaining
   records are destroyed.

This is what the draft memo in [§ 8](#8-a-draft-acknowledgment-memo) provides. It is not a vendor
contract; it is a written record of an arrangement that already exists
in substance, brought into the form UCSC's review processes can
recognize.

### 4.3 How the § 99.33(b) chain is bound

Each subprocessor in BayLeaf's chain must be contractually bound on
substantively the same terms a directly-controlled outsourced party
would accept under (a)(1)(i)(B). The terms a reviewer should look for:

- **Use limited to providing the service.** The subprocessor uses
  customer data only to deliver what it has been asked to deliver, not
  for its own purposes (analytics, training, profiling, sale).
- **No unauthorized redisclosure.** The subprocessor does not pass data
  to its own vendors except under equivalent terms.
- **No training on customer data.** This is the AI-specific extension
  of the redisclosure prohibition; training-on-input would constitute
  a use beyond the institutional purpose. ZDR commitments and
  no-training clauses are how this is operationalized in modern
  contracts.
- **Appropriate security.** Encryption in transit and at rest, access
  controls, breach notification, incident response.
- **Termination with deletion.** When the relationship ends, customer
  data is returned or destroyed.

The state of these terms across BayLeaf's subprocessors is summarized
in [§ 5](#5-the-contract-stack-beneath-bayleaf). In short: DigitalOcean and Cloudflare have standard
commercial DPAs that meet these requirements. OpenRouter restricts
routing to ZDR provider endpoints, where the no-training and
no-retention commitments are enforced contractually. The non-uniform
piece of the chain is the model-provider layer: those providers'
commitments to OpenRouter are not under UC-signed agreements. Direct
Google Cloud (already demonstrated in private preview) and AWS Bedrock
(identified as a second institutional back-end) bring large slices of
that layer under UC-signed terms. Models without an institutional
back-end available remain on the OpenRouter-ZDR path; the
acknowledgment can scope which protection levels are appropriate for
which inference path.

### 4.4 An alternative framing under (a)(1)(i)(B)

Some reviewers may prefer the (a)(1)(i)(B) "outside party" frame
because it is the path UCSC's vendor-review processes are built around.
The regulation's "contractor, consultant, volunteer, or other party"
language is broad enough to cover BayLeaf under that frame: "volunteer"
is a defensible descriptor for a faculty member operating an
institutional service without compensation, and ED has not published
guidance excluding faculty-operated services from (a)(1)(i)(B). What
the frame would require is the same set of controls described in
[§ 4.3](#43-how-the--9933b-chain-is-bound), restated as commitments BayLeaf-the-instrument makes to
UCSC: institutional service, direct control, redisclosure limits.

The substantive review is the same under either frame. The frames
differ in their fit:

- **(a)(1)(i)(A) + § 99.33(b) (primary).** Matches the reality: the
  operator is already a school official; BayLeaf is his chain of tools.
  No fictional "outsourcing" needs to be asserted. Cleanly bounded by
  the operator's continued institutional role.
- **(a)(1)(i)(B) (alternative).** Matches UCSC's vendor-review
  templates more directly. Asserts an outsourcing relationship that is
  formally artificial (UCSC does not contract with Adam-as-vendor) but
  produces a similar instrument.

The memo in [§ 8](#8-a-draft-acknowledgment-memo) is written in the (a)(1)(i)(A) + § 99.33(b) form.
A short note at the end of the memo records the (a)(1)(i)(B) translation
for reviewers who prefer that framing.

### 4.5 What acknowledgment does not require

Several things a reasonable reviewer might expect to be prerequisites
are in fact not required by FERPA:

- **Transparent vetting of every subprocessor by UCSC.** UCSC reviews
  the school official on its side; the school official manages the
  chain under § 99.33(b). UCSC does not need to review DigitalOcean's
  DPA line-by-line; it needs the operator to have done so, and to have
  recorded the chain in Appendix A.
- **Vendor retention of education records prohibited.** FERPA does not
  ban retention; it regulates disclosure and redisclosure. ZDR is a
  *stronger* commitment than FERPA alone requires, useful for the
  inference layer.
- **U.S.-only hosting or specific encryption schemes.** FERPA is
  technology-neutral. Such requirements may flow from UC IS-3 or other
  institutional policies, but not from FERPA itself.
- **A no-training contractual clause as a FERPA requirement per se.**
  Training on user data would ordinarily constitute use beyond the
  institutional purpose and thus violate § 99.33(a) redisclosure
  limits, so a no-training commitment is FERPA-relevant; but the FERPA
  obligation is the redisclosure limit, not the clause.
- **Industry certifications.** SOC 2, ISO 27001, FedRAMP attestations
  are evidence of security maturity. They are neither substitutes for
  the FERPA framework nor required to obtain one.
- **Paid vendor status or a procurement event.** Neither is named in
  the regulation.
- **Exclusivity.** BayLeaf's acknowledgment does not conflict with
  UCSC's existing designations of Workspace-Gemini or NotebookLM, or
  of other vendors for other functions.

What acknowledgment *does* require is the three-part instrument in
[§ 4.2](#42-what-ucscs-acknowledgment-would-say): role recognition, chain documentation under § 99.33(b),
protection-level scope. The memo in [§ 8](#8-a-draft-acknowledgment-memo) provides all three in
concrete form. Note the July 2026 qualification in the
[introduction](#ferpa-and-bayleaf): the Registrar's office does not treat
such an instrument as something it issues, so this subsection describes
what an acknowledgment *would* require rather than a live requirement.

### 4.6 Business need to know: the user-level control

The analysis to this point locates FERPA risk in the *chain*: which
subprocessor sees what, under which contract. When the Registrar and
VPDUEGE reviewed BayLeaf in June 2026, they located it somewhere else
entirely, in the **user**. Their operative doctrine is *business need to
know*, and it is worth stating plainly because it decodes an otherwise
vague concern and because this document previously underweighted it.

The doctrine, as the Registrar's office applies it:

- Within the University, access to student information requires a
  business need to know. This is the operational face of "legitimate
  educational interest" ([§ 1.2](#12-the-school-official-exception)).
- **All faculty have a business need to know the student records for the
  classes they have offered.** A department analyzing its own course
  offerings or curriculum is likewise fine. These are the ordinary cases,
  and they are unproblematic.
- A **limited number** of faculty hold broader access, through MyUCSC,
  through Infoview / AIS-Daily, or through staff who have such access.
  This is where the concern lives: data reached through those broader
  channels can be explored in ways that exceed the explorer's business
  need to know, whether for internal purposes or by drifting into human
  subjects research ([§ 4.7](#47-the-ferpairb-boundary)).

Two consequences for reading the rest of this document.

**First, this decodes the Registrar's stated concern about "merging data
beyond a faculty member's specific class information."** That phrase does
not describe a subprocessor-redisclosure problem. It describes a faculty
member with institution-wide data access using a capable tool to join and
roam across records they have no business need to know. The concern was
explicitly noted as **not specific to BayLeaf or the Gemini tools**: it
attaches to any system that makes such exploration easy.

**Second, it reframes the blast-radius argument in
[§ 3.2.4](#324-blast-radius-asymmetry-between-user-and-teacher-use-cases).**
That subsection treats teacher-side automation as a protection-level
question (higher volume implies more contractual exposure). The
need-to-know frame asks a different and sharper question: is the *scope*
of records a given agent run touches bounded by the operating user's
legitimate interest? A faculty member's own roster is in bounds at any
volume. A cross-department join is out of bounds at volume one. Volume
and scope are independent axes, and the campus control is on the scope
axis.

This is a control BayLeaf can support but not enforce. BayLeaf has no
knowledge of which records a given user has a business need to know,
because it holds no roster or enrollment data of its own
([§ 3.2.5](#325-data-bayleaf-does-not-and-would-not-handle)); the
credentials a user supplies to a tool or sandbox determine reach. What
BayLeaf can do is make the boundary salient at the point of use: name it
in user-facing guidance, and surface it in the tool descriptions for
anything that reaches institutional data through user-supplied
credentials. That is the concrete ask arising from this subsection.

### 4.7 The FERPA/IRB boundary

Both the Registrar and the VPDUEGE raised human subjects research
independently, and neither treated it as settled by anything in this
document. Earlier versions of this file said nothing about IRB at all,
which was a genuine gap: the data taxonomy in
[§ 3.2](#32-data-taxonomy-ferpa-categories-bayleaf-would-handle) is
organized by entry path and protection level, with no axis for *purpose
of use*.

The scenario the Registrar posed: a faculty member has survey responses
that students completed as part of a course. Using that data to run the
course is ordinary instructional use. Using it to write a paper about the
relationship between the survey responses and student performance is a
shift from class information to human subjects research, and most likely
requires IRB review to determine whether the use is exempt or falls into
another category.

Three points that matter for BayLeaf specifically:

1. **The boundary is about purpose, not about the tool, and not about
   FERPA.** Nothing in the FERPA analysis in this document authorizes
   research use of education records. Any of the three campus tools could
   be used for research on student data; the IRB obligation attaches to
   the research, not to the software. Were UCSC to execute the memo in
   [§ 8](#8-a-draft-acknowledgment-memo), it would not touch this
   obligation, and § 6 of that memo ("Scope of data") should not be read
   to imply otherwise.
2. **Agent assistance makes the drift easier and less deliberate.** The
   analysis in this document has previously argued that BayLeaf gives
   faculty no data-collection capability they lacked (they could already
   send a Google Form or a Canvas quiz); what is new is agent-assisted
   *analysis* of data already collected. That is precisely the step where
   instructional use slides into research use, and it can now happen in a
   single conversational turn, without the deliberate project setup that
   used to prompt a researcher to think about IRB.
3. **Campus guidance is being written.** The Office of Research Compliance
   Administration (ORCA) is working with the University Registrar on
   guidance for researchers using education record information. BayLeaf's
   user-facing material should point at that guidance once published
   rather than restating it, and the joint three-tool outreach identified
   in the July 2026 status note should carry an IRB reminder.

For present purposes the operative statement is: **BayLeaf is not
operated as a research instrument.** It does not collect data for the
operator's own findings, and it does not maintain a corpus for research
use. But it is fully capable of being *used* for research on student
data by a faculty member who has that data, and that use requires IRB
review independent of any FERPA posture described here.

---

## 5. The contract stack beneath BayLeaf

<!-- SEC:CONTRACT_STACK -->
The FERPA basis in [§ 4](#4-bayleafs-ferpa-basis) describes the shape of
the arrangement; the contract stack beneath BayLeaf determines how strong
it is. § 99.33(b) requires that
each downstream disclosure fit a § 99.31 exception, which in practice
requires each subprocessor to be bound by terms equivalent to the
(a)(1)(i)(B) "direct control" conditions ([§ 4.3](#43-how-the--9933b-chain-is-bound)). This section
walks the inference layer in detail and references the platform layer
briefly.

Read this section as establishing that the posture is sound rather than
as satisfying a campus requirement. As the July 2026 status note records,
no campus reviewer engaged the subprocessor chain, and the review that
actually cleared BayLeaf was a security-controls assessment. The contract
analysis remains the honest account of where prompts go and under what
terms, which is worth having on its own merits and is what a future
reviewer would need if the chain ever became contested.

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

BayLeaf applies this same no-retention standard to **itself** on the
intermediary hops. The BayLeaf API (Cloudflare) stores no prompt or
completion content, disables request tracing, and exposes no operator
interface to read request content in flight: a zero-operator-access
*posture* in the sense of the [AWS Mantle design](https://aws.amazon.com/blogs/machine-learning/exploring-the-zero-operator-access-design-of-mantle/),
though not a hardware-attested guarantee (`SECURITY.md §2.3a`). BayLeaf
Chat is the deliberate exception: it stores conversation history so users
can carry chats across devices, and that history sits in an
administrator-readable database outside the ZDR boundary. The ZDR/ZOA
posture covers the **inference and proxy layers**, not Chat's stored
conversation history.

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

A working private proof-of-concept of this path now exists in BayLeaf
Chat (admin-only, surfacing both Google's Gemini models and third-party
MaaS open models via the [`vertex_pipe`](../chat/functions/vertex_pipe/) 
function). The pipe holds a Google service-account JSON in an admin-only 
valve, mints short-lived access tokens locally, and proxies chat completions 
to the Vertex AI OpenAI-compatible endpoint
(`{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi/chat/completions`).

Regarding Zero Data Retention (ZDR) on this Vertex path: Google's
documentation confirms that for third-party MaaS open models (e.g., Zhipu AI,
Mistral), prompts and responses are **not** shared with the third-party
publisher. However, to achieve parity with OpenRouter's ZDR, a project-level
exception for Google's Abuse Monitoring (which otherwise retains flagged prompts
for up to 90 days) must be granted. That request was filed for the
`bayleafchat` GCP project but **received no response from Google after more
than three weeks** (well past the stated ~2-week SLA).

**Status (disabled): Because we could not obtain the Abuse Monitoring
opt-out, we cannot promise ZDR parity with our OpenRouter path, and the
Vertex backend has been disabled on both services** (issue #36):

- **BayLeaf Chat:** the `vertex_pipe` function is set inactive, removing its
  models from the picker. The function and its admin valves are retained so
  the path can be restored quickly if a credible ZDR path opens.
- **BayLeaf API:** a `VERTEX_ENABLED` env flag (default `"false"`) gates all
  `vertex:` routing, model listing, and curated-model exposure; `vertex:`
  completions are rejected with HTTP 503 while disabled.

The contract analysis below remains valid as analysis, but no live traffic
flows over this path while it is disabled. The most likely route back to a
BAA-covered ZDR backend is **Amazon Bedrock** under UCSC's existing AWS
agreement (issue #41), which is ZDR-by-default; the API's backend-enablement
design is built to admit Bedrock symmetrically.

This demonstrates that the architectural path is real and the contract
chain below attaches to live traffic. Productionizing it (broader user
exposure, an institutional GCP project under UCSC ITS, key-rotation
policy, and a written Council-facing risk rating) is the conversation
the [HECVAT](HECVAT.md) and AI Council designation work is now
shaping.

UCSC has a signed **Customer Affiliate Agreement** with Google (executed
August 2024, Google Customer Affiliate ID 7947-1465-9142). This
agreement makes UCSC a ratified affiliate under the parent **UC Regents
↔ Google Cloud Platform License Agreement** (originally 2019) and its
current **Enterprise Addendum** (2025). The affiliate agreement is
administrative plumbing: it does not reopen contract terms, it simply
binds UCSC to the UC-wide agreements already in force.

If BayLeaf routes Gemini traffic through this direct Google Cloud
integration (as it does today for the private demo, and as the
production path would extend), the contract chain for those calls is:

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

For the FERPA basis in [§ 4](#4-bayleafs-ferpa-basis), a direct Google integration strengthens
the § 99.33(b) chain for Gemini traffic specifically: the inference
hop is brought under a UC-signed agreement, and the no-training,
P4-classified, audit-rightful posture replaces a commercial ZDR
commitment from an intermediary. It does not change the posture for
non-Google models, which continue to route through OpenRouter unless
an alternative institutional back-end (see [§ 5.3](#53-inference-layer-proposed-aws-bedrock)) is used.

### 5.3 Inference layer proposed: AWS Bedrock

AWS Bedrock has been identified as a second institutional inference
back-end. Where Vertex AI is the strongest path for Google's own models,
Bedrock provides parallel coverage for a wider catalog of frontier and
open-weight models accessed under enterprise terms: Anthropic Claude,
Meta Llama, Mistral, Cohere, AI21, and Amazon's own Nova and Titan
families, all served from Amazon-operated endpoints inside an AWS
account that the customer controls.

The contract chain for this path would be:

```
User at UCSC
   │
   ▼
BayLeaf Chat (DigitalOcean) or BayLeaf API (Cloudflare)
   │   [operational terms: BayLeaf's own service commitments]
   ▼
UCSC-managed AWS account
   │   [contract: UC ↔ AWS enterprise agreement(s), presumed extant]
   │   [inherits: AWS Customer Agreement, AWS Service Terms,
   │              AWS Data Processing Addendum]
   ▼
Amazon Bedrock (serving Anthropic, Meta, Mistral, Amazon Nova, …)
       [governed by the above; model-provider terms incorporated by
        Bedrock's published policies]
```

The substantive Bedrock posture, in plain terms (citations to specific
UC-AWS contract sections to be supplied by UCSC ITS / Procurement when
this section is reviewed):

- **No training on customer data.** AWS Bedrock's published policy is
  that prompts and outputs are not used to train Amazon's or any
  third-party model provider's foundation models. This applies
  uniformly to all models served through Bedrock, including Anthropic's
  Claude family and Meta's Llama family, by terms incorporated through
  Bedrock when those models are made available.
- **No retention by model providers.** When a customer invokes a
  third-party model through Bedrock, the request is processed in an
  Amazon-operated environment; the third-party provider does not
  receive, log, or retain the prompt or output. This is the
  Bedrock-architectural equivalent of OpenRouter's ZDR routing, but
  under direct AWS contractual control rather than commercial pass-
  through.
- **Customer-controlled logging.** Bedrock model-invocation logs (if
  enabled) are written to a customer-controlled S3 bucket or
  CloudWatch log group inside the customer's AWS account. The logging
  posture is a customer choice, not a default.
- **Encryption with customer-managed keys.** Bedrock supports KMS
  customer-managed keys for both invocation logs and model-customization
  artifacts.
- **UC enterprise terms presumed.** UCSC presumably operates under UC
  ↔ AWS enterprise agreement(s) parallel to the UC ↔ Google stack
  (the operator does not have access to these contracts; this section
  asserts their existence pending review by UCSC ITS / Procurement).
  The substantive expectation is that those agreements provide UC-
  signed equivalents of the no-training, breach-cap, audit-right, and
  data-classification protections enumerated in [§ 5.2](#52-inference-layer-proposed-direct-google-cloud) for GCP.

Compared to the OpenRouter-ZDR path, Bedrock is contractually stronger
on the same dimensions Vertex/GCP is: UC-signed master contract,
institutionally negotiated terms, explicit data-classification posture,
direct rather than commercial-intermediary control. Compared to Vertex,
Bedrock's primary advantage for BayLeaf is **catalog coverage**:
Anthropic's Claude family is the model line most heavily used in
BayLeaf today, and Bedrock brings Claude under UC contract directly
where Vertex does not.

For the FERPA basis in [§ 4](#4-bayleafs-ferpa-basis), Bedrock plays the same role as the GCP
path for the models it covers: it brings the inference hop of the
§ 99.33(b) chain under a UC-signed agreement. A BayLeaf deployment
that routes Gemini through Vertex and Anthropic/Meta/Mistral through
Bedrock would have the entire frontier-model surface inside UC-signed
contracts; only the platform layer (DigitalOcean, Cloudflare) and
models without an institutional back-end available would remain on
commercial DPA terms. That is the architecture the rest of this
document treats as the target state.

### 5.4 The "school official" seam in the Google stack

FERPA's school-official exception, as it applies to Google, sits in two
places in UC's agreement stack, both of which cover Google Workspace
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

#### What the seam analysis got wrong about process

The two readings above ask which contractual formulation the campus
*relied on* when it approved Workspace-Gemini for P3. Correspondence with
the VPDUEGE in June 2026 indicates the premise is faulty: the campus does
not appear to have made a FERPA determination about Gemini in either the
strict or the pragmatic reading. Asked directly whether there had been any
review or affirmation regarding FERPA data with Gemini, the answer was
that Google's tools are presumed to fall under the same **Appendix DS**
purchasing review processes that gave the University confidence in
Canvas/Instructure: a data-security risk assessment, not a
school-official analysis. See
[§ 7.3](#73-appendix-ds-the-mechanism-this-document-originally-missed).

Two corrections follow.

**The pragmatic reading was not adopted; it was bypassed.** This
subsection previously asserted that the AI Council had "implicitly taken
the pragmatic reading." That over-reads the FAQ. The Council's P3
statement rests on the existence of negotiated UC-Google agreements
assessed through procurement, and the FAQ language quoted above says
exactly that (negotiated agreements, control over storage and reuse, no
training, institutional support) without invoking FERPA's school-official
exception at all. The seam described above is real as a matter of contract
text, but the campus resolved the practical question without adjudicating
it.

**The FERPA framing of the Gemini rollout was itself flagged as a gap.**
The VPDUEGE noted not having been consulted on the campus Gemini
announcement and expressed concern that it did not refer to FERPA, in
both directions: positively (a contracted tool is one it is acceptable to
upload student work to, in contrast with non-contracted tools) and
negatively (any system that retains or processes education record data
carries risk of unintentional FERPA disclosure). The desired remedy is
that tool announcements carry FERPA framing. That is a point in favor of
the joint three-tool outreach identified in the July 2026 status note,
and it means BayLeaf's own user-facing material should model the framing
the Gemini announcement omitted rather than match its silence.

The consequence for BayLeaf is favorable but should be stated carefully.
If Workspace-Gemini reached P3 through a procurement data-security
assessment rather than a FERPA determination, then BayLeaf's completed
HECVAT review is the *same kind* of artifact as the one that cleared
Gemini, which is the reasoning by which the Registrar's office placed the
two tools at the same risk threshold. This does not make the § 99.33(b)
analysis in [§ 4](#4-bayleafs-ferpa-basis) wrong; it makes it supererogatory
relative to what the campus process actually asks for.

#### The narrower open question

What the campus has *not* yet determined is whether that same P3
approval extends to Vertex AI / Gemini accessed through the GCP API,
rather than through the Google Workspace interface. Both paths sit
under the same UC–Google agreement stack and inherit the same
§ 15.1(d) no-training commitment, the same P4 data classification, and
the same Data Processing Addendum. The technical difference is that
Workspace-Gemini is a managed Google product built on top of Vertex,
while direct Vertex access is the raw API.

For BayLeaf's FERPA basis ([§ 4](#4-bayleafs-ferpa-basis)), this seam matters in a specific
way. Even under the strict reading, Vertex AI under UCSC's GCP project
is substantively better-protected for FERPA purposes than any other
inference path available to BayLeaf. An acknowledgment framework that
routes FERPA-sensitive traffic to Gemini-via-UCSC-GCP-project (and the
parallel Bedrock-via-UCSC-AWS-account path for non-Google models),
with non-FERPA traffic permitted to the OpenRouter-ZDR path, is
defensible under both readings.

### 5.5 Inference layer alternative: NRP / SDSC

The [National Research Platform](https://nrp.ai/), operated out of
UC San Diego and funded by NSF, serves open-weight models on
UC-affiliated research infrastructure. BayLeaf has this configured as
an alternative inference path for open-weight models, currently
disabled because NRP's documented policy is to log prompts (incompatible
with the no-retention posture required of a P3-handling subprocessor).

NRP is UC-operated infrastructure. Traffic to NRP does not leave the UC
system boundary in the same way that traffic to a commercial provider
does. The FERPA posture is different in kind from the commercial paths
above: there is no redisclosure-to-commercial-vendor question, because
there is no commercial vendor. The relevant questions are UC-internal
data-handling and inter-campus agreements, which are substantially
easier to satisfy than commercial-vendor terms.

For the FERPA basis in [§ 4](#4-bayleafs-ferpa-basis), NRP would be the strongest inference
path available for the open-weight models it serves, conditional on a
no-logging arrangement for BayLeaf traffic. The other limitation is
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

BayLeaf in its current form is not on the published P3-approved list.
Its inference paths today route through OpenRouter under commercial ZDR
terms, which is real protection but not under a UC-signed agreement.
This applies regardless of which model the user selects, including Gemini
(which currently reaches Google via OpenRouter rather than via UCSC's
Google contract).

A distinction matters here, and it is easy to elide because FERPA
records *are* P3. UCSC's review of a P3-eligible tool has two
components, and tracking them separately is what lets this document
state BayLeaf's status precisely:

- **The IS-3 security-controls review** asks whether the tool's
  architecture is secure enough to hold data at this protection level.
  For BayLeaf this is **complete**: the Information Security Office
  (Brian Hall, Mike Ware) reviewed the [HECVAT](HECVAT.md) and
  determined P3-classified data may be used in the system (reported to
  the AI Council, June 2026).
- **The FERPA question** was referred separately, by the AI Council
  co-chair, to the University Registrar and Campus Counsel. Earlier
  versions of this document called this a *FERPA-authorization review*
  and treated it as a gate BayLeaf had not cleared. That
  characterization did not survive contact with the reviewers. The
  Registrar's office does not conduct tool-level FERPA authorization
  and does not regard certifying a tool as FERPA-compliant as a
  meaningful act ([§ 7.2](#72-what-the-registrars-office-actually-does));
  campus exposure is managed instead through training, best practices,
  and Appendix DS purchasing review
  ([§ 7.3](#73-appendix-ds-the-mechanism-this-document-originally-missed)).
  Their response, in June 2026, was that BayLeaf as an internal tool has
  reached the same low risk threshold as Google's tools and Canvas, is in
  the same status as Gemini, and could be announced in a similar way.

So the accurate statement of BayLeaf's status has three parts, and
collapsing any two of them produces a claim this document does not make:

1. BayLeaf's **P3 security controls are cleared** by ISO (June 2026).
2. The **Registrar and VPDUEGE assess BayLeaf at the same risk threshold
   as the P3-approved Google tools** (June 2026 correspondence), and
   identified no FERPA-specific gate for it to clear.
3. BayLeaf **is not on the published P3-approved tools list**, no signed
   or published campus artifact records (2), and Campus Counsel has not
   weighed in.

What (3) means is narrower than "not approved for P3." It means a user
who checks the published list will not find BayLeaf there, which is a
real and material fact for anyone deciding what to paste into which
tool today, and is why the user-facing guidance in
[§ 9](#9-what-this-means-in-practice) remains conservative. It is no
longer accurate, though, to describe BayLeaf as awaiting a FERPA
authorization that the responsible office says it does not issue.

The architectural shift now under way (the Vertex AI demo in private
preview, AWS Bedrock as a second institutional back-end) brings the
inference layer of the chain into UC-signed agreement territory for the
models those back-ends serve. That strengthens the posture on its own
terms, and remains worth doing, but on the evidence of the June 2026
review it is not what the published listing is waiting for.

---

## 7. The approval pathway

<!-- SEC:APPROVAL_PATHWAY -->

### 7.1 Which UCSC offices are involved

FERPA itself does not name an approver; it requires the institution to
make the school-official determination and to include the criteria in
its annual notification (§ 99.7). At UCSC, the relevant authority is
distributed:

- **Office of Campus Counsel.** Reviews the legal form of the
  acknowledgment memo ([§ 8](#8-a-draft-acknowledgment-memo)) and the underlying subprocessor
  contracts to the extent they are material.
- **Privacy Office / Chief Privacy Officer.** Applies UC's privacy
  framework (IS-3, the data classification scheme, the UC Statement of
  Privacy Values and Privacy Principles). Decides whether data-handling
  practices are adequate for the relevant protection level.
- **Information Security Office (ISO).** Applies IS-3's security
  controls. For P3/P4-eligible tools this is typically a formal
  security review: risk assessment, security questionnaire (HECVAT;
  prepared at [HECVAT.md](HECVAT.md)), review of subprocessor contracts,
  verification of encryption and access-control posture.
- **UCSC AI Council.** The campus body that has taken the operative
  positions on AI-tool approvals to date (Workspace-Gemini, NotebookLM).
  Natural venue for the policy decision about whether to extend the
  P3-approved list, typically deferring to Counsel, Privacy, and ISO
  for the underlying review. In BayLeaf's case the Council's co-chair
  performed the referral to the Registrar and VPDUEGE that produced the
  June 2026 response.
- **Procurement / Strategic Sourcing.** Executes contracts on UCSC's
  behalf. Because BayLeaf involves no UCSC purchase, this office has no
  transaction to execute. Note, however, that the *review* this office
  ordinarily performs (Appendix DS) turns out to be the substantive
  mechanism the campus relies on, even where there is no transaction;
  see [§ 7.3](#73-appendix-ds-the-mechanism-this-document-originally-missed).
- **University Registrar.** Data steward for student data. This
  document originally assumed the Registrar was the office that would
  authorize FERPA-level use of a tool. That assumption was wrong; see
  [§ 7.2](#72-what-the-registrars-office-actually-does).

The typical path is a review package circulated among Privacy, ISO, and
Counsel, with the AI Council making the final policy determination
once the review is clean.

### 7.2 What the Registrar's office actually does

This subsection corrects the premise of
[§ 7.1](#71-which-ucsc-offices-are-involved) above and of the memo in
[§ 8](#8-a-draft-acknowledgment-memo) below.

The operator's June 2026 message to the Registrar asserted that using
BayLeaf for FERPA-relevant work would require "some affirmative legal
document, executed by the registrar." The response established that this
is not how the office works.

**The Registrar's stated roles**, per that correspondence:

1. Being knowledgeable about FERPA and its campus implementation.
2. Stewarding campus definitions, such as which specific fields are
   treated as public directory information for this campus.
3. Stewarding non-release elections (students' FERPA holds).
4. Reporting FERPA violations that come to light, where law or policy
   requires.

**Tool authorization is not on that list**, and the omission is
principled rather than incidental. Because FERPA is a prohibitory
statute, constraining what an institution may disclose rather than
enumerating permitted tools, the Registrar's office does not regard
"certifying a tool as FERPA-compliant" as a coherent act. Tools and
practices *can* be identified as non-compliant; the converse
certification has no corresponding instrument.

Instead, the campus reduces financial and legal exposure to FERPA (and
other) violations through a mix of:

- **training**, slightly at the UC system level and mostly at the campus
  level;
- **development of best practices**; and
- **careful procurement practices**
  ([§ 7.3](#73-appendix-ds-the-mechanism-this-document-originally-missed)).

Three consequences for this document.

**The memo in [§ 8](#8-a-draft-acknowledgment-memo) is not the pathway.**
It is retained because it is a compact and accurate statement of the
obligations BayLeaf's operator accepts, and because a reviewer who wants
a signed artifact would find it useful. But it should not be circulated
as a document awaiting signature, and nothing in BayLeaf's status is
contingent on its execution. See the framing note at the head of that
section.

**The right ask is inclusion, not execution.** What the Registrar's
office offered was an assessment of risk parity with the already-approved
tools and a suggestion that BayLeaf be announced similarly. The
actionable follow-through is therefore addition to the published
P3-approved list and participation in campus guidance, both of which run
through the AI Council rather than the Registrar.

**The user-level controls are where the Registrar's substantive concerns
land.** Business need to know
([§ 4.6](#46-business-need-to-know-the-user-level-control)) and the
IRB boundary ([§ 4.7](#47-the-ferpairb-boundary)) are the two things the
Registrar's office actually raised about BayLeaf's use, and both are
addressed by training and guidance rather than by architecture. This is
the most useful thing the referral produced, and it was not what this
document was built to elicit.

### 7.3 Appendix DS: the mechanism this document originally missed

Every prior version of this document analyzed FERPA authorization
through the regulation (§ 99.31, § 99.33) and through UC's data
classification policy (IS-3, protection levels). Neither is the
instrument the campus actually uses to decide whether a tool may hold
student data. That instrument is **Appendix DS**, the UC purchasing
system's data-security appendix, applied through UC's standard
procurement review processes.

Per the June 2026 correspondence, Appendix DS review is understood to be
what gives the University as much confidence as possible that data is
protected, while acknowledging that no system is perfect. It is the
process presumed to cover Google's tools, and it is explicitly the
process Canvas/Instructure completed. It assesses data-security risk.
It does not perform a FERPA school-official analysis, and it does not
issue a FERPA certification.

For BayLeaf, the significant move in the June 2026 response was to treat
the operator's **HECVAT response** ([HECVAT.md](HECVAT.md)) as the
functional equivalent of an Appendix DS review, and then to add the
student-data steward's own input as a supplement. On that basis BayLeaf
was assessed as an internal tool that has reached the same risk threshold
as the tools cleared through procurement: low risk, characterized as the
best available.

This inverts a worry that runs through
[§ 7.4](#74-fit-and-mismatch-with-the-standard-vendor-pathway) below.
That subsection treats the absence of a procurement event as a structural
mismatch to be worked around, on the reasoning that BayLeaf cannot pass
through the pathway the campus is built for. The correction is that
BayLeaf effectively did pass through the substantive part of that
pathway: the data-security assessment is separable from the purchasing
transaction, and completing the assessment without a transaction is not a
defect. Read [§ 7.4](#74-fit-and-mismatch-with-the-standard-vendor-pathway)
with that in mind.

Two open items follow. First, this document has not seen Appendix DS
itself; the characterization above is drawn from correspondence, and a
reviewer with access should confirm the mapping between its control
expectations and the HECVAT responses. Second, if HECVAT-as-Appendix-DS
is the operative equivalence, it is worth asking whether that equivalence
should be recorded somewhere more durable than email, which is the same
question as item (3) in [§ 6](#6-protection-levels-and-whats-already-approved).

### 7.4 Fit and mismatch with the standard vendor pathway

UCSC's standard P3-vendor approval sequence (intake → security/privacy
review → Counsel review → procurement → AI Council policy addition) is
partially applicable and partially mismatched for BayLeaf:

- **Intake and security/privacy review apply directly.** A risk
  assessment of BayLeaf's architecture, subprocessors, and data-handling
  is the right gate. This document plus [SECURITY.md](SECURITY.md),
  [DEPENDENCIES.md](DEPENDENCIES.md), and [HECVAT.md](HECVAT.md) is the
  substantive input.
- **Counsel review applies but in a different form.** There is no UCSC-
  vendor contract to negotiate. What Counsel reviews is the
  acknowledgment memo ([§ 8](#8-a-draft-acknowledgment-memo)) and the adequacy of the underlying
  subprocessor contracts.
- **Procurement is skipped, but its review is not.** No purchase, no
  procurement event. This was originally read as a gap; per
  [§ 7.3](#73-appendix-ds-the-mechanism-this-document-originally-missed),
  the substantive Appendix DS data-security review was effectively
  satisfied by the HECVAT response, and the assessment turns out to be
  separable from the transaction.
- **AI Council policy addition is the visible outcome.** Addition to
  the campus-approved AI tools list is what changes operationally. On
  the June 2026 assessment, this is now the only step outstanding.

The structural facts that drive this fit:

- **No vendor counterparty.** The operator is a UCSC faculty member;
  the commercial subprocessors are contracted personally, not
  institutionally. UCSC is acknowledging an instrument, not contracting
  with a vendor. The Registrar's office reached the same conclusion by a
  different route, characterizing BayLeaf as an **internal tool**.
- **The operator is already a school official.** The acknowledgment
  does not create that status; it scopes the subprocessor chain that
  the school official may use under § 99.33(b). In the campus's own
  idiom, the equivalent point is that faculty have a business need to
  know the records of the classes they have offered
  ([§ 4.6](#46-business-need-to-know-the-user-level-control)).
- **Scope of benefit is campus-wide.** BayLeaf is offered to the whole
  UCSC community, more like a campus ITS service than a
  department-scoped vendor.
- **Reversibility.** The acknowledgment is bounded by the operator's
  continued institutional role: if the operator's appointment ends, the
  acknowledgment terminates and remaining records are destroyed
  ([§ 8](#8-a-draft-acknowledgment-memo) memo, § 9). UCSC is acknowledging a time-limited instrument,
  not acquiring a permanent capability. Absent an executed memo, this
  reversibility is a property of the operator's commitment rather than a
  contractual term, which is an argument for recording it somewhere.

These are features, not bugs. The alternative (routing all campus AI
needs through enterprise vendor procurement) is slower, more expensive,
and less responsive to pedagogical needs than faculty-operated tools
can be. The process needs to accommodate the shape, not the other way
around. The June 2026 review suggests it did accommodate the shape,
without anyone needing to redesign the process: an internal tool with a
completed security questionnaire and a data-steward consult was assessed
on the same terms as a procured vendor.

### 7.5 Review package artifacts

A complete review package includes:

1. **FERPA posture document** (this file).
2. **Security posture document** ([SECURITY.md](SECURITY.md)).
3. **Dependency audit** ([DEPENDENCIES.md](DEPENDENCIES.md)).
4. **HECVAT 4.1.5 response** ([HECVAT.md](HECVAT.md)), with a framing
   memo addressing the vendor-shaped questions that do not apply.
5. **Draft acknowledgment memo** ([§ 8](#8-a-draft-acknowledgment-memo) below), optional; see
   [§ 7.2](#72-what-the-registrars-office-actually-does).
6. **Subprocessor appendix** (Appendix A of the memo): each
   subprocessor, the category of data it handles, the contract under
   which it handles that data, and the term limits and deletion
   obligations.

Items 1–4 exist in this repository. Item 5 is provided in [§ 8](#8-a-draft-acknowledgment-memo).
Item 6 is to be assembled in coordination with ISO during the security
review.

In practice, item 4 carried the review. The ISO security determination
(June 2026) and the Registrar's risk-parity assessment both rested on the
HECVAT response; items 1 and 5, the FERPA analysis and the draft memo,
were referenced by the operator but did not drive either outcome. A future
review package for a comparable faculty-operated tool should lead with the
HECVAT.

---

## 8. A draft acknowledgment memo

<!-- SEC:ACKNOWLEDGMENT_MEMO -->
This section provides a working draft of the memorandum UCSC would
execute to acknowledge BayLeaf as an instrument operated by a UCSC
school official under FERPA. It is written in the form UCSC would sign,
with brackets indicating open choices that Counsel, the Privacy Office,
or the signing official would resolve. The draft is a proposal by the
BayLeaf operator; it is not a UCSC document until an authorized UCSC
official signs it.

The memo is grounded in 34 CFR § 99.31(a)(1)(i)(A) (the operator is
already a school official; this is the framing developed in [§ 4](#4-bayleafs-ferpa-basis))
and 34 CFR § 99.33(b) (the operator's use of subprocessors is
authorized redisclosure on UCSC's behalf). A short concluding note
records the (a)(1)(i)(B) translation for reviewers who prefer the
outsourced-party frame; the substantive obligations are the same under
either framing.

> **Standing of this draft, as of July 2026.** This memorandum is
> **not the active pathway** and is not awaiting anyone's signature.
> When the AI Council referred the FERPA question to the University
> Registrar in June 2026, the response was that the Registrar's office
> does not issue tool-level FERPA authorizations and does not regard
> certifying a tool as FERPA-compliant as a coherent act, FERPA being a
> prohibitory statute
> ([§ 7.2](#72-what-the-registrars-office-actually-does)). The campus
> mechanism is Appendix DS data-security review plus training and best
> practices ([§ 7.3](#73-appendix-ds-the-mechanism-this-document-originally-missed)),
> which BayLeaf has substantively completed by way of its
> [HECVAT](HECVAT.md) response.
>
> The draft is retained for three reasons. It is the most compact
> statement available of the obligations BayLeaf's operator accepts, and
> § 4 in particular is a useful self-binding checklist independent of
> whether anyone signs it. It would serve if a reviewer, most plausibly
> Campus Counsel, did want a signed artifact. And § 7's
> protection-level options remain a clean way to frame the one decision
> that is still genuinely open: which inference paths are appropriate for
> which data.
>
> Do not circulate it as a document pending execution. Sections that
> speak of what UCSC "would" acknowledge, or of termination and audit
> obligations, describe an instrument that does not exist, and the
> operator's commitments in § 4 are currently commitments of practice
> rather than contract.

---

> **Memorandum acknowledging BayLeaf AI Playground as an instrument of
> a UCSC school official under FERPA**
>
> **From:** [UCSC signing official; candidates include the Provost,
> the Chief Information Officer, the Chief Privacy Officer, or another
> official authorized to make FERPA determinations on behalf of the
> Regents of the University of California]
>
> **To:** Adam Smith, Associate Professor, Department of Computational
> Media, UC Santa Cruz, in his capacity as operator of the BayLeaf AI
> Playground ("BayLeaf")
>
> **Date:** [to be supplied]
>
> **Subject:** Acknowledgment of BayLeaf as an instrument of a UCSC
> school official under 34 CFR § 99.31(a)(1)(i)(A), with subprocessor
> chain authorized under 34 CFR § 99.33(b)
>
> ---
>
> **1. Recitals.**
>
> (a) Adam Smith ("Operator") is a tenured faculty member of UC Santa
> Cruz ("UCSC") and a school official within the meaning of 34 CFR
> § 99.31(a)(1)(i)(A), having signed the written form indicating
> legitimate educational interest required by §IX.C of the UCSC
> Administrative Procedures Applying to Disclosure of Information from
> Student Records as a condition of UCSC employment.
>
> (b) Operator has built and operates the BayLeaf AI Playground
> ("BayLeaf"), a service consisting of two user-facing surfaces (BayLeaf
> Chat at `chat.bayleaf.dev` and BayLeaf API at `api.bayleaf.dev`) and
> a chain of cloud subprocessors enumerated in Appendix A.
>
> (c) UCSC has determined that the function BayLeaf supports (AI-assisted
> analysis, drafting, and related language tasks in support of teaching,
> research, and administrative work) is a function for which UCSC
> would otherwise use employees, and that Operator's use of BayLeaf in
> performing that work falls within the scope of his school-official
> status.
>
> **2. Acknowledgment.**
>
> UCSC hereby acknowledges that:
>
> (a) Operator's use of BayLeaf, in his capacity as a UCSC school
> official, to handle education records is consistent with 34 CFR
> § 99.31(a)(1)(i)(A); and
>
> (b) Operator's disclosure of education records to the subprocessors
> enumerated in Appendix A, for the sole purpose of supporting the
> services described in § 1(b), constitutes authorized redisclosure on
> UCSC's behalf under 34 CFR § 99.33(b), provided each such
> subprocessor is bound by terms substantively equivalent to those set
> forth in § 4 of this memorandum.
>
> **3. Legitimate educational interest.**
>
> A legitimate educational interest exists when a school official needs
> to review an education record in order to fulfill his or her
> professional responsibility to the institution. BayLeaf, when used by
> UCSC faculty, staff, or other institutional role-holders in the
> course of their institutional responsibilities, processes education
> records in support of that fulfillment. Use of BayLeaf does not, by
> itself, establish legitimate educational interest; the user is
> responsible for ensuring such interest exists for any particular
> record handled.
>
> **4. Operator and subprocessor obligations.**
>
> Operator agrees, and shall ensure by contract that each subprocessor
> in Appendix A is bound to:
>
> (a) Use education records, and personally identifiable information
> derived from them, only for the purpose of providing the services
> described in § 1(b);
>
> (b) Not use education records to train, fine-tune, or otherwise
> incorporate them into machine-learning models, except with UCSC's
> prior written authorization;
>
> (c) Not disclose education records to any further party except as
> permitted by 34 CFR § 99.31, as further authorized by UCSC in
> writing, or to a downstream subprocessor itself bound by terms
> substantively equivalent to this § 4;
>
> (d) Maintain appropriate administrative, technical, and physical
> safeguards to protect the confidentiality, integrity, and
> availability of education records, consistent with UC Electronic
> Information Security Policy IS-3 at the protection level assigned
> under § 7 below;
>
> (e) Limit access to education records to those personnel and
> subprocessors whose access is necessary to provide the service;
>
> (f) Permit UCSC to audit Operator's compliance with this memorandum
> on reasonable notice, including by reviewing subprocessor contracts,
> inspecting relevant records, and interviewing the Operator; and
>
> (g) On termination of this acknowledgment, cease processing education
> records on UCSC's behalf, return or destroy education records held
> by BayLeaf or by subprocessors as recorded in Appendix A, and
> certify such return or destruction to UCSC in writing.
>
> **5. Subprocessor chain.**
>
> Appendix A lists the subprocessors BayLeaf uses in providing the
> services described in § 1(b), the category of data each handles, the
> contractual instrument governing each, and the termination and
> data-disposition obligations applicable to each. Operator agrees not
> to add subprocessors handling education records without notifying
> UCSC and updating Appendix A. UCSC may object to the addition of a
> subprocessor on reasonable grounds, in which case Operator and UCSC
> will in good faith determine an acceptable alternative or treat this
> acknowledgment as terminated with respect to the service dependent
> on that subprocessor.
>
> **6. Scope of data.**
>
> This acknowledgment applies to education records and personally
> identifiable information derived therefrom that BayLeaf receives in
> the course of providing the services described in § 1(b). It does
> not expand Operator's or BayLeaf's access to education records held
> in UCSC systems; BayLeaf does not receive data pushes from the
> Student Information System, Canvas, or any institutional record
> store, and this acknowledgment does not authorize any such access.
>
> **7. Protection level and inference paths.**
>
> The parties acknowledge that FERPA-protected student education
> records are classified as Protection Level 3 (P3) under UC IS-3 and
> UCSC's data classification guidance. This acknowledgment is:
>
> [Option A] limited to Protection Levels 1 and 2; users must use
> currently-approved P3 tools (Workspace-Gemini, NotebookLM) for P3
> content.
>
> [Option B] extended to Protection Level 3 data subject to the
> security controls set forth in Appendix B, across all of BayLeaf's
> inference paths.
>
> [Option C] extended to Protection Level 3 data only when processed
> through institutional inference back-ends (the direct Google Cloud
> path described in § 5.2 of the accompanying FERPA posture document,
> and the AWS Bedrock path described in § 5.3 of that document); P3
> content is not authorized for the OpenRouter-ZDR path.
>
> [The signing official to select among these options on the basis of
> the security and privacy review.]
>
> **8. Term and termination.**
>
> This acknowledgment is effective on the date of signature below and
> continues until terminated by either party on thirty (30) days'
> written notice, or automatically on the date Operator ceases to hold
> an institutional role at UCSC that includes school-official status
> under 34 CFR § 99.31(a)(1)(i)(A). On termination, the obligations in
> § 4(g) survive until all education records in BayLeaf's possession or
> control have been returned or destroyed and such return or
> destruction has been certified to UCSC.
>
> **9. Annual notification.**
>
> UCSC shall update its annual notification of FERPA rights pursuant to
> 34 CFR § 99.7 to reflect that BayLeaf is among the instruments that
> UCSC school officials may use in the course of work falling within
> their legitimate educational interest, with subprocessor handling
> governed by 34 CFR § 99.33(b) as set forth in this memorandum.
>
> **10. Not an additional employment or agency relationship.**
>
> This acknowledgment does not create an employment, agency,
> partnership, or joint venture relationship between UCSC and Operator
> beyond his existing UCSC faculty appointment. Operator's
> institutional role and responsibilities as a member of the UCSC
> faculty are governed by his appointment and applicable UC policy,
> independent of this acknowledgment.
>
> **11. Amendment.**
>
> This memorandum may be amended by written agreement of the parties.
> Appendix A (subprocessors) and Appendix B (security controls, if
> applicable) may be updated by Operator on notice to UCSC and do not
> require amendment of the body of the memorandum.
>
> **12. Alternative framing under § 99.31(a)(1)(i)(B).**
>
> Should it be procedurally preferable, the parties agree that the
> substantive obligations set forth in §§ 2–8 of this memorandum may
> be construed as a designation of BayLeaf as an outside party
> performing institutional services under 34 CFR § 99.31(a)(1)(i)(B).
> Such construction does not enlarge or reduce the substantive
> obligations of either party.
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
> Cloudflare, OpenRouter, NRP, the specific model providers reached
> via OpenRouter's ZDR endpoints, plus the UCSC-managed Google Cloud
> project for direct Vertex AI access and the UCSC-managed AWS account
> for Bedrock if those institutional back-ends are added), with the
> contractual instrument governing each, the category of data handled,
> the retention and training posture, and the termination obligations.
> To be prepared as a companion document when the memorandum is
> submitted for review.]*
>
> **Appendix B: Security Controls for Protection Level 3 Data**
>
> *[If the acknowledgment extends to P3, this appendix would specify
> the security controls Operator commits to maintain, consistent with
> IS-3 at P3, including any additional controls ISO requires for
> teacher-side automation flows that read across full rosters (see
> [§ 3.2.4](#324-blast-radius-asymmetry-between-user-and-teacher-use-cases)
> of the accompanying FERPA posture document). To be prepared in
> coordination with ISO during the security review.]*

---

The draft above is written to be readable by non-lawyers while
retaining the structure and references a reviewing attorney would
look for. Three design choices deserve comment:

**Framing under (a)(1)(i)(A) + § 99.33(b).** The memo's substantive
form acknowledges the operator's pre-existing school-official status
and authorizes the subprocessor chain under § 99.33(b), rather than
designating BayLeaf-the-instrument as an outside party under
(a)(1)(i)(B). This matches the operating reality: there is no vendor
counterparty for UCSC to outsource to. § 12 of the memo records the
(a)(1)(i)(B) translation for reviewers whose template assumes the
outsourced-party frame; the obligations are the same.

**Option structure in § 7 (protection level).** The memo offers the
signing official three choices for protection-level scope rather than
asserting P3 unilaterally. Option C, scoping P3 to institutional
back-ends (Vertex/GCP, Bedrock) only, is a defensible middle path that
matches the architectural changes in [§ 5](#5-the-contract-stack-beneath-bayleaf): it gives users a clean
P3 lane through UC-signed inference contracts while keeping the
OpenRouter-ZDR path available for non-FERPA work without forcing
campus to take a position on its P3 sufficiency.

**Termination tied to the operator's role (§ 8).** The acknowledgment
self-terminates when the operator ceases to hold an institutional role
that includes school-official status. This addresses the reversibility
point from [§ 7.4](#74-fit-and-mismatch-with-the-standard-vendor-pathway): UCSC is acknowledging a time-limited
instrument bounded by the faculty appointment that supports it, not
acquiring a permanent capability.

**What the June 2026 review implies about all three.** The framing choice
was vindicated from an unexpected direction: the Registrar's office
independently characterized BayLeaf as an *internal tool*, which is the
(a)(1)(i)(A) reading arrived at without reference to the regulation, and
is evidence against bothering with the (a)(1)(i)(B) translation in § 12.
The protection-level options survive as the live question, though the
decision now belongs to the AI Council as a listing decision rather than
to a signing official as a contract term. The termination provision is
the one piece with no substitute: absent an executed memo, nothing
records what happens to BayLeaf's stored conversation history if the
operator's appointment ends. That gap is properly a retention question
rather than a FERPA-authorization one, and it belongs in
[chat/RETENTION.md](../chat/RETENTION.md) whether or not any memo is ever
signed.

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
  by a UC-signed institutional agreement or an equivalent campus review.

BayLeaf is **not on that published list**, and that is the fact to act
on when deciding what to paste where today: the list is what you can
check, and it does not name BayLeaf. This applies regardless of which
model you select in BayLeaf (Gemini included, since today's
Gemini-in-BayLeaf goes through OpenRouter rather than UC's Google
contract).

Two qualifications, because "not on the list" is doing narrower work here
than "disallowed":

- BayLeaf's **P3 security controls were cleared by ISO** in June 2026.
- The **University Registrar and the VPDUEGE assessed BayLeaf, in June
  2026 correspondence, as an internal tool at the same low risk threshold
  as the P3-approved Google tools**, in the same status as Gemini, and
  suggested it could be announced similarly. That assessment is not a
  published listing, is not signed, and has not been reviewed by Campus
  Counsel. See the July 2026 status note in the
  [introduction](#ferpa-and-bayleaf) and
  [§ 6](#6-protection-levels-and-whats-already-approved).

So the guidance below is cautious by choice, not because a campus officer
has told the operator that BayLeaf may not hold P3 data. Earlier versions
of this section said BayLeaf was awaiting FERPA authorization; that was
never quite right, and per
[§ 7.2](#72-what-the-registrars-office-actually-does) no such
authorization is issued by anyone.

If the content contains FERPA-protected PII, the current options are:

- **Use Gemini-in-Workspace** (the Gemini side panel in Google Docs,
  Gmail, Drive, or gemini.google.com signed in with your UCSC account).
  Campus-approved for P3 and on the published list; inherits the explicit
  Workspace "school official" designation.
- **Use NotebookLM** under your UCSC account; also campus-approved
  for P3.
- **Prefer the published-list tools for P3 work while BayLeaf is
  unlisted.** BayLeaf is unreservedly appropriate for P1/P2 content:
  drafting, brainstorming, code, generic Q&A where no student identifiers
  are involved. For P3 content, the conservative reading is to use a
  listed tool; the operator will not represent that BayLeaf is
  campus-approved for P3 until it appears on the list.
- **Air-gapped paraphrasing** is almost always the right move when the
  task itself is P3. Remove identifiers before the prompt; apply the
  AI's suggestions back onto the identified record yourself. This
  reduces the FERPA surface regardless of which tool you use.
- **Check your business need to know before you check your tool.** The
  concern campus reviewers actually raised about agent-assisted work on
  student data was not which service processes the prompt but whether the
  user has a business need to know the records in question
  ([§ 4.6](#46-business-need-to-know-the-user-level-control)). Your own
  classes: yes. Data reached through MyUCSC, Infoview / AIS-Daily, or a
  colleague's broader access: ask first. Choosing a listed tool does not
  cure a need-to-know problem.
- **If you are heading toward a publication, that is research.** Using
  course data to produce findings is human subjects research and needs
  IRB review, independent of which AI tool you use
  ([§ 4.7](#47-the-ferpairb-boundary)).

The change that would simplify all of this is BayLeaf's addition to the
published P3 list, which per the June 2026 assessment is the remaining
step. The memo in [§ 8](#8-a-draft-acknowledgment-memo) is no longer
presented as the mechanism for that.

### For a student using BayLeaf

BayLeaf is an opt-in service. You are not submitting education records
to a third party by using it. You are sending your own prompts to an AI
service. FERPA does not regulate what you choose to share about
yourself; it regulates what the institution shares about you.

If you are a student worker handling education records in an
institutional role (e.g., a peer advisor, a teaching assistant with
grade access, a student employee in an administrative office), then
the faculty/staff guidance above applies to you when you are acting in
that role, including the business-need-to-know limit
([§ 4.6](#46-business-need-to-know-the-user-level-control)): a TA's
access runs to the course they support, not to the institution's student
records generally.

### For a reviewer asking "is BayLeaf FERPA-compliant?"

The framing of the question is itself contested. The Registrar's office
holds that certifying any tool as FERPA-compliant is not a coherent act,
since FERPA constrains disclosure rather than blessing tools, though
tools and practices can be identified as *non*-compliant
([§ 7.2](#72-what-the-registrars-office-actually-does)). With that noted,
there are two answerable versions:

1. *Can BayLeaf receive FERPA-protected records from an institutional
   role-holder (faculty, staff, advisor) acting in their professional
   capacity?*
   No campus officer has said it may not. BayLeaf's P3 security controls
   were cleared by ISO (June 2026), and the Registrar and VPDUEGE
   assessed it at the same risk threshold as the P3-approved Google tools
   (June 2026). What is missing is a *published* statement to that
   effect: BayLeaf does not appear on the campus-approved AI-tools list
   for P3 data, and Campus Counsel has not weighed in. Until it is
   listed, this document declines to tell users it is approved.

2. *Does BayLeaf hold education records on behalf of UCSC?*
   No. BayLeaf does not receive data pushes from the Student Information
   System, Canvas, or any institutional record store. It processes
   whatever users type into it. It retains conversation histories (in
   Open WebUI's database) accessible only to the system administrator.
   See [SECURITY.md](SECURITY.md) for the full data-handling picture.

The honest one-sentence answer to "is BayLeaf FERPA-compliant?" is:
**"BayLeaf is operated by a UCSC school official as an instrument in
support of his institutional role; its P3 security controls were cleared
by the Information Security Office in June 2026, and the University
Registrar and the VPDUEGE subsequently assessed it as an internal tool at
the same low risk threshold as the Google tools UCSC has approved for
FERPA-protected content; but that assessment lives in correspondence
rather than in the campus's published list of P3-approved AI tools, and
Campus Counsel has not yet weighed in, so users working with
FERPA-protected content should still prefer the listed tools
(Workspace-Gemini, NotebookLM) until BayLeaf is listed, and should
attend at least as carefully to their own business need to know and to
IRB obligations, which no tool listing addresses."**

---

## 10. Open questions for the AI Council

<!-- SEC:COUNCIL_QUESTIONS -->
These are the questions this analysis cannot resolve on its own, and
that are most naturally addressed by the UCSC AI Council (with input
from Campus Counsel, the Privacy Office, and the Information Security
Office as needed).

Two of the three gates this document was written to address have closed.
The Information Security Office's P3 security-controls review is
**complete** (June 2026). The FERPA referral to the University Registrar
has **come back**, with the answer that no tool-level FERPA
authorization exists to be granted and that BayLeaf, as an internal tool
with a completed security questionnaire, sits at the same risk threshold
as the already-approved Google tools (June 2026; see the
[introduction](#ferpa-and-bayleaf) status notes). The questions below are
what remains, and the character of the list has changed: what was a
legal-basis inquiry is now mostly a communication and scoping agenda.

1. **Listing and announcement.** The Registrar's office suggested BayLeaf
   could be announced in the same way as Gemini. Will the Council add
   BayLeaf to the published P3-approved tools list at
   [campusai.ucsc.edu/faq](https://campusai.ucsc.edu/faq/)? If the answer
   is yes, that single edit resolves most of the hedging in
   [§ 9](#9-what-this-means-in-practice). If the answer is not yet, what
   is the remaining obstacle, so this document can name it accurately
   instead of inferring one?

2. **The three-tool guidance.** The proposal coming out of the June 2026
   correspondence was joint outreach on how Workspace-Gemini, NotebookLM,
   and BayLeaf can each be used in teaching, with recurring reminders
   about student-records privacy and business need to know. Does the
   Council want to own that document? What should it say about choosing
   among the three, given that the tools differ in capability more than
   in FERPA posture? The BayLeaf operator can draft the BayLeaf portion
   and has an interest in not being the sole author of the comparison.

3. **FERPA framing in tool announcements.** The VPDUEGE raised, as a
   general concern rather than a BayLeaf-specific one, that the campus
   Gemini announcement did not mention FERPA in either direction:
   positively (a contracted tool is one it is acceptable to upload
   student work to, unlike a non-contracted tool) or negatively (any
   system processing education records carries risk of unintentional
   disclosure), and noted not having been consulted on it. Should the
   Council adopt a standing expectation that AI tool announcements carry
   FERPA framing, with the Registrar consulted?

4. **Recording the HECVAT-as-Appendix-DS equivalence.** The June 2026
   assessment treated BayLeaf's HECVAT response as the substantive
   equivalent of an Appendix DS review
   ([§ 7.3](#73-appendix-ds-the-mechanism-this-document-originally-missed)).
   That equivalence currently exists only in email. Should it be recorded
   somewhere durable, and if so by whom and in what form? This is the
   narrow question the draft memo in
   [§ 8](#8-a-draft-acknowledgment-memo) could still usefully serve, in a
   much shorter form than currently drafted.

5. **Extending P3 to direct institutional inference back-ends.** The
   Council has approved Workspace-Gemini and NotebookLM for P3 on the
   strength of UC's negotiated Google agreements. Two architectural
   extensions of that posture are in view: (a) Vertex AI under UCSC's GCP
   project ([§ 5.2](#52-inference-layer-proposed-direct-google-cloud),
   demonstrated in private preview but currently disabled for want of a
   ZDR abuse-monitoring exception), and (b) AWS Bedrock under UC ↔ AWS
   enterprise agreements ([§ 5.3](#53-inference-layer-proposed-aws-bedrock)).
   Does the P3 approval extend to these direct-API back-ends, given that
   they sit under the same UC-signed agreement stacks as the
   already-approved Workspace surfaces? This is now a question about
   architectural strength rather than about clearing a gate.

6. **OpenRouter-ZDR and per-path scoping.** If the Council wants P3 work
   confined to institutional back-ends while leaving the OpenRouter-ZDR
   path available for P1/P2 work and for models not on Vertex or Bedrock,
   does it want that distinction enforced technically (per-model access
   gates by protection level) or organizationally (user training plus the
   model labeling already in place)? Note that the technical option is
   only meaningful if a listing distinguishes the paths.

7. **Business need to know and agent autonomy.** The substantive concern
   the Registrar's office raised is a user-scope concern
   ([§ 4.6](#46-business-need-to-know-the-user-level-control)): faculty
   with broad data access (MyUCSC, Infoview / AIS-Daily) using capable
   agents to explore beyond their business need to know. It is explicitly
   not BayLeaf-specific. Does the Council want a campus-level position on
   agent-assisted access to institutional data, and does it want any
   technical expectations of BayLeaf specifically for the teacher-side
   automation flows in
   [§ 3.2.4](#324-blast-radius-asymmetry-between-user-and-teacher-use-cases)
   (rate limits, logging, review of agent-driven Canvas API usage)?

8. **The IRB seam.** ORCA is working with the University Registrar on
   guidance for researchers using education record information
   ([§ 4.7](#47-the-ferpairb-boundary)). Should AI-tool guidance point at
   that work, and should agent-assisted analysis of course data get
   explicit treatment there, given how easily instructional use slides
   into research use in a single conversational turn?

9. **User-side characterization.** When a UCSC faculty member pastes
   FERPA-protected content into an AI service not on the campus-approved
   list, what is the correct characterization under UC policy? User
   violation, institutional gap, or communication problem the existing
   guidance already addresses? This question predates BayLeaf; BayLeaf
   makes it concrete, and the answer determines how the three-tool
   guidance in item 2 should be worded.

10. **Precedent for faculty-operated instruments.** BayLeaf's review
    established a workable pattern almost by accident: an internal tool
    completes a HECVAT, ISO reviews it, the relevant data steward is
    consulted, and the tool is assessed at a risk threshold comparable to
    procured vendors, with no procurement event. Should that be codified
    as a standing pathway for other faculty-operated services? What is
    the minimum viable review package
    ([§ 7.5](#75-review-package-artifacts) suggests the HECVAT carries
    most of the weight), and who keeps the subprocessor inventory
    current?

Answers to items 1 through 4 would let this document replace most of its
remaining hedged language with definite statements and simplify the
user-facing guidance in [§ 9](#9-what-this-means-in-practice)
considerably. Items 5 and 6 shape whether and how to productionize the
institutional inference back-ends. Items 7 through 10 are campus-level
questions that BayLeaf has surfaced but does not own.

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
- **Appendix DS**, the UC purchasing system's data-security appendix.
  Not consulted directly for this analysis; characterized here from the
  June 2026 correspondence below, which identifies it as the review
  process covering Google's tools and Canvas/Instructure. A reviewer with
  access should confirm the mapping between its control expectations and
  the [HECVAT](HECVAT.md) responses
  ([§ 7.3](#73-appendix-ds-the-mechanism-this-document-originally-missed)).
- Office of Research Compliance Administration (ORCA), reported in June
  2026 to be developing guidance with the University Registrar on
  researcher use of education record information
  ([§ 4.7](#47-the-ferpairb-boundary)). Not yet published as of this
  writing.

### Campus correspondence

Several claims in this document, particularly the July 2026 status note,
[§ 7.2](#72-what-the-registrars-office-actually-does), and
[§ 7.3](#73-appendix-ds-the-mechanism-this-document-originally-missed),
rest on an email thread rather than on published or signed artifacts.
Recorded here so a reader can weigh the provenance:

- Thread: "Processing FERPA-level data in BayLeaf AI," 18–30 June 2026.
  Initiated by the UCSC AI Council co-chair (Michael Tassio) as a
  referral to the University Registrar (Tchad Sanger) and the Vice
  Provost and Dean of Undergraduate Education and Global Engagement
  (Richard Hughey), following the Information Security Office's P3
  determination. Principal Campus Counsel (Jessica Espinoza) was added
  on 30 June 2026 and had not responded as of this writing.
- Nothing in that thread constitutes a signed determination, a published
  campus position, or advice from Campus Counsel. Where this document
  reports the Registrar's or the VPDUEGE's position, it paraphrases that
  correspondence and says so.

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
