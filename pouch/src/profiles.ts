// Harness profiles (LANGUAGE.md "Harness"). A harness is one engine plus a
// profile. The engine is pi-durable as Pouch extends it (src/agent.ts:
// routing, compaction, steering; src/subagents.ts: spawn, join, detach,
// caps; src/tools.ts: per-path write serialization). A profile is what one
// kind of agent runs with: its prompt, tool set, loop and limits. Five exist,
// and this module is the one place that says how they differ:
//
//   profile         tools                                   loop               limits
//   main            every page tool + subagent              multi-step         daily allowance
//   subagent        page tools, subagent swapped for agents multi-step         per-pair message caps
//   oneshot         none (no extensions, no Pouch prompt)   exactly one call   1 request
//   transformersjs  4 qualified tools (read/write/edit/bash) multi-step       8 steps, ~4k tokens
//   localhost       page tools minus subagent and agents     multi-step         24 steps, no allowance
//
// profileOf() picks one. The engine reads `agent(...)` (pi-durable agent
// config for a conversation it creates) and the transformersjs recipe; main's
// prompt is assembled by systemPrompt() in src/tools.ts from the workspace.
// Pure data and text: no pi-durable, no DOM, so node tests import it directly.
import { MAIN } from './graph.ts';
import type { AgentChange, ModelRef, ToolRegistration } from '@earendil-works/pi-durable';
import type { LocalChatMessage, LocalToolSchema } from './local/protocol.ts';

export const SUBAGENT_DIR = '/work/.subagents';

// Pouch's ubiquitous language (LANGUAGE.md), told briefly to every agent that
// gets main's prompt (main, subagents, localhost), so replies use the words the
// interface uses. Not the transformersjs profile: its prompt is qualified verbatim.
export const UL_GLOSS = `Pouch's terms, which the user also sees (use them): you are an agent, a model run by Pouch's harness on a provider, acting for the user. A session groups its agents; each agent's turns form a thread the user reads. Files live in the workspace (/work), shared by every session; your namespace is the part of it you can see. While you work, the user may steer you (read after your current step) or send a follow-up (read after your turn ends). Agents act: your edits change the user's files immediately and there is no undo, so make them deliberately and say plainly what you changed.`;

// The harness gloss on messaging, shared by main's prompt and every child's.
export const GRAPH_GLOSS = `The agents of this session message each other by handle: main is ${MAIN}, subagents are a2, a3 and so on. Common shapes: many-to-one (several send findings to one collector), pipeline (each passes its result to the next), cross-check (two answer each other). Messages arrive between your steps, tagged [from <name> (<handle>)]; do not poll. join blocks until subagents go quiet and returns their last messages; it never wakes one, so to get new work, message it and then join it. When your part is done, send your result to whoever asked, then stop.`;

// Where a subagent keeps notes: /work/.subagents when it may write /work,
// else its private /tmp (a spawn that narrowed /work to read-only files).
export function scratchOf(ns: string[] | undefined) {
  if (!ns?.length) return SUBAGENT_DIR;
  const rw = ns.filter((s) => !/:ro$/.test(s)).map((s) => s.replace(/:rw$/, '').replace(/\/+$/, ''));
  return rw.some((p) => (SUBAGENT_DIR + '/').startsWith(p + '/')) ? SUBAGENT_DIR : '/tmp';
}

function instructions(name: string, ref: string, task: string, ns: string[] | undefined) {
  const dir = scratchOf(ns);
  const where = dir === '/tmp' ? `/tmp (your private scratch, lost on reload; /work is read-only for you, so never write there), for example /tmp/${name}.md` : `${dir}/, for example ${dir}/${name}.md`;
  return `You are a subagent named "${name}" (handle ${ref}), started by the main BayLeaf Pouch agent, "main" (handle ${MAIN}), to work on one task while it keeps talking to the user. Work only on this task:
<task>
${task}
</task>
You cannot start subagents yourself (ignore any guidance about them above). ${GRAPH_GLOSS} Use the agents tool for that (actions list, message, join). Nobody else will answer questions: make reasonable assumptions and say what they were. Write any long output (notes, lists, drafts) to a file under ${where}. If your task says to send your result to another agent, send it there with the agents tool and then end with one short line; otherwise finish with a concise report (at most about 200 words) that states what you found or did and lists the paths of files you wrote: main reads only that report. To stop, simply finish your reply.`;
}

// A one-shot subagent: one model request, no tools, no Pouch prompt. It sees
// the task and the files main attached; its reply is its report (or goes to
// `to`, forwarded by the harness, since it cannot message anyone itself).
function oneshotInstructions(name: string, ref: string, toLabel: string) {
  return `You are "${name}" (handle ${ref}), a one-shot helper started by the BayLeaf Pouch agent. You have no tools and exactly one reply: answer the task below from the text you are given, concisely and concretely, quoting the text where it helps. Nobody will answer questions: make reasonable assumptions and say what they were. Your reply goes to ${toLabel}.`;
}

