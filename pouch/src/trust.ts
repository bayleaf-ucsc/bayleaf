// Trust contracts: what crosses Pouch's trust boundaries, as types only
// (README "Architecture"). Nothing here runs (arch.mjs fails the build on any
// runtime statement), so a contract cannot carry behavior.
//
// The shapes are plain data wherever a decision is made (egress, control
// writes, namespace binds, attestation), so a sans-IO trusted core (#143: Rust
// compiled to wasm) can take over one boundary at a time behind the same types:
// data in, a decision out, the effects left to the page.

// ── Egress: data leaving the pouch (src/egress.ts, src/bayleaf-cli.ts) ──
export type EgressService = 'web' | 'sandbox' | 'inbox' | 'account';
// What the approval sheet shows; audiences are who can see what is sent.
export interface EgressRequest { command: string; service: EgressService; summary: string; detail: string; audiences: string[] }
export type EgressAnswer = false | 'once' | 'session';
// One request that went out (status 0: it may have been sent, no answer came).
export interface EgressNotice { command: string; service: EgressService; summary: string; audiences: string[]; method: string; path: string; status: number; ok: boolean }
// egressOf's reading of a bash result's durable traces; text is it without the marker.
export interface EgressTrace { commands: string[]; audiences: string[]; text: string }
// A SessionId (src/agent-types.ts): a string, or a legacy session's numeric
// conversation id. null is the terminal (no session, no grant).
export type EgressSid = string | number | null | undefined;
// What the `bayleaf` command awaits (tools.ts binds the caller): true only on an explicit allow.
export type EgressHook = (req: EgressRequest) => Promise<boolean>;
// The sheet behind it (createEgress().approve). agentName: the subagent
// asking; asker: who else asks (the terminal, with sid null).
export type ApproveEgress = (req: EgressRequest, sid: EgressSid, agentName?: string, asker?: string) => Promise<boolean>;
// A request waiting for its sheet, for the composer tray.
export interface EgressPending { id: number; sid: string | null; command: string; agentName: string | undefined; since: number }

// ── Sealed: the encrypting client, held as an opaque handle (src/sealed.ts) ──
// The verification document fields Pouch reads (a subset of Tinfoil's).
export interface AttestationStep { status: string; error?: string }
export interface Attestation {
  securityVerified: boolean; enclaveHost?: string; configRepo?: string; releaseTag?: string; releaseDigest?: string;
  codeFingerprint?: string; enclaveFingerprint?: string; verifiedAt?: string; steps?: Record<string, AttestationStep | undefined>;
}
// All the shell may do with a Sealed client: wait for it and show its attestation.
export interface SealedHandle { ready(): Promise<void>; getVerificationDocument(): Promise<Attestation> }

// ── Account plane: metadata only (src/bayleaf-api.ts) ──
export interface ClaimStart { device_code: string; user_code: string; claim_url: string; expires_in: number; poll_interval?: number }
export interface ClaimPollReply { key?: string; status?: string }
export interface Budget { provider: string; status?: string; remaining?: number | null; limit?: number | null; used?: number | null; unit?: string; resets_at?: string | null }
export interface UsageReply { budgets?: Budget[] }
export interface CampusPassReply { campus_network?: boolean; enabled?: boolean; quota?: { remaining?: number | null; limit?: number | null; used?: number | null; resets_at?: string | null; approximate?: boolean } }
export interface SealedModel {
  id: string; name?: string; tool_calling?: boolean; endpoints?: string[]; context_window?: number; reasoning?: boolean; multimodal?: boolean;
  pricing?: { inputTokenPricePer1M?: number; outputTokenPricePer1M?: number };
}
export interface SealedModelList { data?: SealedModel[] }

// ── Control plane: everything that acts is a file (src/ns/control.ts) ──
// Authority is the view you were handed, never a claim in a request:
// view({ by: 'user' }) sees every session, view({ by: 'agent', sid }) only its own.
export type Authority = { by: 'user' } | { by: 'agent'; sid: string | number };
export type Writer = Authority['by'];
// label: which of the user's clients wrote, for events ("you (terminal)"); not authority.
export type ControlView = Authority & { label?: string };
// What parseCtl returns: "kill" is already folded into stop.
export type CtlCommand = 'stop' | 'stop all' | 'detach';
// Which ctl file was written: a session's (stop, detach) or a1's (also stop all).
export interface CtlTarget { main?: boolean; session?: boolean }
export type InMode = 'steer' | 'followup' | 'message';
// What parseIn returns; text is trimmed and empty for a truncating redirection.
export interface InMessage { mode: InMode; text: string }

// ── Namespaces: what a task can see (src/ns/namespace.ts) ──
export type BindFlag = 'replace' | 'before' | 'after';
// mount(2): root is the path inside the file server.
export interface MountOptions { flag?: BindFlag; readOnly?: boolean; root?: string; label?: string }
// bind(2): the members keep their own roots and labels.
export interface BindOptions { flag?: BindFlag; readOnly?: boolean }
// One subtree of a capability view, parsed from '/work' or '/pouch:ro' (parseSpecs).
export interface CapabilitySpec { path: string; readOnly: boolean }
// describe() reports the mount table as lines: "/work  rw opfs, ro seed starter.zip".
export type MountLine = string;

// ── Pins: what the hash checks compare against (src/assets.ts, src/models.ts, build defines) ──
// A pinned upstream file (a lock entry's file), or a manifest's file.
export interface FilePin { name: string; bytes: number; sha256: string }
// A build define naming a manifest of content-addressed parts.
export interface PartsPin { dir: string; manifest: string; sha256: string; bytes?: number }
export interface ModelPin { id: string; label: string; repo: string; revision: string; license: string; files: FilePin[] }
// The Transformers.js model's pins as build-models.mjs embeds them (from models.lock.json).
export interface LocalModel extends ModelPin { dtype: string; bytes: number; runtime: PartsPin }
