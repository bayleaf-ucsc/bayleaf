// Types of src/tools.ts (the page tools, the shell and the fs proxies), kept apart
// for its size budget. Types only: no runtime code.
import type { ConversationId } from '@earendil-works/pi-durable';
import type { PreparedImage } from './attachments.ts';
import type { BaseFs, Namespace } from './ns/namespace.ts';
import type { Addons, AddonWho } from './addons.ts';
import type { OpenHooks, ShowRequest } from './open-cli.ts';
import type { PdfService } from './pdf.ts';
import type { DuckdbService } from './duckdb.ts';
import type { RunToolDeps } from './run.ts';
import type { EgressNotice, EgressRequest } from './trust.ts';
import type { bayleafCommands } from './bayleaf-cli.ts';
import type { mediaCommands } from './media.ts';
import type { Vfs } from './vfs.ts';

export type Caller = ConversationId | undefined; // the calling conversation; undefined: none (the page's own fs)
// What a proxied filesystem has: every Pouch fs (Namespace, NinepFs, a control view) is a BaseFs.
export type ToolFs = BaseFs;
export type ChangeOp = 'created' | 'modified' | 'deleted';
export interface EditSpec { oldText?: string; newText?: string; replaceAll?: boolean }

// Option bags of the wrapped methods.
export type RmOpts = Parameters<ToolFs['rm']>[1];
export type MkdirOpts = Parameters<ToolFs['mkdir']>[1];
export type CpOpts = Parameters<ToolFs['cp']>[2];
export type ShellHooks = Parameters<typeof bayleafCommands>[1] & OpenHooks & { addons?: Addons; pdf?: PdfService; media?: Parameters<typeof mediaCommands>[1]; duckdb?: DuckdbService };
// The page's side of the tools: namespaces, egress approval, the shared engines.
export interface ToolsHooks {
  namespaceFor?(caller: Caller): string[] | null | undefined; // a subagent's mounts
  sourceOf?(caller: Caller): string | undefined;
  mainView?(caller: ConversationId, base: Namespace): ToolFs;
  onChange?(caller: ConversationId, op: ChangeOp, path: string): void;
  bayleafCredential?(): string | null | undefined;
  approveEgress?(req: EgressRequest, caller: Caller): Promise<boolean>;
  onEgress?(e: EgressNotice, caller: Caller): void;
  addons?: Addons; addonsWho?(caller: Caller): Extract<AddonWho, { by: 'agent' }> | undefined;
  show?(req: ShowRequest, caller: Caller): Promise<{ opened?: boolean; reason?: string } | null | undefined>;
  pdf?: PdfService; media?: Parameters<typeof mediaCommands>[1]; duckdb?: DuckdbService;
  prepareImage?(bytes: Uint8Array): Promise<PreparedImage>;
  sessionOf?(caller?: ConversationId): string | number | null; // a SessionId: legacy sessions are numeric
  makeWorker?: RunToolDeps['makeWorker'];
}
export type ToolsVfs = Pick<Vfs, 'fs' | 'mounts' | 'seedLayer'> & Partial<Pick<Vfs, 'as'>> & RunToolDeps['vfs'];
// A subagent's namespace over 9P: its key (the mount specs), the fs its tools use, its namespace.
export interface View { key: string; fs: ToolFs; ns: Namespace; close(): void }
export interface SkillInfo { name: string; description: string; path: string; requests?: string; unlisted?: boolean }
