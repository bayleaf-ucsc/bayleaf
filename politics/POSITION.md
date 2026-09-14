# Position: Procure Inference, Preserve Agency

*Working position, revised with Adam through discussion on September 14, 2026. ✨
These are developing commitments, not a finished procurement specification.*

## The choice before the campus

Universities can purchase model inference separately from the software through
which people use it. That supply market already exists. The political question is
whether campuses recognize this as a credible form of AI provision, or define
their needs around integrated, per-seat chatbot subscriptions.

The distinction is between buying access to computation and buying a package of
models, interfaces, conversation storage, tools, and administration. An
organization can operate a lightweight harness, or help participants configure
desktop software, while purchasing inference separately. By *harness* we mean the
software surrounding a model: it manages context, instructions, tools, and the
interaction through which someone works.

The analogy is campus internet access: shop for connectivity, not just
subscriptions to particular services delivered over that connectivity. Models
are not interchangeable in the way electrical outlets are. Their capabilities,
behavior, and interfaces differ. The practical requirement is that changing an
inference supplier need not require replacing the whole working environment.

BayLeaf is a situated counterplatform at UC Santa Cruz. Its role in this argument
is operational evidence that alternative arrangements can be organizationally,
technically, and economically feasible and useful within a stated scope. This is
not a request for funding BayLeaf or a claim that every institution should adopt
it. It is an argument that procurement should permit BayLeaf-like arrangements to
qualify and compete on their merits.

## A normal technology in a continuing history

We place Generative AI in the succession Internet → Web → Cloud → Generative AI.
Each layer builds on earlier infrastructure. The Internet, Web, and Cloud found
wide adoption and changed university practices without destroying higher
education. This history supports a cool-headed approach to the next layer:
curiosity, criticism, experimentation, and selective adoption or refusal.

We reject both promotional hype and narratives that treat the technology as an
inherent existential danger to education. Historical continuity does not prove
that a particular use is harmless, worthwhile, or inevitable. It gives us grounds
to treat GenAI as consequential normal technology whose terms and uses can be
shaped. The question is what it does in a practice, who controls it, and whether
the arrangement is worth supporting.

## Make the alternative eligible

A specification can exclude an architecture before anyone evaluates its merits.
If an “AI solution” must arrive from one vendor with its own model, interface,
history storage, and administrative console, an institution-operated arrangement
is off the table by definition.

Procurement should evaluate the complete service arrangement, including internal
provision and separately purchased components. Security, accessibility, support,
maintenance, and continuity remain real responsibilities. They can be allocated
and documented across an organization and its suppliers.

We want campuses to ask:

- Can participants use independently chosen software with the inference service?
- Can the institution replace a supplier without replacing its interfaces,
  instructional resources, and working practices?
- Who retains content, who can access it, and who could change the system to
  acquire access?
- Can courses and groups extend the service without maintaining a fork of its
  core software?
- What are the full costs, including operation, support, accessibility,
  integration, and exit?

Integrated products may still be useful purchases. They should not define the
shape of foundational campus AI provision. A corporate supplier could offer
better privacy assurances and lower full costs through economies of scale, and
could reasonably win a fair comparison. Autonomy and privacy nevertheless have
value that a subscription-price comparison can miss.

## Integrated chatbots should be optional at the campus level

An institution can reject ChatGPT or another corporate package while supporting
selected uses of AI under different terms. Criticism of retention, operator
access, and dependency should be able to change what the campus provides.

Participants should not need an integrated chatbot to obtain ordinary university
services, such as advice about completing a degree. A supported inference route
and adequate onboarding should let ordinary users configure an alternative,
including desktop software. **Exemption from surveillance should not be a
power-user-only feature.** Additional hosted chat services can coexist with that
route.

This campus-level commitment does not prescribe every course's tool choices.
Instructors may require engagement with particular technologies when teaching
disciplinary ways of knowing. Our aim is to make open alternatives easy for them
to offer, rather than let proprietary products appear to be the only options.
The institutional optionality claim does not, by itself, resolve disputes about
compulsion within a course.

## Retention and operator access are different questions

“Not used for training” does not establish either zero retention or zero operator
access. A service can retain no content while still allowing an operator to
inspect it in transit or deploy a revision that records it.

Procurement should distinguish:

- **Retention:** where prompts, responses, files, and histories persist.
- **Standing access:** which operators can routinely inspect content.
- **Change authority:** who could modify the service to acquire content access.
- **Architectural protection:** which operators are technically prevented from
  accessing content, and how that protection is verified.
- **Metadata:** what remains visible when content is protected.

The campus should support at least some mode in which neither campus nor
inference-provider operators can access content. Standards and client support
for this mode are not yet widely adopted. We accept weaker arrangements during
this transition with their limitations explicit, including services that retain
no content but whose deployers could introduce capture.

