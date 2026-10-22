/** Shared by the raw specification and its classical Scalar presentation. */
import type { Bindings } from './types';
import { ALT_BACKENDS, isBackendEnabled } from './constants';
import { maxGrantSeconds } from './grants';

export function apiOverview(env: Bindings): string {
  return `BayLeaf API serves the UC Santa Cruz campus community: standard LLM inference, a separate encrypted Sealed lane, web tools and persistent Linux sandboxes. This is the HTTP reference, generated from the route definitions and Zod schemas that live beside the implementation.

## Start here

- **Connecting an agent or choosing a workflow?** Read [the agent integration guide](/llms.txt), including external Google Workspace and Canvas CLI integrations. Those CLIs call their own services, not BayLeaf inference routes.
- **Implementing an HTTP client?** Read the operations, schemas and examples below, or [the raw OpenAPI JSON](/docs/openapi.json). This page renders that same specification, not a separately maintained contract.
- **Inspecting how it works?** [Browse the source](https://github.com/bayleaf-ucsc/bayleaf/tree/main/api) or [ask for support](https://github.com/bayleaf-ucsc/bayleaf/blob/main/SUPPORT.md).

## Access and first request

Use standard base URL https://api.bayleaf.dev/v1. Obtain the current recommended model from [GET /recommended-model](/recommended-model), rather than hardcoding a documentation snapshot.

| Access | What it is for |
| --- | --- |
| Ordinary BayLeaf key | Personal account access; issue at [the dashboard](/dashboard). Send Authorization: Bearer with the key. |
| Dedicated sandbox credential | Controller-managed access bound to one owner and machine, with separate rotation/revocation from the ordinary key. Shares the owner's allowances, not extra credit. No automatic expiry; kept in Daytona Secrets, not copied into guest files. See [custody and lifecycle](https://github.com/bayleaf-ucsc/bayleaf/blob/main/api/SANDBOX-CREDENTIALS.md). |
| Campus Pass | Omit Authorization on campus-supported operations. [GET /campus-pass](/campus-pass) checks network, approximate quota and standard shared credit without spending a request. |
| Temporary inference token | Selected-model-set, expiring standard inference using an owner's allowance. See the Grants workflow and exact schemas below. No tools, discovery or Sealed. |
| Browser session | BayLeaf's own dashboard/grant management; not a cross-origin app credential. Cookie-authenticated writes require the BayLeaf origin. |
| Inboxes | ${env.INBOXES_ENABLED === 'true' ? 'Enabled' : 'Disabled'} on this deployment. Owner operations accept ordinary keys and sandbox credentials only: not Campus Pass, temporary inference tokens or browser sessions. |

Public operations explicitly declare no authentication. An empty alternative on a campus-supported operation means keyless access is conditional on the trusted campus network, not that arbitrary off-campus requests are accepted. Sandbox and personal usage inspection require personal access.

## Inference and privacy boundaries

Standard inference uses OpenAI-shaped JSON through zero-data-retention OpenRouter providers, restricted to verifiably open-weight models. Alternate standard backends: ${ALT_BACKENDS.map(b => `${b.label}: ${isBackendEnabled(env, b.key) ? 'enabled' : 'disabled'}`).join('; ')}.

POST /v1/decisions evaluates named Choice, Noul and Score questions over text or structured JSON using the same backend allowance. Models are discovered with text and decision outputs together. A token authorizes model slugs, not modalities; using a model in the wrong operation is rejected. Embedded image/audio/video fields reserve the future multimodal contract, but nonempty media is rejected until the upstream transport is verified. No silent text fallback. Confidential decisions use the Sealed lane instead (POST /sealed/v1/decisions with Tinfoil's decision-* models and native schema).

Sealed is ${env.SEALED_ENABLED === 'true' ? 'enabled' : 'disabled'} on this deployment. It requires a client that verifies attestation and encrypts bodies with EHBP, not an ordinary plaintext OpenAI client. BayLeaf relays ciphertext without the enclave-bound decryption key. Both lanes expose request metadata; BayLeaf retains no inference content. See [retention boundaries](https://github.com/bayleaf-ucsc/bayleaf/blob/main/api/RETENTION.md).

## Allowances and recovery

Inboxes are ${env.INBOXES_ENABLED === 'true' ? 'enabled' : 'disabled'}${env.INBOXES_PILOT_OWNER ? ' for operator-only qualification; other accounts receive 404' : ' for authenticated BayLeaf campus owners with ordinary API keys or sandbox credentials'}: email and HTTP reception stores sender-controlled content, unlike content-free inference. New email inboxes can optionally require verified DKIM domain allowlists and selector pins, capped at 1 MiB; omitted/null policy remains unrestricted. This authenticates domain signing authority, not a person. Check /inboxes/limits for effective restricted-creation availability. This is not zero data retention; the operator can technically read stored messages. Messages expire 90 days from receipt, regardless of reading or archiving. Addresses are not secrets. See the Inboxes operations for credentials, limits and asynchronous destruction.

Budget units differ: dollars versus request counts. Use GET /usage or the dashboard for personal allowances, and GET /campus-pass for keyless standard readiness. Unknown metadata is not zero credit. Availability checks are advisory, never reservations or model-health guarantees.

Temporary inference tokens are ${env.GRANTS_ENABLED === 'true' ? 'enabled' : 'disabled'}; the current maximum lifetime is ${maxGrantSeconds(env)} seconds. Follow the Grants workflow for direct issuance or visitor consent. Exact fields, expiry units, authentication alternatives and error examples are attached to those operations and schemas, not maintained as a second table in the agent guide.

Always handle the actual response: eligibility, quotas, models and providers can change after discovery. Error schemas are operation-specific. Temporary-token expiry/revocation requires explicit authorization again, not automatic renewal. Keep credentials out of URLs, logs and public page source.`;
}
