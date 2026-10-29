// The Local lane as a pi-ai provider: generation runs in this browser on the
// WebGPU worker (src/local/worker.js via engine.js); nothing is sent anywhere.
//
// It applies the recipe qualified in experiments/lfm3-webgpu (agent v2, "v8"):
// a grounded system prompt naming /work, one byte-exact few-shot turn, four
// short tool schemas, greedy decoding, at most 8 model steps per user turn and
// about 4k tokens of context (older turns are dropped first). The model writes
// native XML tool calls; parseToolCalls() turns them into pi tool calls. The
// newline normalization the recipe needs lives in the tools themselves
// (src/tools.js), for every lane.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

export const LOCAL_PROVIDER = 'pouch-local';
export const LOCAL_API = 'pouch-local';
export const STEP_CAP = 8;
export const BUDGET = 4096; // prompt tokens; past ~4k decode halves and memory roughly quadruples
export const MAX_NEW = 512;
export const isLocal = (modelId) => String(modelId ?? '').startsWith('local:');

// The qualified "grounded" system prompt, verbatim.
export const SYSTEM = 'You are a concise coding assistant inside a browser. Use read, write, edit and bash tools for real file operations in /work. Never claim an edit without using a tool. Read files before editing. Tool errors are feedback: inspect and retry. No network, real processes, code execution or package installs. Finish with a concise summary.' +
  ' Make exactly the requested change and nothing more: never add blank lines, reformat, reorder or tidy surrounding text. To append a line to a file, use edit with oldText set to the current last line and newText set to that same line plus a newline plus the new line (no blank line in between) unless asked otherwise.' +
  ' The workspace root and current directory is /work (there is no /workspace). Use relative paths like src/a.js.';

const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties) }), str = { type: 'string' };
// Pouch's own read/write/edit/bash accept these argument subsets. No run, no
// subagent (it would spend Sealed requests): a call to anything else is refused.
export const TOOLS = [
  { type: 'function', function: { name: 'read', description: 'Read a UTF-8 text file. Paths relative to /work.', parameters: obj({ path: str }) } },
  { type: 'function', function: { name: 'write', description: 'Create or overwrite a file with exact content. Parents created.', parameters: obj({ path: str, content: str }) } },
  { type: 'function', function: { name: 'edit', description: 'Replace exact oldText with newText. oldText must occur exactly once. Read first; include neighboring lines if ambiguous.', parameters: obj({ path: str, oldText: str, newText: str }) } },
  { type: 'function', function: { name: 'bash', description: 'Simulated bash over /work only. ls, find, cat, grep, sed, printf. No network, node, python, or processes.', parameters: obj({ command: str }) } },
];

// One synthetic prior turn: a byte-exact append, a create, in Pouch's own tool output format.
export const FEWSHOT = [
  { role: 'user', content: 'Append the exact line b = 2 to the end of x.txt and create y.txt containing exactly ok followed by a newline. Read first; change nothing else.' },
  { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'read', arguments: { path: 'x.txt' } } }] },
  { role: 'tool', content: 'a = 1\n' },
  { role: 'assistant', content: '', tool_calls: [
    { type: 'function', function: { name: 'edit', arguments: { path: 'x.txt', oldText: 'a = 1\n', newText: 'a = 1\nb = 2\n' } } },
    { type: 'function', function: { name: 'write', arguments: { path: 'y.txt', content: 'ok\n' } } }] },
  { role: 'tool', content: 'Applied 1 edit to /work/x.txt. Edited lines now read:\n1: a = 1\n2: b = 2\n3: ' },
  { role: 'tool', content: 'Wrote 2 lines (3 characters) to /work/y.txt' },
  { role: 'assistant', content: 'Appended b = 2 to x.txt and created y.txt.' },
];

