# Research: BayLeaf as Design Reasoning

## The lab

The [Design Reasoning Lab](https://designreasoning.org) at UC Santa Cruz studies
how people author, inspect, and reason about computational systems that generate
consequential artifacts. The lab's lineage is classical AI applied to design:
constraint solving, answer set programming, design space modeling, computational
caricatures of the design process. The objects of study have been games,
educational software, visualization systems, and other interactive media. The
methods have been formal -- specifications over generative spaces, quantification
over play, mechanized exploration of design alternatives.

BayLeaf is the lab's current instrument. The domain shifted; the questions did
not.

## The research question

What happens to the design of AI systems when the people affected by them can
inspect, modify, and replace the reasoning layer?

This is a design reasoning question. A system prompt is a soft constraint on a
generative process. Model switchability is the same move as swapping solvers in a
constraint system -- same specification, different engine. An instructor writing a
system prompt is doing design work: articulating intent in a form that shapes
generation, then observing and revising based on output. A student reading the
system prompt is inspecting the design rationale -- the same transparency
principle the lab applies to any generative system.

The difference from prior work is scale. The generative system is not a level
generator or a puzzle solver. It is a campus AI service with hundreds of users,
real pedagogical stakes, and institutional politics. The design space is not a
set of tile patterns or game rules. It is the space of possible AI
infrastructures a university could operate, and the space of possible
pedagogical relationships those infrastructures create.

## Action research

BayLeaf is [action research](https://en.wikipedia.org/wiki/Action_research):
the intervention is the inquiry. The researcher builds and operates the system,
observes what breaks and what holds, revises the design, and reports the findings
-- which include the artifact itself, the process of building it, and the
institutional dynamics encountered along the way.

This is methodologically legitimate and has precedent in participatory design,
critical making, design-based research in education, and the lab's own tradition
of using working systems as research contributions. The commit history is the lab
notebook. The repository is public. The [politics/](.) folder is the analysis.

The specific contributions this method produces:

1. **Designerly system prompt authorship.** When instructors write system prompts
   for course models, what design process do they follow? How does it differ from
   prompt engineering? The Brace model -- where the instructor edits a Canvas
   wiki page and BayLeaf syncs the prompt to the model at request time -- is an
   instrument for studying iterative design with a generative system, in
   production, with real students. This is the lab's home turf: authoring
   specifications for generators and observing the consequences.

2. **Infrastructure as authored medium.** The access model, the rate limits, the
   tool bindings, the group permissions, the model routing -- these are all
   design decisions with pedagogical consequences. The classical design reasoning
   question is about how authors reason about generative systems. BayLeaf extends
   the authorship surface from "the game" or "the generator" to the
   infrastructure itself. This is a new finding: infrastructure is not a neutral
   substrate for AI pedagogy. It is the pedagogy.

3. **Switchability as a design constraint.** The lab's constraint-solving work
   studies the relationship between a specification and the space of artifacts
   that satisfy it. Model switchability is the same structure: the system prompt
   and tool bindings are a specification, and different models are different
   solvers. What is preserved and what breaks when you swap the engine? BayLeaf
   answers this empirically -- the inference provider has been swapped multiple
   times, in production, with measurable consequences for the user experience.

4. **Counterfoil research as method.** Ivan Illich used the term *counterfoil
   research* for inquiry conducted against the grain of institutional
   self-interest. BayLeaf is counterfoil research applied to AI procurement:
   building a working alternative to the vendor path produces knowledge that
   studying the vendor path from outside cannot. The artifact is the argument.
   This is defensible as method -- it is what critical making looks like at
   infrastructure scale.

## Alignment with national objectives

[America's AI Action Plan](https://www.whitehouse.gov/wp-content/uploads/2025/07/Americas-AI-Action-Plan.pdf)
(White House, July 2025) articulates federal priorities for AI innovation,
infrastructure, and international competitiveness. BayLeaf's
research program produces artifacts that align with several of these priorities
-- not because the research was designed to serve them, but because the
underlying problems are the same.

**Open-weight model adoption.** The Action Plan identifies open-source and
open-weight AI models as strategically valuable for startups, government,
academic research, and geostrategic influence. BayLeaf runs open-weight models
as the default, operates two inference backends in parallel (commercial and
NSF-funded), and treats model switchability as a first-class design constraint.
The research produces empirical evidence about what open-weight adoption looks
like in institutional practice.

**NAIRR and academic compute access.** The Action Plan directs NSF to build a
"lean and sustainable NAIRR operations capability" connecting researchers and
educators to AI resources. BayLeaf's NRP/SDSC backend already uses the
predecessor infrastructure -- NSF-funded GPUs at the San Diego Supercomputer
Center, serving open-weight models via CILogon authentication. BayLeaf is a
demonstrated integration point for what NAIRR could enable at the institutional
level.

**AI evaluation testbeds.** The Action Plan calls for investment in "AI testbeds
for piloting AI systems in secure, real-world settings, allowing researchers to
prototype new AI systems and translate them to the market." A campus AI service
with hundreds of users, multiple models, instructor-authored system prompts, and
a public codebase is an AI testbed. The research questions about system prompt
authorship, model switchability, and infrastructure design are evaluation
questions.

**AI skill development and workforce.** The Action Plan directs multiple agencies
to prioritize AI skill development across education and workforce programs.
BayLeaf does not just give students access to AI -- the architecture is
transparent (readable system prompts, inspectable tool bindings, open-source
code), and the graduate students who build and operate the system are gaining
experience in AI infrastructure that has no equivalent in a vendor-mediated
environment.

**Multi-model procurement flexibility.** The Action Plan recommends an "AI
procurement toolbox" for federal agencies that allows "easily choosing among
multiple models" with "flexibility to customize models to their own ends."
BayLeaf implements this architecture for a university rather than a federal
agency. The structural critique in [POSITION.md](POSITION.md) -- that vendor
products lock institutions to one model with one configuration -- identifies
the same problem the Action Plan identifies in federal procurement.

**The "try-first" culture.** The Action Plan advocates for moving from cautious
gatekeeping to a "dynamic, try-first culture for AI." BayLeaf is the try-first
approach to campus AI: a faculty member built it, deployed it, iterated on it
in production, and published the results. The alternative -- a multi-year
procurement process culminating in a vendor contract -- is the cautious
gatekeeping the Action Plan warns against.

## Siting

BayLeaf is operated at UC Santa Cruz, a public university of the United States.
The operator is a tenured faculty member who swore an oath to support and defend
the Constitution. The service uses the university's own identity system
(CILogon/InCommon Federation), runs on infrastructure accessible to any
InCommon member institution, and is funded through ordinary faculty research
activity. The code is MIT-licensed, copyright The Regents of the University of
California.

This is normal activity of a research lab at a public university, producing
open-source research artifacts, operating experimental systems with human
participants, and publishing findings. The fact that the artifact is also a
functioning campus service is the point: the research requires operation at
scale, because the questions are about what happens when AI infrastructure is
designed rather than procured.

## Relation to other documents in this folder

- [README.md](README.md) frames BayLeaf as a counterpower strategy against
  vendor procurement. That framing is political and intentional.
- [POSITION.md](POSITION.md) articulates baseline criteria for AI tools in
  higher education and tests vendor products against them. That is the standards
  argument.
- [DEPENDENCIES.md](DEPENDENCIES.md) audits every external dependency in the
  stack. That is the honesty argument.
- [SECURITY.md](SECURITY.md) discloses the security posture for institutional
  reviewers. That is the transparency argument.
- This document explains why all of the above is research. The political
  argument and the research argument are the same argument made legible to
  different audiences. Neither is a disguise for the other.
