# BayLeaf: Faculty-Controlled AI for Course Instruction

A brief for faculty, governance committees, and anyone evaluating AI tools for
higher education.

---

## The problem

When a university deploys AI for instruction, the decision is typically made by IT
procurement. The contract is signed with Google, Anthropic, Microsoft, or OpenAI.
Faculty receive a preconfigured tool. Students use it. Neither can see the system
prompt that shapes every interaction. Neither chose the model. Neither controls what
the tool can access. The person who decides what AI tool you use in your classroom
has never entered your classroom.

This process takes 6–18 months and produces a tool optimized for institutional
legibility, not pedagogical intent.

Meanwhile, faculty are either using nothing or using unapproved tools with no
guardrails.

## The baseline

Before evaluating any specific tool, institutions should establish minimum criteria.
We propose five:

1. **Transparency.** Students can see the system prompt and tool configuration.
   They know what the model is told to do. They don't have to trust its self-report.

2. **Faculty control.** The instructor writes the system prompt and selects the
   tools for their course model. Configuration is a pedagogical act, not an IT
   ticket.

3. **Zero data retention on inference.** No student message content is stored by
   any third-party model provider. Ever.

4. **Vendor-switchable.** The model provider can be changed without rebuilding the
   system. The intelligence is a commodity input, not a strategic dependency.

5. **No new login.** Students authenticate with their existing institutional
   identity. No new account. No new password. No new vendor relationship.

These are not ambitious. They are minimal. Any tool that fails these criteria is
asking faculty and students to accept less than they should.

## What BayLeaf is

BayLeaf is an open-source AI platform operated at UC Santa Cruz by a faculty member
in Computational Media. It runs on [Open WebUI](https://openwebui.com/), routes
inference through zero-data-retention providers, and gives each course a dedicated
AI model whose system prompt is written by the instructor and visible to students.

The core integration that connects AI models to Google Workspace (Drive, Docs,
Sheets) is approximately 400 lines of code. It gives any user with an institutional
Google account OAuth-consented access to their own files through any LLM. This is
the empirical argument against the premise that AI-Workspace integration requires
enterprise procurement.

BayLeaf meets all five baseline criteria.

### Current operation

- Running at UCSC since Fall 2024
- Multiple course models across departments
- Students access via invite links shared through Canvas
- Teachers configure models by editing a Canvas page — no new interface to learn
- Model provider has been swapped multiple times with zero user disruption

## The question

Does your institution's current or planned AI tool meet the baseline?

Ask your vendor:

> *Can a faculty member see and edit the system prompt for their course's AI model?*

> *Can a student read it?*

> *Where does the conversation data go?*

If the answer to any of these is unclear, the tool is not ready for the classroom.

## Contact

**Adam Smith** · Associate Professor, Computational Media, UC Santa Cruz
[amsmith@ucsc.edu](mailto:amsmith@ucsc.edu) · [github.com/rndmcnlly/bayleaf](https://github.com/rndmcnlly/bayleaf)
