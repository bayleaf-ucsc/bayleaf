# University AI infrastructure landscape

Last updated: 2026-09-01

## Intent

This document tracks how universities and university systems provide, procure,
build, and govern generative AI. It records what each institution offers, who can
use it, why it was adopted, what it costs, and what rules govern it.

The document is a factual registry, not a ranking or recommendation. It includes
commercial deployments, institution-built systems, shared public infrastructure,
partial adoption, and organized refusal.

Coverage is selective. The entries represent different technical, financial,
pedagogical, and governance arrangements across regions. Each entry requires public
evidence of a specific service, procurement, policy, or governance action.

Sources are scanned weekly. The document is updated monthly. Each institution is an
independent research unit.

## What this document tracks

Each institutional record uses the following facets when evidence is available.

- **Status and dates:** Proposed, pilot, active, renewed, suspended, or ended;
  announcement, launch, and contract dates.
- **Adoption:** The product or system, model providers, hosting arrangement, and
  whether the institution bought, built, bundled, or joined it through a consortium.
- **Scope:** Campuses and eligible populations, whether use is optional, and whether
  advanced access differs by role or course.
- **Rationale:** The institution's stated reasons, attributed rather than treated as
  demonstrated outcomes.
- **Cost and procurement:** Contract value, duration, procurement method, funding
  source, renewal terms, license count, usage charges, and implementation costs.
- **Governance:** Decision-making bodies; faculty, student, staff, librarian, union,
  privacy, security, and accessibility participation; review and appeal processes.
- **Allowed and foreseeable use:** The highest data classification the institution
  permits, prohibited uses, exceptions, and the highest sensitivity reasonably likely
  to enter the service during ordinary use.
- **Data practices:** Data category, actor, purpose, retention period, storage
  location, deletion, training use, human access, processing region, subprocessors,
  contractual terms, user choice, and technical controls.
- **Pedagogy:** Instructor control, student visibility into instructions, course
  integration, assessment policy, and required or optional training.
- **Model policy:** Published restrictions or preferences concerning open weights,
  model scale, energy use, or vendor diversity. This field is omitted when an
  institution publishes no specific policy.
- **Model development:** Pretraining, continued pretraining, supervised fine-tuning,
  preference tuning, distillation, or adapter training performed or commissioned by
  the institution. Retrieval, indexing, prompting, tool integration, quantization,
  and hosting are recorded separately and are not called model training.
