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
UC-signed agreements, and UCSC has not yet acknowledged BayLeaf as an
instrument operating under § 99.33(b). UCSC has approved Workspace-Gemini
and NotebookLM for use with FERPA-protected data at Protection Level 3
per the [UCSC AI Council's published guidance](https://campusai.ucsc.edu/faq/);
BayLeaf is not on that list.

> **Status note (June 2026).** The UCSC Information Security Office
> completed a security review of BayLeaf against the
> [HECVAT](HECVAT.md) and determined that **P3-classified data may be
> used in the BayLeaf system** (review by Brian Hall and Mike Ware,
> reported to the AI Council June 2026). That determination answers the
> UC IS-3 *controls* question: is BayLeaf's architecture secure enough
> to hold data at this tier. It does **not** by itself answer the FERPA
> *authorization* question this document addresses: whether there is a
> lawful basis for education records to transit BayLeaf's subprocessor
> chain under § 99.33(b). The AI Council co-chair has confirmed that
> "tool approval for processing FERPA-level data follows a different
> review process," now underway with the University Registrar
> (Tchad Sanger) and the Office of Campus Counsel. BayLeaf is therefore
> **security-cleared for P3 but not yet FERPA-authorized**, and remains
> off the AI Council's published P3-approved tools list pending that
> separate review. The conditional language throughout this document
> ("not approved," "if UCSC executes the acknowledgment") refers to the
> FERPA-authorization gate, not the now-completed security review.

Two things would change that:

1. **A written acknowledgment from UCSC** ([§§ 4](#4-bayleafs-ferpa-basis),
   [7](#7-the-approval-pathway), [8](#8-a-draft-acknowledgment-memo)) that
   BayLeaf is an instrument operated by a UCSC school official, that the
   subprocessor chain beneath it is governed by § 99.33(b), and that the
   chain's protection level is sufficient for the categories of data
   users are expected to share with it. This is the lever. It does not
   require UCSC to separately vet every subprocessor; it requires UCSC
   to set the protection-level scope and hold the operator accountable
   for the chain.
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

This document focuses on the FERPA frame. The platform layer (DigitalOcean,
Cloudflare, Open WebUI's conversation storage) sits under the same
acknowledgment umbrella but is treated in detail in [SECURITY.md](SECURITY.md).
Where platform facts are FERPA-relevant they are summarized here with
pointers.

A note on framing: where prior versions of this document treated
§ 99.31(a)(1)(i)(B) (outside parties as designated school officials) as
the primary path, this version treats § 99.31(a)(1)(i)(A) plus § 99.33(b)
as primary, because the operator's pre-existing school-official status is
the most accurate description of how BayLeaf actually relates to UCSC.
The (B) framing is preserved as an alternative in [§ 4.4](#44-an-alternative-framing-under-a1ib)
in case a reviewer prefers a vendor-shaped instrument.

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
[GitHub issue #5](https://github.com/rndmcnlly/bayleaf/issues/5).

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
[GitHub issue #5](https://github.com/rndmcnlly/bayleaf/issues/5)
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
flow, both today (in policy-violating form) and under the redesign
(in policy-covered form, contingent on acknowledgment). Today, teaching
staff use the BayLeaf Code Sandbox feature with command-line tools
like [`canvaslms`](https://github.com/dbosk/canvaslms) to manipulate
student data via the Canvas API; this runs ahead of BayLeaf's
*authorized*-use ceiling (the tool is now ISO-cleared for P3 security
controls, but FERPA-authorization for education-record use remains
pending, so this practice is not yet covered) and is one of the
practices the acknowledgment needs to cover (or explicitly prohibit).
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
concrete form.

---

## 5. The contract stack beneath BayLeaf

<!-- SEC:CONTRACT_STACK -->
The acknowledgment in [§ 4](#4-bayleafs-ferpa-basis) is the lever; the contract stack beneath
BayLeaf determines how strong the lever is. § 99.33(b) requires that
each downstream disclosure fit a § 99.31 exception, which in practice
requires each subprocessor to be bound by terms equivalent to the
(a)(1)(i)(B) "direct control" conditions ([§ 4.3](#43-how-the--9933b-chain-is-bound)). This section
walks the inference layer in detail and references the platform layer
briefly.

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
terms, which is real protection but not under a UC-signed agreement,
and UCSC has not yet acknowledged BayLeaf's § 99.33(b) chain. This
applies regardless of which model the user selects, including Gemini
(which currently reaches Google via OpenRouter rather than via UCSC's
Google contract).

A distinction matters here, and it is easy to elide because FERPA
records *are* P3. UCSC's review of a P3-eligible tool has two
components, and they have come apart for BayLeaf:

- **The IS-3 security-controls review** asks whether the tool's
  architecture is secure enough to hold data at this protection level.
  For BayLeaf this is **complete**: the Information Security Office
  (Brian Hall, Mike Ware) reviewed the [HECVAT](HECVAT.md) and
  determined P3-classified data may be used in the system (reported to
  the AI Council, June 2026).
- **The FERPA-authorization review** asks whether there is a lawful
  basis for education records to flow through the subprocessor chain
  (the § 99.33(b) question developed in [§ 4](#4-bayleafs-ferpa-basis)).
  For BayLeaf this is **open**, and the AI Council has explicitly
  routed it through a separate process led by the University Registrar
  and Campus Counsel.

So BayLeaf is presently **security-cleared for P3 but not
FERPA-authorized**, and accordingly not yet on the AI Council's
published P3-approved tools list. The security clearance is a
necessary input to the FERPA review (it satisfies the controls
expectation Appendix B of the [§ 8](#8-a-draft-acknowledgment-memo) memo would otherwise have to
establish), but it is not a substitute for it.

The architectural shift now under way (the Vertex AI demo in private
preview, AWS Bedrock as a second institutional back-end) brings the
inference layer of the chain into UC-signed agreement territory for the
models those back-ends serve. Combined with the acknowledgment in
[§§ 4](#4-bayleafs-ferpa-basis) and [8](#8-a-draft-acknowledgment-memo), this is the path for adding BayLeaf to the
P3-approved list, either as a whole or scoped by inference path.

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
  for the underlying review.
- **Procurement / Strategic Sourcing.** Executes contracts on UCSC's
  behalf. Because BayLeaf involves no UCSC purchase, this office has no
  transaction to execute; the acknowledgment memo can be signed by an
  authorized UCSC official without a procurement event.

The typical path is a review package circulated among Privacy, ISO, and
Counsel, with the AI Council making the final policy determination
once the review is clean.

### 7.2 Fit and mismatch with the standard vendor pathway

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
- **Procurement is skipped.** No purchase, no procurement event. The
  signing official is whoever Counsel and the Provost identify as
  appropriate for this kind of acknowledgment.
- **AI Council policy addition is the visible outcome.** Addition to
  the campus-approved AI tools list is what changes operationally.

The structural facts that drive this fit:

- **No vendor counterparty.** The operator is a UCSC faculty member;
  the commercial subprocessors are contracted personally, not
  institutionally. UCSC is acknowledging an instrument, not contracting
  with a vendor.
- **The operator is already a school official.** The acknowledgment
  does not create that status; it scopes the subprocessor chain that
  the school official may use under § 99.33(b).
- **Scope of benefit is campus-wide.** BayLeaf is offered to the whole
  UCSC community, more like a campus ITS service than a
  department-scoped vendor.
- **Reversibility.** The acknowledgment is bounded by the operator's
  continued institutional role: if the operator's appointment ends, the
  acknowledgment terminates and remaining records are destroyed
  ([§ 8](#8-a-draft-acknowledgment-memo) memo, § 9). UCSC is acknowledging a time-limited instrument,
  not acquiring a permanent capability.

These are features, not bugs. The alternative (routing all campus AI
needs through enterprise vendor procurement) is slower, more expensive,
and less responsive to pedagogical needs than faculty-operated tools
can be. The process needs to accommodate the shape, not the other way
around.

### 7.3 Review package artifacts

A complete review package includes:

1. **FERPA posture document** (this file).
2. **Security posture document** ([SECURITY.md](SECURITY.md)).
3. **Dependency audit** ([DEPENDENCIES.md](DEPENDENCIES.md)).
4. **HECVAT 4.1.5 response** ([HECVAT.md](HECVAT.md)), with a framing
   memo addressing the vendor-shaped questions that do not apply.
5. **Draft acknowledgment memo** ([§ 8](#8-a-draft-acknowledgment-memo) below).
6. **Subprocessor appendix** (Appendix A of the memo): each
   subprocessor, the category of data it handles, the contract under
   which it handles that data, and the term limits and deletion
   obligations.

Items 1–4 exist in this repository. Item 5 is provided in [§ 8](#8-a-draft-acknowledgment-memo).
Item 6 is to be assembled in coordination with ISO during the security
review.

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
> (c) UCSC has determined that the function BayLeaf supports — AI-assisted
> analysis, drafting, and related language tasks in support of teaching,
> research, and administrative work — is a function for which UCSC
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
point from [§ 7.2](#72-fit-and-mismatch-with-the-standard-vendor-pathway): UCSC is acknowledging a time-limited
instrument bounded by the faculty appointment that supports it, not
acquiring a permanent capability.

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
  by a UC-signed institutional agreement or a UCSC FERPA acknowledgment.

BayLeaf currently falls in the "not approved" set, for the reasons
discussed in [§§ 4](#4-bayleafs-ferpa-basis), [5](#5-the-contract-stack-beneath-bayleaf), [6](#6-protection-levels-and-whats-already-approved). This applies regardless of which model you select
in BayLeaf (Gemini included, since today's Gemini-in-BayLeaf goes
through OpenRouter rather than UC's Google contract). Note that
"not approved" here means **not yet FERPA-authorized and not on the
published P3 list**; BayLeaf's *security controls* for P3 were cleared
by ISO in June 2026 (see the status note in the [introduction](#ferpa-and-bayleaf) and [§ 6](#6-protection-levels-and-whats-already-approved)).
The authorization review with the Registrar and Counsel is the
remaining gate.

If the content contains FERPA-protected PII, the current options are:

- **Use Gemini-in-Workspace** (the Gemini side panel in Google Docs,
  Gmail, Drive, or gemini.google.com signed in with your UCSC account).
  Campus-approved for P3; inherits the explicit Workspace
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

If UCSC executes the acknowledgment memo in [§ 8](#8-a-draft-acknowledgment-memo), BayLeaf's posture
changes in ways that will be specified in the signed memo itself. At
minimum: UCSC has acknowledged the operator's school-official use of
BayLeaf, and the subprocessor chain is brought within the § 99.33(b)
authorized-redisclosure framework. Whether this carries P3 authorization
depends on the protection-level option selected in § 7 of the memo.

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
   Today, not yet: BayLeaf's P3 *security controls* have been cleared
   by ISO (June 2026), but BayLeaf is not yet *FERPA-authorized* and is
   not on the campus-approved AI-tools list for P3 data. With execution
   of the acknowledgment memo in [§ 8](#8-a-draft-acknowledgment-memo), and at
   the protection level selected in § 7 of that memo, yes.

2. *Does BayLeaf hold education records on behalf of UCSC?*
   No. BayLeaf does not receive data pushes from the Student Information
   System, Canvas, or any institutional record store. It processes
   whatever users type into it. It retains conversation histories (in
   Open WebUI's database) accessible only to the system administrator.
   See [SECURITY.md](SECURITY.md) for the full data-handling picture.

The honest one-sentence answer to "is BayLeaf FERPA-compliant?" is:
**"BayLeaf is operated by a UCSC school official as an instrument in
support of his institutional role; its P3 security controls have been
cleared by the Information Security Office (June 2026), but in its
current un-acknowledged form it is not yet FERPA-authorized and is not
among the campus-approved AI tools for FERPA-protected content, so
users should use the Workspace-based Gemini and NotebookLM tools UCSC
has already approved for that purpose; a proposed acknowledgment by
UCSC of BayLeaf's operating posture under 34 CFR § 99.31(a)(1)(i)(A),
with the subprocessor chain governed by § 99.33(b), would close the
remaining authorization gate at a protection level to be specified in
the signed memorandum."**

---

## 10. Open questions for the AI Council

<!-- SEC:COUNCIL_QUESTIONS -->
These are the questions this analysis cannot resolve on its own, and
that are most naturally addressed by the UCSC AI Council (with input
from Campus Counsel, the Privacy Office, and the Information Security
Office as needed).

The Information Security Office's P3 security-controls review is
**complete** (June 2026; see the [introduction](#ferpa-and-bayleaf)
status note). The questions below are therefore the
*FERPA-authorization* questions that remain, now in the hands of the
University Registrar and Campus Counsel.

1. **The acknowledgment itself.** Given the draft memo in [§ 8](#8-a-draft-acknowledgment-memo), is
   UCSC willing to acknowledge BayLeaf as an instrument of a school
   official under 34 CFR § 99.31(a)(1)(i)(A) with the subprocessor
   chain authorized under § 99.33(b)? Which of the three
   protection-level options in § 7 of the memo should apply? What
   office is the appropriate signer?

2. **Conditions and controls.** ISO has cleared BayLeaf's P3 security
   controls; what subset of those controls does ISO want transcribed
   into Appendix B as binding conditions of the acknowledgment?
   Particular attention is warranted for the teacher-side automation
   flows described in [§ 3.2.4](#324-blast-radius-asymmetry-between-user-and-teacher-use-cases): rate limits, logging
   requirements, review of agent-driven Canvas API usage.

3. **Extending the P3 approval to direct institutional inference
   back-ends.** The Council has approved Workspace-Gemini and
   NotebookLM for P3 on the strength of UC's negotiated Google
   agreements. Two architectural extensions of that posture are now in
   view: (a) Vertex AI under UCSC's GCP project ([§ 5.2](#52-inference-layer-proposed-direct-google-cloud), already
   demonstrated in private preview), and (b) AWS Bedrock under
   UC ↔ AWS enterprise agreements ([§ 5.3](#53-inference-layer-proposed-aws-bedrock)). Does the P3
   approval extend to these direct-API back-ends, given that they sit
   under the same UC-signed agreement stacks as the
   already-approved Workspace surfaces?

4. **OpenRouter-ZDR for non-FERPA work.** Even if P3 is restricted to
   institutional back-ends (Option C in § 7 of the memo), the
   OpenRouter-ZDR path remains valuable for P1/P2 work and for models
   not yet available on Vertex or Bedrock. Does the Council want this
   distinction enforced technically (per-model access gates by
   protection level) or organizationally (user training plus the
   model labeling already in place)?

5. **User-side characterization.** When a UCSC faculty member pastes
   FERPA-protected content into any AI service that is not on the
   campus-approved list, what is the correct characterization under UC
   policy? User violation, institutional gap, or communication problem
   the existing guidance already addresses? This question predates
   BayLeaf; BayLeaf makes it concrete.

6. **Precedent for faculty-operated instruments.** If UCSC acknowledges
   BayLeaf under [§ 8](#8-a-draft-acknowledgment-memo), does that establish a pattern that could
   support similar acknowledgments for other faculty-operated services
   in the future? What should that pattern look like (minimum viable
   review package, standing signer, mechanism for keeping the
   subprocessor appendix current)?

Answers to these let us replace the conditional language in this
document with definite statements, update user-facing guidance, and
decide whether and how to productionize the institutional inference
back-ends.

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
