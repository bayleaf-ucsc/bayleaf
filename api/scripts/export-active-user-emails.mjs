#!/usr/bin/env node
/**
 * Export active BayLeaf API account emails from production D1.
 *
 * The resulting recipient list contains PII, so reports/ is gitignored and the
 * file is created mode 0600. No API keys or backend credentials are selected.
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const API_DIR = join(dirname(new URL(import.meta.url).pathname), '..');
const D1_DATABASE = 'bayleaf-keys';

function parseArgs(argv) {
  let output = join(API_DIR, 'reports', `active-user-emails-${new Date().toISOString().slice(0, 10)}.csv`);
  for (const arg of argv) {
    if (arg === '--help') {
      console.log('Usage: node scripts/export-active-user-emails.mjs [--output=PATH]');
      process.exit(0);
    } else if (arg.startsWith('--output=')) output = arg.slice('--output='.length);
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return output;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function main() {
  const output = parseArgs(process.argv.slice(2));
  const raw = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', D1_DATABASE, '--remote', '--json',
      '--command', 'SELECT email FROM user_keys WHERE revoked = 0 ORDER BY email'],
    { cwd: API_DIR, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const emails = JSON.parse(raw)[0]?.results?.map((row) => row.email) ?? [];
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `email\n${emails.map(csvCell).join('\n')}\n`, { mode: 0o600 });
  chmodSync(output, 0o600);
  console.log(`Wrote ${emails.length} active user emails to ${output}`);
}

main();
