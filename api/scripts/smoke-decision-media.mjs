#!/usr/bin/env node
/** Opt-in local Worker + real OpenRouter qualification. Synthetic content only.
 * One disposable $0.25 lifetime-capped key, no automatic retry, <=12 inference
 * attempts. Secrets remain in memory; exact upstream key is deleted in finally.
 * --production instead exercises BayLeaf with the owner's key, then one scoped
 * app token (revoked/verified in finally). No deployment or automatic retry.
 * Usage: node scripts/smoke-decision-media.mjs --live
 * Management key path: OPENROUTER_MANAGEMENT_KEY_FILE (default ~/.tokens/openrouter-mgmt).
 */
import assert from 'node:assert/strict';
import { readFile, mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { image, video, embedded } from './decision-fixtures.mjs';

if (!process.argv.includes('--live')) {
  console.log('No live work performed. Pass --live to spend at most $0.25 using a disposable capped key.');
  process.exit(0);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const production = process.argv.includes('--production');
const base = 'https://api.bayleaf.dev';
const secretFile = (await readFile(production
  ? process.env.BAYLEAF_API_KEY_FILE || join(homedir(), '.tokens/bayleaf-api')
  : process.env.OPENROUTER_MANAGEMENT_KEY_FILE || join(homedir(), '.tokens/openrouter-mgmt'), 'utf8')).trim();
// Local token files may be shell assignments, not raw secrets. Do not execute them.
const candidates = secretFile.match(production ? /sk-bayleaf-[A-Za-z0-9_-]+/g : /sk-or-v1-[A-Za-z0-9_-]+/g) || [];
assert.equal(candidates.length, 1, 'Expected exactly one credential in the private file');
const admin = candidates[0];
let productionCredential = admin, grantId;
const origin = 'https://openrouter.ai/api/v1';
async function management(path, method = 'GET', body) {
  const r = await fetch(origin + path, { method, headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Management ${method} failed with HTTP ${r.status}`);
  return r.json();
}
async function bayleaf(path, method = 'GET', body, credential = admin) {
  return fetch(base + path, { method, headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(90000) });
}
async function speech(word) {
  const dir = await mkdtemp(join(tmpdir(), 'bayleaf-decision-speech-'));
  const aiff = join(dir, 'synthetic.aiff'), wav = join(dir, 'synthetic.wav');
  try {
    if (spawnSync('say', ['-o', aiff, `The secret word is ${word}.`]).status !== 0) throw new Error('Local synthetic speech failed.');
    if (spawnSync('ffmpeg', ['-v', 'error', '-i', aiff, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', wav]).status !== 0)
      throw new Error('WAV conversion failed.');
    return await readFile(wav);
  } finally {
    await unlink(aiff).catch(() => {}); await unlink(wav).catch(() => {}); await rmdir(dir);
  }
}
// Prepare fixtures and compile BEFORE provisioning a credential.
const [red, blue, redVideo, blueSoundVideo, pineapple, elephant] = await Promise.all([
  image('red'), image('blue', 'jpeg'), video('red'), video('blue', true), speech('pineapple'), speech('elephant'),
]);
const speechVideo = await video('blue', pineapple);
const bundle = production ? null : await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
import { OpenAPIHono } from '@hono/zod-openapi';
import { decisionsRoutes } from './src/routes/decisions';
const app = new OpenAPIHono(); app.route('/v1', decisionsRoutes);
export default { fetch: (r, env, ctx) => app.fetch(r, env, ctx) };
` }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
let hash, mf, calls = 0, reportedCost = 0;
const results = [];
const visualQuestions = {
  red: { type: 'noul', instructions: 'Is the visual content predominantly red rather than blue?' },
  color: { type: 'choice', instructions: 'What is the predominant color?', criteria: { red: null, blue: null, green: null } },
  brightness: { type: 'score', instructions: 'Rate the brightness of the visual content.', criteria: ['Black', 'Dim', 'Bright'] },
};
const wordQuestions = {
  word: { type: 'choice', instructions: 'Which secret word is spoken in the audio?', criteria: { pineapple: null, elephant: null, banana: null } },
  speech: { type: 'noul', instructions: 'Does the audio contain intelligible speech?' },
  clarity: { type: 'score', instructions: 'How intelligible is the spoken audio?', criteria: ['Unintelligible', 'Partly clear', 'Clear'] },
};
async function check(label, model, fields, questions, expected, status = 200) {
  const body = { model, state: 'Synthetic media qualification. Answer only from the attached media.', questions,
    provider: { max_price: { prompt: '0.30', completion: '0' } }, ...fields };
  if (production && status === 200) assert.ok(++calls <= 13 && reportedCost < 0.20, 'Production call/cost ceiling reached');
  const r = production ? await bayleaf('/v1/decisions', 'POST', body, productionCredential)
    : await mf.dispatchFetch('http://localhost/v1/decisions', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await r.json();
  assert.equal(r.status, status, `${label}: HTTP ${r.status} (${value.error?.message || 'no message'})`);
  if (status !== 200) { results.push({ label, status }); return; }
  assert.equal(value.provider, 'Cloudflare');
  assert.deepEqual(Object.keys(value.answers).sort(), Object.keys(questions).sort());
  for (const [key, question] of Object.entries(questions)) {
    const a = value.answers[key]; assert.equal(a.type, question.type);
    if (a.type === 'noul') assert.ok(a.noul >= 0 && a.noul <= 1);
    if (a.type === 'score') assert.ok(a.score >= 0 && a.score <= question.criteria.length - 1);
  }
  assert.ok(Number.isFinite(value.usage.cost), 'Cost missing: stop rather than assume zero');
  reportedCost += value.usage.cost;
  const observed = expected ? value.answers[expected.key].choice : null;
  results.push({ label, status, credential: production ? (productionCredential === admin ? 'owner' : 'app token') : 'local campus pool', provider: value.provider, model: value.model, usage: value.usage,
    answers: value.answers, expected: expected?.value, matched: expected ? observed === expected.value : null });
  if (expected) assert.equal(observed, expected.value, `${label}: media discrimination failed`);
}
try {
  if (production) {
    const before = await bayleaf('/v1/auth/key'); assert.equal(before.status, 200);
    const data = (await before.json()).data;
    results.push({ label: 'owner allowance before', limit: data.limit, usage: data.usage });
  } else {
  const created = await management('/keys', 'POST', { name: 'BayLeaf issue98 synthetic media qualification', limit: 0.25, limit_reset: null,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  hash = created.data.hash;
  assert.ok(hash && created.key, 'Management response omitted credential or hash');
  assert.equal(created.data.limit, 0.25); assert.equal(created.data.limit_reset, null);
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'live-media-qualification', modules: true,
    script: bundle.outputFiles[0].text, compatibilityDate: '2025-01-31',
    bindings: { CAMPUS_IP_RANGES: '127.0.0.0/8', DEV_LOOPBACK_AUTH: 'true', CAMPUS_POOL_KEY: created.key,
      CAMPUS_RPD_LIMIT: '30', VERTEX_ENABLED: 'false', BEDROCK_ENABLED: 'false' },
    kvNamespaces: ['MODEL_STATUS', 'CAMPUS_RPD'], d1Databases: ['DB'],
    outboundService: async req => {
      const url = new URL(req.url);
      assert.ok(['openrouter.ai', 'huggingface.co'].includes(url.hostname), 'Unexpected destination');
      if (req.method === 'POST') {
        assert.equal(url.href, 'https://openrouter.ai/api/alpha/decisions');
        assert.ok(++calls <= 12 && reportedCost < 0.20, 'Local call/cost ceiling reached');
        const body = await req.json();
        assert.equal(body.provider.zdr, true); assert.equal(body.provider.data_collection, 'deny');
        assert.deepEqual(body.provider.only, ['cloudflare']); assert.equal(body.provider.allow_fallbacks, false);
        return fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(90000) });
      }
      return fetch(req.url, { headers: req.headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    },
  }] }));
  }
  for (const name of ['clef-flash', 'clef', 'clef-omni']) {
    for (const [color, mime, bytes] of [['red', 'image/png', red], ['blue', 'image/jpeg', blue]])
      await check(`${name} ${color} image`, 'cloudflare/' + name, { images: [embedded(mime, bytes)] }, visualQuestions, { key: 'color', value: color });
  }
  if (production) {
    const issued = await bayleaf('/grants', 'POST', { models: ['clef', 'clef-flash', 'clef-omni'].map(n => 'openrouter:cloudflare/' + n),
      scopes: ['inference.decisions'], expires_in: 600 });
    assert.equal(issued.status, 200, 'Scoped test-token issuance failed');
    const token = await issued.json(); grantId = token.grant_id; productionCredential = token.access_token;
    assert.ok(grantId && productionCredential, 'Missing app-token credential or ID');
  }
  for (const [word, bytes] of [['pineapple', pineapple], ['elephant', elephant]])
    await check(`Omni spoken ${word}`, 'cloudflare/clef-omni', { audio: [embedded('audio/wav', bytes)] }, wordQuestions, { key: 'word', value: word });
  for (const [color, bytes] of [['red', redVideo], ['blue', blueSoundVideo]])
    await check(`Omni ${color} video`, 'cloudflare/clef-omni', { videos: [embedded('video/mp4', bytes)] }, visualQuestions, { key: 'color', value: color });
  await check('Omni hears video soundtrack', 'cloudflare/clef-omni', { videos: [embedded('video/mp4', speechVideo)] },
    wordQuestions, { key: 'word', value: 'pineapple' });
  await check('Omni mixed audio and video', 'cloudflare/clef-omni', {
    audio: [embedded('audio/wav', pineapple)], videos: [embedded('video/mp4', blueSoundVideo)] }, {
    video: { type: 'choice', instructions: 'What color is the video (not the still image)?', criteria: { red: null, blue: null } },
    ...wordQuestions,
  }, { key: 'word', value: 'pineapple' });
  const before = calls;
  for (const [label, fields] of [['wrong modality', { audio: [embedded('audio/wav', pineapple)] }],
    ['remote image', { images: ['https://example.test/image.png'] }], ['routing override', { images: [embedded('image/png', red)], provider: { only: ['deepinfra'] } }],
    ['mixed still image and video', { model: 'cloudflare/clef-omni', images: [embedded('image/png', red)], videos: [embedded('video/mp4', blueSoundVideo)] }]])
    await check(label, 'cloudflare/clef-flash', fields, visualQuestions, null, 400);
  assert.equal(calls, before);
  if (production) {
    await check('app token cannot select an unapproved model', 'typesafe/jev-1.14', {}, visualQuestions, null, 403);
    const r = await bayleaf('/campus-pass', 'GET', undefined, null); assert.equal(r.status, 200);
    const campus = await r.json();
    results.push({ label: 'Campus Pass availability', campus_network: campus.campus_network, enabled: campus.enabled });
    const response = await bayleaf('/v1/decisions', 'POST', { model: 'cloudflare/clef-flash', state: 'Synthetic campus media test',
      images: [embedded('image/png', red)], questions: visualQuestions,
      provider: { max_price: { prompt: '0.30', completion: '0' } } }, null);
    assert.equal(response.status, campus.campus_network && campus.enabled ? 200 : 401);
    if (response.status === 200) {
      const value = await response.json(); calls++; reportedCost += value.usage.cost;
      assert.equal(value.provider, 'Cloudflare'); assert.equal(value.answers.color.choice, 'red');
      results.push({ label: 'keyless production image', status: 200, usage: value.usage });
    } else results.push({ label: 'off-campus keyless media denied', status: response.status });
    const after = await bayleaf('/v1/auth/key'); assert.equal(after.status, 200);
    const data = (await after.json()).data;
    assert.equal(data.limit, results.find(r => r.label === 'owner allowance before').limit);
    results.push({ label: 'owner allowance after', limit: data.limit, usage: data.usage });
  }
} finally {
  try { if (mf) await mf.dispose(); } finally { if (hash) {
    try {
      const usage = await management('/keys/' + hash);
      results.push({ label: 'upstream lifetime key accounting', limit: usage.data.limit, usage: usage.data.usage });
    } finally {
      await management('/keys/' + hash, 'DELETE');
      const gone = await fetch(origin + '/keys/' + hash, { headers: { Authorization: `Bearer ${admin}` }, signal: AbortSignal.timeout(30000) });
      assert.equal(gone.status, 404, 'Disposable key deletion not verified');
    }
  } else if (grantId) {
    const revoked = await bayleaf('/grants/' + grantId, 'DELETE'); assert.equal(revoked.status, 200, 'Test app-token revocation failed');
    const listed = await bayleaf('/grants'); assert.equal(listed.status, 200);
    assert.ok(!(await listed.json()).grants.some(g => g.id === grantId), 'Revoked app token still listed');
    const denied = await bayleaf('/v1/decisions', 'POST', { model: 'cloudflare/clef-omni', state: 'Synthetic revoked token test', questions: wordQuestions }, productionCredential);
    assert.equal(denied.status, 401, 'Revoked app token remains usable');
    results.push({ label: 'exact test-token revocation and denial verified', status: 401 });
  } }
  console.log(JSON.stringify({ production, localWorkerWithRealUpstream: !production, maxLifetimeDollars: production ? null : 0.25, calls, reportedCost, results }, null, 2));
}
