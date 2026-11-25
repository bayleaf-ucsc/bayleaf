# Run evidence: backup-reconcile

Dated record of past runs of [`backup-reconcile.md`](../playbooks/backup-reconcile.md), newest first unless noted.
Consult for diagnosis; current procedure lives in the linked file.

- 2026-11-25 (OWUI v0.13.5): Full private pre/post pulls found only the intended
  builtin-tool keys and the new filter. Saving the model defaults form also wrote a
  hidden `video_generation: true`: diff the config after UI edits and ask. Known
  metadata drift was left alone; the instance `version_id` stays out of the repo.

- 2026-11-20 (OWUI v0.13.4): Refreshed an expired admin JWT before deployment.
  Private pre/post resources, hidden base, and admin valve JSON were unchanged.
  Six global config defaults appeared; the app spec changed only the Open
  WebUI image reference. Compare valve JSON rather than auxiliary log files.

- 2026-11-10 (OWUI v0.13.3): Refreshed complete private pre/post resources,
  hidden base, valves and app spec were byte-identical. Only 18 new global config
  keys and the unset admin chat-read limit appeared; no existing setting changed.
  New external scoring routes remain disabled. Known repo/live metadata and skill
  decorations were left untouched.

- 2026-11-04 (OWUI v0.13.0): Full private pre/post resource and valve pulls plus
  hidden-base reads found only `is_active=true` added to all nine tools. Synced
  that field without overwriting known unrelated metadata/decorative drift.
  Config/admin exports added comments off, notifications on and empty Mistral
  OCR params. Saved sub-agent limits survived; global config keys are flat dotted
  names. App spec and qualified served arrival assets were unchanged.

- 2026-10-27 (OWUI v0.12.4): Full private pre/post resources, hidden base model
  and app spec were unchanged. Global config/admin snapshots revealed only new
  inactive upstream defaults (empty LDAP fallback domain/UI visibility and lazy
  skills false). Kept known pre-existing metadata/decorative drift out of the
  coordinated upgrade backup; Lathe 1.3.3 source/valves remained exact.

- 2026-10-27 (Lathe 1.3.3): Full private pre/post pulls and a separate hidden-base
  read found only the expected Lathe source/schema delta. Synced generated Lathe
  artifacts only, retaining stable repo timestamps/grant IDs and leaving known
  Brace3 metadata/default drift and live skill decorations untouched.

- 2026-10-27: Full private pull (9 tools, 6 functions, 8 skills, 4 workspace
  models plus the hidden base) found only previously known metadata/default
  drift and decorative skill suffixes. Added private global config/admin reads
  to capture automations, compaction and model defaults, absent from resource
  backups. Initial `/var` exports were refused; canonical `/private/var` paths
  succeeded. Recorded reviewed current settings without inventing a baseline.

- 2026-10-21: Full private pre/post Lathe 1.1.0 pulls found only its source/schema
  changes before the companion skill update. Kept unrelated working-tree edits
  untouched and retained pre-existing decorative live skill suffixes during the
  surgical guidance update rather than silently discarding them.

- 2026-10-18: Post-v0.12.3 recovery pull captured all four resource types after
  token renewal; no fresh pre-upgrade API pull was possible during the outage.
  Tool/function sources and normalized tool schemas matched the repo; model
  differences were null voice defaults and known Brace3 metadata drift. Three
  decorative additions in live Code Sandbox skill text were left untouched
  pending confirmation. Hidden base-model activity, visibility and public read
  grant were verified separately.

- 2026-10-12: Lathe 0.32.0 full private before/after pulls found only its
  source/schema changes. Synced those artifacts only, verified the hidden Basic
  base model separately, and kept migration version IDs private. No unrelated
  resource definitions or user/group/chat data entered the public backup.

- 2026-10-12: Full private pre/post-v0.12.0 pulls found only migration-assigned
  version-history IDs, with content, grants and images unchanged. Retained the
  IDs in private snapshots, not portable repo definitions. Known pre-existing
  Brace3 metadata differences were left outside the upgrade; the hidden base
  model was separately verified active, hidden and wildcard-user readable.

- 2026-10-11: Pulled all four public-backup resource types privately after Adam's
  Lathe 0.31.2 deployment; synced only its source/metadata and documentation.
  Live source matched upstream `74b42c2` exactly. Unrelated Brace3 metadata
  differences were schema ordering/formatting and expanded server metadata,
  not source changes, and were left outside this focused reconciliation.

- 2026-09-25: Recovery pull after Brace3 course provisioning ran all four
  resources into a private temp directory because the repo had in-progress
  edits. No roster emails, student IDs, Canvas token, group exports, or chat
  exports entered the candidate backup. `models pull-all` omitted the hidden
  GLM base record even though `models show` found it active with public read;
  added a separate base-model check rather than deleting the repo record.
  Remaining differences were rotating metadata, a dropped Lathe
  `content_length`, and two optional-null schema defaults on the inactive
  Brace v2 toolkit: no substantive prod drift.
- 2026-09-18: The Lathe 0.28.0 full pull produced only the expected source/schema
  delta plus rotating model and skill timestamps/grant IDs. Removing SSH also
  required reconciling stale guidance in DESIGN.md, RETENTION.md, and the live
  Code Sandbox skill, not just vendoring the upstream tool.
- 2026-09-17: A long feature session had an intentionally dirty API tree, so full
  before/after pulls went to a private snapshot directory first. Review found only
  the intended Lathe/skill changes and old model timestamp/grant-ID noise. Full
  repo pulls followed; model noise was restored without discarding unrelated work.

- 2026-08-25: promoted from a live run (commit `05d9d85`): offramp skill
  rollout captured, lathe v0.24.1, activation flips confirmed deliberate,
  whole_document_retrieval id drift resolved, DESIGN.md six-spot stale
  claims fixed. Status set stable on the strength of one complete run.
- 2026-09-01: post-OWUI-v0.11.3 pull was limited to a new null `meta.knowledge`
  field and the Canary's live null avatar reference; rotating grant IDs and
  timestamps were stripped as noise. No resource ID drift found.
- 2026-09-16: (issue #67 root cause) the "live null avatar reference" from
  2026-09-01 turned out to be the actual bug: OWUI v0.11.x rejects bare
  filenames as `profile_image_url` and nulls them, *and* strips the field from
  all list/read responses (icons moved to `GET /model/profile/image`), so
  pulled model.json can report a null field instead of a `data:` URI — "no
  output from extract" no longer distinguishes broken from stripped. Push-side
  sibling inlining added in owui-cli ≥ 0.5.2; prod icons re-pushed and verified
  bytewise via the image endpoint.

## Moved from the playbook body

```text
`spinoff-module-bump.md`. Also run standalone whenever prod might have
drifted (the 2026-08-25 run found a week of accumulated drift in one pull).
```

```text
   surfaces, and the §8 directory tree. Six spots were stale in the
   2026-08-25 run; expect a similar count after any active month.
```

```text
The 2026-08-25 run found `whole_document_retrieval_toolkit/` (repo dir,
hand-named) vs live id `whole_document_retrieval` — identical source,
mismatched id, undetectable until a full pull-all wrote meta.json for both.
This is the backup-direction twin
```