// The chat template renders non-string values with tojson, so a declared
// non-string parameter is parsed back; one that does not parse stays a string.
function coerce(name, key, v, tools) {
  const t = tools.find((x) => x.function.name === name)?.function.parameters.properties?.[key]?.type;
  if (!t || t === 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}
// Native XML tool calls: <tool_call><function=NAME><parameter=K>\nV\n</parameter>...</function></tool_call>.
export function parseToolCalls(text, tools = TOOLS) {
  const calls = [];
  for (const m of text.matchAll(/<tool_call>\s*<function=([^>\n]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g)) {
    const args = {};
    for (const p of m[2].matchAll(/<parameter=([^>\n]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) args[p[1]] = coerce(m[1], p[1], p[2], tools);
    calls.push({ name: m[1].trim(), arguments: args });
  }
  const at = text.indexOf('<tool_call>');
  return { text: clean(at < 0 ? text : text.slice(0, at)), calls, malformed: at >= 0 && !calls.length };
}
const clean = (t) => t.replace(/<\|[^|>\s]*\|>/g, '').trim();

const textOf = (c) => typeof c === 'string' ? c
  : c.map((p) => p.type === 'text' ? p.text : '[image omitted: the Local model reads text only]').join('\n');

// pi transcript -> chat-template messages. Pouch's own system prompt is
// replaced by SYSTEM (the Local model's context is too small for it).
export function toLocalMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: textOf(m.content) });
    else if (m.role === 'assistant') {
      const calls = m.content.filter((c) => c.type === 'toolCall').map((c) => ({ type: 'function', function: { name: c.name, arguments: c.arguments } }));
      const text = m.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (!calls.length && !text) continue;
      out.push({ role: 'assistant', content: calls.length ? '' : text, ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (m.role === 'toolResult') out.push({ role: 'tool', content: (m.isError ? 'ERROR: ' : '') + textOf(m.content) });
  }
  return out;
}

// What this user turn has done so far (pi messages after the last user message).
export function turnState(messages) {
  const last = messages.findLastIndex((m) => m.role === 'user');
  const turn = messages.slice(last + 1);
  const steps = turn.filter((m) => m.role === 'assistant').length;
  const calls = turn.flatMap((m) => m.role === 'assistant' ? m.content.filter((c) => c.type === 'toolCall') : []);
  const files = new Set(calls.filter((c) => c.name === 'write' || c.name === 'edit').map((c) => String(c.arguments?.path ?? '').replace(/^\/work\//, '')));
  const failedEdits = turn.filter((m) => m.role === 'toolResult' && m.toolName === 'edit' && m.isError).length;
  return { steps, files: files.size, failedEdits };
}

export const HINTS = {
  'step-cap': `Local stopped at its ${STEP_CAP}-step cap for this message.`,
  'edit-failed': 'Local failed the same kind of edit twice.',
  'many-files': 'This task touches more than 3 files, which is past what Local does reliably.',
  context: 'This conversation is longer than Local\'s ~4k-token context; older turns were left out.',
};

const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
let callN = 0;

// engine: { generate(req, { onDelta, signal }) } (src/local/engine.js).
// onHint(kind): a reason to suggest Sealed; the page shows it, never switches.
export function localApi(engine, { onHint } = {}) {
  function stream(model, context, options = {}) {
    const s = createAssistantMessageEventStream();
    const msg = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: zero(), stopReason: 'stop', timestamp: Date.now() };
    const fail = (reason, message) => { msg.stopReason = reason; msg.errorMessage = message; s.push({ type: 'error', reason, error: msg }); s.end(msg); };
    (async () => {
      const st = turnState(context.messages);
      if (st.failedEdits >= 2) onHint?.('edit-failed');
      if (st.files > 3) onHint?.('many-files');
      s.push({ type: 'start', partial: msg });
      // A request with no tools is a summary or title request: plain, no example.
      const withTools = context.messages.some((m) => m.role === 'system' && m.toolsAdded?.length);
      if (withTools && st.steps >= STEP_CAP) {
        onHint?.('step-cap');
        const text = `[Local lane: stopped after ${STEP_CAP} steps, its cap for one message. Send "continue" to go on, or switch to Sealed for longer work.]`;
        msg.content.push({ type: 'text', text });
        s.push({ type: 'text_start', contentIndex: 0, partial: msg });
        s.push({ type: 'text_end', contentIndex: 0, content: text, partial: msg });
        s.push({ type: 'done', reason: 'stop', message: msg }); s.end(msg);
        return;
      }
      let shown = '', block = null;
      const onDelta = (d) => {
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
          history: toLocalMessages(context.messages), tools: withTools ? TOOLS : [], budget: BUDGET, maxNew: MAX_NEW }, { onDelta, signal: options.signal });
      } catch (e) { return fail(options.signal?.aborted ? 'aborted' : 'error', String(e?.message ?? e)); }
      if (r.trimmed) onHint?.('context');
      if (r.over) { onHint?.('context'); return fail('error', `This message alone is longer than the Local lane's ${BUDGET}-token context (${r.input_tokens} tokens). Shorten it, or switch to Sealed.`); }
      msg.usage = { ...zero(), input: r.input_tokens, output: r.output_tokens, totalTokens: r.input_tokens + r.output_tokens };
      if (r.interrupted || options.signal?.aborted) return fail('aborted', 'Stopped.');
      const { text, calls, malformed } = parseToolCalls(r.text, TOOLS);
      if (block) block.text = text; else if (text) { block = { type: 'text', text }; msg.content.push(block); s.push({ type: 'text_start', contentIndex: 0, partial: msg }); }
      if (block) s.push({ type: 'text_end', contentIndex: 0, content: block.text, partial: msg });
      const known = new Set(TOOLS.map((t) => t.function.name));
      const bad = calls.filter((c) => !known.has(c.name));
      if (malformed || bad.length) {
        const note = malformed ? '[Local lane: the model wrote an incomplete tool call; nothing ran.]' : `[Local lane: the model asked for ${bad.map((c) => c.name).join(', ')}, which Local cannot use; nothing ran.]`;
        if (!block) { block = { type: 'text', text: '' }; msg.content.push(block); s.push({ type: 'text_start', contentIndex: 0, partial: msg }); }
        block.text = (block.text ? block.text + '\n\n' : '') + note;
        s.push({ type: 'text_end', contentIndex: 0, content: block.text, partial: msg });
        s.push({ type: 'done', reason: 'stop', message: msg }); s.end(msg);
        return;
      }
      for (const c of calls) {
        const call = { type: 'toolCall', id: `local_${Date.now().toString(36)}_${++callN}`, name: c.name, arguments: c.arguments };
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
export function localModel(local) {
  return {
    id: 'local:' + local.id, name: `Local: ${local.label} (on this device)`, api: LOCAL_API, provider: LOCAL_PROVIDER, baseUrl: 'local:',
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072, maxTokens: MAX_NEW,
  };
}
