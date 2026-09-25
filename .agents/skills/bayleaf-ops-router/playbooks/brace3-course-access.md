---
source-skill: bayleaf-ops-router
description: Provision course roster access to an existing Brace3 workspace model on BayLeaf Chat.
status: First production run completed for CMPM 121, Fall 2026
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
   toolkit's URL allowlist does not check course ID, so Canvas token permissions
   are currently the only cross-course boundary.
2. Accept a roster of student UCSC email addresses, optionally with names.
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
   through `meta.toolIds`, has `brace3_canvas_system_prompt_filter` attached, and its underlying
   model is readable by the intended audience. Confirm both Canvas token
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

## Verification and handoff

- Compare the roster's unique emails to `GET /api/v1/users/all` and the group's
  exported `user_ids`; verify every intended person is a member. Check the
  model is active, has the group read grant, and that the underlying base-model
  chain permits non-admin inference. Seeing a model in a picker is not enough
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
outcome, and surprises in this playbook without student PII. If the model
configuration changed or exists only in production, run the separate
`backup-reconcile` workflow to capture it in `chat/models/`; do not assume a
roster provisioning run alone backs it up. Do not commit or push without the
user's explicit approval.

## Refinement log

- 2026-09-24: First run, CMPM 121 Fall 2026 (`94741`). The 84-address
  student-only roster was clean; 23 students already had accounts (27.4%),
  61 needed placeholders. A named export arrived after the first generic-name
  placeholder; its name was updated, and the other 60 used supplied full names.
  Both TAs already had accounts; instructor was also added for symmetry. Final
  `course:94741` group had 87 members, and the active `brace3-94741` model had
  its group read grant. No non-admin course-member inference was exercised in
  this run. Discovery: `users list` pages at 30, `/users/all` supports the
   census, and group add supports a batch. The model was not yet in the repo
   at provisioning time; it was pulled during the subsequent toolkit refactor.
   An email-only intake is workable,
   but a named roster avoids generic placeholder names.
- 2026-09-24: Follow-up split the toolkit's Canvas token into its own valve
  and bound it in the course model's `toolIds`; the Canvas prompt filter now only fetches
  the prompt. Verify both tokens and model binding on future course runs.
  This does not make the tool independently user-toggleable or constrain its
  URLs to the current course; those remain separate design decisions.
- 2026-09-25: Renamed the live filter to
  `brace3_canvas_system_prompt_filter` so its ID and display name describe its
  Canvas prompt-fetching role, independently of possible future Brace3 filters.
  `owui-cli functions deploy` failed on the new ID because OWUI returns 401,
  not 404, for an absent function. Use `POST /api/v1/functions/create`, copy the
  valve, activate, rebind and verify every model, then delete the old ID.
