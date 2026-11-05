# Checkpoint: local-first authoring prototype

A deliberately small writing workbench: Milkdown edits Markdown, isomorphic-git
records checkpoints, LightningFS persists the repository in IndexedDB, and BayLeaf
provides optional criticism through temporary inference tokens. No BayLeaf server
changes, repository host, CI runner, analytics, or document backend.

## Try it

```sh
cd api/examples/checkpoint
npm ci
npm run dev
```

Open **http://127.0.0.1:5174/**. Keep using that exact origin: changing between
`localhost` and `127.0.0.1`, or changing ports, opens different browser storage.

1. Write a draft. Use **Feedback policy** to author the critic's instructions.
   The initial policy is only a starting point, not an enforced instructor policy.
2. Optionally open **Critic**, click **Use recommended**, then **Connect BayLeaf**. This redirects
   to BayLeaf for explicit consent, using its existing S256 PKCE grant protocol.
   No ordinary API key is requested by this app. The grant uses the visitor's
   allowance, not a teacher-funded course account.
3. **Save checkpoint** makes a real local Git commit containing both documents.
   When connected it also requests feedback, using the committed policy, draft,
   parent draft, and checkpoint note. It does not send the whole repository.
4. Browse checkpoint history. Feedback is rendered as read-only Markdown.
   Exact request messages remain in exports, not in the reading interface.
   Re-reviewing retains earlier attempts. Each review can be deleted separately
   after confirmation, without changing its checkpoint. Deletion affects this
   browser workspace, not previously exported copies. Copying an earlier draft into the
   editor changes the working draft only, leaving the policy and history intact.
5. **Export workspace** frequently. Import restores drafts, policies, complete Git
   files, and reviews in a new browser workspace. It retains the old database but
   does not currently provide a workspace switcher. Export the current workspace
   before importing if you want an easily accessible copy of both.

The grant callback works on localhost without registration or a tunnel. The
protocol example at `../grants/index.html` and contract at `../../GRANTS.md` own the
underlying authorization behavior. A reload deliberately forgets the token.
Reconnect to request more feedback. Disconnect forgets the token locally;
server-side revocation is available on the BayLeaf dashboard.

## Storage and privacy boundaries

- Editing and checkpointing need no network after the application has loaded.
  This is **not an offline-installable PWA**: offline page reloads are not promised.
- A successful save awaits LightningFS's explicit filesystem flush, including its
  otherwise-debounced directory metadata. Browser storage still is not a backup.
  Eviction, clearing site data, private browsing, or device loss can erase it.
- One tab can write at a time, guarded by Web Locks. HTTPS or loopback HTTP and a
  modern browser are required. No real-time collaboration or cross-device sync.
- Documents, review prompts, and responses remain on the device and in exports.
  Only the selected review context transits BayLeaf and its approved ZDR inference
  provider on a review request. This prototype uses standard inference, not Sealed.
- The bearer token stays in tab memory and is not written to Git, IndexedDB,
  exports, or logs. PKCE verifier/state temporarily use sessionStorage during the
  redirect. No third-party scripts or fonts load at runtime. The CSP blocks remote
  images in pasted/imported Markdown. Review Markdown disables raw HTML and images,
  rejects executable link schemes, and opens links with noopener/noreferrer.
- The app host can change its JavaScript and therefore potentially read local
  content or the active token. Local-first is not a zero-operator-access guarantee.
- A checkpoint is an editable working record, not authenticated evidence of
  effort, authorship, or learning. Nothing is automatically shared with a teacher.

## Implementation

- `src/main.js`: UI, serialized writes, autosave, commit/review lifecycle, archives.
- `src/workspace.js`: actual Git operations, snapshots, archive validation, and
  review-context construction. Review sidecars live outside the Git working tree,
  keyed by commit ID, so feedback cannot recursively trigger document commits.
- `src/auth.js`: browser grant handoff and one non-streaming chat completion.
- `src/style.css`: local workbench styling over Milkdown Crepe.

The editor exposes ordinary formatting but not arbitrary execution. The underlying
documents remain Markdown. No claim of academic citation-manager integration,
DOCX fidelity, or full accessibility qualification: test these with the intended
writers before using this for coursework. Footnotes and rich scholarly apparatus
are not implemented as first-class features in this prototype.

There is one workspace/document pair in the interface. The history viewer shows
the current and previous texts rather than a word-level diff. Reviews time out
after two minutes, are bound to their original checkpoint, and never overwrite
the current draft. Failed/interrupted attempts remain visible and can be retried.
If a tab closes mid-request, a pending sidecar does not imply the provider stopped.
There is no background agent or service worker to finish requests after closing.

Archives are prototype JSON containers with base64-encoded files, including the
actual `.git` directory, not a new version-control format. They have a 40 MB import
limit and path validation; import only archives you trust. They are neither
encrypted nor signed. You can extract `/workspace` to disk and inspect it with
ordinary Git. The UI never configures or contacts a Git remote.

## Checks

```sh
npm test
npx playwright install chromium # once, if Chromium is not installed
npm run test:browser
npm run build
```

Unit tests use memfs but real Git objects. Browser tests exercise IndexedDB,
history, export/import, tab exclusion, a phone-sized layout, and mocked BayLeaf
consent and inference. They do not authorize a real account or spend real credit.
The live consent/inference path still needs human qualification via Connect BayLeaf.

`npm run build` produces `dist/` for a static HTTPS host. Nothing is published by
this prototype. The Vite dev server is bound to loopback only. Milkdown Crepe adds
a substantial editor bundle, acceptable for this first proof of concept.

The KaTeX override in `package.json` keeps Crepe's transitive math dependencies on
the patched 0.18.2+ line (GHSA-238p-pmpm-9mq7), even though math editing is disabled.
