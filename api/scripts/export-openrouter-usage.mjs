#!/usr/bin/env node
/**
 * Export per-user, per-model OpenRouter usage to CSV.
 *
 * Defaults to the previous completed UTC calendar month. The output contains
 * user emails, so reports/ is gitignored and files are created mode 0600.
 * OpenRouter retains request metadata only; this script never requests prompt
 * or completion content.
 *
 * Usage:
 *   node scripts/export-openrouter-usage.mjs
 *   node scripts/export-openrouter-usage.mjs --start=2026-08-01 --end=2026-09-01
 *   node scripts/export-openrouter-usage.mjs --output=/tmp/openrouter-usage.csv
 *
 * The interval is start-inclusive and end-exclusive. Credentials come from
 * OPENROUTER_MAINTENANCE_KEY (api/.env or the environment).
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const API_DIR = join(dirname(new URL(import.meta.url).pathname), '..');
const KEY_NAME_TEMPLATE = 'BayLeaf API for $email'; // must match wrangler.jsonc

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

function die(message) {
  console.error(message);
  process.exit(2);
}

function previousUtcMonth() {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));
  return { start: isoDate(start), end: isoDate(end) };
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseDate(value, flag) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) die(`${flag} must be YYYY-MM-DD, got ${value}`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || isoDate(date) !== value) die(`${flag} is not a valid date: ${value}`);
  return date;
}

function parseArgs(argv) {
  const defaults = previousUtcMonth();
  const args = { ...defaults, output: null };
  for (const arg of argv) {
    if (arg === '--help') {
      console.log('Usage: node scripts/export-openrouter-usage.mjs [--start=YYYY-MM-DD --end=YYYY-MM-DD] [--output=PATH]');
      process.exit(0);
    } else if (arg.startsWith('--start=')) args.start = arg.slice('--start='.length);
    else if (arg.startsWith('--end=')) args.end = arg.slice('--end='.length);
    else if (arg.startsWith('--output=')) args.output = arg.slice('--output='.length);
    else die(`Unknown argument: ${arg}`);
  }

  const start = parseDate(args.start, '--start');
  const end = parseDate(args.end, '--end');
  if (start >= end) die('--start must be before --end');
  args.output ??= join(API_DIR, 'reports', `openrouter-usage-${args.start}-to-${args.end}.csv`);
  return args;
}

function emailFromKeyName(name) {
  const [prefix, suffix] = KEY_NAME_TEMPLATE.split('$email');
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return null;
  const email = name.slice(prefix.length, name.length - suffix.length);
  return email.includes('@') ? email : null;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function queryUsage(auth, start, end) {
  const response = await fetch(`${OPENROUTER_API}/analytics/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      metrics: [
        'request_count',
        'total_usage',
        'tokens_prompt',
        'tokens_completion',
        'reasoning_tokens',
      ],
      dimensions: ['api_key_id', 'model'],
      time_range: {
        start: `${start}T00:00:00Z`,
        end: `${end}T00:00:00Z`,
      },
      limit: 10000,
    }),
  });
  if (!response.ok) throw new Error(`OpenRouter analytics: ${response.status} ${await response.text()}`);

  const result = await response.json();
  if (result.data?.metadata?.truncated) {
    throw new Error('OpenRouter truncated the analytics result; narrow the date interval');
  }
  if (!Array.isArray(result.data?.data)) throw new Error('OpenRouter returned an unexpected analytics response');
  return result.data;
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const auth = process.env.OPENROUTER_MAINTENANCE_KEY;
  if (!auth) die('Set OPENROUTER_MAINTENANCE_KEY or put it in api/.env');

  const result = await queryUsage(auth, args.start, args.end);
  const rows = [];
  const sharedKeys = new Set();
  for (const row of result.data) {
    const email = emailFromKeyName(String(row.api_key_id ?? ''));
    if (!email) {
      sharedKeys.add(String(row.api_key_id ?? '(unnamed key)'));
      continue;
    }
    const promptTokens = Number(row.tokens_prompt) || 0;
    const completionTokens = Number(row.tokens_completion) || 0;
    const reasoningTokens = Number(row.reasoning_tokens) || 0;
    rows.push({
      email,
      model: row.model,
      requests: Number(row.request_count) || 0,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      reasoning_tokens: reasoningTokens,
      total_tokens: promptTokens + completionTokens,
      usage_usd: Number(row.total_usage) || 0,
      window_start: args.start,
      window_end_exclusive: args.end,
    });
  }
  rows.sort((a, b) => a.email.localeCompare(b.email) || b.usage_usd - a.usage_usd || String(a.model).localeCompare(String(b.model)));

  const columns = [
    'email',
    'model',
    'requests',
    'prompt_tokens',
    'completion_tokens',
    'reasoning_tokens',
    'total_tokens',
    'usage_usd',
    'window_start',
    'window_end_exclusive',
  ];
  const csv = [columns.join(','), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))].join('\n') + '\n';
  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, csv, { mode: 0o600 });
  chmodSync(args.output, 0o600);

  const users = new Set(rows.map((row) => row.email));
  const models = new Set(rows.map((row) => row.model));
  const requests = rows.reduce((sum, row) => sum + row.requests, 0);
  const usage = rows.reduce((sum, row) => sum + row.usage_usd, 0);
  console.log(`Wrote ${rows.length} user-model rows for ${users.size} users and ${models.size} models to ${args.output}`);
  console.log(`Attributed totals: ${requests} requests, $${usage.toFixed(2)} OpenRouter usage`);
  if (sharedKeys.size) console.log(`Excluded shared/non-user keys (not attributable by email): ${[...sharedKeys].sort().join(', ')}`);
  for (const warning of result.warnings ?? []) console.warn(`OpenRouter warning: ${warning}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