Institution-custodied chat and privately accessed inference can have different
boundaries. Some organizational visibility can be acceptable in a supported Chat
service if participants have practical offramps. The guiding intuition is that
visibility should be proportional to support, not a general entitlement to
inspect people's work. Its precise limits still need development.

Campus email versus HTTPS traffic to an external email service is a useful
custody analogy: providing connectivity does not require custody of the
application's contents. This is a technical-access distinction, not a claim that
externally held records are immune from legal discovery or records obligations.

**Open question:** how quickly must the strongest protected mode become usable
by ordinary participants? A specialist-only protected route and a well-supported
weaker route expose a tension between transitional acceptance and the commitment
that privacy not be reserved for power users.

## Local authorship without local forks

Institutional sovereignty is not enough. Campus administrators can become
overseers, and instructor control is not identical to student agency. We favor
participant autonomy and distributed authority.

Educators should be able to write prompts, skills, and disciplinary resources
that participants' agents can read. That need not give educators control of the
agents themselves. Courses, departments, and other groups should also be able to
offer tools accessed with appropriate authorization.

This resembles the software open–closed principle: a stable core that supports
extension without requiring modification of the core. The political objective
is that specific groups can adapt their practices without maintaining divergent
versions of campus infrastructure or making their needs universal first.

A broadly used commercial desktop client can fit this arrangement. Regional
autonomy means the capacity to adapt and leave, not an obligation to produce
distinct software everywhere. The important exercise of that capacity may occur
in course or group resources and tools.

Coding agents may reduce the costs of repairing and integrating local
adaptations. This is a hypothesis, not evidence that maintenance disappears. If
slightly incompatible regional variants become a persistent integration burden,
that weighs against recommending the arrangement.

## Open weights and bounded provision

Open-weight access matters as a contribution back to a shared technical
ecosystem and as a counterweight to concentrated ownership. That value does not
depend on every participant running a model themselves.

At this stage, publishing usable weights is a sufficient contribution for this
catalog-policy purpose. As the landscape matures, more specific criteria may be
appropriate. Weight publication does not settle questions about licenses,
training data, labor, or compensation, and does not imply that every debt to
contributors has been repaid.

A campus catalog need not include every model. Exclusions should have published,
contestable criteria and a route to request alternatives. Participants who gain
experience through BayLeaf should be better equipped to seek what they need from
third parties. A bounded service can teach capabilities that travel beyond it.

## Ecological sufficiency

Energy, water, hardware production, and disposal belong in the assessment of AI
provision. These costs are unevenly borne and are not fully represented in the
price of inference. Lower prices or more efficient models are not reasons to
expand consumption indefinitely.

We favor enough capability for a worthwhile task: smaller models where adequate,
bounded use, and declining computation that adds little value. Campuses should
not treat access to the largest model or rising usage as measures of success.
This leaves room for demanding tasks that justify more computation without
making their requirements the default for everyone.

BayLeaf's usage limits and mid-sized API recommendation put some of this
commitment into practice. They do not establish a measured environmental
advantage. Comparisons need evidence about actual workloads, hardware, energy
sources, and resource use; parameter counts and token prices alone are
insufficient. Operational reporting should distinguish what is measured from
what remains unknown.

## What BayLeaf currently demonstrates

BayLeaf separates interfaces and access arrangements from inference suppliers,
and has changed providers in operation. Its privacy boundaries differ by service:

- **Chat** uses curated OpenRouter zero-data-retention inference endpoints, with
  proprietary and open-weight models. BayLeaf stores conversation history, which
  its administrator can access. Provider-side inference retention guarantees do
  not cover that history.
- **API plaintext** retains no prompt or completion content at BayLeaf and routes
  through OpenRouter ZDR endpoints. It enforces a published-weight eligibility
  policy. Its deployer could nevertheless modify it to capture content: this is
  not a hardware-attested zero-operator-access guarantee.
- **API Sealed** carries encrypted requests to an attested Tinfoil enclave.
  BayLeaf cannot decrypt the requested model or body. Usage metadata remains a
  separate boundary; non-streaming usage may reveal the executed model. The
  available model catalog is controlled by Tinfoil, not enforced by BayLeaf.

BayLeaf still depends on commercial cloud and inference services. Its argument
is about how those dependencies are organized and made replaceable. Its
operational evidence should include actual costs and labor, support limits,
provider-switching experience, and what participants find useful. A working
service establishes possibility; broader recommendations require those details.

## The agenda

Make disaggregated, institution-operated arrangements eligible. Make integrated
chatbots optional for campus services. Support ordinary participants in using
content-private inference. Preserve group-level authorship and authorized tool
extension. Include open-weight access, contestable catalog choices, and practical
exits. Orient provision toward sufficient capability and bounded resource use.

These commitments give campuses a way to respond to criticism through changes in
provision. Whether a particular use of AI is worthwhile remains a question for
the people and practices involved.