// ── transformersjs: the recipe qualified in experiments/lfm3-webgpu (agent
// v2, "v8", 39/40 tasks). Moved here byte for byte from src/local/provider.ts;
// do not edit the prompt, few-shot turn or tool descriptions without rerunning
// that qualification (src/local/provider.ts applies them).
export const STEP_CAP = 8;
// Prompt tokens. One-shot prefill returns non-finite logits at exactly 8,192 and
// fails from 11,586, so this stays at most 8,000 until prefill is chunked
// (experiments/lfm3-webgpu/qualification/context-2026-11-01/REPORT.md).
export const BUDGET = 4096;
export const MAX_NEW = 512;
export const isLocal = (modelId: unknown) => String(modelId ?? '').startsWith('local:');
// The qualified "grounded" system prompt, verbatim.
export const SYSTEM = 'You are a concise coding assistant inside a browser. Use read, write, edit and bash tools for real file operations in /work. Never claim an edit without using a tool. Read files before editing. Tool errors are feedback: inspect and retry. No network, real processes, code execution or package installs. Finish with a concise summary.' +
  ' Make exactly the requested change and nothing more: never add blank lines, reformat, reorder or tidy surrounding text. To append a line to a file, use edit with oldText set to the current last line and newText set to that same line plus a newline plus the new line (no blank line in between) unless asked otherwise.' +
  ' The workspace root and current directory is /work (there is no /workspace). Use relative paths like src/a.js.';

const obj = (properties: Record<string, { type: string }>) => ({ type: 'object', properties, required: Object.keys(properties) }), str = { type: 'string' };
// Pouch's own read/write/edit/bash accept these argument subsets. No run, no
// subagent (it would spend BayLeaf Sealed requests): a call to anything else is refused.
export const TOOLS: LocalToolSchema[] = [
  { type: 'function', function: { name: 'read', description: 'Read a UTF-8 text file. Paths relative to /work.', parameters: obj({ path: str }) } },
  { type: 'function', function: { name: 'write', description: 'Create or overwrite a file with exact content. Parents created.', parameters: obj({ path: str, content: str }) } },
  { type: 'function', function: { name: 'edit', description: 'Replace exact oldText with newText. oldText must occur exactly once. Read first; include neighboring lines if ambiguous.', parameters: obj({ path: str, oldText: str, newText: str }) } },
  { type: 'function', function: { name: 'bash', description: 'Simulated bash over /work only. ls, find, cat, grep, sed, printf. No network, node, python, or processes.', parameters: obj({ command: str }) } },
];

// One synthetic prior turn: a byte-exact append, a create, in Pouch's own tool output format.
export const FEWSHOT: LocalChatMessage[] = [
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

export const TJS = Object.freeze({ STEP_CAP, BUDGET, MAX_NEW, SYSTEM, TOOLS, FEWSHOT });

// ── localhost: a model on the user's own server (src/localhost.ts applies it).
// Main's prompt and page tools, without subagents: one local server runs a few
// requests at a time (oMLX: 4) and a second model may not fit in memory, so a
// Localhost agent works alone. The step cap stops a small model looping on a
// failing tool; capable models finished every qualification task well inside it.
export const LOCALHOST_STEP_CAP = 24;
export const LOCALHOST_DROP_TOOLS = ['subagent', 'agents'];
export const LOCALHOST_NOTE = 'You run on a model server on the user\'s own computer (Localhost). Subagents are not available here: ignore guidance about the subagent tool and do the work yourself.';

// pi-durable agent configs. tool/peerTool are subagents.ts's two tools: a
// subagent loses `subagent` and gains `agents` (list, message, join).
export interface ProfileAgentInput {
  model: ModelRef | undefined; name: string; ref: string; task: string; ns?: string[]; toLabel: string;
  tool: ToolRegistration; peerTool: ToolRegistration;
}
export const PROFILES = Object.freeze({
  main: { name: 'main', tools: 'all', loop: 'multi-step', limits: 'daily allowance' },
  subagent: { name: 'subagent', tools: 'trimmed', loop: 'multi-step', limits: 'per-pair caps',
    agent: ({ model, name, ref, task, ns, tool, peerTool }: ProfileAgentInput): AgentChange => ({ model, modelTools: { remove: [tool], add: [peerTool] }, instructions: instructions(name, ref, task, ns) }) },
  oneshot: { name: 'oneshot', tools: 'none', loop: 'one call', limits: '1 request',
    agent: ({ model, name, ref, toLabel }: ProfileAgentInput): AgentChange => ({ model, extensions: [], modelTools: [], instructions: oneshotInstructions(name, ref, toLabel) }) },
  transformersjs: { name: 'transformersjs', tools: TOOLS, loop: 'multi-step', limits: `${STEP_CAP} steps, ${BUDGET} tokens`, recipe: TJS },
  localhost: { name: 'localhost', tools: { remove: LOCALHOST_DROP_TOOLS }, loop: 'multi-step', limits: `${LOCALHOST_STEP_CAP} steps, no allowance` },
});
export const isLocalhost = (modelId: unknown) => String(modelId ?? '').startsWith('localhost:');

// Which profile an agent runs: the provider decides first (a Transformers.js
// model always gets its qualified recipe), then the agent's role.
export function profileOf({ modelId, child = false, oneshot = false }: { modelId?: string; child?: boolean; oneshot?: boolean } = {}) {
  if (isLocal(modelId)) return 'transformersjs';
  if (isLocalhost(modelId)) return 'localhost';
  return oneshot ? 'oneshot' : child ? 'subagent' : 'main';
}
