---
source-skill: bayleaf-ops-router
description: Change the privacy notice, subprocessor list, or retention policy; notify active users on both Chat and API.
status: rough
last-reviewed: 2026-09-16
---

# Privacy Notice Change

## When to use

Any material change to `PRIVACY.md` (repo root), the subprocessor list, retention
policy (`chat/RETENTION.md`, `api/RETENTION.md`), or the data-posture claims.
These affect both Chat and API even when the trigger is one service.

Not for: routine docs edits that don't touch claims about data handling.
Terminology-only edits and corrections that make the documentation match
existing behavior use the normal docs workflow and do not require user notice.

## Prerequisites

- Root `AGENTS.md` "Data posture" section: ZDR everywhere, ZOA where
  practical; Chat is ZDR at inference only, API is the ZOA target. Wording
  must claim the posture, never overclaim (e.g. never "full ZOA", never
  "Chat is private from the administrator").
- Since 2026-09-16 the notice is GitHub-served markdown (`PRIVACY.md`): push
  to `main` publishes it at the GitHub blob URL immediately. **Commit is
  still publish.** The landing page (`landing/index.html`, deployed by
  GitHub Pages on the same push) is the only bayleaf.dev HTML surface.

## Steps

1. Draft the change in `PRIVACY.md` (repo root). If a subprocessor is added or
   removed, update the subprocessor list in the same revision. Cross-check
   every claim against the current architecture; cite the source of truth
   (the AGENTS.md files) in the commit message. The landing page links to the
   notice by absolute GitHub URL, so a rename would also touch
   `landing/index.html`.
2. **Accessibility gate:** changes to markdown files are exempt from the
   `politics/VPAT-pages.md` re-measurement (GitHub's markdown pipeline
   renders them, and that surface is covered by GitHub's own ACRs; see
   VPAT-pages.md §2). Changes to `landing/index.html` or
   `landing/style.css` still require the ACR pass.
3. Show the user the diff and get approval (publishing to `bayleaf.dev` is
   immediate and public on push; the usual deploy-first-commit-later
   relaxation does not apply).
4. Commit and push when approved: `docs: update privacy notice` (single
   revision: page + ACR + any RETENTION.md changes).
5. **Notify active users when the change meaningfully affects existing data.**
   Both populations:
   - **Chat:** users active within the retention window. Enumerate with
     `owui-cli users list` (paginated, 30/page) or a DB query for
     `last_active_at` after the cutoff; collect emails.
   - **API:** keyed users by email from the D1 `user_keys` table.
   - Send from the operator's email (amsmith@ucsc.edu), BCC, plain text,
     what changed, where to read it, what it means for them.
   **[HUMAN GATE]** The user drafts or approves the notice text; tone here is
   political communication, not boilerplate.
6. Offer the blog post. A privacy change is usually motivated by something
   worth writing down (see `blog/`, gitignored, unpublished drafts). The
   user decides whether this one gets the longer treatment.

## Verification

- After push, fetch
  `https://github.com/bayleaf-ucsc/bayleaf/blob/main/PRIVACY.md` and confirm
  the change is live.
- VPAT-pages.md contains the re-measured claims.
- User confirms notifications went out.

## Rollback

Revert the commit and push. Already-sent notifications cannot be unsent;
this is why step 3's approval gate precedes both publishing and notifying.

## Refinement log

- 2026-08-25: drafted from issue #65; the notification mechanics (exact
  queries for active users) are untested sketches.
- 2026-09-03: a terminology revision also corrected documentation of existing
  Sealed metadata visibility. No data handling changed, so user notification
  would have contradicted the public notice's material-change threshold; scope
  and step 5 now use that threshold explicitly.
- 2026-09-16: notice migrated from `docs/privacy.html` to root `PRIVACY.md`
  (GitHub-served markdown). Section 602.3 ACR weight moves off BayLeaf pages;
  `landing/` replaced `docs/` as the Pages source. Steps updated blindly,
  never yet guided a run.
