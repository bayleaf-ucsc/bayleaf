#!/usr/bin/env node
/** Synthetic workerd HTTP tests: no credentials, live inference or retained content. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { embedded, image, wav, video } from './decision-fixtures.mjs';
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
let calls = 0, mode = 'valid', catalogMode = 'valid', mediaCatalogMode = 'valid';
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
    if (url.pathname === '/api/v1/endpoints/zdr') {
      if (mediaCatalogMode === 'unavailable') return new Response(null, { status: 503 });
      return Response.json({ data: ['clef', 'clef-flash', 'clef-omni'].map(name => ({ model_id: 'cloudflare/' + name,
        provider_name: 'Cloudflare', tag: 'cloudflare', safety_retention: mediaCatalogMode === 'retention', status: 0 })) });
    }
    if (url.pathname.endsWith('/models')) {
      catalogQueries.push(url.searchParams.toString());
      assert.ok(['text,decisions', 'decisions'].includes(url.searchParams.get('output_modalities')));
      if (catalogMode === 'unavailable') return new Response(null, { status: 503 });
      if (catalogMode === 'malformed') return Response.json({ data: {} });
      return Response.json({ data: [
      { id: 'test/decision', hugging_face_id: 'test/decision', architecture: { output_modalities: ['decisions'], input_modalities: ['text'] } },
      { id: 'test/text', hugging_face_id: 'test/text', architecture: { output_modalities: ['text'] } },
       { id: 'test/closed', hugging_face_id: null, architecture: { output_modalities: ['decisions'] } },
       ...['clef', 'clef-flash', 'clef-omni'].map(name => ({ id: 'cloudflare/' + name, hugging_face_id: 'Cloudflare/' + name,
         architecture: { output_modalities: ['decisions'], input_modalities: mediaCatalogMode === 'missing' ? ['text']
           : name === 'clef-omni' ? ['text', 'image', 'audio', 'video'] : ['text', 'image'] } })),
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
    assert.ok(['test/decision', 'cloudflare/clef', 'cloudflare/clef-flash', 'cloudflare/clef-omni'].includes(body.model));
    assert.equal(body.images, undefined); assert.equal(body.audio, undefined); assert.equal(body.videos, undefined);
    if (body.model.startsWith('cloudflare/')) {
      assert.deepEqual(body.provider.only, ['cloudflare']); assert.equal(body.provider.allow_fallbacks, false);
    }
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
  const png = await image('red'), jpeg = await image('blue', 'jpeg');
  const silentVideo = await video('red'), soundVideo = await video('blue', true);
  const mediaInput = { ...input, model: 'cloudflare/clef-omni', images: [embedded('image/png', png)] };
  await check('images translate byte-for-byte into pinned native state parts', async () => {
    for (const model of ['cloudflare/clef', 'cloudflare/clef-flash', 'cloudflare/clef-omni']) {
      assert.equal((await post({ ...mediaInput, model, images: [embedded('image/png', png), `data:image/jpeg;base64,${jpeg.toString('base64')}`] })).status, 200);
      const sent = decisionRequests.at(-1);
      assert.equal(sent.state[0], JSON.stringify(input.state));
      assert.deepEqual(sent.state.slice(1).map(x => x.image_url.url), [`data:image/png;base64,${png.toString('base64')}`, `data:image/jpeg;base64,${jpeg.toString('base64')}`]);
    }
  });
  await check('Omni mixed PCM WAV and MP4 use native parts without dropping bytes', async () => {
    const audio = embedded('audio/wav', wav());
    assert.equal((await post({ ...mediaInput, images: [], audio: [audio], videos: [embedded('video/mp4', soundVideo)] })).status, 200);
    const sent = decisionRequests.at(-1);
    assert.deepEqual(sent.state.map(x => typeof x === 'string' ? 'text' : x.type), ['text', 'input_audio', 'video_url']);
    assert.equal(sent.state[1].input_audio.data, audio.base64);
    assert.equal(sent.state[2].video_url.url, `data:video/mp4;base64,${soundVideo.toString('base64')}`);
    assert.equal((await post({ ...mediaInput, audio: [audio] })).status, 200);
  });
  await check('media errors and routing overrides deny before inference', async () => {
    const before = calls;
    const badWav = wav(); badWav.writeUInt32LE(1, 24);
    for (const change of [
      { images: [embedded('image/jpeg', png)] }, { images: [embedded('audio/wav', wav())] },
      { images: [{ content_type: 'image/png', base64: '!!!!' }] },
      { images: [{ content_type: 'image/png', base64: 'AB==' }] },
      { images: [embedded('image/png', Buffer.alloc(129 * 1024))] },
      { images: Array(5).fill(embedded('image/png', png)) },
      { audio: [embedded('audio/wav', badWav)] }, { audio: [embedded('audio/wav', wav(301))] },
      { audio: [embedded('audio/mpeg', wav())] },
      { videos: [embedded('video/mp4', Buffer.from('bad'))] },
      { images: [], videos: [embedded('video/mp4', silentVideo), embedded('video/mp4', soundVideo)] },
      { videos: [embedded('video/mp4', silentVideo)] },
      { model: 'cloudflare/clef', audio: [embedded('audio/wav', wav())] },
      { model: 'cloudflare/clef-flash', videos: [embedded('video/mp4', silentVideo)] },
      { state: 'x'.repeat(1801) },
      { questions: { ...input.questions, long: { type: 'noul', instructions: 'x'.repeat(12000) } } },
      { provider: { only: ['deepinfra'] } }, { provider: { only: [] } },
      { provider: { order: ['cloudflare'] } }, { provider: { ignore: ['cloudflare'] } },
      { provider: { allow_fallbacks: true } },
    ]) assert.equal((await post({ ...mediaInput, ...change })).status, 400, JSON.stringify(Object.keys(change)));
    assert.equal(calls, before);
  });
  await check('inline media cannot bypass validation through state or questions', async () => {
    const before = calls;
    for (const part of [{ type: 'image_url', image_url: { url: 'https://example.test/a.png' } },
      { type: 'input_audio', input_audio: { data: 'bad', format: 'wav' } },
      { type: 'file', file: { file_data: 'data:application/pdf;base64,AAAA' } },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }]) {
      assert.equal((await post({ ...input, state: { nested: [part] } })).status, 400);
      assert.equal((await post({ ...input, questions: { yes: { type: 'noul', instructions: ['check', part] } } })).status, 400);
    }
    assert.equal(calls, before);
  });
  await check('media capability or endpoint ZDR uncertainty denies before inference', async () => {
    const before = calls;
    for (const value of ['unavailable', 'retention', 'missing']) {
      mediaCatalogMode = value; assert.equal((await post(mediaInput)).status, 400);
    }
    mediaCatalogMode = 'valid'; assert.equal(calls, before);
  });
  await check('movie and track duration, fragment and edit-list bounds fail closed', async () => {
    const before = calls;
    for (const marker of ['mvhd', 'mdhd']) {
      const long = Buffer.from(silentVideo), start = long.indexOf(marker) + 4;
      assert.ok(start >= 4);
      long.writeUInt32BE(long.readUInt32BE(start + 12) * 61, start + 16);
      assert.equal((await post({ ...mediaInput, images: [], videos: [embedded('video/mp4', long)] })).status, 400);
    }
    for (const kind of ['moof', 'mvex', 'edts']) {
      const box = Buffer.alloc(8); box.writeUInt32BE(8); box.write(kind, 4);
      assert.equal((await post({ ...mediaInput, images: [], videos: [embedded('video/mp4', Buffer.concat([silentVideo, box]))] })).status, 400);
    }
    const largePng = Buffer.alloc(129 * 1024); png.copy(largePng);
    assert.equal((await post({ ...mediaInput, images: [embedded('image/png', largePng)] })).status, 400);
    const largeFlash = Buffer.alloc(25 * 1024); png.copy(largeFlash);
    assert.equal((await post({ ...mediaInput, model: 'cloudflare/clef-flash', images: [embedded('image/png', largeFlash)] })).status, 400);
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
