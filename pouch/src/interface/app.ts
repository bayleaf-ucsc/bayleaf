// The App: the Interface's regions, composed by main.ts (README "Architecture").
// A region reaches another only as app.<region>.<name>, resolved when called;
// each region's interface is declared in its own module, next to the factory
// that implements it. A contract (arch.mjs): types only.
//
// A cell lives with its writer, read-only elsewhere. Kept on app deliberately:
// state.agent and state.composer (many readers), sessionList.focus and activeRun
// (activeRun's writers claim with different semantics: NEXT.md), and every call
// to a later region, since the regions call each other in real cycles.
import type { StateRegion } from './state.ts';
import type { EditingRegion } from './editing.ts';
import type { TreeRegion } from './tree.ts';
import type { ConnectionRegion } from './connection.ts';
import type { ProvidersRegion } from './providers.ts';
import type { AuthRegion } from './auth.ts';
import type { InstallRegion } from './install.ts';
import type { SessionListRegion } from './session-list.ts';
import type { NamespacesRegion } from './namespaces.ts';
import type { SubagentsRegion } from './subagents.ts';
import type { MetersRegion } from './meters.ts';
import type { TranscriptRegion } from './transcript.ts';
import type { QueuesRegion } from './queues.ts';
import type { HarnessRegion } from './harness.ts';
import type { SendRegion } from './send.ts';
import type { CommandsRegion } from './commands.ts';
import type { BootRegion } from './boot.ts';

export interface App {
  state: StateRegion;
  editing: EditingRegion;
  tree: TreeRegion;
  connection: ConnectionRegion;
  providers: ProvidersRegion;
  auth: AuthRegion;
  install: InstallRegion;
  sessionList: SessionListRegion;
  namespaces: NamespacesRegion;
  subagents: SubagentsRegion;
  meters: MetersRegion;
  transcript: TranscriptRegion;
  queues: QueuesRegion;
  harness: HarnessRegion;
  send: SendRegion;
  commands: CommandsRegion;
  boot: BootRegion;
}
