# Brace3 GitHub Toolkit

Implementation of [issue #78](https://github.com/bayleaf-ucsc/bayleaf/issues/78).
**Deployed v0.2.0:** adds `github_list_repositories(owner, page, per_page)`
for public user/org discovery. Automatically detects account type; returns
names, descriptions, fork/archive flags, default branches and activity dates.
Listing requests are anonymous, still behind course authorization, and reject
unexpected private/internal visibility or mismatched owners. A username or
course organization in context is a navigation hint, not authenticated GitHub
identity. Thirty tests pass, including user/org pagination and visibility
checks; anonymous live reads succeeded for `rndmcnlly` and `bayleaf-ucsc`.
This follow-up was deployed on 2026-09-30 after Adam's approval. Source and
all eleven schemas matched readback; grants, credential valves and model
configuration were unchanged. Adam confirmed production playtesting works as
expected. Non-admin authorization and transcript export were not separately verified.

The v0.2.0 update also extends `github_get_repository` with `fork`,
`is_template`, and compact `provenance.parent`, `provenance.source`, and
`provenance.template_repository` summaries. Recorded public origins include
stable repo IDs, names and links; missing/null/non-public origins are
`state: unavailable` without leaking hidden metadata. Thirty local tests pass.
Live anonymous reads confirmed `rndmcnlly/cmpm-121-f25-d2` was generated from
`rndmcnlly/cmpm-121-f25-d1` (matching the latter's stable repo ID), and verified
a distinct fork-parent/network-root relationship for `cmpm-121-section-2`.

**Assignment support:** starting with a student's `owner/repo`, read repository
provenance and compare the recorded direct template with the assignment's
required public template. Read the expected repo to compare stable IDs when
needed. A matching origin supports the template-generation requirement; a
different recorded origin differs from that direct-origin requirement.
Unavailable metadata is inconclusive, not proof of noncompliance. Forking,
manual copying, and template generation are not interchangeable evidence.
An intermediate template can be inspected separately, but an indirect chain
does not automatically satisfy an assignment requiring the given direct
template. The link does not identify the exact starter revision, demonstrate
retained content, establish student identity, or grade assignment completion.

**Deployed and bound to `brace3-94741` on 2026-09-30.** Eleven named read-only tools cover public
repository discovery and metadata, commits, directories, text files, comparisons, Actions runs,
jobs/logs, and Pages evidence. No generic URL/API dispatcher or write tool.

## Authorization and credential setup

Before any GitHub request, the toolkit:

1. Takes the selected model ID from OWUI-injected `__metadata__.model` (falling
   back to `__model__` when absent, not when a different selection is present).
2. Rereads the active workspace-model record from OWUI, rather than trusting
   course metadata supplied in a request. Requires a base model, its own ID in
   `meta.toolIds`, and a string `meta.bayleaf_course_id`.
3. Requires membership in OWUI's existing `course:<id>` group, independently of
   model ownership, admin role, or tool read grants. Also requires model read
   access (or model ownership). There is deliberately no admin membership bypass.
4. Selects only that course's PAT from the admin valve
   `COURSE_GITHUB_CONFIG_JSON`. Unknown courses and malformed/missing
   credentials fail closed. No course or credential arguments enter tool schemas.
5. Reads repository metadata **anonymously** and requires `private: false`,
   `visibility: public`, and matching `full_name`. A broad replacement PAT cannot
   bypass that gate. Renamed repositories must be addressed by their new names.

Installed non-secret model metadata:

```json
{
  "bayleaf_course_id": "94741",
  "toolIds": ["brace3_canvas_toolkit", "brace3_github_toolkit"]
}
```

The toolkit additionally needs the course group's **tool read grant**, as
required by OWUI 0.11.4. This grant alone is insufficient: selecting the tool
on Basic or an unrelated course model does not select a credential. The local
`meta.json` intentionally has no grants or server-generated IDs/timestamps.

Admin valve shape (placeholder only):

```json
{"94741": {"token": "<public-read GitHub PAT>"}}
```

Use the least-privileged credential that covers the intended public endpoints.
A classic PAT with no scopes is a candidate, **not yet verified** for this
surface. The installed fine-grained PAT passed the endpoint checks below. Pages configuration
and Actions logs can be permission-limited even on a public repository. Do not
expand permissions merely to remove an unavailable field. Tokens belong only
in OWUI admin valves, never in prompts, model JSON, tool metadata, or git.

## Bounded reads and evidence

- List tools read one requested page, 1–100 items. Results include source API
  URLs and `has_next_page`; they never follow server-supplied pagination URLs.
- Branches/tags resolve to commit SHAs before history, file, or comparison
  reads. Use returned SHAs for subsequent pages/ranges. File links are pinned
  to commits, not moving branch names.
- Directory reads expose GitHub's 1000-entry, non-paginated Contents API cap.
- File reads accept UTF-8 text up to 1 MiB and return requested 1-based ranges
  of 1–500 lines, at most 60000 characters. Oversized selections fail explicitly.
- Commit changed files are paginated (GitHub's maximum: 3000). Compare files
  are available only on page 1, at most 300. Patches cap at 12000 characters
  each; missing/truncated patches are labeled.
- API and log downloads cap at 2 MiB per response, with 30-second request
  timeouts. Large responses fail rather than returning silently partial data.
- Log reads select 1–500 lines, cap output at 60000 characters with an explicit
  truncation flag, and strip ANSI escape sequences/control characters.
  Repository text and logs remain untrusted evidence, not instructions.
- Pages returns configuration, the latest legacy build, and five recent
  `github-pages` environment deployments with five statuses each. Continuation
  is reported; use returned API/source links for manual deeper investigation.
  Custom environment names are not searched. This is discoverable evidence,
  not an exhaustive deployment history or a fetch of the served website.

Repository reads are GETs to constructed `api.github.com/repos/owner/repo/...`
destinations. Repository discovery additionally constructs anonymous
`/users/<owner>` and `/users/<owner>/repos` or `/orgs/<owner>/repos` reads.
Ordinary redirects are refused. Job-log redirects allow only
HTTPS `productionresultssa*.blob.core.windows.net` destinations, with **no
Authorization header** and no further redirects. Signed download URLs are
never returned in tool results or failure messages. Other download hosts fail
closed and may need an evidence-backed allowlist update if GitHub changes its
infrastructure. Repository moves, rate limits, expired logs, and permission
limits are explicit failures, not invitations to invent content.

GitHub receives repository/ref/path queries and the course credential on
authenticated requests. These are direct GitHub API reads, not inference.
Retrieved content can enter Chat's stored conversation history; Chat's ZDR
boundary applies to inference, not that history or GitHub's own API handling.

## Verification

```bash
uv run --with aiohttp --with pydantic python -m unittest discover \
  -s chat/tools/brace3_github_toolkit -v
```

**2026-09-30:** 30 local tests passed. Tests cover course/model authorization,
private visibility with a broader credential, malformed configuration, URL/path
boundaries, explicit pagination, pinned file ranges, binary/size limits, log
redirect credential isolation, rate limits, partial Pages evidence, and parity
between eleven named methods and metadata schemas, account discovery, and
public-only template/fork provenance.

Live read-only checks used the operator's existing `gh` credential in memory,
not a new PAT or a production valve. Against `bayleaf-ucsc/bayleaf`, repository
metadata, commit pagination, `landing/` directory, a pinned README range,
Actions runs/jobs/log ranges, and Pages evidence succeeded. The Pages legacy
build reported an August revision while recent workflow deployment evidence
reported September 30: the tool keeps those claims separate. This does **not**
verify a no-scope PAT, real OWUI dispatch, or non-admin execution.

The live legacy Brace `GITHUB_API_TOKEN` valve was also checked without printing
or persisting its value. It exists, but GitHub returned **401** for credential
validation and repository/commits/Pages/Actions reads. It cannot currently be
reused. A replacement credential is needed; the course map does not require
a distinct PAT per course, though separate PATs permit independent revocation.

The replacement fine-grained PAT supplied for course 94741 was validated in
memory: GitHub `/user` returned 200, and public commit/file reads, Actions
runs/jobs/logs, Pages configuration, latest legacy build, deployments and statuses
all succeeded against `bayleaf-ucsc/bayleaf`. Its value was not written to the
repository. After Adam's approval it was installed in the production admin
valve for course 94741. Adam subsequently confirmed production playtesting works
as expected; non-admin authorization and transcript export were not separately verified.

Remaining acceptance work is:

- Verify the chosen public-read course PAT on representative repositories,
  including unavailable Pages metadata/logs and a private-repository rejection.
- Inspect the actual selected-model context in OWUI dispatch, then test a
  non-admin course member, unrelated course member/model, and missing config.
- Verify named calls in the Brace3 HTML transcript export, separately from
  the successful human conversation playtest and deployment readback.

### Production rollout

On 2026-09-30, created the toolkit, installed the course credential, added the
course group's tool-read grant, and appended the GitHub binding and
`bayleaf_course_id` to the live course model. Compared live model configuration
and image bytes with the repo before updating. Source readback matched exactly;
all ten generated schemas excluded reserved parameters; valve, grant, and model
binding readbacks passed. Existing model params, base model, avatar, Canvas
binding, filter, action, and model access principals were preserved.

The PAT expires 90 days after issuance, approximately **2026-12-29**, covering
Fall quarter. The exact expiry timestamp was not independently inspected.
Replace the course's admin-valve token before reuse after that date; expiry
fails closed. Do not fall back to the invalid legacy credential.

A model-mediated HTTP smoke test selected `github_get_repository` with the
correct repository argument. The bare completion endpoint returned the tool
call rather than an executed result, so this proves schema discovery/selection,
**not** tool execution or non-admin authorization. Adam's later production
playtest passed; transcript export and non-admin checks remain separate.

Rollback: remove only the GitHub binding and course metadata added in this run,
then revoke its course tool grant. Preserve Canvas and other settings. A private
pre-update model snapshot is in the session's approved temporary directory
under `brace3-github-rollout-20260930/model-before.json`. Leave the toolkit
unbound while diagnosing rather than deleting user conversations or broad state.
