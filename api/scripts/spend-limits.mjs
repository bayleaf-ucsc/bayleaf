#!/usr/bin/env node
/**
 * Operator tool for BayLeaf API spend limits.
 *
 * OpenRouter is the system of record for a key's daily cap: the worker stamps
 * the global `SPENDING_LIMIT_DOLLARS` at creation time (openrouter.ts
 * createKey) and never mirrors the limit into D1. Adjusting an individual or a
 * cohort's cap is therefore an OR-side operation, which is what this script
 * does. It is the only tool that should be doing it.
 *
 * Corollary worth internalizing before you use this: limits set here are not
 * durable across key re-creation. If a user's OR key is ever self-healed
 * (provision.ts resolveOrKey) or they revoke and re-provision from the
 * dashboard, the new key carries the global default again. That is the honest
 * cost of keeping limits in exactly one place instead of mirroring them into
 * D1 and having two sources of truth disagree. Re-run this script if it
 * happens; nothing will alert you.
 *
 * ── Selecting who to act on (exactly one required) ────────────────
 *
 *   --roster=<file>   One email per line; blank lines and #-comments ignored.
 *                     Targets a known cohort, e.g. a course roster.
 *   --from=<n>        Every active key currently capped at $n/day. Use this to
 *                     sweep the whole platform after changing the global
 *                     default in wrangler.jsonc.
 *
 * ── What happens per target ───────────────────────────────────────
 *
 *   BUMP      The user has both an OR key and an active D1 row. PATCH the cap.
 *   PROVISION (roster mode only) Neither exists. Create the OR key at the
 *             target cap, mint a sk-bayleaf- token, and emit a D1 INSERT. This
 *             is the "budget before first login" path: on the user's first
 *             sign-in, GET /dashboard finds the row and renders the key card
 *             with their token already waiting.
 *   SKIP      A half-state this script refuses to guess at (OR key with no D1
 *             row, a revoked row, or a row whose OR key is gone). Reported so
 *             you can decide; a missing OR key heals itself next dashboard load.
 *
 * ── Usage ─────────────────────────────────────────────────────────
 *
 *   node scripts/spend-limits.mjs --roster=roster.txt --limit=10
 *   node scripts/spend-limits.mjs --from=5 --limit=10 --apply
 *
 * Dry run unless you pass --apply. Credentials come from
 * OPENROUTER_MAINTENANCE_KEY (api/.env or the environment).
 *
 * D1 writes are never executed here. Pending INSERTs go to a 0600 file and the
 * wrangler command is printed, so an OpenRouter key secret never lands in your
 * shell history or in `ps` output.
 */

import { readFileSync, writeFileSync } from 'node:fs';
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
    for (const line of readFileSync(join(API_DIR, '.env'), 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!(key in process.env)) process.env[key] = trimmed.slice(eq + 1).trim();
    }
  } catch {}
}

function die(msg) {
  console.error(msg);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { roster: null, from: null, limit: null, apply: false };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--roster=')) args.roster = arg.slice('--roster='.length);
    else if (arg.startsWith('--from=')) args.from = parseFloat(arg.slice('--from='.length));
    else if (arg.startsWith('--limit=')) args.limit = parseFloat(arg.slice('--limit='.length));
    else die(`Unknown argument: ${arg}`);
  }
  if (!(args.limit > 0)) die('Required: --limit=<dollars>  (positive number)');
  if ((args.roster === null) === (args.from === null)) {
    die('Required: exactly one of --roster=<file> or --from=<dollars>');
  }
  if (args.from !== null && !(args.from >= 0)) die(`--from must be a number, got ${args.from}`);
  return args;
}

