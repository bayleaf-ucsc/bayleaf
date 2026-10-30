// Walkthrough scenes: what WALKTHROUGH.md shows, and how to reach it.
//
// A scene: { id, stories (JOURNEYS IDs; "D19.2" is the second D19),
//   reenactment? (a model-dependent flow, labeled as such), viewport?
//   ('phone' is 390x844), theme? ('dark'), welcome? (keep the first-visit
//   card), shots: [{ id, target, stories?, alt, caption, density?, pad?,
//   grow? }], run(ctx) }.
// ctx: page, rule(r) (a fake-model rule, test/graph-fixture.js: who, when,
//   gate, reply, sticky; `when` is an expression over c, or a self-contained
//   function, run in the page), open(gate), send(text), idle(), seed(files),
//   panel(name), sidebar(), waitRequests(who, n), shot(id, opts).
// A target is a selector or a list (the crop is their union box plus
// padding); "last:sel" picks the last match. Captions are hand-written here;
// a shot without them gets a drafted one only with --draft-captions.

const UTIL = 'export function range(n) {\n  const out = [];\n  for (let i = 0; i <= n; i++) out.push(i);\n  return out;\n}\n';
const ESSAY = '# Walkable towns\n\nTowns should be walkable.\n\nWalking cuts car trips by 40%.\n\nA second example about parking.\n\nSo plan for feet.\n';
const CSV = 'name,dept,salary,note\n"Ortiz, Ana",ENG,"$85,000","said ""yes"""\nLee,eng,"$91,500",\n"Kim, Jo",OPS,n/a,"two\nlines"\nPatel,ops,"$64,000",\nNguyen,XYZ,"$70,000",unknown code\n';
const REPORT_JS = `// Median salary per department from export.csv (RFC 4180 quoting).
function parse(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') q = false; else f += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\\n') { row.push(f); rows.push(row); row = []; f = ''; } else f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const [head, ...rows] = parse(fs.readFile('export.csv'));
const by = {};
for (const r of rows) {
  const dept = r[1].toUpperCase(), pay = Number(r[2].replace(/[$,]/g, ''));
  if (!['ENG', 'OPS'].includes(dept) || !pay) continue;
  (by[dept] ??= []).push(pay);
}
const median = (a) => { a.sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const out = 'dept,people,median_salary\\n' + Object.keys(by).sort().map((d) => d + ',' + by[d].length + ',' + median(by[d])).join('\\n') + '\\n';
fs.writeFile('report.csv', out);
print(out);
`;

// A desk turn: read, edit, a markdown reply naming the file.
async function deskTurn({ rule, send, idle }) {
  await rule({ who: 'main', when: '/Fix util/.test(c.since)', reply: [['read', { path: '/work/util.js' }]] });
  await rule({ who: 'main', when: '/i <= n/.test(c.since)', reply: [['edit', { path: '/work/util.js', edits: [{ oldText: 'i <= n', newText: 'i < n' }] }]] });
  await rule({ who: 'main', when: '/Applied/.test(c.since)', reply: 'Fixed the off-by-one in /work/util.js: the loop ran while `i <= n`, so `range(3)` returned four numbers.\n\n```js\nfor (let i = 0; i < n; i++) out.push(i);\n```\n\nNow `range(3)` is `[0, 1, 2]`.' });
  await send('range(3) should give 0, 1, 2. Fix util.js.');
  await idle();
}

