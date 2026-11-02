// The protocol between src/local/host.ts (the page) and src/local/worker.ts,
// the Transformers.js model worker. Types only: the worker imports it without
// pulling in the page side.

// Chat-template messages (src/local/provider.ts toLocalMessages, profiles.ts FEWSHOT).
export interface LocalToolCall { type: 'function'; function: { name: string; arguments: Record<string, unknown> } }
export interface LocalChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: LocalToolCall[] }
export interface LocalToolSchema { type: 'function'; function: { name: string; description?: string; parameters: { properties?: Record<string, { type?: string }> } } }

// head (system prompt, few-shot turn) always stays; history is trimmed to budget tokens.
export interface LocalGenerateRequest { head: LocalChatMessage[]; history: LocalChatMessage[]; tools: readonly LocalToolSchema[]; budget?: number; maxNew?: number }
// over: the latest message alone does not fit; nothing was generated.
export type LocalGenerateResult = { over: true; input_tokens: number; trimmed: number } | {
  over?: undefined; text: string; input_tokens: number; output_tokens: number; trimmed: number; interrupted: boolean; length: boolean;
  ttft_ms: number | null; ms: number;
};
export interface LocalLoadResult { load_ms: number; adapter: { vendor?: string; architecture?: string }; refused: string[] }

// page -> worker. files: verified blobs by file name; wasm: the verified ORT binary.
export type LocalRequest =
  | { id: number; action: 'load'; files: Record<string, Blob>; wasm: Blob }
  | ({ id: number; action: 'generate' } & LocalGenerateRequest)
  | { id?: undefined; action: 'interrupt' }
  | { id: number; action: 'dispose' };
export type LocalAction = LocalRequest['action'];

// worker -> page, told apart by which field is present (the wire has no type tag).
type Only<T> = T & { [K in Exclude<'id' | 'progress' | 'delta' | 'result' | 'error', keyof T>]?: undefined };
export type LocalReply =
  | Only<{ progress: unknown }>
  | Only<{ id: number; delta: string }>
  | Only<{ id: number; result: LocalLoadResult | LocalGenerateResult | 'disposed' }>
  | Only<{ id: number; error: string }>;

export interface LocalWorker {
  generate(req: LocalGenerateRequest, o?: { onDelta?: (delta: string) => void; signal?: AbortSignal }): Promise<LocalGenerateResult>;
}
