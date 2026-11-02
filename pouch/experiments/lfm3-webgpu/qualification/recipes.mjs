// Recipes and tool layers, the two halves of what a profile gives a small model.
//
// A recipe is text the model sees: system prompt, tool schemas, few-shot turns.
// A tool layer is how the tools behave and what their results say. qualify.mjs
// sends both to the worker as plain data, and records a sha256 of the recipe so a
// result can be tied to the exact text that was qualified.
//
//   recipe     source
//   profiles   pouch/src/profiles.ts transformersjs (TJS): exactly what ships (default)
//   v8         agent-v2's "v8" text, frozen here verbatim from the old worker.js
//   none       agent-v2's "v0" baseline: generic prompt, same four schemas, no few-shot
//   <path>     a JSON file { system, tools, fewshot } (a tuning candidate)
//
//   tool layer  behaviour
//   pouch       mirrors pouch/src/tools.ts: newline matching, one final newline on write,
//               informative empty-grep errors, its result wording (default)
//   v8          the experiment's tools with v8's normalization and grep explanation
//   v8-raw      the experiment's tools with neither (agent-v2 v0, quant "original")
//
// Note: profiles and v8 differ only in the few-shot tool-result wording (Pouch's
// "Edited lines now read" format versus the experiment's), so a profiles run is the
// first qualification of the shipped few-shot text against the shipped tool wording.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TJS } from '../../../src/profiles.ts';

const BASE = 'You are a concise coding assistant inside a browser. Use read, write, edit and bash tools for real file operations in /work. Never claim an edit without using a tool. Read files before editing. Tool errors are feedback: inspect and retry. No network, real processes, code execution or package installs. Finish with a concise summary.';
const FIDELITY = BASE + ' Make exactly the requested change and nothing more: never add blank lines, reformat, reorder or tidy surrounding text. To append a line to a file, use edit with oldText set to the current last line and newText set to that same line plus a newline plus the new line (no blank line in between) unless asked otherwise.';
const GROUNDED = FIDELITY + ' The workspace root and current directory is /work (there is no /workspace). Use relative paths like src/a.js.';

const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties) }), str = { type: 'string' };
const TOOLS = [
  { type: 'function', function: { name: 'read', description: 'Read a UTF-8 text file. Paths relative to /work.', parameters: obj({ path: str }) } },
  { type: 'function', function: { name: 'write', description: 'Create or overwrite a file with exact content. Parents created.', parameters: obj({ path: str, content: str }) } },
  { type: 'function', function: { name: 'edit', description: 'Replace exact oldText with newText. oldText must occur exactly once. Read first; include neighboring lines if ambiguous.', parameters: obj({ path: str, oldText: str, newText: str }) } },
  { type: 'function', function: { name: 'bash', description: 'Simulated bash over /work only. ls, find, cat, grep, sed, printf. No network, node, python, or processes.', parameters: obj({ command: str }) } },
];
const V8_FEWSHOT = [
  { role: 'user', content: 'Append the exact line b = 2 to the end of x.txt and create y.txt containing exactly ok followed by a newline. Read first; change nothing else.' },
  { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'read', arguments: { path: 'x.txt' } } }] },
  { role: 'tool', content: 'a = 1\n' },
  { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'edit', arguments: { path: 'x.txt', oldText: 'a = 1\n', newText: 'a = 1\nb = 2\n' } } }, { type: 'function', function: { name: 'write', arguments: { path: 'y.txt', content: 'ok\n' } } }] },
  { role: 'tool', content: 'Applied 1 edit to /work/x.txt\na = 1\nb = 2\n' },
  { role: 'tool', content: 'Wrote 3 characters to /work/y.txt' },
  { role: 'assistant', content: 'Appended b = 2 to x.txt and created y.txt.' },
];

export const RECIPES = {
  profiles: { system: TJS.SYSTEM, tools: TJS.TOOLS, fewshot: TJS.FEWSHOT, maxNew: TJS.MAX_NEW, stepCap: TJS.STEP_CAP, budget: TJS.BUDGET },
  v8: { system: GROUNDED, tools: TOOLS, fewshot: V8_FEWSHOT },
  none: { system: BASE, tools: TOOLS, fewshot: [] },
};
export const TOOL_LAYERS = {
  pouch: { format: 'pouch', normalizeNl: true, explainEmpty: true },
  v8: { format: 'v8', normalizeNl: true, explainEmpty: true },
  'v8-raw': { format: 'v8', normalizeNl: false, explainEmpty: false },
};

// Resolve a setup { recipe, toolLayer } to the data the worker needs.
export function resolveSetup({ recipe = 'profiles', toolLayer = 'pouch' } = {}, baseDir = '.') {
  const r = RECIPES[recipe] ?? JSON.parse(readFileSync(new URL(recipe, `file://${baseDir}/`), 'utf8'));
  const layer = TOOL_LAYERS[toolLayer];
  if (!layer) throw new Error(`unknown toolLayer ${toolLayer}`);
  const text = { system: r.system, tools: r.tools, fewshot: r.fewshot };
  return { recipe: text, layer, defaults: { maxNew: r.maxNew, stepCap: r.stepCap, budget: r.budget },
    recipeSha256: createHash('sha256').update(JSON.stringify(text)).digest('hex') };
}
