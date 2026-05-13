# Position: Infrastructure Is Pedagogy

## The thesis

The system prompt is the pedagogical frame. The tool bindings are the capability
boundary. The access model is the enrollment policy. These are not metaphors.
When a vendor sets the system prompt, a vendor sets the pedagogical frame. When
procurement selects the model, procurement selects the epistemology. When IT
controls tool access, IT controls who learns with what.

Every AI deployment in a course is a pedagogical decision. The question is
whether that decision is made by the instructor or by someone else.

## What the vendors are selling

Three products define the emerging market for AI in higher education:

- [ChatGPT Edu](https://chatgpt.com/business/education/) (OpenAI)
- [Claude for Education](https://claude.com/solutions/education) (Anthropic)
- [Gemini for Education](https://edu.google.com/intl/ALL_us/ai/gemini-for-education/) (Google)

Visit those pages. Notice who they are talking to. Every testimonial is from a
CIO or superintendent. Every call to action is "Contact sales." The buyer is the
administrator. The instructor appears nowhere in the transaction.

Notice what "customizable" means. All three products offer some form of
side-channel customization (custom GPTs, Gems, Projects) where someone can
create a narrowly-scoped AI character for a specific purpose. But these are
opt-in extras, not defaults. The default experience is the same whether you sign
in with your institutional account or your personal one. There is no mechanism
for the institution to differentiate the AI by role: a student, a faculty
member, and a staff member all get the same default chatbot, despite the fact
that SSO claims already encode these distinctions.

This is not a minor UX issue. It is a privacy architecture failure. The entire
data governance argument for enterprise AI rests on people using their
institutional account for institutional work. But when the product is
indistinguishable from the consumer version (same interface, same personality,
same capabilities), people forget which account they are signed into, or stop
caring. The contract says use your campus identity. The product gives you no
reason to. Every institution already struggles to get people to use campus email
for campus business, respecting FERPA and other obligations. The reinforcement
mechanism is making campus services *recognizably and functionally different*:
not just branded with the correct logo in the corner, but different in character,
in knowledge, in what they can do. The vendor products do not support this.

Notice the privacy framing. All three present data governance as a compliance
checklist (FERPA, COPPA, FedRAMP), not as an architectural decision. None of
them commit to zero data retention on the inference path as a baseline. Privacy
is a contract term, not a design principle.

Notice the integration story. Every product goes deeper into its own ecosystem:
Workspace, Canvas connectors, proprietary plugins. The path in is easy. The path
out is not discussed.

## The baseline

Before evaluating any AI tool for instruction, institutions should establish what
adequate looks like. Four criteria:

1. **The institution and its instructors control the system prompt.** The
   institution sets role-differentiated defaults: students, faculty, and staff
   get AI personalities shaped for their context, not the vendor's generic
   chatbot. Within that, the instructor writes the system prompt for their
   course's model. This is the act of articulating pedagogical intent in
   machine-readable form. It is intellectual work, not configuration. A tool
   that does not support this layered authorship has removed both the
   institution and the instructor from the design of the experience.

2. **The student can read the system prompt.** A student who cannot inspect the
   AI's instructions is in the same position as a student who cannot read the
   syllabus. Transparency is not a feature. It is a prerequisite for informed
   participation.

3. **Zero data retention on inference.** No student message content is stored by
   any third-party model provider. This is not a negotiable contract term. It is
   a minimum standard for putting students in conversation with a commercial AI
   system.

4. **The model provider is switchable.** The pedagogical layer (prompt, tools,
   access) is decoupled from the inference layer. If the vendor raises prices,
   degrades quality, or changes terms, the institution can switch providers
   without rebuilding the system. In a competitive market of pay-per-token
   providers, and alongside NSF-funded institutional inference from the
   [National Research Platform](https://nrp.ai/documentation/userdocs/ai/llm-managed/),
   this is an architectural choice, not a fantasy.

These criteria are not ambitious. They are minimal. Any tool that fails them is
asking faculty and students to accept less than they should.

Are these the final and most important criteria? No. This is a living document,
and further collective experience operating AI in educational settings will
likely clarify the need for additional baseline criteria.

## What the vendors fail

Test the three products against the baseline:

| Criterion | ChatGPT Edu | Claude for Education | Gemini for Education |
|---|---|---|---|
| Institution/instructor controls system prompt | No. Optional side-channel "custom GPTs." No role-differentiated defaults. | No. Organization admin configures. No per-course instructor authorship. | No. Optional side-channel "Gems." No role-differentiated defaults. |
| Student can read system prompt | No. | No. | No. |
| Zero data retention on inference | Contract-dependent. | Contract-dependent. | No. Standard data processing terms apply. |
| Model provider is switchable | No. Locked to OpenAI. | No. Locked to Anthropic. | No. Locked to Google. |

Four criteria. Four failures across the board, as of March 2026, based on
publicly available product documentation.

## What BayLeaf demonstrates

BayLeaf is a faculty-operated AI service at UC Santa Cruz. It meets all four
baseline criteria. This is not because it is a superior product. It is because
the criteria are easy to meet when the architecture is not optimized for vendor
lock-in.

- The default AI personality differs by role: students, faculty, and staff get
  context-appropriate assistants out of the box. Instructors write per-course
  system prompts by editing a Canvas page; BayLeaf syncs them to the model. The
  student can read the prompt.
- All inference routes through zero-data-retention providers. The provider has
  been swapped multiple times with zero user disruption. As of March 2026,
  BayLeaf runs two configured inference backends in parallel: OpenRouter
  (commercial gateway to ZDR providers) and NRP/SDSC (NSF-funded institutional
  inference serving open-weight models via [Envoy AI Gateway](https://aigateway.envoyproxy.io/)).
  The switchability criterion is not hypothetical: it is the current operating
  state.
- The entire system is open source, runs on commodity cloud services, and has no
  proprietary dependency.

BayLeaf was built by a single faculty member using generative AI in agentic
coding tools. It has been running since Fall 2024 with multiple course models
across departments. The total vendor commitment is month-to-month, pay-per-token.

The point is not that every university should run BayLeaf. The point is that a
faculty member built a campus AI service that meets standards the enterprise
products do not, and we expect to operate it at scale for less than the cost of
the single FTE it would take to be the AI vendor liaison.

## The standard

We are not asking institutions to adopt BayLeaf. We are asking them to hold
every tool (including BayLeaf, including ChatGPT, including Claude, including
Gemini) to the baseline.

The tools that meet it will be the ones that treat instructors as designers of
learning experiences and students as participants with a right to understand the
systems they interact with.

The tools that fail it will be the ones where a product manager at a vendor
decides what your course's AI does, and neither you nor your students can see
the instructions it was given.

That is the current state of every major enterprise AI product marketed to
universities. It does not have to be.
