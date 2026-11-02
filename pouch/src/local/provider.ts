// The Transformers.js provider as a pi-ai provider: generation runs in this browser on the
// WebGPU worker (src/local/worker.ts via engine.ts); nothing is sent anywhere.
//
// It applies the recipe qualified in experiments/lfm3-webgpu (agent v2, "v8"):
// a grounded system prompt naming /work, one byte-exact few-shot turn, four
// short tool schemas, greedy decoding, at most 8 model steps per user turn and
// about 4k tokens of context (older turns are dropped first). The model writes
// native XML tool calls; parseToolCalls() turns them into pi tool calls. The
// newline normalization the recipe needs lives in the tools themselves
// (src/tools.ts), for every provider.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
// The qualified recipe (prompt, few-shot turn, tools, limits) is the
// transformersjs profile in src/profiles.ts, moved there byte for byte.
import { TJS } from '../profiles.ts';
export const { STEP_CAP, BUDGET, MAX_NEW, SYSTEM, TOOLS, FEWSHOT } = TJS;
export { isLocal } from '../profiles.ts';
import type { Api, AssistantMessage, ImageContent, JsonObject, JsonValue, Message, Model, StreamOptions, TextContent, ToolCall } from '@earendil-works/pi-ai';
import type { LocalModel } from './engine.ts';
import type { LocalChatMessage, LocalEngine, LocalToolCall, LocalToolSchema } from './protocol.ts';

export type LocalHint = keyof typeof HINTS;
// contextTrimmed: how many turns or tool results the model did not see (src/context.ts).
type LocalAssistantMessage = AssistantMessage & { contextTrimmed?: number };

export const LOCAL_PROVIDER = 'pouch-local';
export const LOCAL_API = 'pouch-local';

