#!/usr/bin/env node
/**
 * One-off script: bump OpenRouter keys from $1/day to $5/day.
 *
 * Reads OPENROUTER_MAINTENANCE_KEY from api/.env (dotenv).
 * Or set OPENROUTER_MAINTENANCE_KEY env var to override.
 *
 * Flags:
 *   --dry-run    List keys that would be updated, but don't PATCH them.
 *   --from 1     Only update keys with this current limit (default: 1).
 *   --to 5       Set keys to this limit (default: 5).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const OPENROUTER_API = 'https://openrouter.ai/api/v1';

function loadDotEnv() {
  try {
    const envPath = join(dirname(import.meta.url.replace('file://', '')), '..', '.env');
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {}
}

function parseArgs(argv) {
  const args = { dryRun: false, from: 1, to: 5 };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    if (arg.startsWith('--from=')) args.from = parseFloat(arg.split('=')[1]);
    if (arg.startsWith('--to=')) args.to = parseFloat(arg.split('=')[1]);
  }
  return args;
}

async function listAllKeys(key) {
  const keys = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const res = await fetch(`${OPENROUTER_API}/keys?offset=${offset}&limit=${limit}`, {
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to list keys: ${res.status} ${await res.text()}`);
    }

    const result = await res.json();
    const batch = result.data ?? [];
    keys.push(...batch);

    if (batch.length < limit) break;
    offset += limit;
  }

  return keys;
}

async function updateKeyLimit(key, hash, newLimit) {
  const res = await fetch(`${OPENROUTER_API}/keys/${hash}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      limit: newLimit,
      limit_reset: 'daily',
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to update ${hash}: ${res.status} ${await res.text()}`);
  }

  return true;
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const maintenanceKey = process.env.OPENROUTER_MAINTENANCE_KEY;

  if (!maintenanceKey) {
    console.error('Set OPENROUTER_MAINTENANCE_KEY or provide it in api/.env');
    process.exit(1);
  }

  console.log(`Fetching all keys from OpenRouter...`);
  const allKeys = await listAllKeys(maintenanceKey);
  console.log(`Found ${allKeys.length} key(s) total.`);

  const toBump = allKeys.filter(k => k.limit === args.from && !k.disabled);
  console.log(`${toBump.length} key(s) with limit=$${args.from}/day (active).`);

  if (toBump.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  for (const key of toBump) {
    const label = key.name || key.hash;
    if (args.dryRun) {
      console.log(`  [DRY RUN] Would update ${label} ($${key.limit} → $${args.to})`);
    } else {
      try {
        await updateKeyLimit(maintenanceKey, key.hash, args.to);
        console.log(`  ✓ ${label} ($${key.limit} → $${args.to})`);
      } catch (e) {
        console.error(`  ✗ ${label}: ${e.message}`);
      }
    }
  }

  if (args.dryRun) {
    console.log(`\nDry run complete. ${toBump.length} key(s) would be updated.`);
  } else {
    console.log(`\nDone. ${toBump.length} key(s) updated.`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
