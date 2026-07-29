#!/usr/bin/env node
/**
 * Provision or re-limit a named cohort of BayLeaf API users.
 *
 * Motivating case: CMPM 118S (Summer 2026) students hit the global $5/day cap
 * while running agentic learning loops with vision. Most had already logged in
 * and had keys; one never had. Two different fixes are needed, so this script
 * does both in one pass over a roster.
 *
 * For each email on the roster, one of three outcomes:
 *
 *   BUMP      An OpenRouter key named `<KEY_NAME_TEMPLATE>` already exists and
 *             a matching D1 row exists. PATCH the OR key's daily limit.
 *   PROVISION Neither exists. Create the OR key at the target limit, mint a
 *             sk-bayleaf- token, and emit an INSERT for D1. This is the
 *             "budget before first login" path: when the student first signs
 *             in, GET /dashboard finds the row and renders the key card with
 *             their token already waiting (see routes/dashboard.tsx:66-72).
 *   SKIP      An inconsistent state we refuse to guess at (e.g. an OR key with
 *             no D1 row, or a revoked row). Reported for manual handling.
 *
 * Deliberately NOT a durable per-user limit. The three key-creation call sites
 * (routes/key.ts ensureOrKey, routes/key.ts POST /key, routes/claim.tsx
 * ensureUserToken) all funnel into openrouter.ts createKey(), which reads the
 * single global SPENDING_LIMIT_DOLLARS. So if a bumped user's OR key is ever
 * self-healed or they revoke and re-provision, they silently drop back to the
 * global default. Re-run this script if that happens; a real fix means a
 * per-email override consulted inside createKey().
 *
 * Credentials: OPENROUTER_MAINTENANCE_KEY from api/.env (or the environment).
 *
 * Usage:
 *   node scripts/provision-cohort.mjs --roster=<file> [--limit=10] [--apply]
 *
 * Flags:
 *   --roster=<file>  One email per line. Blank lines and #-comments ignored.
 *   --limit=<n>      Target daily limit in dollars (default 10).
 *   --apply          Actually mutate. Without it, this is a dry run.
 *
 * The D1 writes are never executed by this script. It writes a .sql file and
 * prints the wrangler command, so the secret-bearing INSERT never lands in
 * your shell history or in `ps` output.
 */

import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const API_DIR = join(dirname(new URL(import.meta.url).pathname), '..');
const KEY_NAME_TEMPLATE = 'BayLeaf API for $email'; // must match wrangler.jsonc
const D1_DATABASE = 'bayleaf-keys';

// ── env / args ───────────────────────────────────────────────────

function loadDotEnv() {
  try {
    const content = readFileSync(join(API_DIR, '.env'), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!(key in process.env)) process.env[key] = trimmed.slice(eq + 1).trim();
    }
  } catch {}
}

function parseArgs(argv) {
  const args = { roster: null, limit: 10, apply: false };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--roster=')) args.roster = arg.slice('--roster='.length);
    else if (arg.startsWith('--limit=')) args.limit = parseFloat(arg.slice('--limit='.length));
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function readRoster(path) {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

// ── OpenRouter ───────────────────────────────────────────────────

const keyName = (email) => KEY_NAME_TEMPLATE.replace('$email', email);

async function listAllKeys(auth) {
  const keys = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const res = await fetch(`${OPENROUTER_API}/keys?offset=${offset}&limit=${limit}`, {
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`list keys: ${res.status} ${await res.text()}`);
    const batch = (await res.json()).data ?? [];
    keys.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return keys;
}

async function patchKeyLimit(auth, hash, newLimit) {
  const res = await fetch(`${OPENROUTER_API}/keys/${hash}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: newLimit, limit_reset: 'daily' }),
  });
  if (!res.ok) throw new Error(`patch ${hash}: ${res.status} ${await res.text()}`);
}

async function createKeyAtLimit(auth, name, newLimit) {
  const res = await fetch(`${OPENROUTER_API}/keys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, limit: newLimit, limit_reset: 'daily' }),
  });
  if (!res.ok) throw new Error(`create ${name}: ${res.status} ${await res.text()}`);
  const result = await res.json();
  const data = result.data ?? result;
  const secret = result.key ?? data.key;
  if (!secret) throw new Error(`create ${name}: response carried no key secret`);
  return { hash: data.hash, secret };
}

// ── D1 (read-only here; writes are emitted as SQL) ───────────────

/** Read the set of emails that already have rows, with revoked status. */
function readD1Rows() {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', D1_DATABASE, '--remote', '--json',
     '--command', 'SELECT email, revoked FROM user_keys'],
    { cwd: API_DIR, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const rows = JSON.parse(out)[0].results;
  return new Map(rows.map((r) => [r.email, r.revoked]));
}

