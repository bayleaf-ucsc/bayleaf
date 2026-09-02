#!/usr/bin/env node
/**
 * Analyze the spending impact of requiring published model weights.
 *
 * A model passes when OpenRouter supplies a nonempty hugging_face_id and the
 * corresponding Hugging Face repository resolves successfully. Missing or
 * broken evidence fails closed, while the CSV records the precise reason.
 *
 * Defaults to the previous completed UTC calendar month. Credentials come from
 * OPENROUTER_MAINTENANCE_KEY in the environment or api/.env.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const API_DIR = join(ROOT, 'api');
const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const PERSONAL_KEY_PREFIX = 'BayLeaf API for '; // derived from KEY_NAME_TEMPLATE

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

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function previousUtcMonth() {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));
  return { start: isoDate(start), end: isoDate(end) };
}

function parseDate(value, flag) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) die(`${flag} must be YYYY-MM-DD, got ${value}`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || isoDate(date) !== value) die(`${flag} is not a valid date: ${value}`);
  return date;
}

function parseArgs(argv) {
  const args = { ...previousUtcMonth(), outputDir: join(API_DIR, 'reports') };
  for (const arg of argv) {
    if (arg === '--help') {
      console.log('Usage: node analysis/open-weight-policy/analyze.mjs [--start=YYYY-MM-DD --end=YYYY-MM-DD] [--output-dir=PATH]');
      process.exit(0);
    } else if (arg.startsWith('--start=')) args.start = arg.slice('--start='.length);
    else if (arg.startsWith('--end=')) args.end = arg.slice('--end='.length);
    else if (arg.startsWith('--output-dir=')) args.outputDir = arg.slice('--output-dir='.length);
    else die(`Unknown argument: ${arg}`);
  }
  const start = parseDate(args.start, '--start');
  const end = parseDate(args.end, '--end');
  if (start >= end) die('--start must be before --end');
  return args;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(path, columns, rows) {
  const csv = [columns, ...rows.map((row) => columns.map((column) => row[column]))]
    .map((row) => row.map(csvCell).join(','))
    .join('\n') + '\n';
  writeFileSync(path, csv, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function fetchJson(url, init, label) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${label}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function fetchUsage(auth, start, end) {
  const result = await fetchJson(`${OPENROUTER_API}/analytics/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      metrics: ['request_count', 'total_usage'],
      dimensions: ['api_key_id', 'model'],
      time_range: { start: `${start}T00:00:00Z`, end: `${end}T00:00:00Z` },
      limit: 10000,
    }),
  }, 'OpenRouter analytics');
  if (result.data?.metadata?.truncated) throw new Error('OpenRouter truncated the analytics result; narrow the date interval');
  if (!Array.isArray(result.data?.data)) throw new Error('OpenRouter returned an unexpected analytics response');
  return result.data.data;
}

async function classifyModels(usedModels) {
  const result = await fetchJson(`${OPENROUTER_API}/models`, undefined, 'OpenRouter models');
  const bySlug = new Map(result.data.flatMap((model) => [
    [model.id, model],
    [model.canonical_slug, model],
  ].filter(([slug]) => slug)));
  const checkedAt = new Date().toISOString();

  return Promise.all([...usedModels].sort().map(async (slug) => {
    const metadata = bySlug.get(slug);
    if (!metadata) return { model: slug, open_weight: false, basis: 'metadata_not_found', checked_at: checkedAt };
    if (!metadata.hugging_face_id) {
      return { model: slug, open_weight: false, basis: 'no_hugging_face_id', checked_at: checkedAt };
    }

    const huggingFaceUrl = `https://huggingface.co/${metadata.hugging_face_id}`;
    try {
      const response = await fetch(huggingFaceUrl, { redirect: 'follow' });
      return {
        model: slug,
        open_weight: response.ok,
        basis: response.ok ? 'valid_hugging_face_url' : 'invalid_hugging_face_url',
        hugging_face_id: metadata.hugging_face_id,
        hugging_face_url: huggingFaceUrl,
        http_status: response.status,
        checked_at: checkedAt,
      };
    } catch {
      return {
        model: slug,
        open_weight: false,
        basis: 'hugging_face_check_failed',
        hugging_face_id: metadata.hugging_face_id,
        hugging_face_url: huggingFaceUrl,
        checked_at: checkedAt,
      };
    }
  }));
}

function summarize(rows) {
  const spend = rows.reduce((sum, row) => sum + row.spend, 0);
  const blockedSpend = rows.filter((row) => !row.openWeight).reduce((sum, row) => sum + row.spend, 0);
  return {
    spend,
    blockedSpend,
    blockedFraction: spend ? blockedSpend / spend : 0,
    requests: rows.reduce((sum, row) => sum + row.requests, 0),
  };
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const auth = process.env.OPENROUTER_MAINTENANCE_KEY;
  if (!auth) die('Set OPENROUTER_MAINTENANCE_KEY or put it in api/.env');

  const rawUsage = await fetchUsage(auth, args.start, args.end);
  const classifications = await classifyModels(new Set(rawUsage.map((row) => row.model)));
  const byModel = new Map(classifications.map((row) => [row.model, row]));
  const usage = rawUsage.map((row) => ({
    keyName: String(row.api_key_id ?? ''),
    model: row.model,
    spend: Number(row.total_usage) || 0,
    requests: Number(row.request_count) || 0,
    openWeight: byModel.get(row.model)?.open_weight === true,
  }));
  const personal = usage.filter((row) => row.keyName.startsWith(PERSONAL_KEY_PREFIX));
  const shared = usage.filter((row) => !row.keyName.startsWith(PERSONAL_KEY_PREFIX));
  const allSummary = summarize(usage);
  const personalSummary = summarize(personal);
  const sharedSummary = summarize(shared);

  const impactRows = classifications.map((classification) => {
    const allModel = summarize(usage.filter((row) => row.model === classification.model));
    const personalModel = summarize(personal.filter((row) => row.model === classification.model));
    const sharedModel = summarize(shared.filter((row) => row.model === classification.model));
    return {
      model: classification.model,
      open_weight: classification.open_weight,
      basis: classification.basis,
      personal_spend_usd: personalModel.spend,
      shared_spend_usd: sharedModel.spend,
      all_spend_usd: allModel.spend,
      personal_fraction_of_total: personalSummary.spend ? personalModel.spend / personalSummary.spend : 0,
      all_fraction_of_total: allSummary.spend ? allModel.spend / allSummary.spend : 0,
    };
  }).sort((a, b) => b.all_spend_usd - a.all_spend_usd);

  mkdirSync(args.outputDir, { recursive: true });
  const suffix = `${args.start}-to-${args.end}`;
  const weightsPath = join(args.outputDir, `openrouter-model-weights-${suffix}.csv`);
  const impactPath = join(args.outputDir, `openrouter-model-spend-${suffix}.csv`);
  writeCsv(weightsPath,
    ['model', 'open_weight', 'basis', 'hugging_face_id', 'hugging_face_url', 'http_status', 'checked_at'],
    classifications,
  );
  writeCsv(impactPath,
    ['model', 'open_weight', 'basis', 'personal_spend_usd', 'shared_spend_usd', 'all_spend_usd', 'personal_fraction_of_total', 'all_fraction_of_total'],
    impactRows,
  );

  console.log(`Period: ${args.start} through ${args.end} (end exclusive)`);
  console.log(`Personal keys: $${personalSummary.spend.toFixed(2)} total, ${(personalSummary.blockedFraction * 100).toFixed(2)}% blocked`);
  console.log(`Shared keys: $${sharedSummary.spend.toFixed(2)} total, ${(sharedSummary.blockedFraction * 100).toFixed(2)}% blocked`);
  console.log(`All keys: $${allSummary.spend.toFixed(2)} total, $${allSummary.blockedSpend.toFixed(2)} blocked (${(allSummary.blockedFraction * 100).toFixed(2)}%)`);
  console.log(`Wrote ${weightsPath}`);
  console.log(`Wrote ${impactPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
