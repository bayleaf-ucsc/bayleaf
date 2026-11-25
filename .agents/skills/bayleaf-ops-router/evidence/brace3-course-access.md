# Run evidence: brace3-course-access

Dated record of past runs of [`brace3-course-access.md`](../playbooks/brace3-course-access.md), newest first unless noted.
Consult for diagnosis; current procedure lives in the linked file.

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
- 2026-09-25: A student-shared chat showed Brace using public web search, then
  asking for assignment text. OWUI 0.11.4's `get_tools()` dropped the bound
  Canvas toolkit because it had no tool grant. Scoped its URLs and pagination
  to course 94741, deployed the fix, then granted `course:94741` tool read
  access. The grant exposes the toolkit in course members' tool pickers on
  other models. Non-admin end-to-end playtest remains a human gate.

## Moved from the body

Original wording, verbatim, as it stood in the procedure.

Frontmatter status:

```text
status: First production run completed for CMPM 121, Fall 2026
```

Step 2, names previously optional:

```text
2. Accept a roster of student UCSC email addresses, optionally with names.
```

Recording step:

```text
Record group name/UUID, model ID, audience counts, verification
outcome, and surprises in this playbook without student PII.
```
