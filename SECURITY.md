# Security Policy

BayLeaf is a running service, not a reusable software package. This document
describes what "supported" means in that context and how to report a
vulnerability responsibly.

## Review status

BayLeaf has undergone a security review by UC Santa Cruz Information Technology
Services (ITS). The campus Chief Information Security Officer (CISO) and his team
reviewed the service and deemed it **ready to launch**: safe for use by the UCSC
campus community. This attests to BayLeaf's security posture; it is **not** an
adoption of BayLeaf as an ITS-operated or ITS-supported service. BayLeaf remains
faculty-operated. See [`politics/SECURITY.md`](politics/SECURITY.md) for the full
security exhibit.

## Supported versions

The GitHub template asks which release lines receive security fixes. BayLeaf
doesn't ship releases — the `main` branch is the operational state of the
live services at `chat.bayleaf.dev`, `api.bayleaf.dev`, and `bayleaf.dev`,
and production sometimes diverges from any specific commit (some
configuration is edited directly in admin panels and later reconciled into
the repo).

In practice:

| Surface | What's "supported" |
|---|---|
| Live services (`*.bayleaf.dev`) | Yes — actively maintained |
| `main` branch of this repo | Yes — tracks operational state |
| Older commits, tags, forks | No — this repo has no release stream |

If you discover a vulnerability affecting the live services, it is in scope
regardless of whether the relevant code is present in the current `main`.

## Reporting a vulnerability

Please report privately, not via a public issue. Two equivalent channels:

- **Email:** `amsmith@ucsc.edu` (Adam Smith, operator). Use the subject
  prefix `[BayLeaf Security]` if you want it triaged ahead of other mail.
- **GitHub Private Vulnerability Reporting:** open a draft advisory at
  <https://github.com/bayleaf-ucsc/bayleaf/security/advisories/new>. Visible
  only to repo administrators.

You can expect an acknowledgment within **3 business days** and a substantive
response within **10 business days**. BayLeaf is operated by a single faculty
member; response times reflect that.

## Scope

In scope: vulnerabilities in the code in this repository, in the running
services at `chat.bayleaf.dev`, `api.bayleaf.dev`, and `bayleaf.dev`, and in
the configuration of the infrastructure accounts documented in
[`politics/ACCOUNTS.md`](politics/ACCOUNTS.md).

Out of scope: vulnerabilities in upstream dependencies (report those to the
relevant project — see [`politics/DEPENDENCIES.md`](politics/DEPENDENCIES.md)
for who owns what), denial-of-service reports against the free rate-limited
endpoints, and issues that require privileged access already granted to the
reporter (e.g. "as an admin I can…").

## Related documents

- [`politics/SECURITY.md`](politics/SECURITY.md) — full security exhibit:
  architecture, data handling, subprocessors, credential management, honest
  disclosures. Written for the audience that asks for a "security exhibit"
  (ITS reviewer, IRB protocol, risk-assessment form).
- [`politics/DEPENDENCIES.md`](politics/DEPENDENCIES.md) — upstream
  dependency audit and exit paths.
- [`politics/ACCOUNTS.md`](politics/ACCOUNTS.md) — account/credential
  structure and handover plan.
