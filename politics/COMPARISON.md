# Comparison: BayLeaf vs. Enterprise AI Products

This table evaluates AI-in-education products against the five baseline criteria
defined in [POSITION.md](POSITION.md). Entries are based on publicly available
documentation as of Spring 2026. Corrections welcome via issue or PR.

## Baseline Criteria

| Criterion | BayLeaf | Google Gemini for Education | Anthropic Claude for Enterprise | OpenAI ChatGPT Edu |
|---|---|---|---|---|
| **Student can read system prompt** | Yes. User story [student-4]. | No. System prompt set by Google. | No. Configurable by admin, not visible to end users. | No. Admin-configurable, not student-visible. |
| **Faculty writes system prompt** | Yes. Teacher edits a Canvas page; BayLeaf syncs it to the model. | No. Gemini behavior controlled by Google product defaults. | Partial. Organization admin can set prompts; individual faculty cannot per-course. | Partial. Admin can create custom GPTs; per-course faculty authorship not standard. |
| **Zero data retention on inference** | Yes. All inference via ZDR providers through OpenRouter. | No. Google's standard data processing terms apply. Workspace data feeds product improvement unless enterprise agreement specifies otherwise. | Depends on contract. Enterprise tier offers ZDR; education-specific terms vary. | Depends on contract. API usage can be ZDR; ChatGPT Edu terms vary by institution. |
| **Vendor-switchable** | Yes. Model provider swapped overnight. Architecture is provider-agnostic. | No. Gemini is tightly integrated with Google Workspace. Switching means rebuilding the integration. | Partially. API-based usage is switchable; platform features create lock-in. | Partially. API is switchable; ChatGPT-specific features (custom GPTs, memory) are not. |
| **Institutional identity (no new login)** | Yes. Google SSO via existing Workspace account. | Yes. Google identity native. | Depends on deployment. SAML/SSO available in enterprise tier. | Yes in Edu tier. SSO integration available. |

## Beyond the baseline

| Dimension | BayLeaf | Enterprise products |
|---|---|---|
| **One model per course** | Yes. Each course gets a dedicated model with its own prompt and tools. | No. Typically one instance per institution. |
| **Teacher controls tool bindings** | Yes. Teacher selects from a vocabulary (Web, Code, Canvas, Drive). | No. Tool access determined by product defaults and admin settings. |
| **Time from decision to deployment** | Hours. Faculty member edits a Canvas page. | 6–18 months through procurement. |
| **Per-student marginal cost** | Near zero. Inference costs shared across usage. | Contract-dependent. Typically per-seat or per-institution licensing. |
| **Open source** | Yes. Full stack visible at [github.com/rndmcnlly/bayleaf](https://github.com/rndmcnlly/bayleaf). | No. |
| **Faculty can inspect all code** | Yes. | No. |
| **Can be forked and modified** | Yes. | No. |

## The question to ask vendors

If you are evaluating an enterprise AI product for course instruction, ask:

1. Can a faculty member write and edit the system prompt for their course's model?
2. Can a student read it?
3. Can the faculty member choose which tools the model has access to?
4. What happens to student conversation data?
5. If we want to switch providers next year, what breaks?

Document the answers. Compare them to the baseline.