/** sk-bayleaf- + 32 hex chars. Mirrors utils/token.ts generateBayleafToken(). */
const generateBayleafToken = () => 'sk-bayleaf-' + randomBytes(16).toString('hex');

const sqlQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ── main ─────────────────────────────────────────────────────────

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const auth = process.env.OPENROUTER_MAINTENANCE_KEY;

  if (!args.roster) {
    console.error('Required: --roster=<file>  (one email per line)');
    process.exit(2);
  }
  if (!auth) {
    console.error('Set OPENROUTER_MAINTENANCE_KEY or put it in api/.env');
    process.exit(2);
  }
  if (!(args.limit > 0)) {
    console.error(`--limit must be a positive number, got ${args.limit}`);
    process.exit(2);
  }

  const roster = readRoster(args.roster);
  console.log(`Roster: ${roster.length} email(s) from ${args.roster}`);
  console.log(`Target daily limit: $${args.limit}`);
  console.log(args.apply ? 'Mode: APPLY\n' : 'Mode: DRY RUN (pass --apply to mutate)\n');

  const orKeys = new Map();
  for (const k of await listAllKeys(auth)) if (k.name) orKeys.set(k.name, k);
  const d1 = readD1Rows();
  console.log(`OpenRouter: ${orKeys.size} named key(s). D1: ${d1.size} row(s).\n`);

  const plan = [];
  for (const email of roster) {
    const or = orKeys.get(keyName(email));
    const revoked = d1.get(email);
    if (or && revoked === 0) plan.push({ email, action: 'BUMP', or });
    else if (!or && revoked === undefined) plan.push({ email, action: 'PROVISION' });
    else {
      const why = or
        ? (revoked === 1 ? 'OR key exists but D1 row is revoked' : 'OR key exists but no D1 row')
        : 'D1 row exists but no OR key (needs self-heal via dashboard)';
      plan.push({ email, action: 'SKIP', why });
    }
  }

  const inserts = [];
  for (const item of plan) {
    if (item.action === 'SKIP') {
      console.log(`  SKIP      ${item.email} — ${item.why}`);
      continue;
    }
    if (item.action === 'BUMP') {
      const cur = item.or.limit;
      if (cur === args.limit) {
        console.log(`  ok        ${item.email} — already $${cur}/day`);
        continue;
      }
      if (!args.apply) {
        console.log(`  BUMP      ${item.email} — $${cur} → $${args.limit}/day`);
        continue;
      }
      try {
        await patchKeyLimit(auth, item.or.hash, args.limit);
        console.log(`  BUMP    ✓ ${item.email} — $${cur} → $${args.limit}/day`);
      } catch (e) {
        console.error(`  BUMP    ✗ ${item.email} — ${e.message}`);
      }
      continue;
    }
    // PROVISION
    if (!args.apply) {
      console.log(`  PROVISION ${item.email} — create OR key at $${args.limit}/day + D1 row`);
      continue;
    }
    try {
      const { hash, secret } = await createKeyAtLimit(auth, keyName(item.email), args.limit);
      const token = generateBayleafToken();
      inserts.push(
        'INSERT INTO user_keys (email, bayleaf_token, or_key_hash, or_key_secret) VALUES (' +
          [item.email, token, hash, secret].map(sqlQuote).join(', ') + ');',
      );
      console.log(`  PROVISION ✓ ${item.email} — OR key created at $${args.limit}/day (D1 insert pending)`);
    } catch (e) {
      console.error(`  PROVISION ✗ ${item.email} — ${e.message}`);
    }
  }

  const counts = plan.reduce((a, p) => ((a[p.action] = (a[p.action] ?? 0) + 1), a), {});
  console.log(`\nPlan: ${JSON.stringify(counts)}`);

  if (inserts.length === 0) {
    if (!args.apply) console.log('Dry run complete. Nothing was changed.');
    return;
  }

  // Write the secret-bearing SQL to a 0600 file rather than passing it on a
  // command line (where it would be visible in `ps` and shell history).
  const tmp = process.env.TMPDIR ?? '/tmp';
  const sqlPath = join(tmp, `bayleaf-provision-${Date.now()}.sql`);
  writeFileSync(sqlPath, inserts.join('\n') + '\n', { mode: 0o600 });
  chmodSync(sqlPath, 0o600);

  console.log(`\nOpenRouter keys are created but NOT yet mapped in D1.`);
  console.log(`${inserts.length} INSERT(s) written to:\n  ${sqlPath}\n`);
  console.log(`Finish the provision by running, from api/:`);
  console.log(`  npx wrangler d1 execute ${D1_DATABASE} --remote --file=${sqlPath}`);
  console.log(`\nThen delete it:\n  rm ${sqlPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
