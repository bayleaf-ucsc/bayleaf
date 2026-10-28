# BayLeaf Pouch (proof of concept)

Issue [#120](https://github.com/bayleaf-ucsc/bayleaf/issues/120). A single HTML file
that chats through the API's Sealed lane and keeps conversations only in the browser.

The name comes from the diplomatic pouch, which a host state carries but may not open
(Vienna Convention on Diplomatic Relations, art. 27). Here BayLeaf, and through it the
university, is the host that carries the pouch. The analogy breaks in one instructive
place: a diplomatic pouch is protected by law, which a state can break; this one is
protected by encryption, which BayLeaf cannot open.

```bash
cd pouch && npm ci && node build.mjs   # writes dist/pouch.html and prints its SHA-256
python3 -m http.server 8742 --directory dist   # or save the file and open it from disk
```

Edit `pouch.html`. `build.mjs` inlines the Tinfoil SDK pinned by `package-lock.json`
and stamps the Content-Security-Policy with the hash of each inline script.

## Stance: no BayLeaf-controlled component holds plaintext

Each BayLeaf surface leaves the operator a different set of capabilities:

| Operator capability | Chat | Sandbox agents | Pouch |
|---|---|---|---|
| Read stored conversations | yes (database) | yes (VM access) | no: IndexedDB on your device |
| Read content in flight | posture only | posture only | no: EHBP ciphertext to an attested enclave |
| Ship code that leaks | n/a | n/a | only visibly, if you run a hash-checked copy |

The third row decides everything. In a web app, whoever serves the code can make
it skip verification or post your prompts elsewhere, which would void the other two
rows. Pouch's answer is publicly logged delivery rather than prevention:
run a copy whose SHA-256 matches a public, tagged release, and any malicious build
would have to be published to reach you. This mirrors how Tinfoil earns trust in its
enclave: the code is in a transparency log, not taken on promise. It also means Pouch
releases cannot follow the repo's usual "deploy first, commit later" practice.

## What the page enforces

- **One network peer.** `connect-src https://api.bayleaf.dev`. Attestation verification
  succeeds under this policy because the relay's `/sealed/attestation` bundle carries
  the whole trust root (verified 2026-10-27, tinfoil 1.3.0).
- **Only its own scripts.** `script-src` lists two SHA-256 hashes, so an injection cannot run.
- **No HTML from models.** Replies render as `textContent`, so a reply cannot inject
  markup into the page that holds your key.
- **Fail closed.** If attestation fails, Send stays disabled. No plaintext fallback exists.

## What it does not protect

- **Metadata.** BayLeaf sees caller identity (key, or IP under Campus Pass), timing,
  sizes, request counts and which model ran.
- **The device.** IndexedDB is not encrypted. Extensions and anyone else using the
  browser profile can read your history and key.
- **The key, while you are there.** Pouch holds a full `sk-bayleaf-` key on purpose: it is
  a client for all of BayLeaf, not only Sealed inference. On a borrowed computer, anything
  that can read the page can copy that key during the session. Ephemeral storage limits
  what persists afterward, not what is exposed during use. If you suspect the key was
  copied, rotate it from the dashboard. Until users can hold more than one key, rotating
  also cuts off your other clients. Narrower credentials are a separate API concern, not
  a Pouch one. Campus Pass needs no key at all, but works only on campus.
- **Which actions are sealed.** Only Sealed inference is encrypted from BayLeaf. Other API
  services Pouch may grow into (web search and fetch, Sandboxes, Inboxes) are plaintext to
  BayLeaf under its ordinary no-logging posture. The UI must mark which actions stay inside
  the pouch and which ones leave it. Tinfoil's tool-like catalog entries stay hidden until
  their data paths are reviewed.

## PoC findings

- Browser Sealed was blocked by CORS. `api/src/index.ts` now gives `/sealed/*` its own
  policy that reflects requested headers (EHBP plus the OpenAI SDK's `x-stainless-*`) and
  exposes `Ehbp-Response-Nonce`. That is safe because the origin is `*` without credentials
  and `sealed.ts` forwards only an allowlist upstream.
- The bundled SDK is about 640 KiB minified. Its verifier has a Node-only gzip fallback
  that is excluded from the build.
- Claim polling is one-shot: the server deletes the claim as it returns the key. Earlier
  prototypes saw "expired" after approval, consistent with two overlapping poll loops or a
  controller shared with streaming. Pouch runs one loop with its own `AbortController`.

## Open questions

- Where the published copy lives (GitHub release asset, or Pages at a tagged commit), and
  how to make "check the hash" a ritual people actually perform. On mobile, opening a file
  from disk is awkward.
- Hosting at `pouch.bayleaf.dev` for use on borrowed computers, where no one can check a
  hash. Candidate: GitHub Pages from a small separate repo, so every deploy is a public
  commit.
- Storage mode chosen at sign-in: borrowed computer (memory only, Leave wipes it) versus
  my device (IndexedDB and OPFS).
- In-page agent tools over OPFS and `showDirectoryPicker`, with write confirmation.
