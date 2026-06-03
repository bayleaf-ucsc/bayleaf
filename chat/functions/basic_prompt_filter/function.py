"""
title: Basic Prompt Filter
author: Adam Smith
description: Appends per-request system-prompt augmentations for the Basic model. Runs an ordered list of augmentors in inlet (server-side, no tool call); the first injects role-based suffixes keyed by OAuth group membership. Built to host future augmentors (e.g. concept-of-the-day). Attach to the Basic model. See issue #44 for the design rationale and v0.9.5 prompt-merge mechanics.
version: 0.1.0
"""

from open_webui.models.groups import Groups

# Keyed by OAuth group name (CILogon affiliation -> eduPerson; see DESIGN.md §1a).
# Inlined (not valves) because the role set is fixed; edit + redeploy to change.
# Iteration order is the concatenation order for multi-role users.
# NOTE: placeholder copy. Content pass per issue #44 comes later.
ROLE_SUFFIXES: dict[str, str] = {
    "Student@ucsc.edu": "## Role context: Student\n(placeholder) The user is a UC Santa Cruz student.",
    "Employee@ucsc.edu": "## Role context: Employee\n(placeholder) The user is a UC Santa Cruz employee.",
    "Faculty@ucsc.edu": "## Role context: Faculty\n(placeholder) The user is UC Santa Cruz faculty.",
}


# Augmentors: (user, metadata, group_names) -> str | None. Add future ones to AUGMENTORS.

def augment_roles(user, metadata, group_names) -> str | None:
    chunks = [text for name, text in ROLE_SUFFIXES.items() if name in group_names]
    return "\n\n".join(chunks) if chunks else None


AUGMENTORS = [
    augment_roles,
]


class Filter:

    async def inlet(self, body, __user__, __metadata__):
        # __user__["groups"] does not exist in v0.9.5; resolve via the model layer.
        groups = await Groups.get_groups_by_member_id(__user__["id"])
        group_names = {g.name for g in groups}

        chunks = [c for a in AUGMENTORS if (c := a(__user__, __metadata__, group_names))]
        if chunks:
            # Insert at index 0: the base prompt (params.system) is applied after
            # inlet and prepended onto messages[0], yielding "{base}\n{augmentation}".
            body.setdefault("messages", []).insert(
                0, {"role": "system", "content": "\n\n".join(chunks)}
            )
        return body
