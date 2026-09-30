# Brace3 Drive Toolkit

Local implementation for [issue #79](https://github.com/bayleaf-ucsc/bayleaf/issues/79).
Deployed as v0.1.2 and bound to `brace3-94741`, with course-group tool read access.

## Tool surface

| Tool | Result |
|---|---|
| `gdrive_read_document` | Markdown text projection of Docs, including nested tabs, tables, links, footnotes and image/alt-text markers |
| `gdrive_read_sheet` | Tab inventory, or displayed cell values from a tab-qualified A1 rectangle |
| `gdrive_read_slides` | Slide text, speaker notes and visual-object markers |
| `gdrive_list_folder` | One page of direct children |
| `gdrive_search` | Full-text search restricted to a required folder's direct children |
| `gdrive_get_sharing_identity` | Course service-account email and sharing requirements |
| `gdrive_view_image` | Explicit unsupported failure |

All readers accept file IDs or ordinary Google links. Links are parsed into IDs;
the toolkit fetches only constructed Google API URLs. Link resource keys are
preserved in requests through `X-Goog-Drive-Resource-Keys`. Folder results include
child resource keys and shortcut targets when Google supplies them. A shortcut
must be resolved explicitly using its target ID/key, not treated as a document.
No binary download/export or write operation is exposed.

## Compact output and continuation

- Docs use the structured Docs API rather than a Markdown export containing
  inline data URLs. Only text and image identifiers/alt text enter the projection;
  embedded-object download URLs and image bytes are not returned.
- Docs and Slides default to 8,000 characters per result, at most 16,000.
  Continue at `next_offset`, passing the returned `version`. For Slides, finish
  the current slide range before advancing to `next_slide` and resetting offset.
  Version checks detect edits between reads; reads are not atomic snapshots.
- Sheets first lists tabs when `cell_range` is empty. Then request a range such
  as `'Second tab'!A1:Z50`, at most 2,000 cells. Results over 16,000 characters
  fail explicitly and ask for a smaller range. Values are Google-formatted
  strings; trailing empty cells/rows are omitted. This avoids the legacy CSV
  export's first-tab-only limitation.
- Folder/search pages default to 30 entries, at most 100, with explicit
  `next_page_token` and `incomplete_search`. Even an empty page can have a next
  token. Listing output above 16,000 characters asks for a smaller page.
- API responses are bounded to 8 MiB. Large Docs/Slides fail before rendering;
  reducing output size does not reduce their initial API download.

Markdown is a text projection, not a layout-preserving conversion. Docs excludes
unaccepted suggestions; list glyphs are normalized, and merged-cell layout is not
reconstructed. Slides element order is not spatial reading order; inherited
master/layout content is not expanded. Sheets charts/images are not read.

Vision is deliberately a stub in this version, per Adam's revised scope. OWUI's
unprefixed `data:image/...` transport is established by Lathe, but implementing
bounded image retrieval, stable document-object references and provider-level
verification would enlarge this first pass. The stub says the agent cannot
perceive visual content; it does not present alt text as visual observation.

## Authorization and setup

The admin-only `GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_JSON` valve contains the complete
Google-generated JSON key for one global Brace service account. Keep
credentials in admin valves, never model JSON, UserValves or git.

1. Enable **Drive, Docs, Sheets and Slides APIs** in the key's Cloud project.
2. Share intended materials with the service-account email as **Viewer**, or use
   anyone-with-link access where permitted. Keep resource keys in supplied links.
3. Set the shared service-account key in the toolkit's admin valve.
4. Bind `brace3_drive_toolkit` explicitly in the workspace model's `meta.toolIds`;
   set its `meta.bayleaf_course_id` to the course's string ID.
5. Grant the corresponding course group tool read access, then verify execution
   with a non-admin course member.

Every tool rereads the stored model and checks active workspace-model status,
explicit binding, course membership and model read access. Admins do not bypass
course membership. Agent arguments cannot select a credential/course. All
authorized Brace courses intentionally read the same shared Drive library:
Google permissions on the global service account define the resource boundary,
not course membership. Folder search is a navigation aid, not course isolation.
Search requires a nonempty folder to reduce bulk discovery of the shared library.
There is no global-search mode or built-in recursion; agents can visit subfolders
explicitly through separate list/search calls when needed.
This revises issue #79's original per-course credential design at Adam's request.

Short-lived tokens are minted using RS256 and `drive.readonly`, with a fixed
Google token endpoint and no delegated subject. Tokens live only for the tool
call, with no new persistent credential/content caches. Retrieved content can
persist in OWUI chat history and exported transcripts. BayLeaf's ZDR promise is
at the inference layer, not a promise to discard chat history.

### UCSC-domain sharing investigation

A service account is an application identity, not a UCSC Workspace user.
[Google's service-account documentation](https://developers.google.com/identity/protocols/oauth2/service-account)
distinguishes this from user authorization and domain-wide delegation.
This implementation does not request or support delegation.

A dedicated, provisioned UCSC Google user could instead authorize the app through
[OAuth user consent with offline access](https://developers.google.com/identity/protocols/oauth2/web-server).
That needs a permitted OAuth client, registered redirect flow, consent to the
read-only scope and protected refresh-token storage, with reauthorization when
revoked/expired. Campus policy can block requested scopes (`admin_policy_enforced`).
[UCSC's Workspace service page](https://its.ucsc.edu/google/drive/) documents
CruzID access but does not establish permission to provision a Brace account or
approve this OAuth client. Institutional feasibility remains unverified; an
email alias alone does not establish a Google user identity. OAuth refresh-token
credentials are not implemented here. The supported baseline is explicitly
shared or link-shared files through a service account.

## Verification

```sh
uv run --with aiohttp --with pydantic --with 'PyJWT[crypto]' python -m unittest discover -s chat/tools/brace3_drive_toolkit
```

2026-09-30: 23 offline tests pass, covering course authorization, shared global
identity, resource keys, bounded output, continuation, tab/range handling,
document/slides fixtures, image-URL exclusion, redirect refusal and the vision
stub. The existing legacy Brace credential successfully minted a token and
called Drive `about` read-only. No credential was copied to this directory and
the initial checks changed no production configuration. The supplied UCSC-domain-shared Slides
fixture returned Drive 404 and Slides permission-denied after the Slides API was
enabled, confirming that this service account lacks access to that fixture.

Still needed: live fixture reads for Docs with embedded images/tabs, a multi-tab
Sheet, Slides with notes, a folder, anyone-with-link access, explicit shares and
inaccessible resources. Resource-key behavior across the editor APIs also needs
live evidence. Non-admin course and unauthorized-course execution checks,
model-mediated calls, and transcript inspection remain pending. Offline
fixtures and token authentication do not establish those acceptance results.

Deployment on 2026-09-30 was explicitly approved. Live source and seven generated
schemas match the local toolkit; the global key matches the legacy Brace valve.
Course-94741 tool read access and the model binding were read back, preserving
the existing Canvas/GitHub bindings and model prompt. The credential was copied
in memory, not saved to the repository. Human playtesting remains pending.

Production playtesting exposed a search defect: Google returns 403 when a
`fullText` query includes `orderBy`. Version 0.1.1 sorts folder listings only;
search uses Google's relevance order. It also distinguishes query/API-disabled
403s from unknown denials rather than diagnosing every 403 as a sharing problem.
The reported folder search for `notes` now succeeds against Google, returning
two Docs with no continuation or incomplete-search flag. Twenty-four offline
tests pass; deployed source readback matches, with unchanged schemas, grants,
valves and model configuration. The corrected model-mediated retry is pending.

Version 0.1.2 makes `folder` required in the search schema and rejects empty
folder values before network access. Twenty-five offline tests pass. Live source
and all seven schemas match; valves, grants and model configuration are unchanged.