// The chat template renders non-string values with tojson, so a declared
// non-string parameter is parsed back; one that does not parse stays a string.
function coerce(name: string, key: string, v: string, tools: readonly LocalToolSchema[]): JsonValue {
  const t = tools.find((x) => x.function.name === name)?.function.parameters.properties?.[key]?.type;
  if (!t || t === 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}
// Native XML tool calls: <tool_call><function=NAME><parameter=K>\nV\n</parameter>...</function></tool_call>.
export function parseToolCalls(text: string, tools: readonly LocalToolSchema[] = TOOLS) {
  const calls: { name: string; arguments: JsonObject }[] = [];
  for (const m of text.matchAll(/<tool_call>\s*<function=([^>\n]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g)) {
    const args: JsonObject = {};
    for (const p of m[2].matchAll(/<parameter=([^>\n]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) args[p[1]] = coerce(m[1], p[1], p[2], tools);
    calls.push({ name: m[1].trim(), arguments: args });
  }
  const at = text.indexOf('<tool_call>');
  return { text: clean(at < 0 ? text : text.slice(0, at)), calls, malformed: at >= 0 && !calls.length };
}
const clean = (t: string) => t.replace(/<\|[^|>\s]*\|>/g, '').trim();

const textOf = (c: string | (TextContent | ImageContent)[]) => typeof c === 'string' ? c
  : c.map((p) => p.type === 'text' ? p.text : '[image omitted: the Transformers.js model reads text only]').join('\n');

// pi transcript -> chat-template messages. Pouch's own system prompt is
// replaced by SYSTEM (the Transformers.js model's context is too small for it).
export function toLocalMessages(messages: Message[]) {
  const out: LocalChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: textOf(m.content) });
    else if (m.role === 'assistant') {
      const calls = m.content.filter((c): c is ToolCall => c.type === 'toolCall').map((c): LocalToolCall => ({ type: 'function', function: { name: c.name, arguments: c.arguments } }));
      const text = m.content.filter((c): c is TextContent => c.type === 'text').map((c) => c.text).join('');
      if (!calls.length && !text) continue;
      out.push({ role: 'assistant', content: calls.length ? '' : text, ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (m.role === 'toolResult') out.push({ role: 'tool', content: (m.isError ? 'ERROR: ' : '') + textOf(m.content) });
  }
  return out;
}

// What this user turn has done so far (pi messages after the last user message).
export function turnState(messages: Message[]) {
  const last = messages.findLastIndex((m) => m.role === 'user');
  const turn = messages.slice(last + 1);
  const steps = turn.filter((m) => m.role === 'assistant').length;
  const calls = turn.flatMap((m) => m.role === 'assistant' ? m.content.filter((c): c is ToolCall => c.type === 'toolCall') : []);
  const files = new Set(calls.filter((c) => c.name === 'write' || c.name === 'edit').map((c) => String(c.arguments?.path ?? '').replace(/^\/work\//, '')));
  const failedEdits = turn.filter((m) => m.role === 'toolResult' && m.toolName === 'edit' && m.isError).length;
  return { steps, files: files.size, failedEdits };
}

export const HINTS = {
  'step-cap': `Transformers.js stopped at its ${STEP_CAP}-step cap for this message.`,
  'edit-failed': 'The Transformers.js model failed the same kind of edit twice.',
  'many-files': 'This task touches more than 3 files, which is past what the Transformers.js model does reliably.',
  context: 'This thread is longer than the Transformers.js model\'s ~4k-token context; older turns were left out.',
};

const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
let callN = 0;

// engine: { generate(req, { onDelta, signal }) } (src/local/engine.ts).
// onHint(kind): a reason to suggest BayLeaf Sealed; the page shows it, never switches.
export function localApi(engine: LocalEngine, { onHint }: { onHint?: (kind: LocalHint) => void } = {}) {
  function stream(model: Model<Api>, context: { messages: Message[] }, options: StreamOptions = {}) {
    const s = createAssistantMessageEventStream();
    const msg: LocalAssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: zero(), stopReason: 'stop', timestamp: Date.now() };
    const fail = (reason: 'error' | 'aborted', message: string) => { msg.stopReason = reason; msg.errorMessage = message; s.push({ type: 'error', reason, error: msg }); s.end(msg); };
    (async () => {
      const st = turnState(context.messages);
      if (st.failedEdits >= 2) onHint?.('edit-failed');
      if (st.files > 3) onHint?.('many-files');
      s.push({ type: 'start', partial: msg });
      // A request with no tools is a summary or title request: plain, no example.
      const withTools = context.messages.some((m) => m.role === 'system' && m.toolsAdded?.length);
      if (withTools && st.steps >= STEP_CAP) {
        onHint?.('step-cap');
        const text = `[Transformers.js: stopped after ${STEP_CAP} steps, its cap for one message. Send "continue" to go on, or switch to BayLeaf Sealed for longer work.]`;
        msg.content.push({ type: 'text', text });
        s.push({ type: 'text_start', contentIndex: 0, partial: msg });
        s.push({ type: 'text_end', contentIndex: 0, content: text, partial: msg });
        s.push({ type: 'done', reason: 'stop', message: msg }); s.end(msg);
        return;
      }
      let shown = '', block = null as TextContent | null; // set in onDelta too
      const onDelta = (d: string) => {
        shown += d;
        // Stream prose only: hold back anything from a (possibly partial) <tool_call> on.
        const cut = shown.indexOf('<tool_call>');
        let safe = clean(cut >= 0 ? shown.slice(0, cut) : shown.replace(/<[^>]*$/, ''));
        if (!block && safe) { block = { type: 'text', text: '' }; msg.content.push(block); s.push({ type: 'text_start', contentIndex: 0, partial: msg }); }
        if (block && safe.length > block.text.length && safe.startsWith(block.text)) {
          const delta = safe.slice(block.text.length); block.text = safe;
          s.push({ type: 'text_delta', contentIndex: 0, delta, partial: msg });
        }
      };
      let r;
      try {
        r = await engine.generate({ head: withTools ? [{ role: 'system', content: SYSTEM }, ...FEWSHOT] : [{ role: 'system', content: 'You are a concise assistant.' }],
          history: toLocalMessages(context.messages), tools: withTools ? TOOLS : [], budget: BUDGET,
          // A plain request (a title) may ask for fewer new tokens; the tool recipe keeps MAX_NEW.
          maxNew: withTools ? MAX_NEW : Math.min(MAX_NEW, options.maxTokens ?? MAX_NEW) }, { onDelta, signal: options.signal });
      } catch (e) { return fail(options.signal?.aborted ? 'aborted' : 'error', String((e as Error)?.message ?? e)); }
      if (r.trimmed) onHint?.('context');
      if (r.over) { onHint?.('context'); return fail('error', `This message alone is longer than the Transformers.js model's ${BUDGET}-token context (${r.input_tokens} tokens). Shorten it, or switch to BayLeaf Sealed.`); }
      msg.usage = { ...zero(), input: r.input_tokens, output: r.output_tokens, totalTokens: r.input_tokens + r.output_tokens };
      // Stored with the reply, so the context meter (src/context.ts) can say the model did not see everything.
      if (r.trimmed) msg.contextTrimmed = r.trimmed;
      if (r.interrupted || options.signal?.aborted) return fail('aborted', 'Stopped.');
      const { text, calls, malformed } = parseToolCalls(r.text, TOOLS);
      if (block) block.text = text; else if (text) { block = { type: 'text', text }; msg.content.push(block); s.push({ type: 'text_start', contentIndex: 0, partial: msg }); }
      if (block) s.push({ type: 'text_end', contentIndex: 0, content: block.text, partial: msg });
      const known = new Set(TOOLS.map((t) => t.function.name));
      const bad = calls.filter((c) => !known.has(c.name));
      if (malformed || bad.length) {
        const note = malformed ? '[Transformers.js: the model wrote an incomplete tool call; nothing ran.]' : `[Transformers.js: the model asked for ${bad.map((c) => c.name).join(', ')}, which it cannot use here; nothing ran.]`;
        if (!block) { block = { type: 'text', text: '' }; msg.content.push(block); s.push({ type: 'text_start', contentIndex: 0, partial: msg }); }
        block.text = (block.text ? block.text + '\n\n' : '') + note;
        s.push({ type: 'text_end', contentIndex: 0, content: block.text, partial: msg });
        s.push({ type: 'done', reason: 'stop', message: msg }); s.end(msg);
        return;
      }
      for (const c of calls) {
        const call: ToolCall = { type: 'toolCall', id: `local_${Date.now().toString(36)}_${++callN}`, name: c.name, arguments: c.arguments };
        msg.content.push(call);
        const i = msg.content.length - 1;
        s.push({ type: 'toolcall_start', contentIndex: i, partial: msg });
        s.push({ type: 'toolcall_end', contentIndex: i, toolCall: call, partial: msg });
      }
      msg.stopReason = calls.length ? 'toolUse' : r.length ? 'length' : 'stop';
      s.push({ type: 'done', reason: msg.stopReason, message: msg }); s.end(msg);
    })().catch((e) => fail('error', String(e?.message ?? e)));
    return s;
  }
  return { stream, streamSimple: stream };
}

// The pi-ai model record. contextWindow is large on purpose: this provider
// trims to BUDGET itself, so pi-durable never asks the 1.7B model to compact.
export function localModel(local: LocalModel): Model<typeof LOCAL_API> {
  return {
    id: 'local:' + local.id, name: `${local.label} (Transformers.js, in this browser)`, api: LOCAL_API, provider: LOCAL_PROVIDER, baseUrl: 'local:',
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072, maxTokens: MAX_NEW,
  };
}
