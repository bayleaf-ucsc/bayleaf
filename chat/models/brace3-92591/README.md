# brace3-92591 — Brace (CMPM 120 Spring 2026)

Workspace model for <https://canvas.ucsc.edu/courses/92591/>.

## Status: Canvas API lockdown workaround (May 2026)

In response to the [2026 Canvas security incident](https://en.wikipedia.org/wiki/2026_Canvas_security_incident),
UCSC Canvas administrators revoked all existing API tokens and disabled
issuance of new ones. This broke the normal Brace3 architecture, which
depends on Canvas API access in two places:

1. `brace3_filter` (function) fetches the course-specific system prompt
   from a Canvas wiki page titled "Brace3 System Prompt" on every chat
   inlet, caching per session.
2. `brace3_canvas_toolkit` (force-injected by the filter) gives the
   model live read access to Canvas course data during the conversation.

Both fail closed without a valid Canvas API token.

### What changed

- `params.system` is now a hand-installed copy of the Canvas wiki page
  content (as of May 10, 2026), prefixed with a header marking it as
  manually installed during the lockdown.
- `meta.filterIds` was `["brace3_filter"]`, now `[]`. The filter would
  otherwise raise on every request.
- `meta.toolIds` is unchanged (`["gws_toolkit"]`). The Brace3 Canvas
  toolkit was filter-injected at runtime, never in the model's own
  list, so removing the filter implicitly removes that toolkit too.

The pre-lockdown config is preserved at `model.json.pre-canvas-lockdown-2026`.

### How to restore once Canvas API access returns

1. Re-issue a Canvas API token and update the `CANVAS_ACCESS_TOKEN`
   valve on `brace3_filter` (Functions → Valves in the OWUI admin UI,
   or `owui-cli functions valves-set-field brace3_filter CANVAS_ACCESS_TOKEN <token>`).
2. Restore the original config:

   ```bash
   set -a && source ~/.tokens/owui/chat-bayleaf-dev && set +a
   uvx owui-cli models update chat/models/brace3-92591/model.json.pre-canvas-lockdown-2026
   ```

3. Confirm the Canvas page <https://canvas.ucsc.edu/courses/92591/pages>
   still has a page titled exactly "Brace3 System Prompt". If the
   wiki content has drifted from the snapshot in `params.system` here,
   the live page is the source of truth going forward.
4. Once verified, replace this file's "Status" section with a brief
   note that the lockdown is over, and keep `.pre-canvas-lockdown-2026`
   around as historical record (or delete it once you're confident).

### Why this is in the repo

The deploy-first / commit-later workflow means the live OWUI instance
is normally ahead of the repo. We're committing this drift on purpose:
the disruption should be legible to future-us (and to other agents
working in this repo) so that the unusual config — a workspace model
with a giant inlined system prompt and no filter — doesn't read as a
mistake worth "cleaning up."
