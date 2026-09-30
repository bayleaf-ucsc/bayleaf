# Brace2 retirement

Retired from production and the current source tree on 2026-09-30 at Adam's
request. The old components were unbound; both functions were inactive and
non-global. Their production source matched the preserved Git source. ✨

| Retired component | Historical source | Replacement |
|---|---|---|
| `brace_toolkit` | [All-in-one Canvas, GitHub and Drive toolkit](https://github.com/bayleaf-ucsc/bayleaf/tree/65ba2f3/chat/tools/brace_toolkit) | Separate `brace3_canvas_toolkit`, `brace3_github_toolkit`, `brace3_drive_toolkit` |
| `brace_filter` | [Canvas prompt and tool-injection filter](https://github.com/bayleaf-ucsc/bayleaf/tree/65ba2f3/chat/functions/brace_filter) | `brace3_canvas_system_prompt_filter` plus explicit model tool bindings |
| `brace_submit_action` | [Conversation submission action](https://github.com/bayleaf-ucsc/bayleaf/tree/65ba2f3/chat/functions/brace_submit_action) | `brace3_submit_action` |

The linked revision preserves Python source and non-secret metadata. For example:

```sh
git show 65ba2f3:chat/tools/brace_toolkit/tool.py
```

A private operator recovery snapshot, including live source, metadata and valve
values, is stored at `~/.tokens/bayleaf-brace2-retirement-20260930/`. Credentials
are not in the public Git record. Current Brace3 has its own configured valves;
deleting the legacy rows did not revoke or change the credentials used by Brace3.

Verification: all four stored models had no legacy references, and surviving
function source had no legacy references. After deletion, all three IDs were
absent from production lists; Brace3's three toolkits, prompt filter and submit
action retained their metadata and valves; stored models were unchanged and
Chat health returned HTTP 200. Earlier playtest limitations remain documented
with each replacement.
