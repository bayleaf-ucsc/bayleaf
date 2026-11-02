// What agents are told must match what Pouch does (LANGUAGE.md). Guards the
// prompt text against drift: the ubiquitous-language gloss reaches every agent
// that gets main's prompt, the qualified transformersjs prompt stays without
// it, and no removed feature (change review, file undo) is promised.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UL_GLOSS, TJS } from '../src/profiles.ts';

const tools = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8');
const prompt = tools.slice(tools.indexOf('export async function systemPrompt'));

for (const term of ['agent', 'session', 'thread', 'workspace', 'namespace', 'steer', 'follow-up', 'no undo'])
  assert.ok(UL_GLOSS.includes(term), `UL_GLOSS names "${term}"`);
assert.ok(prompt.includes('${UL_GLOSS}'), "main's prompt includes UL_GLOSS");
assert.ok(!TJS.SYSTEM.includes("Pouch's terms"), 'transformersjs prompt stays verbatim (qualified)');
for (const stale of [/review a diff/i, /undo it/i, /reviewable changes/i, /Changed \d+ files/i])
  assert.ok(!stale.test(prompt), `main's prompt does not promise ${stale}`);
// HTML reports (Batch G): the agent knows to write self-contained files and link them,
// and is not told anything the viewer blocks will work (remote scripts, CDNs, fetch).
assert.match(prompt, /self-contained \.html file \(inline CSS and JS, images as data: URLs; nothing loads from the network/);
assert.match(prompt, /link it: it opens in the preview/);
for (const wrong of [/\bCDN\b/i, /<script src/i, /fetch\(/]) assert.ok(!wrong.test(prompt), `main's prompt does not suggest ${wrong}`);
assert.match(prompt, /\/task: this session's/, "main's /task is its own session's (src/ns/tasks.ts)");
// Add-ons (2026-11-01): main's bash tool names the `addons` command; the qualified
// transformersjs recipe is untouched and never mentions the retired `models` command.
assert.match(tools, /`addons list` shows optional tools and models kept in this browser/);
for (const s of [TJS.SYSTEM, ...TJS.TOOLS.map((x) => x.function.description)]) assert.ok(!/\bmodels (get|list)\b|\baddons\b/.test(s), 'transformersjs recipe stays verbatim');
console.log('ok prompt: UL gloss in main prompt, transformersjs verbatim, no removed features promised, HTML reports, addons');
