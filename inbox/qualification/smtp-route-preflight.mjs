#!/usr/bin/env node
// Authorized one-rule provisioning check. No mail is sent, no content retained.
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
if (!process.argv.includes('--deploy-route-delete')) throw Error('Explicit --deploy-route-delete required');
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!/^[a-f0-9]{32}$/.test(account || '')) throw Error('Explicit CLOUDFLARE_ACCOUNT_ID required');
const profile = process.env.CLOUDFLARE_PROFILE || 'ucsc';
if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw Error('Invalid profile');
const domain = process.env.INBOX_QUALIFICATION_DOMAIN;
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain || '')) throw Error('Explicit INBOX_QUALIFICATION_DOMAIN required');
const output = process.argv[process.argv.indexOf('--output') + 1];
if (!process.argv.includes('--output') || !output || output.startsWith('--')) throw Error('--output required');
const windowSeconds = process.argv.includes('--window-seconds') ? Number(process.argv[process.argv.indexOf('--window-seconds') + 1]) : 0;
const mode = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : 'pin-pass';
const settleSeconds = process.argv.includes('--settle-seconds') ? Number(process.argv[process.argv.indexOf('--settle-seconds') + 1]) : 60;
if (!Number.isInteger(settleSeconds) || settleSeconds < 60 || settleSeconds > 180) throw Error('Settle must be 60–180 seconds');
if (!Number.isInteger(windowSeconds) || windowSeconds < 0 || windowSeconds > 600) throw Error('Window must be 0–600 seconds');
if (!['pin-pass', 'pin-fail', 'domain-fail', 'unknown', 'throw', 'rate-reject'].includes(mode)) throw Error('Invalid mode');
process.umask(0o077);
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp('/private/var/folders/qj/gyqbn5y57956rrqd_g6yfqwr0000gn/T/opencode/inbox-smtp-route-');
const name = 'bayleaf-inboxes-temp-smtp-' + randomBytes(6).toString('hex');
const recipient = randomBytes(16).toString('hex') + '@' + domain;
const report = { started: new Date().toISOString(), sends: 0, storage_resources: 0 };
execFileSync('cf', ['workers', 'list', '--profile', profile], { stdio: 'ignore' });
const token = JSON.parse(await readFile(join(homedir(), `Library/Preferences/cloudflare/config/${profile}.json`))).oauth_token;
async function api(path, method = 'GET', body) {
  const response = await fetch('https://api.cloudflare.com/client/v4/' + path, {
    method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json();
  if (!data.success) throw Object.assign(Error('Cloudflare API rejected request'), {
    status: response.status, codes: data.errors?.map(e => e.code), providerErrors: data.errors
  });
  return data.result;
}
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
let zone, beforeRules, beforeCatch, attempted = false, tail, socket, rule;
const normalizeId = value => (value || '').replaceAll('-', '').toLowerCase();
async function correlate() {
  // Documented, recipient-scoped activity API. No production-wide log query.
  const query = `query($z:string!,$r:string!,$s:Time!,$e:Time!){viewer{zones(filter:{zoneTag:$z}){
    emailRoutingAdaptive(filter:{to:$r,datetime_geq:$s,datetime_leq:$e},limit:20,orderBy:[datetime_ASC]){
      datetime status action errorDetail ruleMatched sampleInterval dkim dmarc spf
    }}}}`;
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { z: zone, r: recipient, s: report.started, e: new Date().toISOString() } })
  });
  const data = await response.json();
  await writeFile(join(work, 'private-activity.json'), JSON.stringify(data));
  if (data.errors?.length || !data.data?.viewer?.zones?.length) {
    report.activity_unavailable = true;
    return;
  }
  const knownReasons = ['5.1.1 Address not found', '5.7.1 DKIM domain authorization required',
    '5.3.4 Restricted inbox supports DKIM mail up to 1 MiB', '4.7.0 Rate limited, try later'];
  report.activity = data.data.viewer.zones[0].emailRoutingAdaptive.map(row => ({
    datetime: row.datetime, status: row.status, action: row.action,
    sample_interval: row.sampleInterval,
    matched_fixture: normalizeId(row.ruleMatched) === normalizeId(rule.tag || rule.id),
    matched_catchall: normalizeId(row.ruleMatched) === normalizeId(beforeCatch.tag || beforeCatch.id),
    reason: knownReasons.find(reason => row.errorDetail === 'Worker rejected email with reason: ' + reason) || (row.errorDetail ? 'other' : 'none'),
    dkim: row.dkim, dmarc: row.dmarc, spf: row.spf
  }));
}
try {
  const zones = await api('zones?name=' + encodeURIComponent(domain));
  if (zones.length !== 1 || zones[0].account.id !== account || zones[0].status !== 'active') throw Error('Zone boundary');
  zone = zones[0].id;
  const base = `zones/${zone}/email/routing`;
  const settings = await api(base);
  if (!settings.enabled || settings.status !== 'ready') throw Error('Routing not ready');
  beforeRules = await api(base + '/rules');
  beforeCatch = await api(base + '/rules/catch_all');
  const workers = await api(`accounts/${account}/workers/scripts`);
  const subscriptions = await api(`accounts/${account}/subscriptions`);
  const addresses = await api(`accounts/${account}/email/routing/addresses`);
  report.preflight = { routing_ready: true, existing_rules: beforeRules.length, workers: workers.length,
    verified_destinations: addresses.filter(x => x.verified).length,
    paid_workers: subscriptions.some(x => x.rate_plan?.id === 'workers_paid') };
  if (!report.preflight.paid_workers || workers.length >= 490 || beforeRules.length >= 190) throw Error('Quota boundary');
  execFileSync(process.execPath, ['scripts/build-dkim.mjs'], { cwd: root, stdio: 'ignore' });
  const verifier = join(root, '.generated/dkim-verifier.mjs');
  report.verifier_sha256 = createHash('sha256').update(await readFile(verifier)).digest('hex');
  const template = await readFile(join(root, 'qualification/smtp-isolated-worker.mjs'), 'utf8');
  report.fixture_sha256 = createHash('sha256').update(template).digest('hex');
  await writeFile(join(work, 'entry.mjs'), template.replace("'../.generated/dkim-verifier.mjs'", JSON.stringify(verifier)));
  const config = { name, account_id: account, main: 'entry.mjs', compatibility_date: '2026-08-01',
    compatibility_flags: ['nodejs_compat'], workers_dev: false, preview_urls: false,
    observability: { enabled: false }, limits: { cpu_ms: 30000 },
    vars: { QUALIFICATION_RECIPIENT: recipient, QUALIFICATION_EXPIRES: String(Date.now() + 900000), QUALIFICATION_MODE: mode } };
  await writeFile(join(work, 'wrangler.json'), JSON.stringify(config));
  attempted = true;
  let deployed = '';
  try { deployed = execFileSync(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--config', join(work, 'wrangler.json')], {
    cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token }
  }); } catch (error) {
    if (!String(error.stderr).includes('10007')) throw error;
    // Wrangler may upload successfully then race the subdomain API. Verify, do not redeploy.
    await new Promise(resolve => setTimeout(resolve, 5000));
    if (!(await api(`accounts/${account}/workers/scripts`)).some(x => x.id === name)) throw error;
    const subdomain = await api(`accounts/${account}/workers/scripts/${name}/subdomain`);
    if (subdomain.enabled) throw Error('Unexpected public subdomain');
    report.wrangler_subdomain_race = true;
  }
  report.startup_ms = Number(deployed.match(/Startup Time: (\d+) ms/)?.[1]) || null;
  report.deployed = true;
  rule = await api(base + '/rules', 'POST', { enabled: true, name: 'Temporary SMTP qualification',
    actions: [{ type: 'worker', value: [name] }],
    matchers: [{ type: 'literal', field: 'to', value: recipient }], priority: 0 });
  report.rule_created = true;
  const check = await api(base + '/rules/' + (rule.tag || rule.id));
  report.rule_readback = check.enabled && check.actions?.[0]?.value?.[0] === name && check.matchers?.[0]?.value === recipient;
  if (!report.rule_readback) throw Error('Rule readback mismatch');
  // Preserve private correlation identifiers even if setup subsequently fails.
  await writeFile(join(work, 'resource-manifest.json'), JSON.stringify({ account, zone, name, recipient, mode, rule, beforeCatch, started: report.started }));
  if (windowSeconds) {
    report.mode = mode;
    report.verdicts = [];
    tail = await api(`accounts/${account}/workers/scripts/${name}/tails`, 'POST', {});
    socket = new WebSocket(tail.url, 'trace-v1');
    socket.addEventListener('message', async event => {
      try {
        const data = JSON.parse(typeof event.data === 'string' ? event.data : await event.data.text());
        for (const log of data.logs || []) for (const text of log.message || []) {
          const value = JSON.parse(text);
          if (report.verdicts.length < 20 && value.qualification === mode && ['accepted', 'rejected', 'size-rejected'].includes(value.verdict) && Number.isInteger(value.bytes)) {
            report.verdicts.push({ mode, verdict: value.verdict, bytes: value.bytes });
          }
        }
      } catch { /* Never persist raw traces or their email event metadata. */ }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Tail connect timeout')), 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('Tail failed')); }, { once: true });
    });
    socket.send(JSON.stringify({ debug: true }));
    report.settle_seconds = settleSeconds;
    console.log('Rule readback passed; waiting for routing propagation before ready signal.');
    await new Promise(resolve => setTimeout(resolve, settleSeconds * 1000));
    // Management readback does not prove data-plane propagation; activity correlation does.
    const settled = await api(base + '/rules/' + (rule.tag || rule.id));
    if (!settled.enabled || settled.actions?.[0]?.value?.[0] !== name) throw Error('Settled rule mismatch');
    await writeFile(join(work, 'send-manifest.json'), JSON.stringify({ recipient, mode, expires: new Date(Date.now() + windowSeconds * 1000).toISOString() }));
    console.log('Ready for parent-owned sender; private manifest: ' + join(work, 'send-manifest.json'));
    await new Promise(resolve => setTimeout(resolve, windowSeconds * 1000));
    await correlate();
  }
} catch (error) {
  report.failure = { status: error.status || null, codes: error.codes || [], stage: report.deployed ? 'routing' : 'preflight-or-deploy' };
  await writeFile(join(work, 'private-error.json'), JSON.stringify({ message: error.message, errors: error.providerErrors }));
} finally {
  socket?.close();
  if (tail) {
    try { await api(`accounts/${account}/workers/scripts/${name}/tails/${tail.id}`, 'DELETE'); }
    catch { report.tail_delete_failed = true; } // Still remove the rule and Worker below.
  }
  // Reconcile even an ambiguous create response by exact fresh recipient + Worker.
  if (zone && beforeRules) {
    const base = `zones/${zone}/email/routing`;
    for (const candidate of await api(base + '/rules')) {
      if (candidate.matchers?.some(x => x.type === 'literal' && x.field === 'to' && x.value === recipient) &&
          candidate.actions?.some(x => x.type === 'worker' && x.value?.includes(name))) {
        await api(base + '/rules/' + (candidate.tag || candidate.id), 'DELETE');
      }
    }
    report.rules_unchanged = hash(await api(base + '/rules')) === hash(beforeRules);
    report.catchall_unchanged = hash(await api(base + '/rules/catch_all')) === hash(beforeCatch);
  }
  if (attempted) {
    await api(`accounts/${account}/workers/scripts/${name}`, 'DELETE');
    report.worker_deleted = !(await api(`accounts/${account}/workers/scripts`)).some(x => x.id === name);
  }
  report.finished = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  // Parent archives evidence before explicitly removing these mode-0700/0600 files.
  console.log('Retained private evidence directory: ' + work);
}
// Undici's trace socket can retain handles after close. All remote cleanup and writes above are awaited.
process.exit(report.failure || !report.worker_deleted || !report.rules_unchanged || !report.catchall_unchanged ? 1 : 0);
