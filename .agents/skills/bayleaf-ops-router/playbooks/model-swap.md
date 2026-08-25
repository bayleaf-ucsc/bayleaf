---
source-skill: bayleaf-ops-router
description: Change the LLM powering Basic or Help (base_model_id swap, incl. vision capability handling).
status: rough
last-reviewed: 2026-08-25
---

# Model Swap (Basic / Help)

## When to use

Changing `base_model_id` on the `basic` or `help` workspace models (currently
both `openrouter.z-ai/glm-5.2`), including flips of the vision capability.

## Prerequisites

- **[HUMAN GATE]** Adam already has personal experience with the candidate
  model (used it himself, not just seen benchmarks). If not, candidates are
  discussion, not deployment.
- The candidate must be reachable through a **ZDR provider endpoint** via
  OpenRouter (platform floor; see root `AGENTS.md`). Check the provider's
  OpenRouter listing states zero data retention.
- `GET https://api.bayleaf.dev/v1/models` lists only open-weight entries
  (truthy `hugging_face_id`); Chat curation follows the same open-weight
  preference. Prefer candidates on that list.

## Steps

1. Edit `chat/models/<id>/model.json` in the repo: set `base_model_id` to the
   OpenRouter slug (e.g. `openrouter.<owner>/<model>`).
2. Vision handling (the recurring flip-flop, recorded for honesty): if the
   new model is vision-capable, set `meta.capabilities.vision: true` so OWUI
   routes image inputs; if not, `false`. Running without vision is a
   legitimate, cheaper posture we have used repeatedly; the prompt should not
   promise image understanding the model can't do. Update
   `chat/DESIGN.md` §2's model description in the same pass.
3. Push: `set -a && source ~/.tokens/owui/chat-bayleaf-dev && set +a && uvx
   owui-cli models update chat/models/<id>/model.json`
4. **[HUMAN GATE]** The user exercises the swapped model in prod: a real
   conversation, an image upload if vision is on, a tool call. Model quality
   judgment is not delegable.
5. Record: commit the model.json + DESIGN.md edit as
   `update: swap <model> to <slug>`.

## Verification

- `uvx owui-cli --json models show <id>` returns the new `base_model_id`.
- User confirms conversation quality (manual gate).

## Rollback

```bash
git checkout chat/models/<id>/model.json
uvx owui-cli models update chat/models/<id>/model.json
```

Instant and complete; this is why the repo file is edited first and pushed,
never hand-edited in the OWUI UI.

## Refinement log

- 2026-08-25: drafted from issue #65; never yet run as a playbook.