// A background subagent ("scout") whose steps wait on gates s1, s2.
async function scout({ rule, send, page }) {
  await rule({ who: 'main', when: '/parking minimums/.test(c.since) && !/Started/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'scout', task: 'Find three studies on parking minimums and save short notes to /work/notes/parking.md.' }]] });
  await rule({ who: 'main', when: '/Started subagent "scout"/.test(c.since)', reply: 'Scout is looking into parking minimums in the background. Meanwhile, want me to tighten the intro?' });
  await rule({ who: 'scout', gate: 's1', reply: [['bash', { command: 'ls /work' }]] });
  await rule({ who: 'scout', gate: 's2', reply: [['write', { path: '/work/notes/parking.md', content: '# Parking minimums\n\n- Shoup (2005): minimums raise housing costs.\n- Manville (2013): removal adds units.\n- Gabbe (2020): Seattle builds fewer stalls.\n' }]] });
  await rule({ who: 'scout', reply: 'Saved three peer-reviewed studies to /work/notes/parking.md.' });
  await rule({ who: 'main', when: '/Saved three/.test(c.since)', reply: 'Scout saved three studies to /work/notes/parking.md; the strongest is Manville (2013).' });
  await send('Look into parking minimums while we keep going.');
  await page.waitForSelector('.tray-row[data-kind="subagent"]', { timeout: 15000 });
}

export const scenes = [
  {
    id: 'arrive', stories: ['A1', 'A5'], welcome: true,
    shots: [
      { id: 'arrive-welcome', target: '#welcome', stories: ['A5', 'L3'],
        alt: 'First-visit card in the chat pane: what Pouch is, where files are kept, Upload files and Mount a folder buttons.',
        caption: 'One screen says what Pouch is and where files are kept; dismissing it is remembered.' },
      { id: 'arrive-usage', target: '#usage', maxHeight: 330, stories: ['A2', 'A6'],
        alt: 'Usage panel showing about 187 of 200 Sealed requests left today under Campus Pass, with the reset time.',
        caption: 'Campus Pass needs no sign-in; the allowance is shared by the network address, and the reset time is stated.' },
      { id: 'arrive-trust', target: '#trust', maxHeight: 420, stories: ['T1', 'T2', 'T3', 'T4'],
        alt: 'The trust panel: enclave verification facts, the one network peer, the build id and a shasum recipe.',
        caption: 'What BayLeaf can see, stated in the page: attestation facts, one peer (api.bayleaf.dev), and how to check the build.' },
    ],
    async run({ page, shot, panel }) {
      await shot('arrive-welcome');
      await page.click('#welcome-dismiss');
      await panel('usage'); await page.waitForSelector('#usage .big', { timeout: 15000 });
      await shot('arrive-usage');
      await panel('trust');
      await shot('arrive-trust');
    },
  },
  {
    id: 'desk', stories: ['D1', 'D2'],
    shots: [
      { id: 'desk-turn', target: ['last:#log .msg.user', 'last:#log .msg.assistant'], stories: ['D1', 'D2', 'D11', 'D23', 'R7'],
        alt: 'A turn: the user asks to fix util.js; Read and Edit tool pills; a markdown reply with a code block; the turn footer with the model and time.',
        caption: 'Tool calls show as pills while they run; the reply is markdown; the footer names the model, the duration and the time.' },
      { id: 'desk-layout', target: '#app', density: 1, stories: ['A1', 'A7'],
        alt: 'The whole Pouch window at 1280 by 800: chat with the finished turn on the left, the Editor panel on the right, the icon rail at the edge.',
        caption: 'Chat first, one side panel at a time from the rail; panels and the sidebar resize and are remembered.' },
    ],
    async run(ctx) {
      await ctx.seed({ '/work/util.js': UTIL });
      await deskTurn(ctx);
      await ctx.shot('desk-turn');
      await ctx.shot('desk-layout');
    },
  },
  {
    id: 'conflict', stories: ['R4'],
    shots: [
      { id: 'conflict-bar', target: ['#editor-path', '#conflict-bar'], grow: 180, stories: ['R4', 'R1'],
        alt: 'The editor with unsaved user edits and a bar: the agent changed this file, with Show diff, Keep mine and Take theirs.',
        caption: 'The editor follows agent edits to the open file without losing yours: a conflict bar asks which to keep.' },
    ],
    async run(ctx) {
      await ctx.seed({ '/work/util.js': UTIL });
      await ctx.page.click('#tree .row[data-path="/work/util.js"]');
      await ctx.page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('range'), null, ctx.T);
      await ctx.page.click('.cm-content'); await ctx.page.keyboard.press('ControlOrMeta+End'); await ctx.page.keyboard.type('// my note');
      await ctx.rule({ who: 'main', when: '/JSDoc/.test(c.since)', reply: [['edit', { path: '/work/util.js', edits: [{ oldText: 'export function range(n) {', newText: '/** 0 .. n-1 */\nexport function range(n) {' }] }]] });
      await ctx.rule({ who: 'main', when: '/Applied/.test(c.since)', reply: 'Added a JSDoc line above range.' });
      await ctx.send('Add a JSDoc comment to range.');
      await ctx.idle();
      await ctx.shot('conflict-bar', { wait: '#conflict-bar:not([hidden])' });
    },
  },
  {
    id: 'composer', stories: ['D22'],
    shots: [
      { id: 'composer-mention', target: ['#ac', '#composer'], stories: ['D22', 'I6'],
        alt: 'The composer with "@ut" typed and a list of matching paths, /work/util.js first.',
        caption: '@ lists paths in /work, /pouch, /tmp and mounted folders; $ lists skills; / lists commands.' },
      { id: 'composer-shield', target: ['#shield-pop', '#composer'], stories: ['D20.2', 'D17'],
        alt: 'The composer card with its shield popover open: this session is Sealed, encrypted to the enclave, with no egress grants.',
        caption: 'One card: tray, input, verbs on the left (Attach, the shield, Usage), model and Send on the right.' },
    ],
    async run(ctx) {
      await ctx.seed({ '/work/util.js': UTIL, '/work/notes/todo.md': '- fix range\n' });
      await ctx.typing('#input', '@ut');
      await ctx.page.waitForSelector('#ac:not([hidden])', ctx.T);
      await ctx.shot('composer-mention');
      await ctx.page.keyboard.press('Escape'); await ctx.page.fill('#input', '');
      await ctx.page.click('#shield-btn');
      await ctx.shot('composer-shield', { wait: '#shield-pop:not([hidden])' });
    },
  },
  {
    id: 'attach', stories: ['I8'],
    shots: [
      { id: 'attach-chips', target: '#composer', stories: ['I8'],
        alt: 'The composer with two attachment chips, export.csv and lookup.json, each with a size and a remove button, and a typed request.',
        caption: 'Attach, drop or paste: files land in /work/.attachments/ byte for byte, and nothing is sent until you press Send.' },
    ],
    async run({ page, shot }) {
      await page.locator('#attachment-picker').setInputFiles([{ name: 'export.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) }, { name: 'lookup.json', mimeType: 'application/json', buffer: Buffer.from('{"ENG":"Engineering","OPS":"Operations"}') }]);
      await page.waitForFunction(() => document.querySelectorAll('.attachment').length === 2);
      await page.fill('#input', 'Median salary per department, please.');
      await shot('attach-chips');
    },
  },
  {
    id: 'run', stories: ['D18'],
    shots: [
      { id: 'ns-trust', target: ['#ns-facts'], pad: 16, maxHeight: 300, stories: ['D20'],
        alt: 'The trust panel mount tables: what the agent sees, and the stopped run call with its own narrowed view.',
        caption: 'Every task sees a declared view of the files; the trust panel lists each mount table.' },
      { id: 'run-tray', target: '#composer', stories: ['D18', 'D21.2', 'D19'],
        alt: 'The activity tray above the input: "Running 1 · N requests this turn", a run row with its script, /task id, elapsed time and Stop.',
        caption: 'An in-flight run shows in the tray with its /task file; Stop ends that one call and the model carries on.' },
    ],
    async run({ page, rule, send, shot, idle, panel }) {
      await rule({ who: 'main', when: '/count/.test(c.since)', reply: [['run', { code: "let n = 0; const t = Date.now(); while (Date.now() - t < 4500) n++; print('counted ' + n)" }]] });
      await rule({ who: 'main', when: '/Stopped|counted|exit/i.test(c.since)', reply: 'The script was stopped before it finished.' });
      await send('count as high as you can in a few seconds');
      await page.waitForSelector('#tray-list li[data-kind="run"]', { timeout: 15000 });
      await shot('run-tray');
      await page.click('#tray-list li[data-kind="run"] .tray-stop');
      await idle();
      await panel('trust');
      await shot('ns-trust');
    },
  },
  {
    id: 'analyst', stories: ['D19.2'], reenactment: true,
    shots: [
      { id: 'analyst-turn', target: ['last:#log .msg.user', 'last:#log .msg.assistant'], stories: ['D19.2', 'D18'],
        alt: 'The analyst turn: write build_report.js, run it, and a markdown table of median salary by department naming report.csv and the script.',
        caption: 'A quoted CSV that defeats awk becomes a checked report.csv, and the script that made it stays in /work to rerun or hand on.' },
    ],
    async run(ctx) {
      await ctx.seed({ '/work/export.csv': CSV });
      await ctx.rule({ who: 'main', when: '/median/i.test(c.since) && !/Wrote/.test(c.since)', reply: [['write', { path: '/work/build_report.js', content: REPORT_JS }]] });
      await ctx.rule({ who: 'main', when: '/Wrote/.test(c.since)', reply: [['run', { path: '/work/build_report.js', files: ['/work/export.csv'] }]] });
      await ctx.rule({ who: 'main', when: '/median_salary/.test(c.since)', reply: 'Wrote /work/report.csv with /work/build_report.js (it parses the quoted fields itself):\n\n| dept | people | median salary |\n|---|---|---|\n| ENG | 2 | 88,250 |\n| OPS | 1 | 64,000 |\n\nSkipped: one `n/a` salary and one unknown code (XYZ). Rerun with Run script on the file.' });
      await ctx.send('Median salary per department from export.csv; keep the script.');
      await ctx.idle();
      await ctx.shot('analyst-turn');
    },
  },
  {
    id: 'egress', stories: ['D10', 'D13'],
    shots: [
      { id: 'egress-sheet', target: '#egress', stories: ['D10', 'D13'],
        alt: 'The approval sheet for a web search: the exact query, who can see it, and Deny (focused), Allow once and Allow for this session.',
        caption: 'Anything that would leave the pouch asks first, showing the exact payload and who can see it; Deny has focus.' },
    ],
    async run({ page, rule, send, shot, idle }) {
      await rule({ who: 'main', when: '/sources/.test(c.since)', reply: [['bash', { command: 'bayleaf web search parking minimums housing cost study' }]] });
      await rule({ who: 'main', reply: 'Understood, I will not search the web; working from your files instead.' });
      await send('Find sources on parking minimums.');
      await page.waitForSelector('#egress:not([hidden])', { timeout: 15000 });
      await shot('egress-sheet');
      await page.click('#egress-deny');
      await idle();
    },
  },
  {
    id: 'subagents', stories: ['D15', 'D16'],
    shots: [
      { id: 'subagents-tray', target: ['last:#log .subagent', '#composer'], stack: true, stories: ['D15', 'D16', 'D21.2'],
        alt: 'A subagent card for "scout" at the spawn point, and the tray above the input listing scout as running, with Stop.',
        caption: 'A background subagent: its card sits where it was spawned, and the tray lists it while it runs.' },
      { id: 'subagents-sidebar', target: ['#new', 'last:#session-list .session'], stories: ['S1', 'D9'],
        alt: 'The session sidebar with scout nested under the current session, marked working.',
        caption: 'Running children nest under their session with a live state.' },
      { id: 'subagents-view', target: ['#log .sa-view-head', 'last:#log .msg.user.steer'], grow: 40, stories: ['S2', 'S3'],
        alt: 'The subagent view: header "subagent of" the session with task, state, /task id and mounts; below, the user steering message labeled "You, while it worked".',
        caption: 'Open a subagent to read its live transcript and steer it; the message reaches its next step.' },
      { id: 'subagents-review', target: 'last:#log .subagent', stories: ['S4', 'S5', 'D16'],
        alt: 'The finished scout card expanded: a compact transcript, one line per tool call, the steering message marked, the final answer set apart.',
        caption: 'Back in the parent, the card shows the compact transcript and counts the steering; the report tells the parent model you steered.' },
    ],
    async run(ctx) {
      const { page, shot, open, sidebar, send, T } = ctx;
      await scout(ctx);
      await ctx.idle();
      await shot('subagents-tray');
      await sidebar();
      await page.waitForSelector('#session-list .s-child', T);
      await shot('subagents-sidebar');
      await page.click('.tray-row[data-kind="subagent"] button.tray-text');
      await page.waitForSelector('#log.child-view .sa-view-head', T);
      await send('Prefer peer-reviewed sources.');
      await open('s1'); // its next request carries the steer
      await page.waitForSelector('#log.child-view .msg.user.steer', T);
      await shot('subagents-view');
      await open('s2');
      await page.waitForSelector('#log .sa-ended', T);
      await page.click('#log .sa-ended button');
      await page.waitForSelector('#log:not(.child-view) .subagent', T);
      await page.waitForFunction(() => /Manville/.test(document.getElementById('log').textContent), null, T);
      await page.locator('#log .subagent details.sa-log > summary').last().click();
      await shot('subagents-review', { wait: '.subagent details.sa-log[open] .sa-final' });
    },
  },
  {
    id: 'panel', stories: ['G1'], reenactment: true,
    shots: [
      { id: 'graph-skill', target: ['#ac', '#composer'], stories: ['G1', 'D22'],
        alt: 'With essay.md open, "$pan" in the composer offers the bundled panel skill.',
        caption: '$ completes skills: "Use the panel skill." starts a review panel on the open draft.' },
      { id: 'panel-oneshot', target: '#composer', stories: ['G1', 'D21'],
        alt: 'The activity tray while the panel runs: four one-shot judges (argument, evidence, clarity, audience), each in its own color, and the requests spent this turn.',
        caption: 'The skill runs four one-shot judges in one round (one request each, no tools), then a one-shot chair; the tray counts the requests as they go.' },
      { id: 'panel-joined', target: ['last:#log .subagent', 'last:#log .msg.assistant'], stories: ['G1', 'G7'],
        alt: 'The one-shot chair\'s card (finished, one request) edged in its own color, then main\'s reply with the panel\'s numbered suggestions.',
        caption: 'Each one-shot keeps a compact card in its color; main shows the chair\'s merged suggestions and asks which to apply.' },
    ],
    async run(ctx) {
      const { page, shot, T } = ctx;
      await ctx.seed({ '/work/essay.md': ESSAY });
      await page.click('#tree .row[data-path="/work/essay.md"]');
      await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('Walkable towns'), null, T);
      await page.evaluate(() => { window.fakeTitle = 'Essay panel review'; });
      await ctx.typing('#input', '$pan');
      await page.waitForSelector('#ac:not([hidden]) >> text=panel', T);
      await shot('graph-skill');
      await page.press('#input', 'Enter');
      // The one-shot flow, as the bundled skill says (one request per judge).
      const JUDGES = ['argument', 'evidence', 'clarity', 'audience'];
      await ctx.rule({ who: 'main', when: '/panel/.test(c.since) && !/oneshot/.test(c.since)', reply: [['read', { path: '/pouch/skills/panel/SKILL.md' }]] });
      await ctx.rule({ who: 'main', when: '/oneshot/.test(c.since)', reply: JUDGES.map((j) => ['subagent', { action: 'spawn', mode: 'oneshot', background: false, name: `judge-${j}`, task: `Judge only the ${j} of the attached draft.`, files: ['/work/essay.md'] }]) });
      for (const j of JUDGES) await ctx.rule({ who: `judge-${j}`, gate: 'judges', reply: `${j}: ${j === 'evidence' ? 'the 40% claim needs a source' : 'mostly fine'}.` });
      await ctx.rule({ who: 'main', when: '/needs a source/.test(c.since) && !/REVIEW/.test(c.since)', reply: [['subagent', { action: 'spawn', mode: 'oneshot', background: false, name: 'chair', files: ['/work/essay.md'], task: 'Chair a review panel: merge the four findings into numbered suggestions.' }]] });
      await ctx.rule({ who: 'chair', reply: 'REVIEW: 1. Cite a source for the 40% claim (evidence). 2. Name the thesis first (argument).' });
      await ctx.rule({ who: 'main', when: '/REVIEW:/.test(c.since)', reply: 'The panel suggests:\n1. Cite a source for the 40% claim.\n2. Name the thesis in the first paragraph.\nSay which to apply.' });
      await page.type('#input', 'Review this draft.');
      await page.press('#input', 'Enter');
      await page.waitForFunction(() => ['argument', 'evidence', 'clarity', 'audience'].every((j) => (window.fake.requests['judge-' + j]?.length ?? 0) >= 1), null, T);
      await shot('panel-oneshot');
      await ctx.open('judges');
      await page.waitForFunction(() => /The panel suggests/.test(document.getElementById('log').textContent), null, { timeout: 30000 });
      await ctx.idle();
      await shot('panel-joined');
    },
  },
  {
    id: 'graph', stories: ['G2', 'G3'], reenactment: true,
    shots: [
      { id: 'graph-sidebar', target: ['#new', 'last:#session-list .session'], stories: ['G2', 'G3', 'G6'],
        alt: 'The sidebar with five subagents nested under the session: chair and four judges (argument, evidence, clarity, audience) with states and message counts.',
        caption: 'Main spawns a chair, then four judges in one round; all five nest under the session with live states.' },
      { id: 'graph-chair', target: '#log .sa-view-head', stories: ['G4', 'G5', 'G9'],
        alt: 'The chair subagent view: per-edge message counts in the header and incoming messages labeled by sender, from main and from each judge.',
        caption: 'The chair hears from each judge by id, cross-examines the two who disagree, and sends one review to main.' },
      { id: 'graph-review', target: ['last:#log .msg.from', 'last:#log .msg.assistant'], stories: ['G7', 'G8'],
        alt: 'Main reply with three numbered suggestions from the panel and an invitation to say which to apply.',
        caption: 'Main receives only the chair review (no judge text reaches it) and offers numbered suggestions to apply.' },
    ],
    async run(ctx) {
      const { page, shot, sidebar, T } = ctx;
      await ctx.seed({ '/work/essay.md': ESSAY });
      await page.click('#tree .row[data-path="/work/essay.md"]');
      await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('Walkable towns'), null, T);
      await page.evaluate(() => { window.fakeTitle = 'Essay agent graph'; });
      // Judges are gated one by one after the chair has the ids, so message
      // counts do not depend on which judge the scheduler runs first.
      await page.evaluate(() => window.panelRules(window.fake, { judgeGate: (j) => 'j-' + j }));
      // A hand-built graph the user asks for (agents that message each other), not the skill.
      await page.type('#input', 'review this draft with a panel of agents that message each other by id');
      await page.press('#input', 'Enter');
      await page.waitForFunction(() => window.fake.seen('chair').includes('Judges:') && (window.fake.requests['judge-audience']?.length ?? 0) >= 1, null, T);
      for (const j of ['argument', 'evidence', 'clarity', 'audience']) {
        await ctx.open('j-' + j);
        await ctx.waitRequests('judge-' + j, 2); // its findings are sent
        await page.waitForTimeout(100);
      }
      await page.waitForFunction(() => /The panel suggests/.test(document.getElementById('log').textContent), null, { timeout: 30000 });
      await ctx.idle();
      await sidebar();
      await page.waitForFunction(() => document.querySelectorAll('#session-list .s-child').length === 5, null, T);
      await shot('graph-review');
      await shot('graph-sidebar');
      await page.click('#session-list .s-child .s-child-open >> text=chair');
      await page.waitForSelector('#log.child-view .sa-view-head', T);
      await page.click('.sa-view-head .sa-more-btn'); // the per-edge counts sit under Details once scrolled
      await shot('graph-chair');
    },
  },
  {
    id: 'sendmode', stories: ['D25', 'D26', 'D27'],
    shots: [
      { id: 'sendmode-menu', target: ['#sendmode-menu', '#composer'], stories: ['D26', 'D25'],
        alt: 'While Pouch works: the round Stop button, a split Steer button and its menu: Steer now, Queue for after this turn, Stop and send.',
        caption: 'While Pouch works, Enter steers (read after the current step), Alt+Enter queues for after the turn; the menu offers both and Stop and send.' },
      { id: 'sendmode-tray', target: '#composer', stories: ['D27', 'D21.2'],
        alt: 'The tray with two pending inputs: "Steering, after current step" with Cancel, and "Queued, after this turn" with Edit, Steer now and Cancel.',
        caption: 'Pending input waits in the tray, where it can be cancelled, edited or promoted.' },
      { id: 'sendmode-paused', target: '#composer', stories: ['D29'],
        alt: 'After Stop: one tray row "Paused after Stop" holding both messages, with Send and Cancel.',
        caption: 'Stop never sends: unread steering and the queued message become one paused item.' },
    ],
    async run({ page, rule, send, shot, T }) {
      await rule({ who: 'main', when: '/tidy/.test(c.since)', gate: 'a', reply: [['bash', { command: 'ls /work' }]] });
      await rule({ who: 'main', gate: 'b', reply: 'Tidied.' });
      await send('tidy the notes folder');
      await page.waitForSelector('#sendmode:not([hidden])', T).catch(() => {});
      await page.fill('#input', 'use British spelling');
      await page.click('#sendmode-more');
      await shot('sendmode-menu', { wait: '#sendmode-menu:not([hidden])' });
      await page.keyboard.press('Escape');
      await page.press('#input', 'Enter');
      await page.waitForSelector('.tray-row[data-kind="steer"]', T);
      await page.fill('#input', 'then summarize what changed');
      await page.press('#input', 'Alt+Enter');
      await page.waitForSelector('.tray-row[data-kind="queued"]', T);
      await shot('sendmode-tray');
      await page.click('#send');
      await shot('sendmode-paused', { wait: '.tray-row.paused' });
    },
  },
  {
    id: 'watch', stories: ['G13', 'G14', 'G16'], reenactment: true,
    shots: [
      { id: 'watch-tray', target: ['last:#log .msg.assistant', '#composer'], stack: true, stories: ['G13'],
        alt: 'Main says in one line that it is watching essay.md; the tray shows "Watching essay.md: offer to re-run the panel", changes by you, with Stop watching.',
        caption: 'Asked to wait for your revision, main watches the file and says so in one line; the tray shows the watch.' },
      { id: 'watch-woken', target: ['last:#log .msg.from', 'last:#log .msg.assistant'], stories: ['G14'],
        alt: 'A turn labeled "Woken by watch w1: offer to re-run the panel" after the user saved essay.md, and main offering to re-run the panel.',
        caption: 'Your save wakes main with a one-line event (no file text) and your note; it offers the next step.' },
      { id: 'watch-waiting', target: '#composer', stories: ['G16'],
        alt: 'The tray shows "Waiting for files in data: clean your CSV exports" with Cancel.',
        caption: 'Files not here yet: main waits for them instead of polling, and the tray says what it is waiting for.' },
    ],
    async run(ctx) {
      const { page, rule, send, shot, idle, T } = ctx;
      await ctx.seed({ '/work/essay.md': ESSAY });
      await rule({ who: 'main', when: '/revise it myself/.test(c.since)', reply: [['watch', { action: 'watch', paths: ['/work/essay.md'], by: 'user', note: 'offer to re-run the panel' }]] });
      await rule({ who: 'main', when: '/Watching/.test(c.since)', reply: 'I am watching essay.md; save your revision and I will offer to re-run the panel.' });
      await send('I will revise it myself first.');
      await idle();
      await page.waitForSelector('.tray-row[data-kind="watch"]', T);
      await shot('watch-tray');
      await rule({ who: 'main', when: '/\\[from files\\]/.test(c.since)', reply: 'You added a closing line to essay.md. Re-run the whole panel, or only the judges for the paragraphs you touched?' });
      await page.click('#tree .row[data-path="/work/essay.md"]');
      await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('Walkable towns'), null, T);
      await page.click('.cm-content'); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type('\nA new closing line.');
      await page.keyboard.press('ControlOrMeta+s');
      await page.waitForSelector('#log .msg.from.watch', T);
      await idle();
      await shot('watch-woken');
      await rule({ who: 'main', when: '/not here yet/.test(c.since)', reply: [['bash', { command: 'mkdir -p /work/data' }], ['watch', { action: 'watch', paths: ['/work/data/*.csv'], once: true, note: 'clean your CSV exports' }]] });
      await rule({ who: 'main', when: '/Watching/.test(c.since)', reply: 'Drop the CSV exports into /work/data and I will start.' });
      await send('Help me clean my CSV exports, they are not here yet.');
      await idle();
      await page.waitForSelector('.tray-row[data-kind="watch"]:has-text("Waiting for files")', T);
      await shot('watch-waiting');
    },
  },
  {
    id: 'offline', stories: ['F1'],
    shots: [
      { id: 'offline-composer', target: ['#composer', '#status'], stories: ['F1'],
        alt: 'The composer while offline: a grey shield, Send refused, and the status line "Offline: the model is unreachable".',
        caption: 'When the network drops, files, editor and run keep working; the composer says plainly that the model is unreachable.' },
    ],
    async run({ page, context, shot, T }) {
      await page.fill('#input', 'Draft kept while offline');
      await context.setOffline(true);
      await page.evaluate(() => dispatchEvent(new Event('offline')));
      await page.waitForFunction(() => /Offline/.test(document.getElementById('status').textContent), null, T);
      await shot('offline-composer');
      await context.setOffline(false);
    },
  },
  {
    id: 'local', stories: ['F4'], reenactment: true,
    shots: [
      { id: 'local-turn', target: [['last:#log .msg.user', 'last:#log .msg.assistant'], '#composer'], stack: true, stories: ['F4'],
        alt: 'A turn on the Local lane: the picker reads "Local: LFM3 1.7B (on this device)", a Read tool pill and a short answer.',
        caption: 'The Local lane answers and runs tools on this device with nothing sent; switching lanes is always explicit.' },
    ],
    async run(ctx) {
      const { page, shot, send, idle } = ctx;
      await ctx.seed({ '/work/notes.md': '- buy stamps\n- call the library\n- send the draft\n' });
      await page.selectOption('#model', 'local:lfm3-1.7b');
      await page.evaluate(() => { window.localScript = ['<tool_call>\n<function=read>\n<parameter=path>\nnotes.md\n</parameter>\n</function>\n</tool_call>', 'notes.md lists three tasks: buy stamps, call the library, send the draft.']; });
      await send('What is in notes.md?');
      await idle();
      await shot('local-turn');
    },
  },
  {
    id: 'sessions', stories: ['D8', 'D9', 'D12'],
    shots: [
      { id: 'sessions-sidebar', target: ['#new', 'last:#session-list .session'], stories: ['D3', 'D8', 'D9'],
        alt: 'The session sidebar with two automatically named sessions, the current one highlighted.',
        caption: 'Sessions are named after the first turn and can be switched, renamed, compacted and deleted from the sidebar.' },
      { id: 'sessions-revert', target: '#sheet', pad: 2, stories: ['D12'],
        alt: 'The "Revert to here?" sheet counting the messages that fold into another branch, saying files stay as they are, with Revert and Cancel.',
        caption: 'Revert forks the conversation just after a message; later messages fold into a dimmed other branch, files stay as they are, and it can be undone.' },
    ],
    async run(ctx) {
      const { page, shot, sidebar, idle, T } = ctx;
      await ctx.seed({ '/work/util.js': UTIL });
      await page.evaluate(() => { window.fakeTitle = 'Parking notes'; });
      await ctx.rule({ who: 'main', when: '/parking/.test(c.since)', reply: 'Here are three angles on parking minimums.' });
      await ctx.send('Ideas for a note on parking?');
      await idle();
      await page.waitForFunction(() => /Parking notes/.test(document.getElementById('title').textContent), null, T);
      await page.click('#new-top');
      await page.waitForFunction(() => /New session/.test(document.getElementById('title').textContent) && !document.querySelector('#log .msg'), null, T);
      await page.waitForTimeout(300);
      await page.evaluate(() => { window.fakeTitle = 'Fix range off-by-one'; });
      await deskTurn(ctx);
      await page.waitForFunction(() => /Fix range/.test(document.getElementById('title').textContent), null, T);
      await sidebar();
      await shot('sessions-sidebar');
      await ctx.rule({ who: 'main', when: '/test/.test(c.since)', reply: [['write', { path: '/work/util.test.js', content: "import { range } from './util.js';\nconsole.assert(range(3).length === 3);\n" }]] });
      await ctx.rule({ who: 'main', when: '/Wrote/.test(c.since)', reply: 'Added /work/util.test.js.' });
      await ctx.send('Also add a test.');
      await idle();
      await page.fill('#input', '/revert'); await page.press('#input', 'Enter');
      await shot('sessions-revert', { wait: '#sheet[open], #sheet:not([hidden])' });
    },
  },
  {
    id: 'phone', stories: ['D17'], viewport: 'phone',
    shots: [
      { id: 'phone-composer', target: ['last:#log .subagent', '#composer'], stack: true, stories: ['D17', 'D20.2', 'D21.2'],
        alt: 'At 390px wide: a subagent card and the composer with the tray, the input, 44px Attach and Send targets and the model picker.',
        caption: 'On a phone the same composer fits 390px with 44px targets.' },
    ],
    async run(ctx) { await scout(ctx); await ctx.idle(); await ctx.shot('phone-composer'); },
  },
  {
    id: 'phone-dark', stories: ['A8'], viewport: 'phone', theme: 'dark',
    shots: [
      { id: 'phone-composer-dark', target: ['last:#log .subagent', '#composer'], stack: true, stories: ['A8', 'D17'],
        alt: 'The same phone view in the dark theme.',
        caption: 'Light, Dark or System appearance, from Settings.' },
    ],
    async run(ctx) { await scout(ctx); await ctx.idle(); await ctx.shot('phone-composer-dark'); },
  },
  {
    id: 'leave', stories: ['L1'],
    shots: [
      { id: 'leave-erased', target: '#erased', stories: ['L1'],
        alt: 'After Erase all and a reload: a notice that everything this site stored was removed and empty databases are recreated at start.',
        caption: 'Erase all removes every trace this origin stored, and the reloaded page says so.' },
    ],
    async run({ page, shot }) {
      await page.click('#erase');
      await shot('leave-erased', { wait: '#erased:not([hidden])' });
    },
  },
];
