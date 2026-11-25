"""
title: Authoring block filter
description: Removes model-driven workspace authoring tools from every chat, including admins' chats.
"""

# OWUI offers create_skill under the same builtinTools switch as view_skill, so
# skills: false would also break attached skills. Users without workspace
# permissions never receive these tools; this covers admins, who always do.
# The request hook runs after OWUI resolves builtin tools.

BLOCKED = {"create_skill": "builtin:create_skill", "create_tool": "builtin:create_tool"}


class Filter:
    def request(self, body: dict, __metadata__: dict = None) -> dict:
        resolved = (__metadata__ or {}).get("tools")
        if not isinstance(resolved, dict):
            return body
        # Match on tool_id so a toolkit method with the same name is untouched.
        removed = {
            name for name, tool_id in BLOCKED.items()
            if (resolved.get(name) or {}).get("tool_id") == tool_id
        }
        for name in removed:
            # Execution looks tools up here, so a guessed call fails too.
            del resolved[name]
        if removed and body.get("tools"):
            body["tools"] = [
                tool for tool in body["tools"]
                if (tool.get("function") or {}).get("name") not in removed
            ]
            if not body["tools"]:
                del body["tools"]
        return body
