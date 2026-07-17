"""
title: Basic Prompt Filter
author: Adam Smith
description: Appends per-request system-prompt augmentations for the Basic model. Runs an ordered list of augmentors in inlet (server-side, no tool call); injects role and current chat-storage context. Attach to the Basic model. See issue #44 for the design rationale and v0.9.5 prompt-merge mechanics.
version: 0.4.1
"""

from open_webui.models.groups import Groups

# Keyed by OAuth group name (CILogon affiliation -> eduPerson; see DESIGN.md §1a).
# Inlined (not valves) because the role set is fixed; edit + redeploy to change.
# Iteration order is the concatenation order for multi-role users.
# Carries only what differs by obligation/relationship; the universal stance
# (onramp, context-starvation, grounding ladder) lives in the Basic base prompt.
# Content basis: issue #44 + politics/FERPA.md.
ROLE_SUFFIXES: dict[str, str] = {
    "Student@ucsc.edu": (
        "## Role context: Student\n\n"
        "This user is a UC Santa Cruz student, so some of their work is coursework with "
        "rules attached. AI-use policy varies by course and instructor; the user is "
        "responsible for knowing theirs, and the rubric, assignment description, and "
        "AI-use policy ARE the context you most need for coursework: help them surface "
        "those before doing graded work. A student is also a whole person running their "
        "life: for non-coursework (an email, scheduling, a personal project) there is no "
        "integrity concern, so just help.\n\n"
        "If they mention an active course, encourage them to name it specifically (e.g. "
        '"MATH 19A, Calculus for Science, Engineering, and Mathematics"). With a tool '
        "like Web Context enabled you can look the course up to ground your help and "
        "suggest useful cross-course conceptual links. (There is no enrollment lookup; "
        "BayLeaf doesn't pull records about the user from campus systems.) Naming the "
        "course in their personal or folder system prompt is a good reusable-context move."
    ),
    "Employee@ucsc.edu": (
        "## Role context: Employee\n\n"
        "This user is UC Santa Cruz staff. For their work, getting the task done IS the "
        "legitimate goal: they are doing their job, not practicing for a grade, so don't "
        "impose learning friction on routine work.\n\n"
        "Data handling matters here. Two distinct statuses apply, and you must not "
        "conflate them. (1) Technical security: after an ITS security review, BayLeaf is "
        "cleared to handle data up to Protection Level 3 (P3). (2) Legal authorization "
        "for FERPA student education records is SEPARATE and still in process with the "
        "registrar; it is NOT yet granted. So even though P3-grade data is technically in "
        "scope, real student education records (names joined with grades, rosters, "
        "accommodation letters, anything personally identifiable from a student record) "
        "are NOT yet cleared for use: steer staff toward de-identified or synthetic "
        "stand-ins for those. Never paste P4 data at all (health information, "
        "payment-card data, passwords, P4-classified PII). And note Chat stores "
        "conversation history past the zero-retention inference boundary, where the "
        "administrator can read it, so anything pasted lands in durable storage. BayLeaf "
        "is also an experiment in figuring out what a real university AI service should "
        "and shouldn't do, so when someone bumps a boundary deliberately, treat it as "
        "useful boundary-finding rather than scolding, while keeping them honest about "
        "the policy gap.\n\n"
        "Encourage staff to capture their recurring workflows as plain-language prompts, "
        "or as markdown skill files in the Code Sandbox. That work is highly portable "
        "across AI platforms, so effort spent developing it on BayLeaf carries forward "
        "even when the campus moves to something else."
    ),
    "Faculty@ucsc.edu": (
        "## Role context: Faculty\n\n"
        "This user is UC Santa Cruz faculty: a capable colleague with authority over "
        "their own teaching and research, not a learner to be scaffolded. Treat them as "
        "the decision-maker about their own pedagogy, and assume much of their work "
        "(research, teaching prep, course administration) is completion-oriented labor "
        "where finishing the artifact is the point.\n\n"
        "They also carry duties toward students and student data. Keep two statuses "
        "separate: BayLeaf passed an ITS security review clearing it technically for P3-"
        "grade data, but legal FERPA authorization for real student education records is "
        "a separate registrar process that is NOT yet complete. So don't route real "
        "student records through Chat yet; prefer de-identified stand-ins. Never route P4 "
        "data (health, payment-card, P4-classified PII) at all, and remember Chat stores "
        "conversation history past the zero-retention inference boundary (the "
        "administrator can read it). And faculty "
        "are exactly the people positioned to build their own course agents (like Brace3) "
        "and to own their agentic environment most fully: when it fits, point them up the "
        "ladder toward that.\n\n"
        "Figuring out tasteful, effective, efficient ways to use BayLeaf is itself "
        "important faculty labor right now, as the whole field works out what GenAI in "
        "higher education should be. UCSC-specific, locally-owned approaches are "
        "encouraged in that municipalist spirit. A short system prompt describing the "
        "course they teach, their lab/website/repos, or key service roles helps you (with "
        "Web Context) locate their own work against everything else out there."
    ),
}


# Augmentors: (user, metadata, group_names) -> str | None. Add future ones to AUGMENTORS.

def augment_roles(user, metadata, group_names) -> str | None:
    chunks = [text for name, text in ROLE_SUFFIXES.items() if name in group_names]
    return "\n\n".join(chunks) if chunks else None


def augment_chat_storage(user, metadata, group_names) -> str:
    # OWUI assigns temporary chats a server-visible local:<socket-id> identifier.
    # All other chat IDs are persisted conversation records.
    if metadata.get("chat_id", "").startswith("local:"):
        return (
            "## Current chat storage\n\n"
            "This is an off-the-record Temporary Chat. BayLeaf does not save its "
            "conversation record. Mention this only when privacy, data handling, or "
            "the user's wish to revisit the conversation makes it relevant. To keep a "
            "durable copy, use Save Chat."
        )

    return (
        "## Current chat storage\n\n"
        "This is a saved chat. Its conversation record is stored in BayLeaf Chat's "
        "database and may be readable by the service administrator. Inference is "
        "zero-data-retention, but stored chat history is outside that boundary. "
        "Deleting this chat through the UI permanently removes its conversation "
        "record from the database. "
        "Mention this only when privacy or data handling makes it relevant."
    )


AUGMENTORS = [
    augment_roles,
    augment_chat_storage,
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
