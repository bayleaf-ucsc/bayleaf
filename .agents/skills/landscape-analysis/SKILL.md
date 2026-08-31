---
name: landscape-analysis
description: Research, compare, verify, or update the university AI infrastructure landscape in politics/LANDSCAPE.md. Use for institutional AI adoption, procurement, governance, privacy, model training or fine-tuning, Agent Skills, providers, interfaces, harnesses, execution, and interoperability.
---

# University AI Infrastructure Landscape

Use `politics/LANDSCAPE.md` as the canonical specification and registry. Read its
Intent, tracked fields, evidence standard, and update procedure before researching.
Do not copy those rules into this skill. If this skill and the document disagree,
follow the document and fix this skill if needed.

## Workflow

1. Define one research unit: an institution, system, product, protocol, or one
   cross-institutional question. Split independent units across parallel agents.
2. Recheck existing inline sources, then search current primary institutional,
   procurement, policy, technical, and repository sources. Use independent reporting
   for disputes and facts absent from primary sources.
3. Classify the evidence before drafting. Separate institution-wide offerings from
   unit, lab, faculty, student, vendor, and research-prototype activity.
4. Edit only supported claims. Put evidence URLs next to the claims they support,
   preserve unresolved contradictions, and use `Unknown` or `Not disclosed` as defined
   by the document.
5. Apply the document's unslop requirement. Keep records terse, neutral, factual, and
   explicit about the authority and limitations of each source.
6. Update `Last verified` and the update log. Run
   `git diff --check` for tracked changes or
   `git diff --no-index --check /dev/null politics/LANDSCAPE.md` while the file is
   untracked. Inspect the final diff and worktree status. Do not commit or publish
   unless the user explicitly asks.

## Classification Traps

- Count model training only when weights or adapters change. RAG, indexing, prompt
  editing, tool integration, model routing, hosting, feedback collection, and
  quantization alone are not model training. Treat an unspecified claim that a system
  was "trained on campus data" as ambiguous until a source identifies the method.
- Count Agent Skills only when there is a `SKILL.md` package or format-specific
  guidance tied to the Agent Skills standard. Human AI literacy, custom assistants,
  prompt libraries, MCP tools, and academic affiliation alone do not qualify.
- Keep no-training, retention, ZDR, E2EE, and ZOA separate. Name the actor, data type,
  purpose, contractual basis, and technical control whenever evidence permits.
