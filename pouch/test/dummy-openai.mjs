// A loopback stand-in for a local OpenAI-compatible server, shaped after oMLX 0.7.2
// (test/fixtures/omlx): /v1/models with max_model_len, Chat Completions and Responses
// streaming, a first "keepalive" chunk, reasoning_content, whole tool calls in one
// chunk, oMLX's usage extras, its error bodies (401 authentication_error, 404
// not_found_error, 400 context_length_exceeded) and its CORS behavior (a preflight
// from an origin not allowed gets 400 "Disallowed CORS origin").
//
// The model is a script, steered by markers in the latest user message:
//   [[call NAME {json}]]  first step calls that tool; after its result, a reply quoting it
//                         (a tool result carrying the marker asks for another call)
//   [[slow N]]            stream N text chunks 250 ms apart (for Stop)
//   [[fail STATUS]]       answer with that HTTP status
// Without markers it answers "ok: <the user's text>". cfg.queue (POST /__config or the
// returned cfg) overrides markers: each tool-offering step takes the next entry,
// { call: { name, arguments } } or { text }, so a screenshot shows no markers.
//
// Use: node test/dummy-openai.mjs [port]  or  import { startDummy } and call it.
// Control (node only, no CORS): GET /__log, POST /__config { key, cors, responses, loadMs }.
import http from 'node:http';

