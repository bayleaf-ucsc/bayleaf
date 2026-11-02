// Types of the engine's surface (src/agent.ts) and of the thread views it
// renders, kept out of agent.ts for its size budget. Types only: no runtime code.
import type { AssistantMessage, ImageContent, Message, TSchema, ToolResultMessage } from '@earendil-works/pi-ai';
import type { JsonValue } from '@earendil-works/chord';
import type { ConversationId, EntryId, EntryRecord, Storage } from '@earendil-works/pi-durable';
import type { Handle } from './graph.ts';
import type { localApi, localModel } from './local/provider.ts';
import type { LocalhostConfig as LocalhostServer, LocalhostModelInfo, localhostApi } from './localhost.ts';
import type { sealedFetch } from './sealed.ts';
import type { SubagentHost } from './subagents-types.ts';
import type { ContextSize } from './context.ts';

// A Pouch session id: 'p-<uuid>' (its own database), or for a legacy session in
// the shared database (and every session over an injected storage) its conversation id.
export type SessionId = string | ConversationId;

// One /sealed/models record; cost is USD per 1M tokens, as in its `pricing`.
export interface SealedModelInfo {
  id: string; name?: string; reasoning?: boolean; multimodal?: boolean; contextWindow?: number;
  cost?: { input?: number; output?: number; cacheRead?: number };
}

// Which conversation in a session's database is current (a revert moves it, D12).
export interface ThreadPointer {
  get(id: SessionId): Promise<ConversationId | null | undefined>;
  set(id: SessionId, convId: ConversationId): Promise<void> | void;
}

// What a page tool's execute() is handed (agent.ts toTool); tools default each part.
export interface ToolCallOptions {
  signal: AbortSignal; output(chunk: unknown): void; caller: ConversationId; callId: string;
  seesImages: boolean | undefined; // asked only for a tool marked `images`
}
// look's result: text lines plus the images, in order.
export interface LookOutput { text: string; images: ImageContent[] }
// A UI tool spec: what src/tools.ts (and run.ts) build, before agent.ts wraps it.
export interface AgentToolSpec {
  name: string; label?: string; description: string; parameters: TSchema; images?: boolean;
  execute(args: Record<string, unknown>, opts: ToolCallOptions): Promise<string | LookOutput> | string | LookOutput;
}

// Settings > Providers > Localhost: the server and the models it offers.
export type LocalhostConfig = LocalhostServer & { models?: LocalhostModelInfo[] };
export type GetClient = Parameters<typeof sealedFetch>[0];

export interface OpenAgentOptions {
  storage?: Storage; // tests: one shared database for every session
  tools?: AgentToolSpec[];
  systemPrompt?: () => string | Promise<string>;
  getClient: GetClient;
  models?: SealedModelInfo[];
  pointer?: ThreadPointer;
  subagents?: SubagentHost; // without reg there is no subagent tool
  onInterrupted?(sids: SessionId[]): void; // sessions whose run a reload cut off (aborted, not resumed)
  local?: { info: Parameters<typeof localModel>[0]; engine: Parameters<typeof localApi>[0]; onHint?: NonNullable<Parameters<typeof localApi>[1]>['onHint'] };
  localhost?: { config?: Partial<LocalhostConfig> | null; onWait?: NonNullable<Parameters<typeof localhostApi>[2]>['onWait'] };
  onRequest?: Parameters<typeof sealedFetch>[1];
}

// A file the user attached (src/attachments.ts Attachment), as stored in the user entry.
export type AttachedFile = { path: string; name: string; size: number; type: string; image?: boolean };
export interface Attachments { files: AttachedFile[]; images: ImageContent[] }

// Content as stored: a string or blocks, of which text blocks carry text.
export type ContentLike = string | readonly { type: string; text?: string }[];
// Any stored pi-ai message, read without narrowing on its role first.
export type StoredMessage = Partial<Omit<AssistantMessage, 'role' | 'content'> & Omit<ToolResultMessage, 'role' | 'content'>>
  & { role?: Message['role']; content?: Message['content']; contextTrimmed?: number };
// What Pouch's own entry kinds carry in data (send(), src/subagents.ts, src/ns/watch.ts).
export type PouchEntryData = {
  text?: string; from?: string; name?: string; to?: string; mode?: string; lines?: string[]; attachments?: AttachedFile[];
  details?: JsonValue; ref?: string; byMessage?: string; lastSent?: { to: string; text: string };
  child?: ConversationId; status?: string; task?: string; steers?: string[]; oneshot?: boolean;
};
export type PouchEntry = Omit<EntryRecord, 'data' | 'model'> & { data?: PouchEntryData; model?: readonly StoredMessage[]; createdAt?: number };

// ---- a thread's flat render list (normalize) ----
// entry, the entry a message came from; at, its time (ms); cut and cutAt, the last entry a revert keeps.
export interface MessageMarks { entry?: EntryId; at?: number; cut?: EntryId; cutAt?: number }
export interface UserItem extends MessageMarks {
  type: 'user'; text: string; steer?: boolean; from?: { ref: Handle; name?: string }; watch?: PouchEntryData; attachments?: AttachedFile[];
}
export interface AssistantItem extends MessageMarks { type: 'assistant'; text: string; thinking: string; streaming: boolean; error?: string; model?: string }
export interface ToolItem {
  type: 'tool'; id: string; name: string; args: unknown; output: string; status: 'running' | 'done' | 'error';
  images?: ImageContent[]; details?: unknown;
}
export type ReportItem = MessageMarks & PouchEntryData & { type: 'report' };
export interface NoticeItem { type: 'notice'; text: string }
export interface CompactionItem { type: 'compaction'; summary: string }
export type ThreadItem = UserItem | AssistantItem | ToolItem | ReportItem | NoticeItem | CompactionItem;
// requests: model responses (steps), for the Usage panel's Requests column.
export interface ThreadUsage { input: number; output: number; cost: number; requests?: number }
export interface NormalizedView { busy: boolean; items: ThreadItem[]; steps: number; toolErrors: number; usage?: ThreadUsage }
// What watch() delivers: the whole thread, sized from its active entries.
export type ThreadView = NormalizedView & { context: ContextSize };