const readRoster = (path) =>
  readFileSync(path, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

// ── OpenRouter ───────────────────────────────────────────────────

const keyName = (email) => KEY_NAME_TEMPLATE.replace('$email', email);

/** Recover the email from a key name, or null if it doesn't match the template. */
function emailFromKeyName(name) {
  const [prefix, suffix] = KEY_NAME_TEMPLATE.split('$email');
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return null;
  return name.slice(prefix.length, name.length - suffix.length) || null;
}

async function listAllKeys(auth) {
  const keys = [];
  let offset = 0;
  const pageSize = 100;
  while (true) {
    const res = await fetch(`${OPENROUTER_API}/keys?offset=${offset}&limit=${pageSize}`, {
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`list keys: ${res.status} ${await res.text()}`);
    const batch = (await res.json()).data ?? [];
    keys.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
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

/** email -> revoked flag, for every row in user_keys. */
function readD1Rows() {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', D1_DATABASE, '--remote', '--json',
     '--command', 'SELECT email, revoked FROM user_keys'],
    { cwd: API_DIR, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return new Map(JSON.parse(out)[0].results.map((r) => [r.email, r.revoked]));
}

/** sk-bayleaf- + 32 hex chars. Mirrors utils/token.ts generateBayleafToken(). */
const generateBayleafToken = () => 'sk-bayleaf-' + randomBytes(16).toString('hex');

const sqlQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ── planning ─────────────────────────────────────────────────────

/**
 * Decide what to do for each target. Roster mode drives from a list of emails
 * (so a missing key means PROVISION); --from mode drives from the keys that
 * already exist (so PROVISION can never arise).
 */
function buildPlan(args, orKeysByName, d1) {
  if (args.roster !== null) {
    return readRoster(args.roster).map((email) => {
      const or = orKeysByName.get(keyName(email));
      const revoked = d1.get(email);
      if (or && revoked === 0) return { email, action: 'BUMP', or };
      if (!or && revoked === undefined) return { email, action: 'PROVISION' };
      const why = or
        ? (revoked === 1 ? 'OR key exists but D1 row is revoked' : 'OR key exists but no D1 row')
        : 'D1 row exists but no OR key (heals on next dashboard load)';
      return { email, action: 'SKIP', why };
    });
  }

  const plan = [];
  for (const or of orKeysByName.values()) {
    if (or.disabled || or.limit !== args.from) continue;
    const email = emailFromKeyName(or.name);
    if (!email) {
      // Service keys like "BayLeaf OWUI" don't map to a user; never touch them
      // implicitly. Change those by hand if you mean to.
      plan.push({ email: or.name, action: 'SKIP', why: 'not a per-user key' });
      continue;
    }
    plan.push(
      d1.get(email) === 0
        ? { email, action: 'BUMP', or }
        : { email, action: 'SKIP', why: d1.has(email) ? 'D1 row is revoked' : 'no D1 row' },
    );
  }
  return plan.sort((a, b) => a.email.localeCompare(b.email));
}

// ── main ─────────────────────────────────────────────────────────

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const auth = process.env.OPENROUTER_MAINTENANCE_KEY;
  if (!auth) die('Set OPENROUTER_MAINTENANCE_KEY or put it in api/.env');

  console.log(
    args.roster !== null
      ? `Targets: roster ${args.roster}`
      : `Targets: all active per-user keys currently at $${args.from}/day`,
  );
  console.log(`Target daily limit: $${args.limit}`);
  console.log(args.apply ? 'Mode: APPLY\n' : 'Mode: DRY RUN (pass --apply to mutate)\n');

  const orKeysByName = new Map();
  for (const k of await listAllKeys(auth)) if (k.name) orKeysByName.set(k.name, k);
  const d1 = readD1Rows();
  console.log(`OpenRouter: ${orKeysByName.size} named key(s). D1: ${d1.size} row(s).\n`);

  const plan = buildPlan(args, orKeysByName, d1);
  if (plan.length === 0) {
    console.log('Nothing selected. Done.');
    return;
  }

  const inserts = [];
  for (const item of plan) {
    if (item.action === 'SKIP') {
      console.log(`  SKIP      ${item.email} — ${item.why}`);
    } else if (item.action === 'BUMP') {
      const cur = item.or.limit;
      if (cur === args.limit) {
        console.log(`  ok        ${item.email} — already $${cur}/day`);
      } else if (!args.apply) {
        console.log(`  BUMP      ${item.email} — $${cur} → $${args.limit}/day`);
      } else {
        try {
          await patchKeyLimit(auth, item.or.hash, args.limit);
          console.log(`  BUMP    ✓ ${item.email} — $${cur} → $${args.limit}/day`);
        } catch (e) {
          console.error(`  BUMP    ✗ ${item.email} — ${e.message}`);
        }
      }
    } else if (!args.apply) {
      console.log(`  PROVISION ${item.email} — create OR key at $${args.limit}/day + D1 row`);
    } else {
      try {
        const { hash, secret } = await createKeyAtLimit(auth, keyName(item.email), args.limit);
        inserts.push(
          'INSERT INTO user_keys (email, bayleaf_token, or_key_hash, or_key_secret) VALUES (' +
            [item.email, generateBayleafToken(), hash, secret].map(sqlQuote).join(', ') + ');',
        );
        console.log(`  PROVISION ✓ ${item.email} — OR key created at $${args.limit}/day (D1 insert pending)`);
      } catch (e) {
        console.error(`  PROVISION ✗ ${item.email} — ${e.message}`);
      }
    }
  }

  const counts = plan.reduce((a, p) => ((a[p.action] = (a[p.action] ?? 0) + 1), a), {});
  console.log(`\nPlan: ${JSON.stringify(counts)}`);

  if (inserts.length === 0) {
    if (!args.apply) console.log('Dry run complete. Nothing was changed.');
    return;
  }

  const sqlPath = join(process.env.TMPDIR ?? '/tmp', `bayleaf-provision-${Date.now()}.sql`);
  writeFileSync(sqlPath, inserts.join('\n') + '\n', { mode: 0o600 });

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
