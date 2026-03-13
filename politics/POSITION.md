# Position: Infrastructure Is Pedagogy

## The argument

The system prompt is the pedagogical frame. The tool bindings are the capability
boundary. The access model is the enrollment policy. These are not metaphors. When
a vendor sets the system prompt, a vendor sets the pedagogical frame. When
procurement selects the model, procurement selects the epistemology. When IT
controls tool access, IT controls who learns with what.

Every AI deployment in a course is a pedagogical decision. The question is whether
that decision is made by the teacher or by someone else.

## What procurement gets wrong

Enterprise AI procurement optimizes for institutional legibility: one vendor, one
contract, one dashboard, one compliance narrative. This is rational from the CIO's
perspective. It is catastrophic from a pedagogical one.

**Procurement removes the teacher from the design loop.** A Gemini for Education
deployment gives every course the same model with the same defaults. The teacher
cannot write a system prompt. The teacher cannot choose which tools the model has.
The teacher cannot decide that *this* course's AI should be able to search the web
but not access Drive, or that *that* course's AI should refuse to generate code.
The design decisions that shape every student interaction are made by product
managers at Google, not by the person who designed the syllabus.

**Procurement creates vendor dependency disguised as infrastructure.** Once Canvas
integrations, SSO, and workflows are built around a vendor's product, switching is
not a technical decision — it's a political crisis. The vendor knows this. The
contract is structured around it. The 5-year renewal is the goal, not the product.

**Procurement is slow.** The typical timeline from "we should have an AI tool" to
"students can use it in a course" is 6–18 months through formal channels. The
technology changes faster than the process. By the time a tool is approved, its
assumptions are stale.

## What faculty control looks like

A faculty-controlled AI tool has these properties:

1. The teacher writes the system prompt for their course's model. This is the act
   of articulating pedagogical intent in machine-readable form. It is intellectual
   work, not configuration.

2. The teacher selects which tools (web search, code execution, document access)
   the model can use. Each tool binding is a decision about what the AI should be
   able to do in the context of this course.

3. The student can read the system prompt and see the tool selection. Transparency
   is not optional. A student who cannot inspect the AI's instructions is in the
   same position as a student who cannot read the syllabus.

4. The model provider can be changed without disrupting the teacher's configuration
   or the student's experience. The pedagogical layer (prompt, tools, access) is
   decoupled from the inference layer (which company's GPU runs the model).

5. No conversation data is retained by any third-party provider. Students are not
   the training data.

## The "any faculty member could build this" test

The design principle is Illich's test for convivial tools: can the user understand,
modify, and replace it? BayLeaf's architecture is designed so that any faculty
member with basic technical literacy could, in principle, stand up an equivalent
system for their institution using open-source components and commodity cloud
services.

This is not yet fully true operationally — the current deployment depends on one
person's credentials and institutional access. Closing this gap is an active
priority. But the architecture is honest: there is no proprietary component, no
vendor SDK, no licensed dependency. The barrier to replication is documentation
and operational knowledge, not intellectual property.

## The dual power reading

BayLeaf operates alongside institutional procurement, not against it. It uses
existing institutional primitives — Canvas, SSO, Google Workspace — to build a
governance model that procurement would never produce but that institutions can
absorb. The architecture is designed so that if the institution decides to adopt
BayLeaf formally, the admin can take over with no migration. And if the institution
decides to shut it down, the admin can do that too. All authority flows through
systems the institution already controls.

This is not revolution. It is a demonstration that the alternative exists, is
operational, and is cheaper than what procurement would buy.

## The ask

We are not asking institutions to adopt BayLeaf. We are asking them to adopt
the *baseline*: transparency, faculty control, zero data retention,
vendor-switchable architecture, institutional identity. Then evaluate every tool —
including BayLeaf, including Gemini, including Claude — against that baseline.

The tools that meet it will be the ones that treat faculty as professionals and
students as people. The ones that don't will be the ones optimized for vendor
lock-in.
