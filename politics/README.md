# Politics

Universities are adopting AI through procurement. The products are
[ChatGPT Edu](https://chatgpt.com/business/education/),
[Claude for Education](https://claude.com/solutions/education), and
[Gemini for Education](https://edu.google.com/intl/ALL_us/ai/gemini-for-education/).
The buyer is the CIO. The contract is the commitment. The faculty member
receives a finished tool and is expected to use it.

BayLeaf is a [counterpower](https://dl.acm.org/doi/10.1145/3290605.3300569)
strategy: a faculty-operated AI service that runs on the institution's own
infrastructure, uses its own identity system, and gives instructors direct
control over the AI their students interact with. It exists to demonstrate that
the vendor path is a choice, not a necessity.

## What we are playing against

Five structures make the vendor path dangerous. None require a villain.

1. **The procurement default.** AI enters the university as infrastructure
   (like email, like the LMS) and routes through IT procurement. The instructor
   is not in the room. The pedagogical question is asked at a remove, through
   advisory councils, after the contract is already shaped.

2. **The product-as-pedagogy substitution.** When a vendor ships a product with
   a fixed system prompt and fixed tool bindings, they have made pedagogical
   decisions and disguised them as product design. The instructor inherits a
   pedagogy they did not choose and cannot inspect. The vendor makes it look
   like the only difference between the university service and the consumer
   product is which account you sign in with: no meaningful difference in
   character or capability.

3. **The dependency ratchet.** Every integration (Canvas plugin, SSO binding,
   Workspace connector) makes switching harder. The vendor knows the switching
   cost is the real moat, not the product quality. The 5-year renewal is the
   business model. In a world with a competitive market of pay-per-token
   zero-data-retention AI providers, long-term agreements are not a requirement
   to get started in providing campus AI services.

4. **The legibility trap.** Universities want one dashboard, one vendor, one
   compliance narrative. This is rational for the administrator and
   catastrophic for the classroom. When "we have an AI tool" means one product
   with one configuration, the actual diversity of how faculty use AI becomes
   invisible. The institution can describe its AI strategy; no individual
   instructor can describe theirs.

5. **The consent vacuum.** Students are enrolled into AI tools they did not
   choose, running system prompts they cannot read, sending data under terms
   they did not negotiate. AI interaction is conversational, open-ended, and
   generative: closer to talking to a tutor than submitting a form. The power
   asymmetry in that interaction, where the student cannot see the instructions
   the tutor was given, represents a level of authorial control over the
   educational experience that universities would never have ceded to a
   textbook publisher. No one is treating it as new.

## What we are designing for

Naming the failure modes is not enough. BayLeaf is also a positive proposal:
five commitments that shape every architectural decision. They are the
inversion of the structures above, made operational.

1. **Energy: smaller models, smaller footprints.** Training compute, energy,
   and cost all
   [scale with parameter count](https://epoch.ai/data/ai-models?view=graph&tab=notable&xAxis=Parameters).
   BayLeaf exclusively uses mid-sized models (tens to hundreds of billions of
   parameters), not the trillion-parameter flagships that dominate the vendor
   products. The institutional pressure to deploy "the best" model is real;
   the environmental cost of treating that pressure as binding is also real.

2. **Reciprocity: open-weight models by default.** Large-scale AI concentrates
   power in a few corporations behind closed APIs. BayLeaf exclusively serves
   [open-weight models](https://huggingface.co/models): models contributed
   back to the public web, available for anyone to download, audit, or build
   on. This is structural reciprocity with the open ecosystem that makes the
   technology possible, not a marketing posture.

3. **Privacy: zero data retention as architecture.** Commercial AI services
   retain copies of user conversations, sometimes for 30 days or longer,
   creating exposure that users cannot control. BayLeaf routes all inference
   through
   [zero-data-retention (ZDR)](https://openrouter.ai/docs/guides/features/zdr)
   providers, so no LLM provider stores a copy of student or faculty data.
   Privacy is a design principle here, not a contract term to be renegotiated.

4. **Pedagogy: instructor-authored prompts, student-readable.** Commercial AI
   assistants are optimized to be maximally helpful, which in practice means
   maximally doing-it-for-you: students mistake speed for understanding, and
   the skills education is supposed to build quietly atrophy. BayLeaf's models
   use system prompts and agent skills written by educators for their students
   and peers, designed to scaffold learning rather than shortcut it. Crucially,
   students can read the prompt their AI was given. A student who cannot
   inspect the AI's instructions is in the same position as a student who
   cannot read the syllabus.

5. **Inquiry: grounded in sources of truth.** General-purpose chatbots
   [reward fluent output over rigorous inquiry](https://calearninglab.substack.com/p/my-robot-teacher-episode-9-transcript):
   they generate plausible answers without grounding them in the user's actual
   data, documents, or methods. BayLeaf connects models to grounded tools (web
   search, Google Workspace, code execution) so AI-assisted inquiry can be
   anchored in evidence the user can verify.

See [POSITION.md](POSITION.md) for the version of this argument written as a
baseline standard against which to evaluate any AI tool, including BayLeaf
itself.

## Dual power

BayLeaf operates alongside institutional procurement, not against it. It uses
the institution's own primitives (Canvas, SSO, Google Workspace) to build a
governance model that procurement would never produce but that the institution
can absorb. If the institution decides to adopt BayLeaf formally, the admin
can take over with no migration. If the institution decides to shut it down,
the admin can do that too. All authority flows through systems the institution
already controls.

This is not revolution. It is a demonstration that the alternative is
operational, and cheaper than what procurement would buy.

## Counterfoil research

Ivan Illich used the term *counterfoil research* for inquiry conducted against
the grain of institutional self-interest: research that questions the
necessity of the institution's own expansion rather than justifying it.
BayLeaf is counterfoil research applied to AI procurement: the artifact is
the finding, the repository is the lab notebook, and this folder is the
analysis.

The method is deliberate. The entire project is built using generative AI in
agentic coding tools, by a single faculty member, in a public repository.
This is not an efficiency claim. It is an empirical argument: that the
capacity to build and operate university AI infrastructure exists within the
university, and that the vendor's role as sole provider is a political
arrangement, not a technical constraint.

The evidence is operational. BayLeaf has been running since Fall 2024, with
course-specific deployments across the Computational Media and Computer
Science & Engineering departments (Brace, Brace2, Brace3, Gambit), serving
roughly 700 students across six course offerings to date. The total vendor
commitment is month-to-month, pay-per-token. See the
[adoption section of bayleaf.dev](https://bayleaf.dev/#adoption) for the
current roster.

## This folder

These documents are a workspace, not a publication. They are written alongside
the project, revised as the argument sharpens, and visible to anyone at any
stage, in the tradition of
[open notebook science](https://en.wikipedia.org/wiki/Open-notebook_science),
where the process is public record, not just the findings.
