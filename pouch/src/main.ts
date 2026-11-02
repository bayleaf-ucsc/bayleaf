// BayLeaf Pouch: UI wiring. Files and the editor work with no account; only
// the agent needs a verified Sealed client (a key or Campus Pass).
//
// Plaintext never leaves this page except as EHBP ciphertext to the attested
// enclave. The only network peer is BayLeaf (enforced by connect-src).
//
// The Interface (LANGUAGE.md) is split into regions under src/interface/ (README "Architecture").
// Each region is a factory that takes `app` and returns its interface; a region
// reaches another only through app.<region>.<name>, resolved when called. A region
// that needs only earlier ones takes them as values instead (install). They
// are created in this order, which is the order their top-level wiring runs.

import type { App } from './interface/app.ts';
import { createStateRegion } from './interface/state.ts';
import { createEditingRegion } from './interface/editing.ts';
import { createTreeRegion } from './interface/tree.ts';
import { createConnectionRegion } from './interface/connection.ts';
import { createProvidersRegion } from './interface/providers.ts';
import { createAuthRegion } from './interface/auth.ts';
import { createInstallRegion } from './interface/install.ts';
import { createSessionListRegion } from './interface/session-list.ts';
import { createNamespacesRegion } from './interface/namespaces.ts';
import { createSubagentsRegion } from './interface/subagents.ts';
import { createMetersRegion } from './interface/meters.ts';
import { createTranscriptRegion } from './interface/transcript.ts';
import { createQueuesRegion } from './interface/queues.ts';
import { createHarnessRegion } from './interface/harness.ts';
import { createSendRegion } from './interface/send.ts';
import { createCommandsRegion } from './interface/commands.ts';
import { createBootRegion } from './interface/boot.ts';

// Filled in below, one region at a time: a region uses another only when called.
const app = {} as App;
app.state = createStateRegion(app);
app.editing = createEditingRegion(app);
app.tree = createTreeRegion(app);
app.connection = createConnectionRegion(app);
app.providers = createProvidersRegion(app);
app.auth = createAuthRegion(app);
app.install = createInstallRegion({ layout: app.state.layout, status: app.state.status, ask: app.tree.ask });
app.sessionList = createSessionListRegion(app);
app.namespaces = createNamespacesRegion(app);
app.subagents = createSubagentsRegion(app);
app.meters = createMetersRegion(app);
app.transcript = createTranscriptRegion(app);
app.queues = createQueuesRegion(app);
app.harness = createHarnessRegion(app);
app.send = createSendRegion(app);
app.commands = createCommandsRegion(app);
app.boot = createBootRegion(app);
