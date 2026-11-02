// Types of src/subagents.ts: registry rows and what the engine and page supply.
// Kept apart for its size budget. Types only: no runtime code.
import type { Context } from '@earendil-works/chord';
import type { Conversation, ConversationId, Harness, ModelRef, SettledSubmissionRecord, SubmissionId } from '@earendil-works/pi-durable';
import type { SessionId, ThreadUsage } from './agent-types.ts';
import type { Handle, HandleRow } from './graph.ts';

export type SubagentStatus = 'running' | 'finished' | 'failed' | 'stopped' | 'interrupted';
// One registry row (Pouch settings, subagentsKey): a subagent and its state.
export interface SubagentRow extends HandleRow {
  id: ConversationId; ref?: Handle; name: string; task: string; status: SubagentStatus; started: number;
  sub?: SubmissionId; requests: number; ns?: string[]; foreground?: boolean; noReport?: boolean;
  oneshot?: boolean; files?: string[]; to?: Handle; ended?: number; resumed?: number; toolErrors?: number;
  usage?: ThreadUsage; seq?: number; error?: string; reported?: SubmissionId; joinedBy?: Handle;
  sentIn?: SubmissionId; wokenBy?: Handle; lastSent?: { to: string; text: string };
}
// The child behind a conversation id.
export interface SubagentOwner { sid: SessionId; id: ConversationId; ns?: string[] }
// A submission the page can await without a pi-durable context.
export interface Waitable { id: SubmissionId; wait(): Promise<SettledSubmissionRecord> }
// Who sends a message or joins: main, or a subagent and its row.
export interface Sender { ref: Handle; name: string; child: SubagentRow | null }
export interface SubagentSummary { answer: string; requests: number; toolErrors: number; steers: string[]; usage?: ThreadUsage }

// What the page supplies (openAgent's `subagents`).
export interface SubagentHost {
  reg: { get(sid: string): Promise<SubagentRow[] | undefined | null>; set(sid: string, list: SubagentRow[] | undefined): Promise<void> | void };
  onChange?(sid: SessionId, list: SubagentRow[]): void;
  onReport?(sid: SessionId, sub: Waitable, child: SubagentRow | null): void;
  onSettle?(sid: SessionId, child: SubagentRow): void;
  onBlocked?(sid: SessionId): void;
  onCap?(sid: SessionId, cap: { from?: string; to?: string; text: string; at: number }): void;
  lowAllowance?(): string | null | undefined;
  followUpHeld?(sid: SessionId): boolean;
  readFile?(path: string): Promise<{ path: string; text: string }>;
  watchLines?(sid: SessionId, ref: Handle): string | null | undefined;
}
// ... and what the engine adds (src/agent.ts).
export interface SubagentDeps extends SubagentHost {
  ctx: Context;
  sidOf(convId: ConversationId): SessionId;
  modelRef(modelId: string): ModelRef;
  dbOf(sid: SessionId): string;
  openDb(name: string): Promise<{ harness: Harness }>;
  conv(sid: SessionId): Promise<Conversation>;
}
