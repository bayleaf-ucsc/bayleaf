---
source-skill: bayleaf-ops-router
description: Provision course roster access to an existing Brace3 workspace model on BayLeaf Chat.
status: practiced for provisioning; end-to-end non-admin course use untested
last-reviewed: 2026-09-24
---

# Brace3 Course Access

## Trigger and boundary

An instructor wants students, TAs, and themselves to see an **existing**
`brace3-<Canvas course ID>` model. This playbook provisions accounts, a
`course:<Canvas course ID>` group, and a group read grant. It does not create or
configure the model, its Canvas prompt, the filter, or its Canvas credentials.
Read `chat/AGENTS.md` and `chat/DESIGN.md` §§1a–1b and 2 first. Use
`owui-admin-tool` for the BayLeaf Chat admin API.

## Intake and authority gates

1. **[HUMAN GATE]** Confirm the course ID, term, instructor authorization, and
   intended audience. For someone else's course, an instructor-provided roster
   is authorization to provision *those addresses*, not authorization to use
   Adam's Canvas token to read that course. Confirm a legitimate Canvas access
   arrangement and who controls the course-specific prompt before exposing the
   model. The filter and toolkit currently use separate copies of Adam's Canvas
   token; do not assume either should read another instructor's course. The
   Fall 2026 toolkit is pinned to course 94741 in code; a new course needs its
   own course-scoped boundary and credential ownership review before granting
   access. Do not reuse that toolkit's instructor token across courses.
2. Accept a roster of student UCSC email addresses, preferably with names.
   Ask separately about TAs, other staff, and the instructor: a student-only
   Canvas export omits them. Keep roster files outside this public repository;
   never print or commit student identifiers, names, bearer tokens, or a roster.
   For email-only rosters, `users add` requires a display name: agree on a
   temporary generic name, which CILogon replaces on first login. If names
   are supplied, use the supplied full name. Do not fabricate first/last names
   from email local parts.
3. Normalize emails for matching (trim and lowercase), validate the expected
   `@ucsc.edu` domain and course ID, reject blanks and duplicates, and compare
   named and email-only exports if both exist. Confirm the roster's origin and
   date with the instructor. Do not silently treat a missing person as a drop:
   removal needs a separate instructor decision.

## Provision

1. Source `~/.tokens/owui/chat-bayleaf-dev` with `set -a`, and verify the target
   is `https://chat.bayleaf.dev`. Read the live model, group list, and user
   list. `uvx owui-cli --json users list` returns only the first page (30);
   use the authenticated `GET /api/v1/users/all` for an exact-email census,
   or page explicitly. Report **aggregate** existing/new counts to the
   instructor. Check that the model is active, binds `brace3_canvas_toolkit`
   through `meta.toolIds`, has `brace3_canvas_system_prompt_filter` attached,
   and its underlying model is readable by the intended audience. Check the
   toolkit's own course-group read grant: model binding alone does not pass
   OWUI 0.11.4's `get_tools()` access check. Confirm both Canvas token
   valves are configured without displaying them. Do not overwrite other grants.
2. Create or reuse `course:<id>` using `uvx owui-cli groups create`. The
   `course:*` namespace is protected from OAuth group reconciliation by
   `OAUTH_BLOCKED_GROUPS`. If an existing group has that name, reuse its UUID
   and inspect its existing membership before modifying it.
3. For each address without an exact-email OWUI account, create a placeholder
   with `uvx owui-cli users add <email> <display-name>`. Exit code 2 means the
   user already exists: re-fetch and use that account, do not try to create a
   duplicate. Leave pre-existing accounts' names and settings alone. The
   placeholder's email must match CILogon's email claim for first-login merge;
   `OAUTH_UPDATE_NAME_ON_LOGIN=true` supplies their later display name.
4. Add all resolved user IDs to the course group. The admin endpoint
   `POST /api/v1/groups/id/<uuid>/users/add` accepts
   `{"user_ids": ["..."]}` for a batch; `owui-cli groups add-user` handles
   individuals. Inspect the group export before and after, and add only missing
   IDs. Include instructor/TAs as explicitly requested, not by guessing from
   student enrollment.
5. Add a **group** read grant for `brace3-<id>`, never 80-plus individual model
   grants. `POST /api/v1/models/model/access/update` expects
   `{"id":"brace3-<id>","access_grants":[...]}` and **replaces all existing
   grants**. Read `GET /api/v1/models/model?id=brace3-<id>` immediately before
   writing, preserve its existing grants, append only
   `{"principal_type":"group","principal_id":"<group-uuid>","permission":"read"}`,
   and then re-read to verify. This access-only endpoint avoids overwriting
   the model configuration or its inlined profile image. It is also safe to
   grant before adding members, provided the final checks cover both.
6. Grant the same group **tool read** access on a toolkit scoped to this
   course. `POST /api/v1/tools/id/<tool-id>/access/update` replaces all grants:
   preserve existing grants, append the group grant, then read back. This
   makes the toolkit selectable on other models, so first restrict its URL
   and pagination allowlist to this course and exclude sensitive routes and
   redirects. Never grant access to an unscoped instructor credential.

## Verification and handoff

- Compare the roster's unique emails to `GET /api/v1/users/all` and the group's
  exported `user_ids`; verify every intended person is a member. Check the
  model is active, both model and toolkit have group read grants, and the
  underlying base-model chain permits non-admin inference. Seeing a model in a picker is not enough
  to prove inference works on OWUI 0.11.3.
- **[HUMAN GATE]** Have an authorized non-admin course member sign in via
  CILogon and make a fresh-chat request. Verify Brace loads its course prompt
  and Canvas tools against the intended course. Do not impersonate a student
  or inspect their chats as a shortcut. Until this check passes, report access
  provisioning complete but end-to-end course use unverified.
- Tell the instructor the aggregate existing/new counts and the procedure for
  late adds. Re-run matching/provisioning for additions. Drops and course end
  require an explicit access-removal policy; never delete accounts just because
  they left the roster, since an account may hold unrelated chats or grants.

## Reversal and recording

To withdraw this course's access, first decide whether to remove the group
grant (everyone) or selected group memberships (individuals). Read-modify-write
the grant list, preserving unrelated grants; do not delete user accounts or
other groups. Record group name/UUID, model ID, audience counts, verification
outcome, and surprises as run evidence, without student PII. If the model
configuration changed or exists only in production, run the separate
`backup-reconcile` workflow to capture it in `chat/models/`; do not assume a
roster provisioning run alone backs it up. Do not commit or push without the
user's explicit approval.
