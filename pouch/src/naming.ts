// Session titles (story D8). One tool-less completion on the session's own
// provider and model (agent.complete), so the digest goes exactly where the
// session's turns already go: BayLeaf Sealed encrypts it to the attested
// enclave (one request from the daily allowance); Localhost sends it to the
// user's loopback server; Transformers.js generates it in this page. There is
// no fallback: if the session's provider is unavailable, there is no title,
// and no other provider is asked. costNote() words what a call costs and
// where it runs, for every label, tooltip and hint that says so (compaction too).
import { el, icon } from './dom.ts';
import { isLocal, isLocalhost } from './profiles.ts';
import type { ThreadItem } from './agent-types.ts';

export const providerOf = (modelId: unknown) => isLocal(modelId) ? 'Transformers.js' : isLocalhost(modelId) ? 'Localhost' : 'BayLeaf Sealed';
export function costNote(modelId: unknown) {
  if (isLocal(modelId)) return 'runs in this browser (Transformers.js), no allowance';
  if (isLocalhost(modelId)) return 'runs on your machine (Localhost), no allowance';
  return '1 request from today\'s BayLeaf Sealed allowance';
}
// New tokens per title: a reasoning model may think first (Sealed, Localhost);
// the in-browser model answers directly and must stay short.
const titleTokens = (modelId: unknown) => isLocal(modelId) ? 24 : 400;

const CAP = 2000; // characters of conversation sent for naming

const clip = (s: string | null | undefined, n: number) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// Turns from a normalized view: each user message and what followed it.
interface Turn { user: string; reply: string; tools: Set<string> }
function turnsOf(items: readonly ThreadItem[]) {
  const turns: Turn[] = [];
  for (const it of items) {
    if (it.type === 'user') turns.push({ user: it.text, reply: '', tools: new Set() });
    else if (turns.length && it.type === 'assistant' && it.text) turns.at(-1)!.reply = it.text;
    else if (turns.length && it.type === 'tool') turns.at(-1)!.tools.add(it.name);
  }
  return turns;
}
const turnText = (t: Turn, n: number) => [`User: ${clip(t.user, n)}`, t.tools.size ? `Tools used: ${[...t.tools].join(', ')}` : '', t.reply ? `Assistant: ${clip(t.reply, n)}` : '']
  .filter(Boolean).join('\n');

// After the first turn: that turn. For the sparkle: the first message plus
// the last three turns, so a long conversation is named for where it went.
export function digest(items: readonly ThreadItem[] | undefined, recent = false) {
  const turns = turnsOf(items ?? []);
  if (!turns.length) return '';
  if (!recent || turns.length === 1) return clip(turnText(turns[0], 900), CAP);
  const tail = turns.slice(Math.max(1, turns.length - 3));
  return [`User (first message): ${clip(turns[0].user, 400)}`, ...tail.map((t) => turnText(t, 350))].join('\n\n').slice(0, CAP);
}

// complete: agent.complete, which routes by the model id's provider. 40 tokens
// was not enough for glm-5-3 to finish thinking, so Sealed and Localhost leave
// room (one request either way).
export type Complete = (modelId: string, prompt: string, opts: { maxTokens?: number; signal?: AbortSignal }) => Promise<string>;
export async function suggestTitle(complete: Complete | null | undefined, model: string, text: string) {
  if (!complete || !text) return null;
  const raw = await complete(model, 'Write a 2-5 word title for the conversation below, in its language. Output the title alone: no quotes, no explanation, no trailing period.\n\n<conversation>\n' + text + '\n</conversation>', { maxTokens: titleTokens(model) });
  return cleanTitle(raw ?? '');
}

// The last non-empty line (a model that thinks aloud ends with the answer),
// without markdown, quotes, a "Title:" prefix or a trailing period; 60 chars.
export function cleanTitle(raw: unknown) {
  const line = String(raw).split('\n').map((s) => s.trim()).filter(Boolean).at(-1) ?? '';
  let t = line.replace(/^(title|titel|título|titre|titolo)\s*[:：]\s*/i, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/^["'“”‘’«»「」]+|["'“”‘’«»「」]+$/g, '')
    .replace(/\s+/g, ' ').trim()
    .replace(/[.。]+$/, '').trim();
  if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, '') || t.slice(0, 60);
  return t || null;
}

// The in-place title field: replaces host with an input and a sparkle button.
// Enter or leaving the field saves, Esc cancels; the sparkle fills in a
// suggestion, which stays editable.
export interface TitleEditorOptions {
  value: string; tip: string; suggest(): Promise<string | null>;
  save(title: string, source: 'user' | 'auto'): unknown; done?(): unknown;
}
export function titleEditor(host: HTMLElement | null | undefined, { value, tip, suggest, save, done }: TitleEditorOptions) {
  if (!host?.isConnected) return;
  const input = el('input', { type: 'text', className: 'title-input', value, maxLength: 60, ariaLabel: 'Session title', placeholder: 'Session title' });
  const spark = el('button', { type: 'button', className: 'icon spark', ariaLabel: 'Suggest a title', title: tip }, icon('sparkles'));
  const wrap = el('span', { className: 'title-edit' }, input, spark);
  let suggested = null as string | null, naming = false, finished = false;
  const finish = async (keep: boolean) => {
    if (finished) return;
    finished = true;
    const t = input.value.trim().slice(0, 60);
    if (keep && t !== value) await save(t, t === suggested ? 'auto' : 'user');
    wrap.replaceWith(host!);
    await done?.();
    if (host!.isConnected) host!.focus();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  };
  // Leaving the field saves, unless focus moved to the sparkle or a suggestion is on its way.
  input.onblur = spark.onblur = () => setTimeout(() => { if (!naming && !wrap.contains(document.activeElement)) finish(true); }, 0);
  spark.onpointerdown = (e) => e.preventDefault(); // keep focus, and the edit, in the field
  spark.onclick = async () => {
    naming = true; spark.disabled = true; spark.classList.add('working');
    try {
      const t = await suggest();
      if (t && !finished) { suggested = t; input.value = t; }
    } finally {
      naming = false; spark.disabled = false; spark.classList.remove('working');
      if (!finished) { input.focus(); input.select(); }
    }
  };
  host.replaceWith(wrap);
  input.focus(); input.select();
}