export function startDummy({ port = 0, key = null, cors = ['*'], responses = true, loadMs = 0, models = [['dummy-small', 32768], ['dummy-coder', 131072]] } = {}) {
  const cfg = { key, cors, responses, loadMs, models };
  const log = [];
  const loaded = new Set();
  const allowed = (o) => cfg.cors.includes('*') || cfg.cors.includes(o);
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const url = new URL(req.url, 'http://x');
    const body = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
    if (url.pathname.startsWith('/__')) {
      if (url.pathname === '/__config' && req.method === 'POST') Object.assign(cfg, JSON.parse(body || '{}'));
      if (url.pathname === '/__reset') { log.length = 0; loaded.clear(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(url.pathname === '/__log' ? log : cfg));
    }
    const entry = { method: req.method, path: url.pathname, origin: origin ?? null, auth: req.headers.authorization ? (req.headers.authorization === `Bearer ${cfg.key}` ? 'good' : 'bad') : 'none', mode: req.headers['sec-fetch-mode'] ?? null, headers: Object.keys(req.headers), at: Date.now() };
    log.push(entry);
    const h = { server: 'uvicorn', vary: 'Origin' };
    if (origin && allowed(origin)) h['access-control-allow-origin'] = cfg.cors.includes('*') ? '*' : origin;
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      const pre = { ...h, vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network', 'access-control-allow-methods': 'DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT, QUERY', 'access-control-max-age': '600', 'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '', 'content-type': 'text/plain; charset=utf-8' };
      if (!origin || !allowed(origin)) { res.writeHead(400, pre); return res.end('Disallowed CORS origin'); }
      res.writeHead(200, pre); return res.end('OK');
    }
    const json = (status, obj) => { res.writeHead(status, { ...h, 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const err = (status, type, message, code = null, param = null) => json(status, { error: { message, type, param, code } });
    if (url.pathname === '/' ) { res.writeHead(200, { ...h, 'content-type': 'text/html' }); return res.end('<p>dummy</p>'); }
    if (cfg.key) {
      if (!req.headers.authorization) return err(401, 'authentication_error', 'API key required');
      if (req.headers.authorization !== `Bearer ${cfg.key}`) return err(401, 'authentication_error', 'Invalid API key');
    }
    if (url.pathname === '/v1/models' && req.method === 'GET') return json(200, { object: 'list', data: cfg.models.map(([id, n]) => ({ id, object: 'model', created: 1793490344, owned_by: 'omlx', max_model_len: n })) });
    const chat = url.pathname === '/v1/chat/completions', resp = url.pathname === '/v1/responses' && cfg.responses;
    if (!chat && !resp) return url.pathname === '/v1/responses' ? err(404, 'not_found_error', 'Not Found') : err(404, 'not_found_error', 'Not Found');
    if (req.method !== 'POST') { res.writeHead(405, { ...h, 'content-type': 'application/json' }); return res.end('{"detail":"Method Not Allowed"}'); }
    let q;
    try { q = JSON.parse(body); } catch { return err(400, 'invalid_request_error', 'Invalid JSON'); }
    if (!q.model) return err(422, 'invalid_request_error', 'body -> model: Field required', null, 'model');
    const m = cfg.models.find(([id]) => id === q.model);
    if (!m) return err(404, 'not_found_error', `Model '${q.model}' not found. Available models: ${cfg.models.map(([id]) => id).join(', ')}`);
    const turn = chat ? fromChat(q) : fromResponses(q);
    entry.model = q.model; entry.tools = turn.tools; entry.system = turn.system.slice(0, 200); entry.lastUser = turn.lastUser; entry.afterTool = turn.afterTool; entry.stream = !!q.stream;
    const promptTokens = Math.ceil(JSON.stringify(q).length / 4);
    if (promptTokens > m[1]) return err(400, 'invalid_request_error', `Prompt is too long: ${promptTokens} tokens > ${m[1]} maximum context length`, 'context_length_exceeded');
    const fail = /\[\[fail (\d{3})\]\]/.exec(turn.lastUser);
    if (fail && !turn.afterTool) return err(Number(fail[1]), 'server_error', 'Scripted failure');
    const plan = turn.tools.length && cfg.queue?.length ? queued(cfg.queue.shift()) : script(turn);
    const load = loaded.has(q.model) ? 0 : cfg.loadMs; loaded.add(q.model);
    let closed = false; req.on('close', () => { closed = true; }); res.on('close', () => { closed = true; entry.closedEarly = !res.writableFinished; });
    if (!q.stream) {
      await sleep(load);
      return chat ? json(200, chatFull(q.model, plan, promptTokens, load)) : json(200, respFull(q.model, plan, promptTokens));
    }
    res.writeHead(200, { ...h, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    const send = chat ? (o) => res.write(`data: ${JSON.stringify(o)}\n\n`) : (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    const ctx = { send, closed: () => closed, model: q.model, promptTokens, load };
    if (chat) await streamChat(ctx, plan); else await streamResponses(ctx, plan);
    if (!closed) { if (chat) res.write('data: [DONE]\n\n'); res.end(); }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    const p = server.address().port;
    resolve({ port: p, url: `http://127.0.0.1:${p}`, cfg, log, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) });
  }));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : '';

function fromChat(q) {
  const msgs = q.messages ?? [];
  const last = msgs.findLastIndex((m) => m.role === 'user');
  return { system: msgs.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n'), lastUser: textOf(msgs[last]?.content), afterTool: msgs.slice(last + 1).some((m) => m.role === 'tool'),
    toolResult: textOf(msgs.findLast((m) => m.role === 'tool')?.content), tools: (q.tools ?? []).map((t) => t.function?.name) };
}
function fromResponses(q) {
  const items = typeof q.input === 'string' ? [{ role: 'user', content: q.input }] : q.input ?? [];
  const last = items.findLastIndex((m) => m.role === 'user');
  return { system: [q.instructions ?? '', ...items.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => textOf(m.content))].join('\n'), lastUser: textOf(items[last]?.content),
    afterTool: items.slice(last + 1).some((m) => m.type === 'function_call_output'), toolResult: String(items.findLast((m) => m.type === 'function_call_output')?.output ?? ''), tools: (q.tools ?? []).map((t) => t.name) };
}
// What the scripted model does this step: { reasoning, text: [chunks], call?, delay }.
function script(t) {
  const call = /\[\[call (\w+) (\{.*?\})\]\]/.exec(t.lastUser);
  const slow = /\[\[slow (\d+)\]\]/.exec(t.lastUser);
  if (!t.tools.length) return { reasoning: 'No tools: a summary or title.', text: ['Summary: the user asked for files to be read.'] };
  const again = /\[\[call (\w+) (\{.*?\})\]\]/.exec(t.toolResult);
  if (t.afterTool && again) return { reasoning: 'The tool asks for more.', text: ['\n\n'], call: { name: again[1], arguments: again[2] } };
  if (call && !t.afterTool) return { reasoning: `I should call ${call[1]}.`, text: ['\n\n'], call: { name: call[1], arguments: call[2] } };
  if (t.afterTool) return { reasoning: 'The tool answered.', text: ['Result seen: ', t.toolResult.split('\n')[0].slice(0, 80)] };
  if (slow) return { reasoning: 'Taking my time.', text: Array.from({ length: Number(slow[1]) }, (_, i) => `chunk ${i + 1} `), delay: 250 };
  return { reasoning: 'Answer plainly.', text: ['ok: ', t.lastUser.replace(/\[\[.*?\]\]/g, '').trim().slice(0, 120)] };
}
const queued = (q) => (q.call ? { reasoning: 'Next step.', text: ['\n\n'], call: { name: q.call.name, arguments: typeof q.call.arguments === 'string' ? q.call.arguments : JSON.stringify(q.call.arguments) } } : { reasoning: 'Done.', text: [q.text] });
const usageOf = (ctx, plan) => { const out = plan.text.join('').length + (plan.call ? 12 : 0) + 4; return { prompt_tokens: ctx.promptTokens, completion_tokens: out, total_tokens: ctx.promptTokens + out, input_tokens: ctx.promptTokens, output_tokens: out, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 4 }, ...(ctx.load ? { model_load_duration: ctx.load / 1000 } : {}), time_to_first_token: 0.1, total_time: 0.5, generation_tokens_per_second: 100 }; };
let n = 0;
async function streamChat(ctx, plan) {
  const id = `chatcmpl-${(++n).toString(16).padStart(8, '0')}`, base = { id, object: 'chat.completion.chunk' };
  const chunk = (delta, finish) => ({ ...base, created: 1793490358, model: ctx.model, choices: [{ index: 0, delta, ...(finish !== undefined ? { finish_reason: finish } : {}) }] });
  ctx.send({ ...base, created: 0, model: 'keepalive', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  await sleep(ctx.load);
  if (ctx.closed()) return;
  ctx.send(chunk({ role: 'assistant' }));
  ctx.send(chunk({ reasoning_content: plan.reasoning }));
  for (const t of plan.text) { if (ctx.closed()) return; if (plan.delay) await sleep(plan.delay); ctx.send(chunk({ content: t })); }
  if (plan.call) ctx.send(chunk({ tool_calls: [{ index: 0, id: `call_${(++n).toString(16)}`, type: 'function', function: plan.call }] }));
  ctx.send(chunk({}, plan.call ? 'tool_calls' : 'stop'));
  ctx.send({ ...base, created: 1793490358, model: ctx.model, choices: [], usage: usageOf(ctx, plan) });
}
async function streamResponses(ctx, plan) {
  let seq = 0; const e = (type, o) => ctx.send({ type, ...o, sequence_number: ++seq });
  const rid = `resp_${(++n).toString(16)}`, response = { id: rid, object: 'response', created_at: 1793490370, model: ctx.model, status: 'in_progress', output: [] };
  e('response.created', { response }); e('response.in_progress', { response });
  await sleep(ctx.load);
  if (ctx.closed()) return;
  const output = [];
  const rs = { type: 'reasoning', id: `rs_${rid}`, status: 'in_progress', summary: [] };
  e('response.output_item.added', { output_index: 0, item: rs });
  e('response.reasoning_summary_part.added', { item_id: rs.id, output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } });
  e('response.reasoning_summary_text.delta', { item_id: rs.id, output_index: 0, summary_index: 0, delta: plan.reasoning });
  e('response.reasoning_summary_text.done', { item_id: rs.id, output_index: 0, summary_index: 0, text: plan.reasoning });
  e('response.reasoning_summary_part.done', { item_id: rs.id, output_index: 0, summary_index: 0, part: { type: 'summary_text', text: plan.reasoning } });
  const rsDone = { ...rs, status: 'completed', summary: [{ type: 'summary_text', text: plan.reasoning }] }; output.push(rsDone);
  e('response.output_item.done', { output_index: 0, item: rsDone });
  const msg = { type: 'message', id: `msg_${rid}`, status: 'in_progress', role: 'assistant', content: [] };
  e('response.output_item.added', { output_index: 1, item: msg });
  e('response.content_part.added', { item_id: msg.id, output_index: 1, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  let text = '';
  for (const t of plan.text) { if (ctx.closed()) return; if (plan.delay) await sleep(plan.delay); text += t; e('response.output_text.delta', { item_id: msg.id, output_index: 1, content_index: 0, delta: t }); }
  e('response.output_text.done', { item_id: msg.id, output_index: 1, content_index: 0, text });
  const part = { type: 'output_text', text, annotations: [] };
  e('response.content_part.done', { item_id: msg.id, output_index: 1, content_index: 0, part });
  const msgDone = { ...msg, status: 'completed', content: [part] }; output.push(msgDone);
  e('response.output_item.done', { output_index: 1, item: msgDone });
  if (plan.call) {
    const fc = { type: 'function_call', id: `fc_${rid}`, call_id: `call_${rid}`, name: plan.call.name, arguments: '', status: 'in_progress' };
    e('response.output_item.added', { output_index: 2, item: fc });
    e('response.function_call_arguments.delta', { item_id: fc.id, output_index: 2, delta: plan.call.arguments });
    e('response.function_call_arguments.done', { item_id: fc.id, output_index: 2, arguments: plan.call.arguments });
    const fcDone = { ...fc, arguments: plan.call.arguments, status: 'completed' }; output.push(fcDone);
    e('response.output_item.done', { output_index: 2, item: fcDone });
  }
  const u = usageOf(ctx, plan);
  e('response.completed', { response: { ...response, status: 'completed', output, usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, total_tokens: u.total_tokens, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 4 } } } });
}
function chatFull(model, plan, pt) {
  return { id: 'chatcmpl-full', object: 'chat.completion', created: 1793490504, model, choices: [{ index: 0, message: { role: 'assistant', reasoning_content: plan.reasoning, content: plan.text.join(''), ...(plan.call ? { tool_calls: [{ id: 'call_full', type: 'function', function: plan.call }] } : {}) }, finish_reason: plan.call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: pt, completion_tokens: 10, total_tokens: pt + 10 } };
}
function respFull(model, plan, pt) {
  return { id: 'resp_full', object: 'response', model, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: plan.text.join(''), annotations: [] }] }], usage: { input_tokens: pt, output_tokens: 10, total_tokens: pt + 10 } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const d = await startDummy({ port: Number(process.argv[2] ?? 12399), key: process.env.DUMMY_KEY ?? null, cors: (process.env.DUMMY_CORS ?? '*').split(',') });
  console.log(`dummy OpenAI-compatible server on ${d.url}`);
}