- **Agent skills:** Public `SKILL.md` packages, registries, authoring guidance,
  contribution rules, review, evaluation, maintenance, and compatibility with the
  [Agent Skills specification](https://agentskills.io/home). Human AI literacy,
  custom chatbots, prompts, MCP servers, and similarly named software concepts do not
  count unless the institution publishes a skill package or format-specific guidance.
- **Evaluation:** Activation and use, outcomes, published studies, audits, and
  evidence of benefit or harm.
- **Disputes and gaps:** Organized opposition, contradictory accounts, missing
  records, and claims that remain unverified.

`Not disclosed` means the relevant source was found but did not publish the fact.
`Unknown` means no authoritative source establishing the fact has yet been found.
`Not applicable` means the field does not fit the arrangement. Estimates are labeled
and kept separate from contract values.

### Data-handling terms

The first question is whether campus content is used to train or fine-tune a model.
The record then covers other uses that a no-training term may still permit.

The following terms are recorded separately:

- **No training:** The provider does not use submitted content to train models. The
  provider may still retain and permit access to that content.
- **Retention period:** The documented interval before stored content is deleted.
- **Zero data retention (ZDR):** The inference provider does not persist prompts or
  completions. Request metadata may still be retained.
- **End-to-end encryption (E2EE):** Content is encrypted by the client and decrypted
  only at the intended endpoint. The term is incomplete without identifying that
  endpoint and who controls it.
- **Zero operator access (ZOA):** Operators lack a technical path to plaintext content.
  [AWS's Mantle design](https://aws.amazon.com/blogs/machine-learning/exploring-the-zero-operator-access-design-of-mantle/)
  uses attested code, isolated execution, and restricted administrative access. This
  document distinguishes a ZOA posture from a hardware-attested guarantee.
- **Negotiated protection:** A contract, data-processing agreement, or institutionally
  configured setting supplies the protection. Public product terms alone are recorded
  separately.

Each `Allowed use and data practices` entry records the permitted maximum data class,
foreseeable content class, retention period, training use, other uses, operator access,
contractual basis, and ZDR or ZOA status. Missing facts remain `not disclosed` or
`unknown`.

For each use of data, the record identifies the actor and purpose where possible:

| Actor | Purposes tracked |
|---|---|
| Model provider | Inference, abuse monitoring, policy enforcement, support, debugging, model evaluation, product improvement, and model training |
| Interface or hosting provider | Conversation history, file storage, retrieval, personalization, telemetry, support, and product development |
| Institution | Administration, security, adoption measurement, use-case characterization, service evaluation, disciplinary review, and records compliance |
| Researchers | Human-subjects research, service evaluation, educational research, publication, and dataset creation |
| Agent or interface developer | Harness engineering, debugging, evaluation, telemetry, and product improvement |
| Tool providers | Search, browsing, code execution, storage, connectors, and other tool-specific processing |

Content and metadata are recorded separately. Aggregate, de-identified, pseudonymous,
and anonymous data are also separate categories. The record states whether a use is
required to provide the service, enabled by default, optional, subject to consent, or
conducted under a research protocol when that information is public.

Permitted use does not describe all data likely to enter a conversational system.
[What We Tell AI](https://www.whatwetellai.com/) collects accounts of people discussing
health, relationships, family, employment, finances, identity, and personal crises with
chatbots. [Offramps](https://blog.bayleaf.dev/p/offramps) describes the same transition
from routine assistance to sensitive disclosure in a university service. The tracker
therefore records **foreseeable content** separately from **permitted content**. A
general-purpose campus chatbot may foreseeably receive an institution's highest data
classification even when policy prohibits that use. This is a risk assumption, not an
authorization to process that data.

### Evidence standard

Sources are preferred in this order:

1. Executed contracts, tender notices, budgets, board minutes, and public records.
2. Adopted policies, governance documents, technical documentation, and official
   institutional service pages.
3. Institutional or government announcements.
4. Independent reporting, especially when it supplies records or documents conflict.
5. Vendor announcements and marketing material.

Material claims link to evidence near the claim. Vendor descriptions of privacy,
educational value, or adoption are attributed to the vendor. Reviews that find no
material change still update the record's `Last verified` date.

Institutional records use public-facing sources. Repository-internal documentation may
support research but is not cited as evidence for an institution.

### Update procedure

An update to one institutional record consists of:

1. Rechecking every linked source in the current record.
2. Searching institutional news, service, policy, governance, procurement, and budget
   pages for changes since `Last verified`.
3. Searching independent reporting for contracts, disputes, and implementation data
   absent from institutional sources.
4. Updating only claims supported by the collected evidence.
5. Recording unresolved contradictions and unavailable fields under `Open questions`.
6. Editing the revised record with Lauren Tan's MIT-licensed pstack
   [`unslop`](https://github.com/cursor/plugins/blob/99559f2f52047978602ef365589275831e76af07/pstack/skills/unslop/SKILL.md)
   method. Cut promotional wording, vague attribution, filler, and repeated conclusions.
   Preserve facts, uncertainty, citations, and named responsibility. Copyright (c)
   2026 Lauren Tan.
7. Updating `Last verified`, including when no material change is found.

## Institutions and systems

### North America

#### Arizona State University, United States

**Last verified:** 2026-08-31<br>
**Status:** Active<br>
**Form:** Institution-wide commercial service with staged access

**Adoption and scope.** ASU was OpenAI's first announced university partner in
January 2024. Its current [ChatGPT Edu service page](https://ai.asu.edu/ai-asu/chatgpt-edu)
says students, faculty, researchers, and staff have no-cost access, with licenses
active from October 1, 2025 through September 1, 2026. Faculty and staff receive a
full-year allocation; student access is semester-based and requested through ASU's
subscription system.

**Rationale and pedagogy.** ASU initially solicited faculty and staff proposals in
teaching, research, and operations. Current
institutional guidance presents ChatGPT Edu as a general assistant and custom-agent
platform. The service is optional; course policy remains separate.

**Cost and procurement.** The university does not publish the current price on its
service page. [Contracts obtained through public-records requests](https://www.insidehighered.com/news/tech-innovation/artificial-intelligence/2026/03/27/faculty-push-back-against-openai-deals)
were reported at $300,000 for the first year, $216,260 for the second agreement, and
$2.1 million for the agreement ending in September 2026. The underlying contracts
have not yet been added to this record.

**Allowed use and data practices.** ASU says the service is approved for non-regulated and internal
data, does not use prompts or responses for model training, and has a 180-day
retention period. The protection comes from an enterprise agreement. The service is
not ZDR. No public source reviewed establishes ZOA or a technical block on submitting
data outside the approved classes.

**Open questions.** The source record does not yet establish activation, monthly
active use, total eligible population covered by the current agreement, procurement
method, or independent educational outcomes.

#### California State University, United States

**Last verified:** 2026-08-31<br>
**Status:** Active; renewed in 2026<br>
**Form:** Public university system-wide single-vendor license

**Adoption and scope.** CSU launched a system-wide ChatGPT Edu initiative in 2025
across its 22 universities. The original 18-month agreement made 500,000 licenses
available. The [current CSU FAQ](https://genai.calstate.edu/about/frequently-asked-questions)
says the renewal expands potential access to 675,000 users and includes access for
students for one year after graduation. Faculty participation and classroom use are
voluntary.

**Rationale.** CSU names equitable access, student success, workforce preparation,
privacy, continuity, and lower price as its principal reasons. It says the nearest
competing offer cost $8 per user per month, while the renewed OpenAI agreement costs
$1.60 per user. The FAQ does not specify whether that figure is per month, but the
reported total implies that it is.

**Cost and procurement.** The original agreement cost approximately $17 million over
18 months. [Independent reporting based on public records](https://laist.com/news/education/csu-renews-openai-contract-chatgpt-artificial-intelligence)
breaks that into roughly $1.9 million for 40,000 users during the first six months and
$15 million for 500,000 users during the following year. The renewed agreement costs
$13 million annually for three years, can be cancelled annually with notice, and is
funded with system-wide resources. The original agreement was executed without a
competitive bid; CSU says it evaluated multiple vendors before selecting OpenAI.

**Governance.** CSU identifies a system-wide Generative AI Advisory Committee and
subcommittees for teaching and learning, privacy and security, and productivity. The
system says these bodies unanimously recommended renewal and that faculty retain
authority over their courses. Faculty and student critics reported that the initial
contract was announced without prior consultation they considered adequate.
[CalMatters documented the dispute](https://calmatters.org/education/2026/05/california-state-university-open-ai-chatgpt-contract/).

**Allowed use and data practices.** CSU says workspace content is not used for model training and
that the service provides SAML SSO, domain verification, configurable retention, and
encryption in transit and at rest. It says individual conversations are not monitored
and that CSU collects basic adoption statistics. The configured retention period and
the conditions under which users may opt into data sharing remain to be verified. The
agreement is institution-specific. No public source reviewed establishes ZDR or ZOA.

**Evaluation and dispute.** More than 94,000 people responded to a system survey, but
the survey did not ask whether the contract itself should continue. As of April 2026,
reported completion of voluntary training was 0.7% among students and 16% among
faculty. Faculty organized against renewal during simultaneous budget cuts. CSU
nevertheless renewed the agreement and says future work will emphasize measurable
impact and long-term sustainability.

#### University of California system and Office of the President, United States

**Last verified:** 2026-09-01<br>
**Status:** Systemwide procurement and governance active; UCOP services active<br>
**Form:** Master agreement, system governance, and office-level commercial services

**Adoption and scope.** UC's
[systemwide OpenAI agreement](https://procurement.ucop.edu/news/openai-it-uc-wide-agreement)
covers ChatGPT Enterprise and Edu from June 13, 2024 through June 12, 2027,
with two optional one-year renewals. It lets UC locations buy the services but
does not itself license every student or employee. UCOP separately offers
[ChatGPT Edu](https://www.ucop.edu/information-technology-services/services/ucop-it-services/software/chatgpt.html)
to employees with manager approval and departmental funding.

**Cost and procurement.** Public sources do not disclose the master agreement's
value, unit prices, minimum purchase, or campus orders. The agreement includes a
BAA, data-processing agreement, Appendix DS, completed systemwide supplier risk
assessment, confidentiality protection for prompts and responses, and an
obligation to reach WCAG 2.1 AA within 12 months. UCOP recharges ChatGPT Edu
annually but does not publish the price outside its authenticated request form.

**Governance.** UC adopted Responsible AI Principles in 2021 and established a
standing [AI Council](https://ucop.edu/ethics-compliance-audit-services/compliance/aicouncil/index.html)
in 2022. Its charge includes procurement, risk and impact assessment, monitoring,
campus coordination, and a public inventory. The council publishes systemwide
guidance and training, but locations retain responsibility for approving tools,
data, and use cases.

**Allowed use and data practices.** UCOP approves ChatGPT Edu through P3. Its
[OpenAI API service](https://www.ucop.edu/information-technology-services/services/ucop-it-services/software/openaiapi.html)
is approved through P4, including fewer than 500 PII records, after use-case and
manager approval. ZDR is the default API configuration; the alternate API mode
may retain inputs and outputs for up to 30 days. OpenAI says API data is not used
for training without consent. UCOP charges model usage plus a 10% administrative
fee. These UCOP settings do not establish another location's configuration.

**Open questions.** Contract value, campus order volumes, ChatGPT retention
settings, administrator and support access, use rates, and outcomes are not
public. No reviewed source establishes ZOA. The status of the proposed public AI
inventory and OpenAI's compliance with the contract's accessibility deadline are
unclear.

#### University of California Agriculture and Natural Resources, United States

**Last verified:** 2026-09-01<br>
**Status:** AI review process active; institution-licensed assistant reported<br>
**Form:** Organization-wide governance with an authenticated service inventory

**Adoption and scope.** UC ANR's
[communications guidance](https://ucanr.edu/dept/communications-toolkit/ai-tools)
directs employees to an authenticated register of reviewed vendors and tools,
including each tool's approved protection level. The public page does not expose
that inventory. UC San Diego
[reports](https://today.ucsd.edu/story/tritongpt-is-here-and-ready-to-help) that
it licenses a branded TritonGPT instance to UC ANR, but no reviewed public ANR
page documents its scope, eligibility, models, or current status.

**Governance.** New tools require a vendor risk assessment. UC ANR's
[implementation guidance](https://ucanr.edu/dept/human-resources/guidelines-ai-tools)
also requires an AI Project Request and review by HR and IT for labor-relations,
privacy, and cybersecurity implications. It identifies union notification and
human oversight as requirements for uses affecting employment conditions.
Additional legal review may apply. This process gives named offices review
responsibility but does not publish approvals, decisions, appeals, or monitoring
results.

**Allowed use and data practices.** Employees may use P1 public information in
AI tools after vendor risk review. P2 through P4 information, non-public output,
and uses affecting employee personal information, health and safety, or working
conditions require approval or are prohibited. The public record does not
identify the approved tools for those classes or disclose retention, training
use, human access, processing regions, subprocessors, ZDR, or ZOA.

**Evaluation and open questions.** A
[2024 employee survey](https://ucanr.edu/sites/default/files/2025-04/UC_ANR-GenAI_Report.pdf)
received 298 usable responses. Forty-five percent reported using generative AI
in UC ANR work and another 20% planned to do so. ChatGPT was the most-used tool,
although the report said it was not then approved for P2 through P4 data. The
sample was voluntary and does not establish organization-wide use. Tool
availability, TritonGPT adoption, costs, outcomes, accessibility review, and
incident history remain unknown.

#### University of California, Berkeley, United States

**Last verified:** 2026-09-01<br>
**Status:** Licensed tools active; multi-model and assistant services in pilot<br>
**Form:** Bundled commercial tools and campus-operated AI services

**Adoption and scope.** Berkeley provides Gemini and Microsoft Copilot to
students and employees and offers paid ChatGPT Edu to employees and student
workers through its
[licensed-tools catalog](https://ai.berkeley.edu/tools-training/licensed-ai-tools).
Its [Campus AI Sandbox](https://ai.berkeley.edu/tools-training/campus-ai-sandbox-beta)
is an AWS-hosted LibreChat deployment offering OpenAI, Anthropic, Google, and
other models, web search, and image generation. The pilot began March 20, 2025
and covers faculty, staff, student workers, and students in Engineering and Haas.
It is for administrative work, not general student academic use.

[BearGPT Enterprise Assistants](https://ai.berkeley.edu/tools-training/beargpt-enterprise-assistants)
lets employees commission internal assistants grounded in official university
content and public chatbots for campus websites. UC San Diego hosts BearGPT on
its infrastructure using OpenAI's open-weight GPT-OSS model. Internal assistants
are approved through P2; public bots are limited to P1.

**Rationale, governance, and cost.** The Provost's Advisory Council on AI
requested the pilot to test productivity, equitable model access, demand, and a
sustainable funding model. Berkeley IT operates it with campus security, the
College of Engineering, Haas, and AWS. The Sandbox and internal BearGPT
assistants have no user charge during their pilots. Public BearGPT chatbots cost
$6,000 annually. Public sources do not disclose total cost or contract value.

**Allowed use and data practices.** The Sandbox is approved through P3 and uses
models covered by UC privacy, security, and intellectual-property agreements.
Berkeley's catalog assigns each licensed tool a maximum protection level; tools
outside negotiated agreements are not approved for confidential UC data. Public
sources reviewed do not disclose retention, model-provider or operator access,
feedback use, processing regions, ZDR, or ZOA.

**Pedagogy and evaluation.** Instructors retain authority over course use.
Berkeley says the pilot will measure cost drivers and how participants benefit,
but it has not published activation, usage, outcome, or equity results.

#### University of California, Davis, United States

**Last verified:** 2026-09-01<br>
**Status:** Multi-tool campus portfolio active<br>
**Form:** Bundled commercial tools, paid licenses, and institution-built services

**Adoption and scope.** The [Aggie AI portfolio](https://iet.ucdavis.edu/aggie-ai/ai-tools)
includes Gemini for Education and Microsoft 365 Copilot Chat at no user charge
for campus students, faculty, and staff, plus Zoom AI Companion and the
institution-built Rocky campus assistant. Gemini is not available to UC Davis
Health. Campus faculty and staff can buy
[ChatGPT Edu](https://iet.ucdavis.edu/aggie-ai/ai-tools/chatgpt-edu) annually
through a departmental chart string; Health access was still pending. Paid
Microsoft 365 Copilot is separate from free Copilot Chat.

**Rationale and governance.** UC Davis presents Aggie AI as a common service
layer for teaching, research, and operations. A campus AI steering committee's
[2026 report](https://leadership.ucdavis.edu/sites/g/files/dgvnsk1166/files/media/documents/AISteeringCommitteeReportFinal.pdf)
calls for build-versus-buy review, pilots, security and privacy coordination,
campus guidance, and measured use of Rocky and related internal services.

**Allowed use and data practices.** UC Davis says institutional
[Gemini](https://iet.ucdavis.edu/aggie-ai/ai-tools/google-gemini) and
[Copilot](https://iet.ucdavis.edu/aggie-ai/ai-tools/microsoft-copilot) chat data
are not used for model training. Its Gemini page also says chats and uploaded
files are not reviewed by humans. Sensitive-data use still requires
tool-specific review; public pages do not establish a common maximum protection
level for the whole portfolio. Retention, campus administrator access, ZDR, and
ZOA are not disclosed.

**Model development and Agent Skills.** Rocky is an institution-built service;
no reviewed source establishes a trained institutional foundation model. UC
Davis also maintains a public Agent Skills registry, recorded
separately below. The steering report proposes service and pilot metrics, but
current activation, outcome, cost, and accessibility results are not public.

#### University of California, Irvine, United States

**Last verified:** 2026-09-01<br>
**Status:** Campus multi-model platform and licensed tools active<br>
**Form:** Institution-built chat, API, course-agent, and assistant services

**Adoption and scope.** UCI's [ZotGPT](https://www.oit.uci.edu/services/ai/zotgpt/)
portfolio provides free multi-model chat to students, faculty, and staff. It
also includes an API gateway with UCInetID authentication, budgets, and
observability; ClassChat for instructor-built course bots; and Creator for
custom assistants. Copilot Chat and Gemini are separately available through UCI
accounts. ZotGPT uses Microsoft Azure AI, AWS, and open-source components.

**Cost and pedagogy.** Chat, Copilot Chat, and Gemini have no additional user
charge. The [gateway](https://zotgpt.uci.edu/) uses metered pricing and offers
new users an initial credit. ClassChat lets faculty ground assistants in course
content. Public sources do not disclose total service cost, procurement method,
activation, or course outcomes.

**Allowed use and data practices.** UCI approves ZotGPT, Copilot Chat, and Gemini
through P3. ZotGPT may process P4 under an MOU; the
[security guide](https://www.security.uci.edu/how-to/ai-chatbot/) otherwise
discourages duplicate P4 data and requires a reviewed business case. UCI says
content processed through the [ZotGPT service](https://zotgpt.uci.edu/) is not
used for commercial model training. Chat history is a service feature, so ZotGPT
is not ZDR as a whole. Retention periods, operator
access, provider abuse review, processing regions, and ZOA are not disclosed.

**Agents and open questions.** ZotGPT supports custom bots and linked agents,
but no public Agent Skills packages were found. The public record does not
establish how agent permissions, tool actions, evaluation, or incident review
are governed.

#### University of California, Los Angeles, United States

**Last verified:** 2026-09-01<br>
**Status:** Licensed tools active; OpenAI pilot completed<br>
**Form:** Bundled services, paid licenses, and a project-based pilot

**Adoption and scope.** UCLA provides Gemini, NotebookLM, and basic Copilot at no
additional charge to eligible students and employees. Its
[tool matrix](https://dts.ucla.edu/initiatives/ai/available-tools) offers
ChatGPT Edu to faculty and staff for $103.60 per year plus optional advanced
model credits at $0.04 each. Departments may also buy Microsoft 365 Copilot.
Zoom AI features are available campus-wide but disabled by default.

**Pilot and evaluation.** UCLA's 2024 campus call selected 68 projects from 74
proposals across 20 departments and distributed more than 400 ChatGPT Enterprise
licenses. The [institutional account](https://dts.ucla.edu/newsroom/openai)
describes projects in teaching, research, and operations but does not publish
project-level outcomes. A separate Gemini and Copilot pilot reported that 76%
of respondents valued summarization and content generation, 41% estimated
immediate productivity gains of at least 25%, and 58% raised privacy or accuracy
concerns; sample size and survey instrument are not given on the
[summary page](https://dts.ucla.edu/newsroom/microsoft-google).

**Allowed use and data practices.** UCLA approves its listed campus-account
tools through P3 and permits P4 only with unit-head and CISO approval. UCLA
Health users may not enter protected health information into the campus tools.
ChatGPT connectors remain disabled pending privacy and security review. Public
sources reviewed do not disclose retention, administrator access, ZDR, or ZOA.

**Governance and open questions.** Digital & Technology Solutions manages the
portfolio and publishes responsible-use guidance. The source record does not
identify continuing faculty, student, labor, or independent oversight of tool
selection, nor total contract cost, use rates, or educational outcomes.

#### University of California, Merced, United States

**Last verified:** 2026-09-01<br>
**Status:** Licensed commercial tools active<br>
**Form:** Bundled and individually purchased commercial services

**Adoption and scope.** UC Merced's
[service comparison](https://libguides.ucmerced.edu/artificial-intelligence/home)
lists Microsoft Copilot for students, faculty, and staff at no additional
charge; Microsoft 365 Copilot for faculty and staff at $360 annually; and
ChatGPT Edu for faculty and staff by request at approximately $360 annually.
Zoom AI Companion and Canva Magic Studio are also available under campus or
paid licenses.

**Allowed use and data practices.** The comparison page marks Copilot, Microsoft
365 Copilot, and ChatGPT Edu as approved through P4, while Zoom and Canva are
limited to P2. It does not state the approval conditions, retention periods,
training use, human or administrator access, processing regions, ZDR, or ZOA.
Those omissions are material because the page authorizes highly sensitive data.

**Governance, pedagogy, and open questions.**
[OIT](https://it.ucmerced.edu/news/2025/uc-merced-ai) describes the portfolio as
a cross-campus effort to collect reviewed tools and guidance. Public sources do
not identify a standing governance body, instructor decision rules, contract
values, license counts, use rates, outcomes, or independent security and
accessibility assessments.

#### University of California, Riverside, United States

**Last verified:** 2026-09-01<br>
**Status:** Campus-licensed tools active; The Grove in soft launch; ChatGPT Edu
under negotiation<br>
**Form:** Commercial services, an institution-configured agent platform, and
research cloud infrastructure

**Adoption and scope.** UCR provides standard Gemini and NotebookLM at no user
charge to faculty, staff, and students. Its
[AI service page](https://its.ucr.edu/ai) also lists Google AI Pro at $96 per
year and Microsoft 365 Copilot at $204 per year for faculty and staff. Zoom AI
Companion is included with UCR Zoom. ChatGPT Edu is not available; UCR lists a
$120 annual price but says negotiations with OpenAI remain underway.

UCR [soft-launched The Grove](https://its.ucr.edu/explore-the-grove) on April
29, 2026 for early adopters among faculty, staff, and students. Built on Gemini
Enterprise, The Grove combines chat and notebook tools with UCR data connectors
and agents that can send email, schedule meetings, and submit support tickets.
Users authenticate with a UCR account and Duo, then authorize the service to
inspect data they can access and act on their behalf. The
[August 2026 update](https://its.ucr.edu/blog/2026/08/10/grove-summer-update)
documents live DocuSign and Slack connectors, a separate Gemini Notebook,
Gemini Canvas, and a marketplace where administrators must approve third-party
agents. Canvas LMS, broader ServiceNow access, and several other connectors
were still planned rather than operational.

**Rationale.** UCR says the services provide protected alternatives to consumer
accounts and support teaching, research, and administrative work. The Grove is
intended to reduce time spent navigating separate campus information systems.

**Cost and procurement.** An
[institutional account](https://insideucr.ucr.edu/stories/2026/03/20/ucr-community-urged-use-google-ai-tools)
dates UCR's broader Google enterprise agreement to approximately 2023. No
reviewed source discloses its value, procurement method, license count, renewal
terms, or The Grove's incremental cost. Copilot and
[Google AI Pro](https://its.ucr.edu/googleaipro) licenses are requested through
campus units. The $96 Google AI Pro rate depends on sufficient bulk demand, and
users or units fund later renewals.

**Governance.** UCR announced a joint Senate-administrative
[AI Council](https://www.senate.ucr.edu/news/article/34) in February 2026. The
Senate-led body is charged with academic guidance, needs assessment, procurement
advice, infrastructure recommendations, and attention to equity and
accessibility. Its standing members include faculty, administrators, ITS, the
teaching center, and a librarian. Students may be consulted at selected points;
privacy officers, counsel, and the Registrar are also consultative rather than
standing members. The [committee page](https://www.senate.ucr.edu/committees/125)
lists no meetings, decisions, or reports. The Google agreement predates this
body, and no public source establishes Council review of The Grove.

**Allowed use and data practices.** UCR limits AI tools without campus contracts
to P1 public data. Its service table permits P1 through P3 in most supported
tools and permits specified tools, including The Grove, to process P4 data after
ITS consultation. The table limits standard Gemini to P3, while the separate
[Google AI Pro page](https://its.ucr.edu/googleaipro) says standard Gemini and
NotebookLM may process P4. The applicable rule is therefore contradictory.

UCR says content submitted through its Google enterprise services remains in
the university-controlled tenant and is not used to train Google's public
models. This is a negotiated no-training protection, not evidence of zero
retention. Public pages do not specify retention periods, deletion controls,
processing regions, subprocessors, support or administrator access, abuse
review, metadata use, or user opt-outs. The services support continuing
conversations, notebooks, and uploaded sources, so the overall arrangement is
not established as ZDR. No reviewed source establishes E2EE or ZOA.

**Foreseeable content.** UCR expressly contemplates P4 use in The Grove and
other supported tools after consultation. The Grove can inspect email,
calendars, documents, and connected administrative systems under a user's
permissions and can take actions for that user. P4 content is therefore both a
permitted and foreseeable exposure for approved deployments, not only a risk of
policy-violating input.

**Pedagogy.** UCR's September 2025
[instructional guidance](https://provost.ucr.edu/media/2947/download?attachment=)
preserves instructor authority over course use, requires equal access when an
AI tool is required, and calls for explicit course expectations and attribution.
It warns that automated AI-detection tools can be inaccurate and biased. A
Canvas LMS connector for The Grove was planned for Fall 2026 but was not
documented as live at verification.

**Model development and agents.** UCR's
[Ursa Major](https://ucr-research-computing.github.io/pages/ursa_major.html)
research service provides Vertex AI, Gemini API access, model-training
infrastructure, and P4 research enclaves. Baseline allocations may be
subsidized; GPU-intensive work is recharged to grants. This establishes campus
capacity, not evidence that UCR pretrained, fine-tuned, distilled, or
commissioned a specific generative model. The Grove supports no-code agents,
institutional connectors, task execution, and administrator-approved third-party
agents. No public `SKILL.md` packages, Agent Skills registry, or format-specific
Agent Skills guidance were found.

**Evaluation and open questions.** UCR collects early-adopter intake and
in-product feedback to prioritize features. It publishes no activation count,
usage rate, outcome study, accessibility audit, security evaluation, or agent
error analysis. Contract value and lineage, retention, human access, agent
authorization and audit controls, Council involvement, and the status of
planned Canvas and ServiceNow integrations remain unknown.

#### University of California, San Diego, United States

**Last verified:** 2026-09-01<br>
**Status:** Campus platform active<br>
**Form:** Institution-operated multi-model chat, API, assistant, and agent platform

**Adoption and scope.** UC San Diego began developing TritonGPT in June 2023,
launched it to campus and Health Sciences employees in Spring 2024, and added
student access in June 2025. The
[institutional account](https://today.ucsd.edu/story/tritongpt-is-here-and-ready-to-help)
describes campus, administrative, and course assistants available through chat,
Canvas, websites, and the UC San Diego mobile application. IT Services operates
the platform at the San Diego Supercomputer Center using locally installed
middleware, locally hosted open models, and approved commercial model APIs.

**Architecture and governance.** [TritonAI](https://tritonai.ucsd.edu/about/index.html)
extends TritonGPT with a managed model gateway, developer APIs, a workflow
harness, institutional connectors, tools, and reusable skills. Supported
services require a named owner, approved hosting and data sources, accessibility
and evaluation checks, human review for consequential actions, and an escalation
path. Model routes include SDSC-hosted models and enterprise AWS, Azure, and
Google Vertex AI services.

**Allowed use and data practices.** TritonGPT and TritonAI Harness are approved
through P3 in approved services; P4 is prohibited. The
[privacy statement](https://tritonai.ucsd.edu/tritongpt/privacy.html) says UCSD
stores chats, feedback, IP addresses, user agents, and interaction metadata;
interaction records are deleted after 90 days and users may delete chats sooner.
Prompts are not used to train underlying models. Authorized personnel can access
logs, while identifiers are removed from analytical interfaces. Some assistants
call commercial APIs under UC agreements. This is not ZDR or ZOA.

**Pedagogy and model development.** Faculty can ground course assistants in
materials placed in an approved Drive location and expose Socratic tutors through
TritonGPT or Canvas. This is retrieval and prompting, not model training. The
default and available models change over time; UCSD also hosts open-weight models
locally. No reviewed source establishes that UCSD changes model weights.

**Cost, evaluation, and open questions.** The Chancellor funded initial
development, and UCSD licenses branded instances to other institutions. Contract
values, operating cost, revenue, current active use, error rates, and educational
outcomes are not public. The relationship between service-level review and
Academic Senate, student, labor, and privacy governance remains unclear.

#### University of California, San Francisco, United States

**Last verified:** 2026-09-01<br>
**Status:** ChatGPT Enterprise active; institution-built API and assistants active<br>
**Form:** Campus-wide commercial chat plus institution-built clinical and research services

**Adoption and scope.** UCSF
[launched ChatGPT Enterprise](https://it.ucsf.edu/news-events/news/open-ais-chatgpt-enterprise-february-2026-launch)
in February 2026. More than 9,000 existing Versa Chat users received initial
access; other people with UCSF accounts could then request access. The
[service FAQ](https://ai.ucsf.edu/ucsf-chatgpt-enterprise-faqs) says ChatGPT
Enterprise replaces UCSF-developed Versa Chat for general-purpose chat. The
[Versa platform](https://ai.ucsf.edu/platforms-tools-and-resources/ucsf-versa)
continues to provide API access and specialized assistants for research,
clinical, and institutional workflows.

**Rationale and cost.** UCSF describes the change as broader access to current
models while retaining institutional privacy and security controls. Public
sources do not disclose contract value, license count, recharge terms, or the
cost and funding of Versa.

**Allowed use and data practices.** [UCSF](https://ai.ucsf.edu/) approves ChatGPT
Enterprise through P4 and describes it as supporting HIPAA-regulated use. The
public page calls the service data-secure and user-private but places detailed
terms behind UCSF authentication. Retention, deletion, training use, OpenAI and
UCSF operator access, processing regions, subprocessors, ZDR, and ZOA remain
unverified publicly. Approval through P4 is not evidence of any of those
properties.

**Governance, agents, and open questions.** UCSF publishes separate Health AI
oversight, IRB guidance, and directories for approved clinical, research, and
productivity tools. Versa supports more than 100 assistants and programmatic
model access, but no public Agent Skills packages were found. Activation after
the initial migration, clinical outcomes, incident reporting, model routing,
assistant evaluation, and the continuing role of Versa Chat are not public.

#### University of California, Santa Barbara, United States

**Last verified:** 2026-09-01<br>
**Status:** Licensed tools and campus multi-model service active; premium pilot active<br>
**Form:** Bundled commercial tools, centrally funded multi-model service, and pilot

**Adoption and scope.** UCSB provides Gemini, NotebookLM, and Zoom AI Companion
to faculty and staff under existing licenses. Its
[tool catalog](https://cio.ucsb.edu/artificial-intelligence/genai-tools-ucsb)
also lists the centrally funded UCSB AI Commons. The
[AI Commons](https://aicommons.ucsb.edu/home) provides multiple models, file and
image input, custom assistants, API access, and an initial monthly allowance of
one million tokens per user. It currently serves faculty, staff, and members of
the campus AI community of practice, with broader access planned.

UCSB also selected 300 employees for a one-year
[Google AI Pro pilot](https://cio.ucsb.edu/google.ai.pro.education). Participants
receive premium models, expanded NotebookLM, Workspace integration, custom Gems,
media generation, and agentic features, and must complete onboarding and two or
three feedback surveys.

**Allowed use and data practices.** Gemini, NotebookLM, and AI Commons are
approved through P4 after required consultation with Information Security; Zoom
AI Companion is approved through P3. UCSB says Google enterprise content is not
used for model training or human review. Public sources do not disclose AI
Commons model providers, retention, operator access, provider access, processing
regions, or deletion controls. Neither the Google tools nor AI Commons are
established as ZDR or ZOA.

**Governance, cost, and open questions.** The CIO's office maintains campus AI
guidance and service approvals. AI Commons is centrally funded with usage
limits; the total budget and procurement method are not public. Pilot survey
results, service activation, model-specific cost, agent review, educational
outcomes, and standing faculty, student, labor, or privacy decision rights remain
unknown.

#### University of California, Santa Cruz, United States

**Last verified:** 2026-08-31<br>
**Status:** Campus-licensed tools active; faculty-operated service active<br>
**Form:** Bundled commercial tools and a separate faculty-operated multi-model service

**Adoption and scope.** UCSC provides campus-licensed Google Gemini Chat and Gemini
Notebook to faculty and staff through its Google Workspace for Education agreement.
The [campus comparison guide](https://its.ucsc.edu/get-support/it-guides/guide-comparison-of-ucsc-licensed-ai-tools/)
also lists Zoom AI Companion for staff and contractors. The tools are available at no
additional charge under existing licenses.

[BayLeaf](https://bayleaf.dev/) separately provides chat, API, search, and sandbox
services to UCSC students, faculty, and staff. It is operated by a Computational Media
faculty member. UCSC ITS does not operate or support it. Course-specific deployments
have served about 700 students across six course offerings since Fall 2024.

**Rationale and pedagogy.** UCSC describes its licensed tools as supported alternatives
to consumer accounts and cites privacy, access, and staff productivity. The campus
consulted leadership and the UCSC AI Council before staff rollout and consulted the
Academic Senate before extending access to faculty. BayLeaf publishes instructor-made
course agents and gives instructors control over course instructions and tools.

**Model policy.** UCSC's campus-licensed tools do not publish a model-size or
open-weight restriction. BayLeaf's [public description](https://bayleaf.dev/) states
that its Chat agents use mid-sized, sub-trillion-parameter open-weight models. The API
recommends an open-weight model and limits its displayed catalog to models for which
OpenRouter supplies a valid Hugging Face reference. The API still routes a manually
specified closed-weight model slug. This is a default and discovery policy, not an
inference allowlist.

**Cost and procurement.** UCSC states that Gemini Chat, Gemini Notebook, and Zoom AI
Companion are included in existing campus licenses. The university does not publish an
allocated cost for their AI functions. BayLeaf publishes no institutional contract;
its [public description](https://bayleaf.dev/) identifies it as a faculty-operated
experimental service.

**Allowed use and data practices.** UCSC's [safe-use guide](https://its.ucsc.edu/get-support/it-guides/guide-use-artificial-intelligence-ai-safely/)
allows campus-licensed AI tools to process P1, P2, and P3 data. P4 data is prohibited,
apart from a stated prior-security-consultation exception for some Zoom AI Companion
uses. Unlicensed AI tools are limited to P1 and P2 data.

BayLeaf's [privacy notice](https://bayleaf.dev/privacy.html) states that a UCSC ITS
security review cleared the service technically for data through P3. That review did
not authorize use with regulated records. Authorization to process actual FERPA
student records remains pending, and the service instructs users not to submit those
records or any P4 data.

BayLeaf's published [Offramps](https://blog.bayleaf.dev/p/offramps) account says its
general assistant is instructed to suggest a local or more private service when a
conversation becomes particularly sensitive. This is behavioral guidance, not a
technical control on data entry.

**Foreseeable content.** UCSC classifies health information, some disability and
financial-aid records, passwords, sensitive personally identifiable information, and
some research data as P4 in its
[Data Protection Levels guide](https://its.ucsc.edu/get-support/it-guides/data-and-it-resource-classification/data-protection-levels/).
These are also subjects that can arise during ordinary chatbot conversations. This
record therefore assigns general-purpose campus chat a foreseeable P4 exposure even
where policy and prompts prohibit P4 input. Neither campus instructions nor model
refusals technically prevent a user from entering P4 content.

**Provider use, retention, and access.** UCSC states that its agreements with Google and other campus
vendors prevent use of institutional inputs for model training and keep the data under
university control. Google's
[Workspace Privacy Hub](https://support.google.com/a/answer/15706919) says Gemini uses
prompts and authorized Workspace context to generate responses. It does not use that
content for model training or human review outside the customer's domain without
permission. The Gemini app can retain conversations for up to 36 months; the default
is 18 months, and disabling history still permits storage for up to 72 hours for
service delivery and feedback processing. Gemini Notebook does not retain prompts and
responses after a session, but uploaded sources and notebooks follow the Workspace
data-processing agreement. UCSC has not published its configured retention values.

Google also permits voluntary in-product feedback to include the prompt, contextual
sources, and response when the user leaves the relevant sharing boxes selected. Google
says it may retain that feedback for 18 months and use it for aggregate analysis, bug
fixes, and policy-enforcement improvements, but not to train the generative models that
support Workspace. UCSC has not published whether administrators disable or modify
these feedback controls. No public source reviewed establishes ZDR or ZOA for UCSC's
Gemini services.

BayLeaf Chat stores conversation history in an encrypted database for 90 days after
last activity; the user and service administrator can access it. Its ordinary
inference path uses OpenRouter endpoints designated ZDR. BayLeaf does not store a
separate copy of prompts or completions in that path. Its API also offers an optional
client-verified route encrypted to a Tinfoil enclave. The operator relays ciphertext
and has no standing access to request content on that route. These are service-level
arrangements, not terms negotiated by UC. The
[public privacy notice](https://bayleaf.dev/privacy.html) documents retention,
subprocessors, access, and deletion controls.

**Institutional secondary use.** BayLeaf's operator conducted one documented use-case characterization of stored Chat
conversations. The [published account](https://blog.bayleaf.dev/p/what-are-people-doing-with-bayleaf)
states that the operator excluded their own chats, removed about 89% of text through
truncation and filtering, sent the remaining conversation text to an LLM for topic and
intent summaries, embedded those summaries, clustered them, and generated aggregate
cluster descriptions. The operator then read a small number of raw conversations in a
sensitive cluster. The post does not state that this was a recurring process, whether
users consented to this secondary use, whether an IRB reviewed it as human-subjects
research, or how long intermediate and derived data were retained.

**Governance.** Campus tool selection involves UCSC ITS, campus leadership, the UCSC
AI Council, and consultation with the Academic Senate. The available public pages do
not specify continuing decision rights for faculty, students, staff, or unions.
BayLeaf remains under its faculty operator rather than campus IT governance.

**Open questions.** UCSC has not published the Google retention configuration,
administrator-access rules, negotiated contract language, aggregate use, allocated
cost, or an evaluation of educational outcomes. BayLeaf's security review is not
public, and its legal authorization for FERPA records remains unresolved. The
governance status and retention of BayLeaf's use-case-analysis data also remain
unresolved in the public sources.

#### University of Colorado System, United States

**Last verified:** 2026-08-31<br>
**Status:** Active rollout<br>
**Form:** Public university system-wide single-vendor license

**Adoption and scope.** CU announced ChatGPT Edu environments for each of its four
campuses and the system office in February 2026, covering about 100,000 students,
faculty, and staff. Staff access was scheduled for March 31 and student access for
August 14 after faculty concerns delayed the student rollout. Use remains optional,
and faculty retain authority over classroom use.

**Rationale.** The [system announcement](https://connections.cu.edu/spotlights/university-colorado-launches-systemwide-chatgpt-access)
emphasizes equitable access, workforce preparation, and replacing risky consumer use
with an institutionally controlled environment.

**Cost and procurement.** The renewable annual agreement costs approximately $2
million for the first year. The system office pays year one; campuses assume the cost
of their own environments afterward. The public announcement does not identify the
procurement method or distinguish base licenses from advanced-use charges.

**Governance.** The President's AI Working Group, composed of faculty and staff,
evaluated options using privacy, security, sustainability, equity, and institutional
benefit. A brief training on appropriate use and privacy is required before access.
Existing academic freedom, conduct, and data governance rules remain in force.

**Allowed use and data practices.** CU states that OpenAI will not use CU environment content for
training. Retention, university administrator access, approved data classifications,
and opt-in controls are not disclosed in the announcement. The system holds an annual
institutional agreement. No public source reviewed establishes ZDR or ZOA.

**Dispute and open questions.** Faculty and students published an open letter arguing
that consultation, evidence of educational benefit, and safeguards were inadequate.
Campus funding after year one remains unresolved in the sources reviewed.

#### University of Maine System, United States

**Last verified:** 2026-08-31<br>
**Status:** Active from July 1, 2026<br>
**Form:** Public university system-wide competitively procured license

**Adoption and scope.** Every matriculated student, faculty member, and staff member
across Maine's public universities is eligible for ChatGPT Edu under a two-year
agreement. Use is optional.

**Rationale.** The [system announcement](https://www.maine.edu/blog/2026/05/26/university-of-maine-system-to-launch-shared-ai-tool-to-accelerate-student-institutional-success/)
names equitable access, workforce preparation, teaching and research support,
organizational effectiveness, and taxpayer benefit.

**Cost and procurement.** The agreement costs $1.4 million over two years. The first
year is funded from unbudgeted investment income; the Board of Trustees will revisit
second-year funding during the FY2028 budget process. The
[competitive RFP](https://www.maine.edu/strategic-procurement/rfx/rfp-2026-065-enterprise-generative-ai-services/)
received four qualified responses. UMS says OpenAI outscored Google-based alternatives
on functionality, data protection, total cost, educational features, and fit with
existing infrastructure. Savings are expected from ending some individual licenses.

**Governance and pedagogy.** A system AI working group recommended shared access.
UMS plans free professional development for more than 5,000 faculty and staff and
training for students. Each university retains discretion over local use.

**Allowed use and data practices.** UMS says prompts and files are not used to train OpenAI models.
The public materials do not establish content retention, administrative access, or
approved data classifications. UMS procured the service under a system contract. No
public source reviewed establishes ZDR or ZOA.

**Open questions.** Watch for the second-year funding decision, any student fee,
activation and usage data, and publication of contract attachments or evaluations.

#### University of Michigan, United States

**Last verified:** 2026-08-31<br>
**Status:** Active<br>
**Form:** Institution-built, multi-model service

**Adoption and scope.** Michigan provides U-M GPT, the configurable U-M Maizey service,
and the U-M GPT Toolkit to faculty, staff, and students across Ann Arbor, Dearborn,
Flint, and Michigan Medicine. [U-M describes the suite](https://genai.umich.edu/) as a
custom institutional alternative built around equity, accessibility, and privacy.
Maizey lets educators and units create retrieval-backed agents using their own data;
the Toolkit exposes models and APIs for developers and researchers.

**Rationale and pedagogy.** Michigan built the suite after an advisory committee
identified privacy, accessibility, and affordability problems in public chatbots.
Maizey gives educators direct control over contextual data and behavior and integrates
with Canvas. U-M publishes service information, accessibility documentation, a privacy
notice, and system prompts.

**Cost.** U-M GPT is free to eligible users. Maizey is free through June 30, 2027;
faculty receive a $1,000 allocation per Canvas course per term after that free period.
Other Maizey projects and Toolkit use are metered. The
[public pricing page](https://its.umich.edu/computing/ai/pricing) publishes per-model
token rates and concrete prompt-cost examples. Total institutional development and
operating costs are not disclosed.

**Allowed use and data practices.** The services use institutional identity and are approved
for specified university data classifications. Earlier institutional documentation
described the services as suitable for moderate-sensitivity data, including FERPA data.
Current classifications and model-specific exceptions are recorded on the individual
service pages. Provider contracts, retention periods, and operator access vary across
the suite and are not consolidated in the sources reviewed. No public source reviewed
establishes ZDR or ZOA for the suite as a whole.

**Model development.** Michigan's
[AI Services FAQ](https://its.umich.edu/computing/ai/faq) states that the university
does not train U-M GPT models or share user-specific data to improve them. Maizey
indexes selected sources and supplies retrieved context to provider models. It is not
institutional model training under this document's definition.

**Open questions.** Total subsidy, staff effort, actual model/provider routing,
conversation retention, instructor access to student interactions, and outcome data
need a consolidated evidence pass.

#### Yale University, United States

**Last verified:** 2026-08-31<br>
**Status:** Active<br>
**Form:** Institution-built, multi-model platform

**Adoption and scope.** Yale's [Clarity platform](https://ai.yale.edu/yales-ai-tools-and-resources/clarity-platform)
provides faculty, staff, and students with institutional chat, custom agents, and API
access to models from OpenAI, Anthropic, Google, and others. The interface is built on
FoundationaLLM and runs on Yale-managed cloud infrastructure. General chat is
available without charge; custom agents and API keys require approval.

**Rationale.** Yale's 2024 AI task force called for secure, equitable access that
could adapt as models changed. The university committed
[more than $150 million over five years](https://provost.yale.edu/news/advancing-yales-leadership-artificial-intelligence-support-faculty-students-and-staff)
to AI-related compute, tools, faculty hiring, seed grants, and collaboration. That
figure is not the cost of Clarity alone.

**Cost.** The [Clarity API pricing page](https://ai.yale.edu/yales-ai-tools-and-resources/clarity-platform/api-pricing)
publishes model rates including a service fee; approved projects are billed monthly to
institutional accounts. The cost and subsidy for general chat are not disclosed.

**Governance.** Yale's [AI Review Framework](https://ai.yale.edu/ai-review-framework)
assigns different cases to an AI Steering Committee, AI Governance Committee, Data
Governance Executive Council, IRB, health-data bodies, and library and health-sciences
groups. The steering committee includes faculty alongside data, legal, privacy,
security, risk, and IT officers.

**Allowed use and data practices.** Yale says Clarity conversations are not used to train external
models and approves the platform for high-risk data with restrictions, including
special paths for protected health information. Exact provider-by-provider retention,
Yale administrator access, and routing rules require further documentation. No public
source reviewed establishes ZDR or ZOA for all Clarity routes.

**Open questions.** Clarity's software provenance, operating cost, retention design,
system-prompt visibility, and educational evaluation are not yet fully documented in
this record.

### Europe

#### Conference of Italian University Rectors (CRUI), Italy

**Last verified:** 2026-08-31<br>
**Status:** Active procurement framework<br>
**Form:** National higher-education consortium agreement

**Adoption and scope.** CRUI negotiated a shared agreement through which member
universities and research institutions can purchase ChatGPT Edu, OpenAI Enterprise API
services, and training and support. Each participating institution retains its own
workspace and enters through the common framework.

**Cost and procurement.** A [public university accession document](https://www.unifg.it/sites/default/files/2025-10/08-allegato-n-04-CA24set2025-contratto-chatGPTedu.pdf)
describes a 36-month negotiated contract, an aggregate minimum of 20,000 subscriptions,
annual volume adjustments, and institution-specific minimums that can fall to 50
licenses or 10% of faculty and staff. The full rate card is included in contract
attachments but needs structured extraction before normalized prices are reported.

**Rationale and governance.** The agreement centralizes negotiation, GDPR terms,
support, and volume discounts while leaving comparative technical and economic
assessment to each public institution. CRUI and Italy are also members of OpenAI's
[Education for Countries](https://openai.com/index/edu-for-countries/) cohort.

**Allowed use and data practices.** The accession document states GDPR compliance and exclusion of
institutional content from model training. Retention, administrator access, and API
endpoint exceptions need contract-level review. The terms were negotiated by CRUI
with OpenAI Ireland. The public material reviewed does not establish ZDR or ZOA.

**Open questions.** Which institutions have joined, how many seats have been ordered,
aggregate expenditure, and whether consortium governance includes faculty, students,
or unions remain to be established.

#### University of Kent, United Kingdom

**Last verified:** 2026-08-31<br>
**Status:** Active rollout<br>
**Form:** Institution-wide competitively procured single-vendor license

**Adoption and scope.** Kent began staff access to ChatGPT Edu in March 2026 and
student access in April. The service covers all current staff and students.

**Rationale and pedagogy.** Kent names equitable access, employability, accessibility,
teaching and research support, operational efficiency, and reduction of unmanaged
consumer use. Access follows completion of university-developed AI literacy training;
course-level assessment rules remain subject-specific.

**Cost and procurement.** The UK government's
[contract award notice](https://www.find-tender.service.gov.uk/Notice/012152-2026)
records a competitive flexible procedure with six final tenders. OpenAI UK received a
contract valued at GBP 3,257,010 excluding VAT for an estimated February 20, 2026 to
April 30, 2028 term, with three optional one-year extensions through April 2031.

**Governance.** Kent created an AI Competency Centre and student and staff ambassador
network. It publishes training and use guidance, but the membership and authority of
the procurement and continuing governance bodies are not yet recorded here.

**Allowed use and data practices.** Kent says content is not used for OpenAI training and that the
university controls workspace data. Its student guidance states that staff access may
occur under ordinary IT-use, legal, or safeguarding powers. This is not E2EE or zero
operator access. The service was competitively procured. The sources reviewed do not
state the retention period or establish ZDR.

**Open questions.** The contract's division among licenses, implementation, support,
and optional capacity is not yet known. Usage and educational outcomes have not been
published.

#### University of Oxford, United Kingdom

**Last verified:** 2026-08-31<br>
**Status:** Active from academic year 2025/26<br>
**Form:** Institution-wide single-vendor license after a pilot

**Adoption and scope.** Oxford became the first UK university to announce free
ChatGPT Edu access for all students and staff after a year-long pilot involving about
750 academics, researchers, postgraduate researchers, and professional staff. Oxford
also supports baseline Copilot Chat and Google Gemini and NotebookLM access.

**Rationale.** The [university announcement](https://www.ox.ac.uk/news/2025-09-19-oxford-becomes-first-uk-university-offer-chatgpt-edu-all-staff-and-students)
names existing unmanaged use, equitable access, research acceleration, personalized
learning, and operational efficiency.

**Cost and procurement.** Not publicly disclosed in the sources reviewed.

**Governance and pedagogy.** Oxford created a Digital Governance Unit and AI Governance
Group. A dedicated AI Competency Centre, staff and student ambassadors, expanded
training, and role-specific guidance accompany the rollout. Information security
training is mandatory for staff and includes AI use.

**Allowed use and data practices.** Oxford describes the environment as institutionally controlled
and says workspace data is not used to train OpenAI models. Retention, administrator
access, approved data classes, and contract terms are not publicly established here.
No public source reviewed establishes ZDR or ZOA.

**Open questions.** The pilot report, contract value and term, usage, instructor
control over default system instructions, and evaluation design are not yet in this
record.

### Asia

#### National University of Singapore, Singapore

**Last verified:** 2026-08-31<br>
**Status:** Active from August 31, 2026<br>
**Form:** Commercial campus-wide baseline plus institution-built tools

**Adoption and scope.** NUS provides baseline ChatGPT Edu access to all students,
faculty, and staff. Advanced capabilities are initially being piloted in selected
courses. The agreement complements NUS's in-house AI-Know platform, existing Copilot
access, seven developing educational tools, and the library's AI Sense Maker over more
than 150,000 digitized institutional materials.

**Rationale.** The [NUS announcement](https://news.nus.edu.sg/nus-powers-education-research-and-administration-to-new-heights-with-ai-through-a-strategic-collaboration-with-openai/)
names human capability, critical judgment, research, innovation, operational
efficiency, secure scaling, and workforce preparation. NUS publicly states that it
does not intend to rely on one provider.

**Cost and procurement.** The amount and procurement method are not disclosed.

**Governance and pedagogy.** Beginning in 2026/27, every first-year undergraduate must
complete `THE1008 Applied Generative AI: From Prompting to Evaluation`. AI competence
is intended to continue through common and disciplinary curricula. NUS teaching
centers support faculty, and instructors can adapt institution-provided course tools.

**Allowed use and data practices.** NUS says content in its ChatGPT Edu workspace is not used for
OpenAI model training. Retention, administrative access, data classification, and
processing region are not disclosed in the announcement. No public source reviewed
establishes ZDR or ZOA.

**Open questions.** The agreement's price, duration, model and credit limits,
governance membership, assessment rules, and outcome measures remain unknown.

#### Nagoya Institute of Technology, Japan

**Last verified:** 2026-08-31<br>
**Status:** Faculty/staff phase active; student expansion proposed<br>
**Form:** Staged single-vendor adoption

**Adoption and scope.** NITech introduced ChatGPT Edu for all full-time faculty and
staff in its first phase. It plans to consider access for master's students entering
in April 2027.

**Rationale and governance.** A presidential project team established in May 2025
reviewed educational, research, and administrative use and delivered a final report in
December. The [institutional announcement](https://www.nitech.ac.jp/eng/news/2026/13881.html)
describes a human-centered principle under which people retain final decision-making
and responsibility. Faculty and staff receive the system first so they can develop
practice and deliberate before student expansion.

**Cost and procurement.** Not publicly disclosed in the source reviewed.

**Allowed use and data practices.** ChatGPT Edu is presented as the common managed
environment, accompanied by faculty and staff development. Specific retention,
training-use terms, data classifications, and course-level controls are not reported.
No public source reviewed establishes ZDR or ZOA.

**Open questions.** Recheck the 2027 student decision, project-team report, contract,
privacy guidance, and participation data.

### Oceania

#### University of Sydney, Australia

**Last verified:** 2026-08-31<br>
**Status:** Active and expanding externally<br>
**Form:** Institution-built educator-authored agent platform

**Adoption and scope.** Cogniti lets educators build course-specific agents using
their own instructions and materials for feedback, simulation, tutoring, and guided
practice. Hundreds of Sydney educators use it. Sydney reports that the service is
being tested or used by about 100 educational institutions; Leiden University has
deployed it in four faculties for about 2,000 students.

**Rationale and pedagogy.** The
[university's account](https://www.sydney.edu.au/news-opinion/news/2026/06/15/ai-education-platform-cogniti-goes-global-on-microsoft-marketplace.html)
says each educator aligns an agent with their teaching method and course materials.
Published examples include Socratic tutoring, feedback, clinical role-play, language
practice, and agents explicitly instructed not to complete assignments.

**Cost and procurement.** Institutional development and operating costs are not
disclosed. Cogniti launched on Microsoft Marketplace in June 2026 as Sydney and
Microsoft pursued a commercially sustainable route for external adoption.

**Allowed use and data practices.** Cogniti runs on Microsoft Azure. Sydney says institutional
content remains under university control, is not used for commercial model training,
and can be analyzed through anonymized interaction patterns. Educators may inspect
conversation analytics to improve agents. The extent of educator access to individual
student conversations is not stated in the source reviewed. Retention and ZDR or ZOA
status are not disclosed.

**Evaluation.** Sydney publishes implementation cases and has integrated Cogniti into
its broader assessment-redesign work. The evidence currently includes reported cases
and small studies rather than institution-wide causal evaluation.

**Open questions.** Source code and license, model routing, retention, student consent,
educator access boundaries, Azure regions, costs, and governance of the commercialized
platform need further documentation.

### Africa

#### University of Cape Town, South Africa

**Last verified:** 2026-08-31<br>
**Status:** Governance framework active; selective tools and pilots<br>
**Form:** Governance-first adoption with bundled and LMS tools

**Adoption and scope.** UCT recommends Microsoft Copilot Chat, available to staff and
students through its existing Microsoft license, and is testing or using tools such as
D2L Lumi, NotebookLM, and targeted teaching pilots. It has not announced a universal
premium standalone-chatbot contract.

**Rationale and governance.** UCT's [AI in Education Framework](https://cilt.uct.ac.za/artificial-intelligence)
centers critical AI literacy, assessment integrity, and pedagogical innovation. It was
developed through the Online Education Subcommittee with faculty, support-unit, and
student consultation and endorsed by the Senate Teaching and Learning Committee in
June 2025. An institution-wide community of practice continues the work.

**Cost and procurement.** Copilot Chat is described as included at no additional cost
in UCT's Microsoft license. The underlying allocation within that broader contract and
costs of other tools and pilots are not disclosed.

**Allowed use and data practices.** UCT's [Copilot service page](https://icts.uct.ac.za/copilot-chat)
says prompts are covered by Microsoft's Enterprise Data Protection and not used for
model training when users authenticate with university accounts. UCT continues to
warn against entering sensitive information and is separately evaluating paid
Microsoft 365 Copilot. The service is available under UCT's Microsoft license. The
retention period, operator access, ZDR status, and ZOA status are not disclosed.

**Pedagogy and evaluation.** UCT rejects AI-detection scores as sufficiently reliable
for high-stakes decisions and disabled Turnitin's AI score in October 2025. Its
framework assigns responsibility for assessment redesign and acknowledges the labor
that redesign requires.

**Open questions.** Track any premium procurement, implementation of the framework,
multilingual evaluation, labor allocation, and results from teaching grants and pilots.

#### University of Johannesburg, South Africa

**Last verified:** 2026-08-31<br>
**Status:** Active targeted service<br>
**Form:** Institution-built student-services assistant

**Adoption and scope.** UJ's MoUJi assistant began as a conventional chatbot in 2019
and was expanded with LLM capabilities in 2026. It serves prospective and current
students in English, Afrikaans, isiZulu, and Sesotho for admissions, registration,
financial aid, and related support.

**Rationale.** The [university announcement](https://news.uj.ac.za/news/uj-enhances-mouji-chatbot-with-multilingual-ai-to-transform-student-support/)
emphasizes multilingual access, immediate responses, and shifting staff effort from
routine questions to complex cases. UJ reports reduced reliance on temporary call
center staff during peak registration, but does not publish quantities or labor effects.

**Cost and procurement.** Not publicly disclosed in the source reviewed.

**Allowed use and data practices.** Personal student information is protected through one-time
password verification, and answers involving institutional data are drawn from
authoritative university systems. Model provider, retention, human access, escalation,
and evaluation procedures are not disclosed. ZDR and ZOA status are unknown.

**Open questions.** Vendor stack, language-quality evaluation, accessibility, error
and appeal handling, cost, and effects on call-center employment are not disclosed.

### Latin America

#### Universidad del Valle de Guatemala, Guatemala

**Last verified:** 2026-08-31<br>
**Status:** Institution-wide rollout scheduled for 2026<br>
**Form:** Commercial campus-wide tools following a pilot

**Adoption and scope.** UVG announced unlimited ChatGPT Edu and Canva for Campus for
students, faculty, researchers, and staff beginning in 2026, following a 2025 pilot and
progressive faculty expansion.

**Rationale.** The [university announcement](https://noticias.uvg.edu.gt/uvg-chatgpt-edu-canva-campus-2026/)
names equitable access, digital competence, critical thinking, creativity, teaching,
research, and administrative work.

**Cost and procurement.** Not publicly disclosed in the source reviewed.

**Governance and pedagogy.** UVG established six work groups covering student
experience, employee experience, teaching integration, academic experience, research,
and ethics and governance. Faculty development and ongoing technical and pedagogical
support accompany the rollout.

**Allowed use and data practices.** The announcement describes a secure institutional integration
but does not state retention, training use, administrator access, data classes, or
processing region. The contractual basis and ZDR or ZOA status are not disclosed.

**Open questions.** Confirm launch status, contract terms, privacy documentation,
governance membership, course-level control, and evaluation plans.

## Broader ecosystem

This section tracks components used in institutional services. Product claims are
attributed to their publishers unless independent evidence is cited.

### Provider data practices

#### OpenAI business and education services

**Last verified:** 2026-08-31

The [OpenAI Services Agreement](https://openai.com/policies/services-agreement/)
permits OpenAI to use customer content to provide the service, comply with law,
enforce its policies, and prevent abuse. It prohibits using customer content to
develop or improve services unless the customer explicitly agrees. After termination,
OpenAI states that it deletes customer content within 30 days unless law requires
retention or the customer agreed otherwise. It may retain or disclose content it
classifies as abusive when legally required or reasonably necessary to protect the
service or a third party.

An order form and service-specific terms can modify the general agreement. For each
institution, track the executed order form, retention setting, abuse-monitoring terms,
feedback controls, administrator access, and any permission for product development,
evaluation, or research. A public statement that content is not used for training does
not resolve those other uses.

#### Google Workspace with Gemini

**Last verified:** 2026-08-31

Google's [Workspace Privacy Hub](https://support.google.com/a/answer/15706919) says
Gemini uses prompts and authorized Workspace content to produce responses. Google does
not use customer content for human review or model training outside the customer's
domain without permission.

Retention differs by product and administrator setting. Gemini in Workspace retains
prompts and responses from 90 days to indefinitely. The Gemini app retains them for up
to 36 months, with an 18-month default; history-off chats can remain for up to 72
hours. Gemini Notebook does not retain prompts and responses after the session, but
uploaded sources and notebooks follow the Workspace data-processing agreement.

Users may voluntarily submit feedback containing ratings, written comments, prompts,
contextual sources, and responses. Google says it retains feedback for up to 18 months
and may use it for aggregate analysis, bug fixes, and policy-enforcement improvements,
but not for training the generative models that support Workspace. Administrators can
control access, history, Workspace integrations, and some feedback settings.

#### Anthropic commercial services

**Last verified:** 2026-08-31

Anthropic's [commercial-product policy](https://privacy.anthropic.com/en/articles/7996868-is-my-data-used-for-model-training)
says it does not use inputs or outputs from Claude for Work or the Anthropic API for
model training by default. If a user submits feedback or otherwise permits use,
Anthropic may use chats and coding sessions for service analysis, research, study of
user behavior, and model training. Feedback can include the full related conversation
and may be retained for up to five years. Organization owners can disable chat-rating
feedback.

Anthropic describes the customer as controller and Anthropic as processor for
commercial accounts. Organization owners may export user conversations, files, and
usage patterns. Anthropic offers ZDR agreements for specified API products; a general
commercial or education agreement is not evidence that ZDR applies.

### Institutional model adaptation

This section uses **model training** only for an optimization process that changes
model weights or trains an adapter: pretraining, continued pretraining, supervised
fine-tuning, preference tuning such as DPO or RLHF, distillation, and LoRA or QLoRA.
Uploading documents, constructing an index, retrieving context at request time,
editing a system prompt, collecting feedback, routing among models, or serving an
existing checkpoint does not meet that definition. A training claim is strongest when
the source identifies the base model, method, data, compute, resulting checkpoint or
adapter, and evaluation. Institutional publicity using "trained" without those facts is
recorded as an unresolved or non-technical claim.

#### Purdue University PeteChat

**Last verified:** 2026-08-31<br>
**Classification:** Weight-changing supervised and preference tuning; deployed course
tutor<br>
**Evidence strength:** High, based on a project-team preprint

Purdue-affiliated authors report that
[PeteChat](https://arxiv.org/html/2606.09845) began with Llama 3 models fine-tuned on
Purdue's Gilbreth cluster and was deployed to students in ECE 20875. The reported
training used about 1,000 instruction-response examples derived from course materials,
LoRA or QLoRA parameter-efficient fine-tuning, and later Direct Preference Optimization
using student preference data. The system also uses RAG for changing course information.
It therefore combines weight-changing training with request-time retrieval rather than
using those terms interchangeably.

The paper is an author account rather than an independent audit, and no released
checkpoint is cited. The documented deployment began at course scale and expanded to
other large Python courses; it is not described as a general campus assistant.

#### Texas A&M University-San Antonio TAMUSA-Chat

**Last verified:** 2026-08-31<br>
**Classification:** Weight-changing supervised fine-tuning; research framework<br>
**Evidence strength:** Moderate, based on a project-team preprint and public code

The [TAMUSA-Chat paper](https://arxiv.org/abs/2603.09992) describes supervised
fine-tuning of open models on instruction-response data derived from university
websites, policies, programs, and support services. It presents the system as a
research-oriented, reproducible framework and testbed, not an established production
campus service. Its architecture also includes RAG.

#### Kaimosi Friends University KAFU AI Assistant

**Last verified:** 2026-08-31<br>
**Classification:** Claimed fine-tuning; live institutional assistant<br>
**Evidence strength:** Provisional

KAFU's Innovation and Incubation Hub labels its
[AI assistant](https://kafu-iihub.com/our-impact/projects/kafu-ai-assistant) live and
states that it uses a language model fine-tuned on university program, fee, admission,
contact, event, and procedure data. The page does not identify the base model, training
method, dataset, run, checkpoint, or evaluation. Its stack includes Qdrant, indicating
that retrieval is also involved. The public claim is retained but does not independently
establish that weights changed.

#### UC San Diego TritonGPT terminology case

**Last verified:** 2026-08-31<br>
**Classification:** Retrieval, prompting, tools, model routing, and hosting; no verified
institutional weight training<br>
**Evidence strength:** High for the classification; an absolute historical negative is
not established

UC San Diego publications use training language broadly. A 2024
[campus story](https://today.ucsd.edu/story/say-hello-to-tritongpt) called TritonGPT
"uniquely trained," described feedback-driven revision as "reinforced learning with
human feedback," and called assistants "trained on targeted datasets." A 2025
[story](https://today.ucsd.edu/story/tritongpt-is-here-and-ready-to-help) similarly says
that adding course files "automatically trains" instructional assistants and that their
Socratic behavior is trained.

Current technical documentation describes different mechanisms. The
[trust architecture](https://tritonai.ucsd.edu/about/trust-architecture.html) says that
assistants look up approved sources at request time and that the model itself was not
trained on private campus content. The
[instructional service](https://tritonai.ucsd.edu/tritongpt/instruction.html) lets
instructors select retrievable documents and choose Socratic or directive behavior.
The [release history](https://tritonai.ucsd.edu/tritongpt/release-notes/index.html)
records changes to indexed sources, embeddings, system prompts, Onyx, LiteLLM routing,
and interchangeable Llama, GPT, Gemini, and Claude models. These are evidence of RAG,
prompt configuration, tools, routing, and model serving, not a UC San Diego-trained
checkpoint.

No reviewed UC San Diego source identifies a training dataset, optimization method,
training run, adapter, or checkpoint for TritonGPT. The record therefore does not count
TritonGPT as institution-performed model training. The narrower official statement that
the model was not trained on private campus content does not prove that no experimental
weight update has ever occurred.

#### Other explicit non-examples

The University of Michigan states in its
[AI Services FAQ](https://its.umich.edu/computing/ai/faq) that it does not train the
models in U-M GPT; Maizey uses indexing, retrieval, and system prompts. The University
of Texas at Austin says faculty
["train" UT Sage tutors](https://provost.utexas.edu/the-office/academic-affairs/office-of-academic-technology/ut-sage/)
by answering configuration questions and uploading resources. Its project team's
[technical account](https://www.frontiersin.org/journals/education/articles/10.3389/feduc.2025.1604934/full)
instead identifies Anthropic models, a RAG pipeline, and project-developed prompts.
Neither service is classified as institution-trained under the weight-change rule.

### Commodity inference and routing

#### OpenRouter

**Last verified:** 2026-08-31<br>
**Role:** Hosted multi-provider gateway and marketplace

OpenRouter exposes many proprietary and open-weight models through one API and routes
requests among underlying inference operators. Its
[provider registry](https://openrouter.ai/providers) records provider-level training
and retention claims, while its [ZDR documentation](https://openrouter.ai/docs/guides/features/zdr)
supports policy enforcement by model group and request. OpenRouter says its own prompt
logging is opt-in, stores request metadata, and can route only to endpoints classified
as zero retention. ZDR applies to inference, not optional web-search or other tools.
Its [data-collection documentation](https://openrouter.ai/docs/guides/privacy/data-collection)
also describes optional private prompt logging, an optional one-percent discount for
allowing OpenRouter to use prompts and completions, and anonymous prompt categorization
performed by a ZDR model when content-use permission is off.

OpenRouter's [Models API](https://openrouter.ai/docs/guides/overview/models) supplies
metadata used by downstream catalogs. One downstream policy is to list only models
with a valid Hugging Face reference as a proxy for published weights. That filter does
not prevent direct requests for other model slugs unless the router applies a separate
allowlist. A Hugging Face reference also does not establish an open-source license for
the weights, training data, or model code.

Track the platform fee, provider ownership, endpoint-level ZDR status, model and price
changes, routing controls, enterprise identity, audit behavior, and changes to the
definition of retention. Policies can differ by endpoint and contract.

#### Direct commodity inference providers

**Last verified:** 2026-08-31<br>
**Role:** Hosted inference for open-weight and selected proprietary models

Tracked providers are DeepInfra, Together AI, Fireworks AI, Groq, Cerebras, Baseten,
Nebius Token Factory, and Cloudflare Workers AI. Relevant primary surfaces are each
provider's pricing, model catalog, data-processing terms, trust center, and status
page. OpenRouter's provider registry is a useful discovery and change-detection source,
but it is not a substitute for the provider contract.

For each endpoint, track input, cached-input, and output price; context and output
limits; quantization; region; uptime commitments; training use; retention; abuse
monitoring; batch and cache behavior; dedicated deployment; and certifications.
"Does not train" and "zero retention" are separate fields.

#### Institutional and public inference

**Last verified:** 2026-08-31<br>
**Role:** Publicly funded or university-operated model serving

Tracked services include the US National Research Platform/SDSC service,
university research-computing centers, national supercomputing programs, and consortial
cloud frameworks such as GÉANT OCRE. NRP serves open-weight models through Envoy AI
Gateway and vLLM with CILogon authentication. Its documentation states that prompts
are logged. The record therefore classifies the service as non-ZDR. NRP's managed LLM
service specifically offers open-weight models.

Track eligibility, funding, queue and quota models, supported weights, service levels,
retention, operator access, identity federation, governance, and whether teaching and
administrative use is allowed alongside research.

### Confidential and end-to-end encrypted inference

The [Confidential Inference Directory](https://confidentialinference.net/) tracks
TEE-based providers, models, prices, API features, attestation methods, and the public
evidence required for comparison. Provider records below use direct provider sources;
the directory supplies a broader index and independently refreshed catalog.

#### Tinfoil

**Last verified:** 2026-08-31<br>
**Role:** Client-verifiable confidential inference and confidential containers

Tinfoil's [verification design](https://docs.tinfoil.sh/verification/verification-in-tinfoil)
uses client-side attestation checks, enclave-bound keys, open inference code, and
measurements published through Sigstore. The client refuses to transmit content when
the running measurement does not match the expected build. Tinfoil's
[security and privacy FAQ](https://tinfoil.sh/security-and-privacy-faq) says interaction
content never leaves the enclave, while billing metadata and network metadata remain
visible. Tinfoil uses token counts, model name, and timestamps for billing and
operations. It says prompts, completions, files, embeddings, tool calls, and error
traces containing content are not retained outside the enclave.

Track supported models, price, hardware and firmware roots of trust, measurement
policy, reproducible or independently built artifacts, SDK enforcement, REST downgrade
paths, metadata, egress, vulnerabilities, incident history, and external audits.

#### NEAR AI Cloud

**Last verified:** 2026-08-31<br>
**Role:** Attested open-weight inference

[NEAR AI Cloud](https://cloud.near.ai/) runs models using Intel TDX and NVIDIA
confidential computing. Its direct-completions path terminates TLS inside the model
enclave; its gateway path adds a separately attested routing enclave. It publishes
verification tooling and describes signed requests and responses.

Track which models use confidential endpoints rather than conventional third parties,
client enforcement, accepted measurements, price, data terms, egress, independent
review, and differences between direct and gateway trust chains.

#### Phala/dstack and Venice

**Last verified:** 2026-08-31<br>
**Role:** Confidential-computing substrate and consumer-facing private chat

Venice exposes TEE and E2EE modes backed by NEAR AI Cloud and Phala/dstack. Its
[E2EE announcement](https://venice.ai/blog/venice-launches-end-to-end-encrypted-ai)
states that E2EE mode encrypts on the client and decrypts only in an attested enclave.
Web search, memory, and other features are disabled in that mode because they require
plaintext outside the enclave. Its "anonymous," "private," TEE, and E2EE modes have
different data paths and trust models.

Track modes separately, including model availability, feature loss, whether clients
verify before transmission, relay metadata, attestation evidence, persistence, and
downgrade behavior. E2EE applies only to the models and modes identified by Venice.

### Gateways and control planes

#### LiteLLM

**Last verified:** 2026-08-31<br>
**Role:** Self-hosted multi-provider gateway and SDK

[LiteLLM](https://github.com/BerriAI/litellm) normalizes more than 100 providers behind
OpenAI-compatible and provider-native APIs. Its gateway supports virtual keys, budgets,
spend tracking, routing, guardrails, MCP, and A2A. Core code is MIT-licensed; some
identity, audit, and governance features are commercial. Track release and security
history, license boundaries, provider coverage, policy enforcement, secret handling,
logs, identity, cost accounting, MCP permissions, and operational complexity.

#### Envoy AI Gateway

**Last verified:** 2026-08-31<br>
**Role:** Open infrastructure-level AI gateway

[Envoy AI Gateway](https://aigateway.envoyproxy.io/) extends Envoy and Kubernetes
Gateway API patterns to model routing, authentication, token-aware limits, and cost
controls. It is used by NRP and is structurally different from a hosted marketplace:
the deploying institution controls the gateway, while downstream providers still
determine inference privacy. Track CNCF governance, releases, provider adapters,
identity, budget enforcement, observability, MCP support, and institutional adopters.

#### Other gateways

**Last verified:** 2026-08-31

Portkey, Kong AI Gateway, Cloudflare AI Gateway, Helicone, Bifrost, and emerging MCP or
A2A gateways belong in this section. Track ownership and acquisitions, open-core
boundaries, deployment location, prompt logging defaults, budgets, identity, audit,
provider-policy enforcement, tool-level authorization, and fail-closed behavior.

### Chat interfaces

#### Open WebUI

**Last verified:** 2026-08-31<br>
**Role:** Self-hosted multi-user chat and tool platform

[Open WebUI](https://github.com/open-webui/open-webui) provides chat, model routing,
knowledge bases, tools, MCP integration, groups, and role-based controls. It stores
conversation history unless an operator configures otherwise.

The current [Open WebUI License](https://github.com/open-webui/open-webui/blob/main/LICENSE)
is not standard BSD or OSI-approved. It preserves BSD-like clauses but restricts
altering or removing Open WebUI branding for deployments exceeding 50 natural-person
end users in any rolling 30-day period unless the operator has written permission or
an enterprise license. Contributions are also subject to a contributor license
agreement.

Track license changes, ownership and governance, authentication, role and group
semantics, audit defaults, conversation and file retention, administrator access,
plugin execution, MCP authorization, accessibility, export, and migration paths.

#### LibreChat

**Last verified:** 2026-08-31<br>
**Role:** MIT-licensed self-hosted multi-provider chat and agent platform

[LibreChat](https://github.com/danny-avila/LibreChat) supports direct commercial and
OpenAI-compatible providers, multi-user authentication, agents, MCP, code execution,
web search, files, and conversation export. Its code is MIT-licensed. Deployments may
include MongoDB, search, RAG, Redis, and code-execution services.

Track project ownership and governance, license, SAML/OIDC/LDAP behavior, role and
group controls, per-user tool credentials, audit, retention, accessibility, deployment
complexity, and the trust boundaries introduced by optional services.

#### Other chat interfaces

**Last verified:** 2026-08-31

LobeChat, AnythingLLM, NextChat, and institution-specific systems remain in scope.
Tracked fields include license, ownership, storage, identity, access control, model
portability, prompt authorship, tools, accessibility, and export. Hosted and
self-hosted editions are separate data arrangements.

### Institutional Agent Skills

The [Agent Skills specification](https://agentskills.io/home) defines a skill as a
folder containing a required `SKILL.md` with discovery metadata and instructions, plus
optional scripts, references, and assets. Compatible agents first inspect names and
descriptions, load full instructions when a skill matches a task, and then read or run
supporting resources as needed. This record excludes generic AI-skills education,
custom chatbots, prompt libraries, MCP servers without `SKILL.md` packages, and
university-affiliated personal projects unless their status is stated explicitly.

Track institutional owner and maintainer, official versus community status, license,
version, source provenance, review and security boundaries, evaluation evidence,
dependencies, expiration dates, installation scope, agent compatibility, update path,
and whether the skill can read files, execute code, use credentials, or change external
systems. Repository ownership establishes custody, not university-wide endorsement.

#### UC San Diego TritonAI Skills Library

**Last verified:** 2026-08-31<br>
**Status:** Active, centrally published library<br>
**Scope:** Nine public, TritonAI-maintained skills<br>
**License:** MIT

The [TritonAI Skills Library](https://tritonai.ucsd.edu/skills/index.html) publishes
skills for code-review closeout, service feedback, harness inspection, accessibility,
campus CMS publishing, UC data classification, the UCSD web design system, and agent
memory. The catalog is generated from a public
[UCSD repository](https://github.com/UCSD/UCSD-Skills-Library) and identifies the
source commit used for each refresh.

The repository separates `tritonai/` skills maintained by approved team members from
reviewed `community/` contributions. It documents `SKILL.md` authoring, installation,
pull-request checks, named community maintainers, and a public/private boundary that
excludes credentials, restricted procedures, real institutional data, and unconfirmed
production actions. The catalog tells users to inspect instructions and supporting
files before installation.

#### UC Davis AI Skills Registry

**Last verified:** 2026-08-31<br>
**Status:** Active repository in the university GitHub organization<br>
**Scope:** General software-engineering and UC Davis project skills<br>
**License:** MIT

The [UC Davis AI Skills Registry](https://github.com/ucdavis/ai-skills-registry)
provides a registry and CLI for discovering, pinning, and installing skills into Claude
Code, Cursor, Visual Studio Code/Copilot, and Antigravity. The current catalog includes
testing, security, code review, accessibility, data-science, documentation,
infrastructure, and UC Davis project workflows.

Its [contribution guide](https://github.com/ucdavis/ai-skills-registry/blob/main/CONTRIBUTING.md)
requires `SKILL.md` frontmatter following the Agent Skills standard, a manifest entry,
semantic versioning, tests, a changelog entry, and pull-request review. Placement in
UC Davis's organization establishes institutional custody; no separate source reviewed
establishes the registry as a campus-wide standard or policy.

#### Harvard Law School Library Innovation Lab

**Last verified:** 2026-08-31<br>
**Status:** Active lab collection; most skills marked preview<br>
**Scope:** Legal education and reusable publishing infrastructure<br>
**License:** Not yet specified for the collection

The Library Innovation Lab's
[Legal Ed Agent Skills Hub](https://lil.law.harvard.edu/lawskills-hub/) publishes
standard-format skills for instructors, students, self-represented litigants,
continuing legal education, and skill authors. The collection distinguishes official
and preview skills and supplies `.skill` packages, inventories, and compatibility
layers for clients that do not load skills directly.

Its [contribution guide](https://github.com/harvard-lil/lawskills-hub/blob/main/CONTRIBUTING.md)
specifies persona constraints, progressive disclosure, rubrics, test scenarios,
skilled-versus-null comparisons, stored evaluation traces, and pull-request review.
The lab separately publishes an early
[Skills Hub](https://github.com/harvard-lil/skills-hub) builder and evaluation harness
for other collections. This is an official Harvard Law lab project, not a
university-wide Harvard standard. The collection repository currently lists its license
as undetermined.

#### Duke University

**Last verified:** 2026-08-31<br>
**Status:** Active unit-level guidance, collection, and research-computing example

Duke OIT's public
[Agent Skills lesson](https://analytics-accelerator.colab.duke.edu/session-2-reusable-skills/agent-skills.html)
distinguishes prompts, project instructions, and reusable skills; links a Duke skills
collection; gives installation and creation instructions; and recommends before-and-after
evaluation. Duke Research Computing publishes an installable
[equation-of-state analysis skill](https://oit-rc.pages.oit.duke.edu/rcsupportdocs/examples/Performing-Equation-of-State-Analysis-using-Agentic-AI-Skills/)
with a `SKILL.md` workflow and Python fitting script. These are official unit-level
resources, not a documented university-wide registry or policy.

#### Other institutional activity

Northwestern's 2026
[Agentic Investigation Challenge](https://www.gain-agent-challenge.northwestern.edu/details/)
requires participants to package reproducible investigative workflows as
specification-valid Agent Skills, submit auditable interaction traces, and use an
open-source license. It promises a public catalog for qualifying submissions; no
Northwestern-published catalog was located by the verification date.

MIT CSAIL's Kellis Lab distributes service-specific `SKILL.md` packages through the
[Mantis CLI](https://mantis.csail.mit.edu/docs/mantis-cli/) for seven agent clients.
George Washington University's OSPO publishes
[governance guidance](https://ospo.gwu.edu/skills-are-infrastructure-and-new-open-source-artifact-class)
that treats skills as open-source artifacts requiring provenance, licensing, versions,
maintainers, review cadence, security review, and evaluation. These are respectively a
lab integration and institutional guidance, not campus-wide skill registries.

No mature inter-university registry or adopted university-wide Agent Skills governance
standard was located. Searches are likely to undercount private repositories and
self-hosted GitLab instances. `SKILL.md` also does not by itself establish conformance:
some packages are client-specific or predate the open specification.

### Agent frameworks, harnesses, interfaces, and execution

The records in this section distinguish four functions:

- An **agent framework** implements the model and tool loop used to build agents.
- A **harness** gives an agent instructions, tools, permissions, context management,
  and a working environment.
- An **interface** lets a person start, supervise, and review agent work.
- An **execution service** isolates or hosts code and processes invoked by an agent.

A product may perform more than one function. Each record states its role and
dependencies.

#### Lathe

**Last verified:** 2026-08-31<br>
**Role:** Open WebUI tool package and model-neutral agent harness<br>
**License:** MIT

[Lathe](https://github.com/rndmcnlly/lathe) is a single-file Open WebUI tool package.
It gives a tool-calling model access to shell commands, file operations, search,
persistent Python, delegated subagents, service previews, onboarding instructions,
handoffs, and sandbox deletion. It does not modify the model or its system prompt.

Lathe creates or resumes one Daytona sandbox for each Open WebUI user. Deployment
labels separate sandboxes belonging to different Open WebUI instances. The
[`destroy`](https://github.com/rndmcnlly/lathe#tools-reference) operation requires an
Open WebUI confirmation. User-supplied environment variables are available to shell
commands and therefore to the model.

Lathe depends on
[`pydantic-ai-slim`](https://github.com/rndmcnlly/lathe/blob/main/pyproject.toml) for
agent and tool execution, including delegated subagents. It uses Daytona's persistent
Python interpreter for its `interpret` tool. It does not use Pydantic Monty.

Track releases, Open WebUI compatibility, Pydantic AI compatibility, Daytona API
changes, per-user isolation, credential exposure, sandbox persistence and deletion,
tool permissions, delegated-agent limits, and test coverage.

#### Pydantic AI

**Last verified:** 2026-08-31<br>
**Role:** Python agent framework and optional harness library<br>
**License:** MIT

[Pydantic AI](https://github.com/pydantic/pydantic-ai) provides a typed agent loop,
validated tool arguments and outputs, dependency injection, model adapters, MCP,
durable execution integrations, and OpenTelemetry instrumentation. Its separate
[Pydantic AI Harness](https://github.com/pydantic/pydantic-ai-harness) adds file,
shell, repository, planning, subagent, memory, and context-management capabilities.

Lathe imports the smaller `pydantic-ai-slim` package and supplies its own tools and
Daytona execution environment. It does not embed Pydantic AI Harness.

Track release compatibility, model adapters, tool approval, durable execution,
instrumentation defaults, Pydantic AI Harness licensing and packaging, MCP and ACP
support, and code-execution integrations.

#### Pydantic Monty

**Last verified:** 2026-08-31<br>
**Role:** Restricted Python interpreter for model-generated code<br>
**License:** MIT<br>
**Status:** Experimental

[Monty](https://github.com/pydantic/monty) is a Python interpreter written in Rust.
It implements a subset of Python without CPython or third-party Python packages.
Filesystem, environment, and network access are unavailable unless the host supplies
them as explicit functions or mounts. The runtime supports memory, stack, allocation,
and execution-time limits. Python and JavaScript bindings run sessions in worker
subprocesses for crash isolation; the WebAssembly build runs in-process.

Monty powers
[Code Mode in Pydantic AI](https://pydantic.dev/docs/ai/harness/code-mode/), where a
model writes Python that calls approved tools. Monty restricts the language and exposes
selected host functions. A remote sandbox such as Daytona provides an operating
system, package installation, processes, and network controls. Lathe does not use
Monty.

Track the supported Python subset, host-function boundary, resource-limit behavior,
worker isolation, security reports, stable API status, language bindings, and Pydantic
AI integration.

#### Daytona

**Last verified:** 2026-08-31<br>
**Role:** Remote code-execution and sandbox service<br>
**Use in Lathe:** Per-user execution environment

[Daytona sandboxes](https://www.daytona.io/docs/en/sandboxes/) provide programmable
Linux containers, Linux and Windows virtual machines, and GPU environments. The API
covers lifecycle management, files, processes, code execution, git, language servers,
terminals, previews, snapshots, volumes, and network controls. Sandboxes can be
persistent or deleted automatically.

Lathe calls Daytona's control-plane and toolbox APIs. A user's shell, files, Python
session, background processes, and delegated agents operate in that user's sandbox.
Daytona is Lathe's execution boundary. Open WebUI runs the primary model and tool
loop; Lathe supplies the tools and Pydantic AI-backed delegation.

The [public Daytona repository](https://github.com/daytonaio/daytona) states that it
stopped receiving updates in June 2026 and that core development moved to a private
codebase. The published repository remains available at its prior license and without
support or warranty.

Track pricing, regions, container and VM isolation, persistence, recovery, network
policy, secret handling, audit logs, data retention, security incidents, API changes,
service availability, and the effects of private development on inspectability.

#### OpenCode

**Last verified:** 2026-08-31<br>
**Role:** Model-neutral coding-agent harness<br>
**License:** MIT

[OpenCode](https://github.com/anomalyco/opencode) provides terminal and desktop clients,
a server and SDK, file and shell tools, configurable agents, subagents, permissions,
LSP integration, MCP, and access to multiple model providers. Its built-in `build`
agent can modify a project; its `plan` agent denies edits by default and requests
permission for shell use.

OpenChamber uses the OpenCode SDK and server APIs. OpenChamber's desktop release
bundles a matching OpenCode CLI; its web and VS Code versions use an installed
OpenCode CLI.

Track ownership, license, provider and authentication support, tool permissions,
telemetry, local and remote execution, sandboxing, session storage, server API changes,
plugin compatibility, and security advisories.

#### OpenChamber

**Last verified:** 2026-08-31<br>
**Role:** Graphical and remote supervision interface for OpenCode<br>
**License:** MIT

[OpenChamber](https://github.com/openchamber/openchamber) provides desktop, browser,
PWA, VS Code, iOS, Android, CLI, and server interfaces for OpenCode sessions. It adds
session status, approvals, schedules, goal-driven continuation, parallel runs,
worktrees, diff review, browser preview, GitHub workflows, SSH, and remote access. It
is independent of the OpenCode project.

The desktop package bundles OpenCode. Other clients connect to an OpenChamber server
and an installed OpenCode runtime. Its Private Relay documentation describes
end-to-end encrypted remote connections; direct, LAN/VPN, tunnel, and SSH access are
also available.

Track OpenCode version compatibility, license, authentication, remote exposure,
relay design, local data storage, session synchronization, notification services,
desktop privilege boundaries, mobile review and approval, and update signing.

#### T3 Code

**Last verified:** 2026-08-31<br>
**Role:** Multi-harness supervision interface<br>
**License:** MIT

[T3 Code](https://github.com/pingdotgg/t3code) controls agent processes installed and
authenticated on the user's machine. Its current built-in providers are Claude Code,
Codex, Cursor, Grok Build, and OpenCode. It provides web, Electron desktop, iOS, and
Android clients backed by a local Node.js server.

The server owns agent sessions, workspaces, version-control operations, terminals, and
filesystem access. Provider drivers translate each agent's native protocol into T3
Code's event and permission model. The Cursor driver uses ACP; the other built-in
drivers use provider-specific interfaces.

Track supported CLIs, provider-driver maintenance, ACP coverage, authentication,
permission translation, local storage, remote access, relay design, telemetry,
desktop signing, and whether provider-specific controls remain available through the
common interface.

#### Paseo

**Last verified:** 2026-08-31<br>
**Role:** Multi-harness supervision and orchestration interface<br>
**License:** Apache-2.0

[Paseo](https://github.com/getpaseo/paseo) runs a local daemon that starts and manages
installed coding-agent processes. Desktop, web, mobile, and CLI clients connect to the
daemon. Paseo supports parallel sessions, worktrees, schedules, voice input, a
TypeScript SDK, and agent-to-agent delegation.

Paseo has direct adapters for Claude Code, Codex, OpenCode, Pi, and OMP. Its
[provider documentation](https://github.com/getpaseo/paseo/blob/main/public-docs/providers.md)
also describes a generic ACP adapter and a catalog for agents including Cursor,
Gemini, GitHub Copilot, Hermes, Kimi, Qwen Code, Cline, and Goose. The installed agent
retains its own credentials, configuration, skills, and MCP servers.

Paseo states that it has no telemetry, tracking, or required account. Remote device
pairing can use an optional end-to-end encrypted relay; direct TCP and VPN connections
are also supported. Track provider and ACP compatibility, credential handling,
permission translation, session persistence, local storage, relay verification,
mobile approvals, plugin authority, and release signing.

#### Other open and model-neutral harnesses

**Last verified:** 2026-08-31

The additional set is [Goose](https://github.com/block/goose),
[Aider](https://github.com/Aider-AI/aider), [Cline](https://github.com/cline/cline),
and [OpenHands](https://github.com/All-Hands-AI/OpenHands). These projects differ in
action scope, approvals, sandboxing, telemetry, memory, interfaces, and organizational
controls. The Linux Foundation's Agentic AI Foundation governs Goose.

#### Anthropic Claude Code and Claude Cowork

**Last verified:** 2026-08-31<br>
**Role:** Vendor-operated coding and general-work agent products

[Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) reads and edits
repositories, runs commands, uses MCP servers, and supports subagents, skills, hooks,
CI, scheduled work, and local or cloud sessions. Anthropic provides terminal, IDE,
desktop, web, and mobile access. The product uses Claude models; terminal and IDE
deployments can route through supported third-party hosting such as Amazon Bedrock or
Google Vertex AI.

[Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-cowork)
applies related agent capabilities to documents, files, connected applications,
browsing, and scheduled knowledge work. Anthropic documents separate local and cloud
execution modes and publishes a
[Cowork architecture overview](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview).

Track the products separately. Relevant fields include source availability, model and
subscription coupling, local and cloud execution, filesystem scope, sandboxing,
connectors, MCP, approval policy, scheduling, enterprise administration, audit and
Compliance API coverage, retention, and regional processing.

#### OpenAI Codex and ChatGPT Work

**Last verified:** 2026-08-31<br>
**Role:** Vendor-operated coding and general-work agent products

[Codex](https://github.com/openai/codex) has an open-source command-line client and
agent runtime, IDE integration, a desktop interface, and cloud execution. The
[Codex app](https://openai.com/index/introducing-the-codex-app/) supports multiple
concurrent agents, worktrees, skills, automations, browser previews, and configurable
sandbox and approval policies. Local clients support ChatGPT or API-key authentication;
Codex cloud requires ChatGPT authentication.

[ChatGPT Work](https://openai.com/index/chatgpt-for-your-most-ambitious-work/) applies
Codex-derived agent capabilities to files, documents, connected applications, web
browsing, computer use, and scheduled tasks. It is the closest OpenAI product match to
Claude Cowork in the sources reviewed. The earlier standalone Operator product was
integrated into [ChatGPT agent](https://openai.com/index/introducing-chatgpt-agent/) in
2025.

Track Codex and ChatGPT Work separately. Relevant fields include open and closed
components, model and subscription coupling, local and cloud execution, sandboxing,
computer use, connectors and plugins, approval policy, audit, retention, regional
availability, institutional administration, and API access.

#### Comparison fields

| System | Primary role | Model relationship | Execution boundary | Main interfaces |
|---|---|---|---|---|
| Lathe | Open WebUI agent tools | Model-neutral | Per-user Daytona sandbox | Open WebUI |
| Pydantic AI | Agent framework | Model-neutral | Application-defined | Python, CLI, web and protocol integrations |
| Pydantic Monty | Restricted code interpreter | Model-independent | Rust interpreter and worker process | Python, JavaScript, Rust, WebAssembly |
| Daytona | Sandbox service | Model-independent | Managed container, VM, or GPU sandbox | API, SDK, CLI, web terminal |
| OpenCode | Coding-agent harness | Multi-provider | Local host or configured runtime | Terminal, desktop, IDE, server API |
| OpenChamber | OpenCode supervision interface | Inherits OpenCode | Inherits connected OpenCode runtime | Desktop, web, PWA, VS Code, mobile |
| T3 Code | Multi-harness supervision interface | Claude Code, Codex, Cursor, Grok Build, OpenCode | Host running each agent CLI | Desktop, web, iOS, Android |
| Paseo | Multi-harness supervision and orchestration | Direct adapters and ACP agents | Host running the Paseo daemon and agent CLIs | Desktop, web, mobile, CLI, SDK |
| Claude Code | Coding-agent product | Claude; supported cloud hosting | Local host or Anthropic cloud | Terminal, IDE, desktop, web, mobile |
| Claude Cowork | General-work agent product | Claude | Local VM or Anthropic cloud sandbox | Desktop, web, mobile |
| OpenAI Codex | Coding-agent product and runtime | OpenAI models | Local sandbox or OpenAI cloud | Terminal, IDE, desktop, web |
| ChatGPT Work | General-work agent product | OpenAI models | Desktop or OpenAI cloud | Desktop, web, mobile |

For all systems, tracked fields include source and license; access to files, shells,
browsers, credentials, tools, and remote execution; approval and delegation rules;
state and memory; sandbox boundaries; identity; cost; telemetry; and audit records.

### Protocols and interoperability

#### Agent Client Protocol

**Last verified:** 2026-08-31<br>
**Role:** Protocol between agent clients and coding agents<br>
**License:** Apache-2.0

The [Agent Client Protocol](https://agentclientprotocol.com/get-started/introduction)
standardizes communication between an agent and a client such as an editor or
supervision interface. Version 1 uses JSON-RPC and defines initialization, capability
negotiation, authentication, session creation and loading, prompts, streamed updates,
tool calls, file operations, terminals, permission requests, and cancellation. Local
agents normally communicate over standard input and output. Remote transport support
is still under development.

Paseo uses ACP for GitHub Copilot and for user-configured agents through a generic
adapter. T3 Code uses ACP for its Cursor integration. OpenCode implements an ACP agent
interface. Claude Code and Codex can be exposed through separate ACP adapters.

Track protocol versions, stewardship, stable and experimental fields, authentication,
permission semantics, session portability, remote transports, official SDKs, adapter
maintenance, and feature loss between native and ACP integrations.

#### OpenAI Chat Completions

**Last verified:** 2026-08-31<br>
**Role:** Message-based model inference API<br>
**Endpoint:** `/v1/chat/completions`

[Chat Completions](https://developers.openai.com/api/reference/resources/chat)
accepts a sequence of role-based messages and returns one or more choices containing
assistant messages. Applications normally maintain conversation history and resend it
with each request. The protocol supports multimodal messages, structured output, and
client-executed function calls. OpenAI continues to support it but recommends Responses
for new projects.

OpenAI's
[migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)
states that Chat Completions are stored by default for new accounts. Clients can request
`store: false`. Institution-specific contracts and ZDR status may override or constrain
that behavior.

#### OpenAI Responses

**Last verified:** 2026-08-31<br>
**Role:** Item-based model and agent API<br>
**Endpoint:** `/v1/responses`

The [Responses API](https://developers.openai.com/api/reference/resources/responses)
represents messages, reasoning, tool calls, and tool results as typed items. It supports
built-in web search, file search, computer use, code interpreter, image generation,
remote MCP servers, and custom functions. Applications can manage state by resending
items, referring to a `previous_response_id`, or using the Conversations API. Streaming
uses typed server-sent events.

Responses are stored by default unless the client sets `store: false`. OpenAI states
that ZDR organizations receive `store: false` automatically and can carry encrypted
reasoning items between stateless requests. The client must preserve and return those
items when it needs reasoning continuity without server-side storage.

Track Chat Completions and Responses support separately. An "OpenAI-compatible" claim
may cover only Chat Completions. Relevant fields include request and event schemas,
tool support, state ownership, storage defaults, ZDR behavior, reasoning-item handling,
model coverage, and compatibility tests across gateways and inference providers.

#### Other interoperability formats

**Last verified:** 2026-08-31

Track the [Model Context Protocol](https://modelcontextprotocol.io/), agent-to-agent
protocols, OpenAI-compatible inference APIs, `AGENTS.md`, portable skill formats, and
identity delegation standards. Relevant fields are stewardship, version,
authentication, delegated authorization, capability discovery, consent, approval,
auditability, and implementation support.

Portability fields include prompts, tools, permissions, identity, data, evaluations,
and wire formats.

## Research queue

The following records await primary-source research:

- Stanford University: concurrent institution-wide ChatGPT, Gemini, and Claude pilot.
- Duke University: ChatGPT Edu, Copilot, and consumption-funded Claude access.
- University of Toronto: Copilot, limited ChatGPT Edu, Cogniti, Cohere North, and the
  emerging AI Kitchen.
- Penn State: multi-model AI Studio and centralized AI governance.
- University of Hong Kong: quota-based multi-model institutional application.
- Keio University: managed Gemini/NotebookLM followed by an OpenAI partnership.
- University of Manchester and University of Leicester: universal Microsoft 365
  Copilot deployments.
- University of British Columbia and Canadian peers using bundled Copilot access.
- University of KwaZulu-Natal: governance, curricular integration, and planned access.
- Universidad EAN in Colombia and Instituto Tecnologico de Aeronautica in Brazil.
- Estonia and the other Education for Countries participants, separating secondary,
  higher-education, and research components.
- Institutional refusals, ended pilots, moratoria, labor agreements, and procurement
  challenges, which are less consistently announced than purchases.

## Update log

### 2026-09-01

- Expanded coverage to the UC system and Office of the President, UC Agriculture
  and Natural Resources, and all ten UC campuses, adding eight campus records and
  two system-location records. The records distinguish systemwide procurement
  from local adoption and cover licensed tools, institution-operated platforms,
  governance, data rules, evaluation, and unresolved evidence gaps.

### 2026-08-31

- Created the tracker and its evidence standard.
- Added initial institutional records spanning North America, Europe, Asia, Oceania,
  Africa, and Latin America.
- Added initial ecosystem records for inference, confidential computing, gateways,
  chat interfaces, agent harnesses, and interoperability protocols.
- Expanded agent-system coverage to distinguish frameworks, harnesses, interfaces,
  and execution services, including the components used by Lathe and OpenChamber.
- Added allowed-use, foreseeable-content, and secondary-use fields. Expanded the UCSC
  record with published Google retention terms and BayLeaf's documented use-case
  analysis.
- Added T3 Code and Paseo as multi-harness supervision interfaces and expanded the
  Agent Client Protocol record.
- Added separate protocol records for OpenAI Chat Completions and Responses.
- Added a strict weight-change definition for institutional model training, qualifying
  and provisional examples, and documented non-examples including TritonGPT.
- Added institutional Agent Skills libraries, authoring guidance, evaluation practices,
  and provenance distinctions.
