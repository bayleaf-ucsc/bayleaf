# Direct Agent Integrations

BayLeaf helps campus users connect agents to services such as Google Workspace
and Canvas LMS. Some of those connections run through BayLeaf Chat, but others
run directly from an agent on the user's computer to the service's own API.
These are different architectures with different privacy and trust boundaries.

This document describes the design of the second category: integrations BayLeaf
supports without turning BayLeaf Chat or BayLeaf API into the gateway for every
tool call.

## Two integration patterns

### BayLeaf-mediated tools

BayLeaf Chat can run tools on a user's behalf. The Google Workspace toolkit, for
example, makes Google API calls from the Chat service using per-user, per-chat
OAuth authorization. The Canvas skill can use a user-supplied Canvas token from
the Code Sandbox. Tool results can become part of a conversation stored by
BayLeaf Chat.

These paths are features of BayLeaf Chat. Their implementation and operational
controls are documented in [`chat/DESIGN.md`](chat/DESIGN.md).

### BayLeaf-supported direct tools

A local agent can instead use a command-line client on the user's own computer:

```text
Google Workspace or Canvas
            ^
            | direct API traffic using the user's credential
            |
local agent harness ---- selected task context ----> BayLeaf API inference
```

BayLeaf may provide setup instructions, an OAuth application configuration, and
LLM inference. It does not proxy the command-line client's Google Workspace or
Canvas API calls. The local client holds the service credential, and the local
harness holds the conversation transcript.

This separation is deliberate. BayLeaf can make useful agent workflows easier
without collecting every campus-system credential, becoming a required gateway
to those systems, or pretending that one platform should own the whole task.

## What crosses each boundary

Direct service traffic and inference traffic are separate even when one agent
coordinates both:

| Material | Where it goes |
|---|---|
| Google OAuth token or Canvas access token | The local client and the relevant service; it should not be sent to BayLeaf |
| Google Workspace or Canvas API request | Directly from the user's computer to Google or Instructure |
| Service-side records | Remain governed by Google Workspace or Canvas and UCSC policy |
| Local agent transcript | Stored by the user's local harness, subject to that harness's configuration |
| Context selected for model reasoning | Sent by the harness to its configured inference provider; when that is BayLeaf API, the API's [privacy](PRIVACY.md) and [retention](api/RETENTION.md) boundaries apply |

Direct integration therefore does **not** mean that no service-derived content
can reach an LLM. An agent may read an email or Canvas record locally and include
some or all of it in a model request to reason about the task. The direct design
keeps credentials and raw API transport out of BayLeaf, while the user and agent
remain responsible for what context is disclosed for inference.

## Google Workspace CLI

The [`gws`](https://github.com/googleworkspace/cli) CLI gives a local agent
access to Gmail, Drive, Calendar, Sheets, Docs, Slides, Tasks, and other Google
Workspace APIs as the signed-in user.

BayLeaf contributes three pieces:

1. The BayLeaf API distributes the desktop OAuth client configuration at
   `https://api.bayleaf.dev/docs/gws-oauth-client.json`. The OAuth client
   identifies the shared application; it does not contain a user's credential.
2. The Google Cloud OAuth application is Internal to UCSC, so only campus
   accounts can authorize it.
3. The shared Google Cloud project grants `domain:ucsc.edu` a project-local
   custom role containing only `serviceusage.services.use`. This lets UCSC users
   consume the project's API quota without granting product-specific access to
   project resources or to another person's Workspace data.

The user completes Google's OAuth consent flow. `gws` then stores and refreshes
that user's credential locally. Google OAuth scopes, the user's existing
Workspace permissions, and the command being run determine what the client can
do. A BayLeaf API key does not authorize Google access.

The generated setup instructions and current smoke-test command live in
[`api/src/routes/llms.ts`](api/src/routes/llms.ts) and are published through
`https://api.bayleaf.dev/llms.txt`. That agent-facing document is an executable
onboarding surface; this document is the durable human-readable design record.

## Canvas LMS CLI

The [`canvaslms`](https://github.com/dbosk/canvaslms) CLI gives a local agent
access to the Canvas REST API. The user creates an access token in Canvas and
configures it locally. BayLeaf does not issue, receive, exchange, or refresh the
Canvas token. A BayLeaf identity or API key does not authorize Canvas access.

Canvas permissions follow the user who created the token. That can include
consequential capabilities such as changing course content, grades, enrollment
configuration, or messages. Agents should inspect before bulk changes, preview
affected records, and require confirmation for consequential submissions.

Student education records remain subject to the limits in
[`PRIVACY.md`](PRIVACY.md). BayLeaf has passed a P3 security review, but legal
authorization to use BayLeaf inference with actual FERPA education records has
not yet been granted. Running a Canvas API request directly does not erase that
boundary if the local agent subsequently sends record content to BayLeaf for
inference.

## Why BayLeaf supports direct integrations

This design serves several counterplatform commitments:

- **Interoperability:** users can combine BayLeaf inference with ordinary,
  replaceable command-line tools rather than wait for a bespoke connector.
- **User-held authority:** service credentials stay with the user and can be
  revoked at the service that issued them.
- **Reduced concentration:** BayLeaf need not become the credential vault or
  traffic intermediary for every campus system an agent can use.
- **Inspectable practice:** setup instructions, trust boundaries, and source
  are public and revisable when real use exposes friction.
- **Exit:** the same CLI integrations can be used with another model provider or
  without BayLeaf. BayLeaf supplies a path, not a lock-in mechanism.

## Support boundary

BayLeaf supports the documented setup and the shared Google OAuth application's
quota configuration. Google, Instructure, the CLI projects, the local harness,
and UCSC each retain responsibility for their own systems. BayLeaf is not an
ITS-operated help desk for those services.

Report reproducible onboarding problems or propose another broadly useful
direct integration through [`SUPPORT.md`](SUPPORT.md). Never include OAuth
tokens, Canvas tokens, API keys, private messages, or student records in a
public issue.
