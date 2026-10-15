#!/usr/bin/env node
/** Synthetic workerd HTTP tests: no credentials, live inference or retained content. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
import { OpenAPIHono } from '@hono/zod-openapi';
import { decisionsRoutes } from './src/routes/decisions';
import { proxyRoutes } from './src/routes/proxy';
const app = new OpenAPIHono(); app.route('/v1', decisionsRoutes); app.route('/v1', proxyRoutes);
export default { fetch(request, env, ctx) {
  const limit = request.headers.get('X-Harness-Limit');
  return app.fetch(request, limit ? { ...env, CAMPUS_RPD_LIMIT: limit } : env, ctx);
} };
` }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
let calls = 0, mode = 'valid', catalogMode = 'valid';
const catalogQueries = [];
const decisionRequests = [];
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'decisions-test', modules: true,
  script: bundle.outputFiles[0].text, compatibilityDate: '2025-01-31',
  bindings: { CAMPUS_IP_RANGES: '127.0.0.0/8', DEV_LOOPBACK_AUTH: 'true', CAMPUS_POOL_KEY: 'synthetic',
    CAMPUS_RPD_LIMIT: '100', VERTEX_ENABLED: 'false', BEDROCK_ENABLED: 'false' },
  kvNamespaces: ['MODEL_STATUS', 'CAMPUS_RPD'], d1Databases: ['DB'],
  outboundService: async req => {
    const url = new URL(req.url);
    if (url.hostname === 'huggingface.co') return new Response('synthetic weights');
    if (url.pathname.endsWith('/models')) {
      catalogQueries.push(url.searchParams.toString());
      assert.equal(url.searchParams.get('output_modalities'), 'text,decisions');
      if (catalogMode === 'unavailable') return new Response(null, { status: 503 });
      if (catalogMode === 'malformed') return Response.json({ data: {} });
      return Response.json({ data: [
      { id: 'test/decision', hugging_face_id: 'test/decision', architecture: { output_modalities: ['decisions'], input_modalities: ['text'] } },
      { id: 'test/text', hugging_face_id: 'test/text', architecture: { output_modalities: ['text'] } },
      { id: 'test/closed', hugging_face_id: null, architecture: { output_modalities: ['decisions'] } },
    ] }); }
    if (['/api/v1/chat/completions', '/api/v1/responses', '/api/v1/completions'].includes(url.pathname)) {
      const body = await req.json(); calls++;
      assert.equal(body.model, 'test/text'); assert.deepEqual(body.models, ['test/text']);
      return Response.json({ choices: [{ message: { content: 'Synthetic fallback succeeded.' } }] });
    }
    assert.equal(url.href, 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(req.headers.get('Authorization'), 'Bearer synthetic');
    assert.equal(req.headers.get('x-session-id'), null);
    const body = await req.json(); calls++;
    decisionRequests.push(body);
    assert.equal(body.provider.zdr, true); assert.equal(body.provider.data_collection, 'deny');
    assert.equal(body.model, 'test/decision'); assert.equal(body.images, undefined);
    if (mode === 'budget') return Response.json({ error: { code: 403, message: 'Budget exhausted' } }, { status: 403 });
    if (mode === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://example.test' } });
    const answers = { yes: { type: 'noul', noul: .8 }, team: { type: 'choice', choice: 'a' },
      severity: { type: 'score', score: .5 } };
    if (mode === 'invalid') answers.yes.noul = 2;
    if (mode === 'wrong-choice') answers.team.choice = 'unknown';
    if (mode === 'wrong-score') answers.severity.score = 2;
    if (mode === 'wrong-type') answers.yes = { type: 'choice', choice: 'a' };
    if (mode === 'wrong-key') { delete answers.yes; answers.other = { type: 'noul', noul: .8 }; }
    return Response.json({ model: body.model, answers, usage: { input_tokens: 100, output_tokens: 0, cost: .00001 } });
  },
}] }));
const input = { model: 'openrouter:test/decision', state: { message: 'synthetic example' },
  provider: { zdr: false, data_collection: 'allow' }, questions: {
    yes: { type: 'noul', instructions: 'Yes?', criteria: { true: 'Supported', false: 'Unsupported' } },
    team: { type: 'choice', instructions: 'Team?', criteria: { a: 'A', b: 'B' } },
    severity: { type: 'score', instructions: 'Severity?', criteria: ['Low', 'High'] },
  } };
async function post(body, path = '/v1/decisions', headers = {}) {
  return mf.dispatchFetch('http://localhost' + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
async function check(label, run) { await run(); console.log('PASS ' + label); }
try {
  await check('typed answers and enforced privacy', async () => {
    const res = await post(input, '/v1/decisions', { 'X-Session-ID': 'synthetic-session-must-not-leak' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(decisionRequests.length, 1);
    // Literal caller contract, independent of the route's payload construction.
    assert.deepEqual(decisionRequests[0].state, { message: 'synthetic example' });
    assert.deepEqual(decisionRequests[0].questions, {
      yes: { type: 'noul', instructions: 'Yes?', criteria: { true: 'Supported', false: 'Unsupported' } },
      team: { type: 'choice', instructions: 'Team?', criteria: { a: 'A', b: 'B' } },
      severity: { type: 'score', instructions: 'Severity?', criteria: ['Low', 'High'] },
    });
    assert.equal(res.headers.get('Cache-Control'), 'no-store'); assert.equal((await res.json()).answers.yes.noul, .8);
    assert.ok(catalogQueries.some(query => new URLSearchParams(query).get('zdr') === 'true'));
  });
  await check('text slug rejected in decision slot', async () => assert.equal((await post({ ...input, model: 'test/text' })).status, 400));
  await check('System One passthrough cannot bypass decision controls', async () => assert.equal((await post(input, '/v1/systemone')).status, 400));
  await check('decision slug rejected in chat and responses slots', async () => {
    assert.equal((await post({ model: 'test/decision', messages: [{ role: 'user', content: 'Hi' }] }, '/v1/chat/completions')).status, 400);
    assert.equal((await post({ model: 'test/decision', input: 'Hi' }, '/v1/responses')).status, 400);
  });
  await check('missing weights denied', async () => assert.equal((await post({ ...input, model: 'test/closed' })).status, 403));
  await check('disabled backend denied', async () => assert.equal((await post({ ...input, model: 'vertex:test' })).status, 503));
  await check('media fails closed without a provider call', async () => {
    const before = calls;
    for (const [field, content_type] of [['images', 'image/png'], ['audio', 'audio/wav'], ['videos', 'video/mp4']])
      assert.equal((await post({ ...input, [field]: [{ content_type, base64: 'YWJjZA==' }] })).status, 400);
    assert.equal(calls, before);
  });
  await check('remote URLs, trace and unknown fields rejected', async () => {
    for (const fields of [{ images: ['https://example.test/x.png'] }, { trace: { x: 'data' } }, { models: ['test/text'] }])
      assert.equal((await post({ ...input, ...fields })).status, 400);
  });
  await check('invalid JSON, question shapes and raw upstream keys rejected before inference', async () => {
    const before = calls;
    assert.equal((await mf.dispatchFetch('http://localhost/v1/decisions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken',
    })).status, 400);
    for (const questions of [{}, { yes: { type: 'noul' } }, { team: { type: 'choice', instructions: 'Team?', criteria: { a: 'A' } } }])
      assert.equal((await post({ ...input, questions })).status, 400);
    assert.equal((await post(input, '/v1/decisions', { Authorization: 'Bearer sk-or-synthetic' })).status, 401);
    assert.equal(calls, before);
  });
  await check('standard fallback lists cannot bypass weights or operation checks', async () => {
    const before = calls;
    for (const path of ['/v1/chat/completions', '/v1/responses', '/v1/completions']) {
      for (const [fallback, expected] of [['test/decision', 400], ['test/closed', 403]]) {
        const body = { model: 'test/text', models: [fallback], route: 'fallback',
          messages: [{ role: 'user', content: 'Hi' }], input: 'Hi' };
        assert.equal((await post(body, path)).status, expected);
      }
    }
    assert.equal(calls, before);
  });
  await check('eligible text fallbacks remain usable and backend prefixes are normalized', async () => {
    for (const path of ['/v1/chat/completions', '/v1/responses', '/v1/completions'])
      assert.equal((await post({ model: 'test/text', models: ['openrouter:test/text'], route: 'fallback',
        messages: [{ role: 'user', content: 'Hi' }], input: 'Hi' }, path)).status, 200);
  });
  await check('unavailable and malformed catalog metadata deny inference without forwarding', async () => {
    const before = calls;
    for (const value of ['unavailable', 'malformed']) {
      catalogMode = value; assert.equal((await post(input)).status, 400);
    }
    catalogMode = 'valid'; assert.equal(calls, before);
  });
  await check('provider budget denial preserved without retry', async () => {
    mode = 'budget'; const before = calls; assert.equal((await post(input)).status, 403); assert.equal(calls, before + 1);
  });
  await check('redirect and invalid probability denied', async () => {
    mode = 'redirect'; assert.equal((await post(input)).status, 502);
    mode = 'invalid'; assert.equal((await post(input)).status, 502);
  });
  await check('answer IDs, types, choices and scores must match the requested questions', async () => {
    for (const value of ['wrong-key', 'wrong-type', 'wrong-choice', 'wrong-score']) {
      mode = value; assert.equal((await post(input)).status, 502);
    }
  });
  await check('encoded request size bounded', async () => {
    assert.equal((await post({ ...input, state: 'x'.repeat(36 * 1024 * 1024) })).status, 413);
  });
  await check('Campus Pass shares a daily counter across decision and chat inference', async () => {
    mode = 'valid';
    const headers = { 'X-Harness-Limit': '1', 'CF-Connecting-IP': '127.0.0.7' };
    assert.equal((await post(input, '/v1/decisions', headers)).status, 200);
    assert.equal((await post({ model: 'test/text', messages: [{ role: 'user', content: 'Hi' }] },
      '/v1/chat/completions', headers)).status, 429);
    assert.equal((await post(input, '/v1/decisions', headers)).status, 429);
  });
} finally { await mf.dispose(); }
