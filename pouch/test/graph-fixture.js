// A scripted fake Sealed endpoint for agent-graph tests (JOURNEYS G1-G12),
// shared by test/graphs-node.mjs (imported) and test/graphs-browser.mjs
// (bundled into the page). No network: it answers each chat completion from
// rules, keyed by which session asks (the subagent's name from its system
// prompt, or "main") and by what arrived since that session's last reply.
//
//   fake.rule({ who, when?(ctx), gate?, reply, sticky? })   first match wins, used once (sticky: kept)
//   reply: 'text' | [[toolName, args], ...] | (ctx) => either
//   ctx: { who, n (its request number, 1-based), since (text of every message
//          after its last reply), all (text of every message), body }
//
// A rule with `gate` matches but answers only once fake.gates[gate] is set,
// so a test decides when a step ends. Unmatched requests answer "ok" and are
// counted in fake.unmatched.
export function createFake() {
  const rules = [], requests = {}, unmatched = [], aborted = [];
  const gates = {};
  const enc = new TextEncoder();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (c) => typeof c === 'string' ? c : (c ?? []).map((b) => b.text ?? '').join('');
  const chunk = (delta, finish = null) => ({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] });
  const sse = (deltas) => new Response(new ReadableStream({ start(c) {
    for (const d of deltas) c.enqueue(enc.encode('data: ' + JSON.stringify(d) + '\n\n'));
    c.enqueue(enc.encode('data: [DONE]\n\n')); c.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
  let callN = 0;

  async function fetch(_url, init) {
    const body = JSON.parse(init.body);
    const sys = textOf(body.messages.find((m) => m.role === 'system')?.content);
    const who = /You are a subagent named "([^"]+)"/.exec(sys)?.[1] ?? /You are "([^"]+)" \(id s\d+\), a one-shot/.exec(sys)?.[1] ?? 'main';
    (requests[who] ??= []).push(body);
    // Stop must abort a request in flight (batch A): record which were.
    let done = false;
    init.signal?.addEventListener('abort', () => { if (!done) aborted.push({ who, n: requests[who].length }); }, { once: true });
    const lastA = body.messages.findLastIndex((m) => m.role === 'assistant');
    const ctx = {
      who, body, n: requests[who].length, sys,
      since: body.messages.slice(lastA + 1).map((m) => textOf(m.content)).join('\n'),
      all: body.messages.filter((m) => m.role !== 'system').map((m) => textOf(m.content)).join('\n'),
      tools: (body.tools ?? []).map((t) => t.function?.name),
    };
    const i = rules.findIndex((r) => (r.who === who || r.who === '*') && (!r.when || r.when(ctx)));
    let reply = 'ok';
    if (i < 0) unmatched.push({ who, n: ctx.n, since: ctx.since.slice(0, 200) });
    else {
      const r = rules[i];
      if (!r.sticky) rules.splice(i, 1);
      while (r.gate && !gates[r.gate]) {
        if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        await sleep(20);
      }
      reply = typeof r.reply === 'function' ? r.reply(ctx) : r.reply;
    }
    done = true;
    if (typeof reply === 'string') return sse([chunk({ role: 'assistant', content: '' }), chunk({ content: reply }), chunk({}, 'stop')]);
    return sse([chunk({ role: 'assistant', tool_calls: reply.map(([name, args], index) => ({ index, id: `call_${++callN}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }), chunk({}, 'tool_calls')]);
  }
  return {
    fetch, rules, requests, gates, unmatched, aborted,
    total: () => Object.values(requests).reduce((n, l) => n + l.length, 0),
    rule: (r) => { rules.push(r); return r; },
    // Every text a session's requests carried (for "never entered main's context").
    seen: (who) => (requests[who] ?? []).map((b) => b.messages.map((m) => textOf(m.content)).join('\n')).join('\n'),
    pending: () => rules.map((r) => `${r.who}${r.gate ? ` (gate ${r.gate})` : ''}`),
  };
}

// The panel flow (G2-G7) as rules: main spawns a chair, then four judges who
// send findings to the chair; the chair cross-examines argument and evidence
// (a peer exchange), then sends one prioritized review to main. Raw judge
// findings carry a RAW- marker, so a test can assert main never saw them.
export const JUDGES = ['argument', 'evidence', 'clarity', 'audience'];
export function panelRules(fake, { judgeGate } = {}) {
  const tagFrom = (name, ref) => `[from ${name} (${ref})]`;
  fake.rule({ who: 'main', when: (c) => /panel/.test(c.since), reply: [['subagent', { action: 'spawn', name: 'chair', task: 'Chair a review panel for /work/essay.md. Main (s1) will message you the judge ids; until then reply Ready and stop. Then join the judges, cross-examine any disagreement, and send one prioritized review to main (s1).', ns: ['/work/essay.md:ro'], report: false }]] });
  fake.rule({ who: 'main', when: (c) => /Started subagent "chair" \(id s2\)/.test(c.since), reply: JUDGES.map((j) => ['subagent', { action: 'spawn', name: `judge-${j}`, task: `Judge the ${j} of /work/essay.md. Send your findings to the chair, s2, with the agents tool, then stop.`, ns: ['/work/essay.md:ro'] }]) });
  fake.rule({ who: 'main', when: (c) => /judge-audience/.test(c.since) && /Started subagent/.test(c.since), reply: [['subagent', { action: 'message', to: 's2', text: 'Judges: s3 argument, s4 evidence, s5 clarity, s6 audience.' }]] });
  // The judges start once main has told the chair their ids (gate "judges").
  fake.rule({ who: 'main', when: (c) => /Sent to chair \(s2\)|woke it/.test(c.since), reply: () => { fake.gates.judges = true; return [['subagent', { action: 'join', ids: ['s2'] }]]; } });
  fake.rule({ who: 'main', when: (c) => /Prioritized review/.test(c.since), reply: 'The panel suggests:\n1. Name the thesis in the first paragraph.\n2. Cite a source for the 40% claim.\n3. Cut the second example.\nSay which to apply.' });

  fake.rule({ who: 'chair', reply: 'Ready.' });
  // A judge's message can wake the chair before main's ids do: acknowledge.
  fake.rule({ who: 'chair', sticky: true, when: (c) => /\[from judge-/.test(c.since) && !/Judges:|Joined:|Sent to|woke it|- s1 main/.test(c.since), reply: 'Noted.' });
  fake.rule({ who: 'chair', when: (c) => c.since.includes('[from main (s1)] Judges:'), reply: [['agents', { action: 'join', ids: ['s3', 's4', 's5', 's6'] }]] });
  fake.rule({ who: 'chair', when: (c) => /Joined:/.test(c.since), reply: [['agents', { action: 'list' }]] });
  fake.rule({ who: 'chair', when: (c) => /s4 judge-evidence/.test(c.since), reply: [
    ['agents', { action: 'message', to: 's3', text: 'Evidence (s4) says the 40% claim is unsupported; you called it the strongest point. Message s4 directly with your answer, then send me your conclusion.' }],
    ['agents', { action: 'message', to: 's4', text: 'Argument (s3) calls the 40% claim the strongest point. Message s3 directly with your answer, then send me your conclusion.' }],
  ] });
  fake.rule({ who: 'chair', when: (c) => /Sent to|woke it/.test(c.since), reply: [['agents', { action: 'join', ids: ['s3', 's4'] }]] });
  fake.rule({ who: 'chair', when: (c) => /Joined:/.test(c.since), reply: [['agents', { action: 'message', to: 's1', text: 'Prioritized review: 1. Name the thesis in the first paragraph. 2. Cite a source for the 40% claim (argument and evidence now agree). 3. Cut the second example.' }]] });
  fake.rule({ who: 'chair', when: (c) => /Sent to main/.test(c.since), reply: 'Sent the review to main.' });

  for (const [i, j] of JUDGES.entries()) {
    const me = `s${i + 3}`;
    fake.rule({ who: `judge-${j}`, gate: judgeGate?.(j) ?? 'judges', reply: [['agents', { action: 'message', to: 's2', text: `RAW-${j}: ${j === 'argument' ? 'the 40% claim is the strongest point' : j === 'evidence' ? 'the 40% claim is unsupported' : 'minor issues only'}.` }]] });
    fake.rule({ who: `judge-${j}`, when: (c) => /Sent to|woke it/.test(c.since) && !/\[from chair/.test(c.since), reply: 'Sent my findings to the chair.' });
    if (j === 'argument' || j === 'evidence') {
      const peer = j === 'argument' ? 's4' : 's3';
      fake.rule({ who: `judge-${j}`, when: (c) => c.since.includes(tagFrom('chair', 's2')), reply: [['agents', { action: 'message', to: peer, text: `RAW-${j}-peer: on the 40% claim, ${j === 'argument' ? 'I concede it needs a source' : 'a source would settle it'}.` }]] });
      fake.rule({ who: `judge-${j}`, when: (c) => /Sent to|woke it/.test(c.since) && c.all.includes(tagFrom('chair', 's2')), reply: [['agents', { action: 'message', to: 's2', text: `RAW-${j}-final: agreed with ${peer}, cite a source.` }]] });
      fake.rule({ who: `judge-${j}`, when: (c) => /Sent to|woke it/.test(c.since), reply: 'Done.' });
      // The peer's message may arrive after this judge finished: it wakes it once more.
      fake.rule({ who: `judge-${j}`, when: (c) => c.since.includes(`(${peer})]`), reply: 'Noted; nothing to add.' });
    }
    void me;
  }
}
