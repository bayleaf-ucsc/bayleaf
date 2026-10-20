import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// Real SQLite SQL, small D1-shaped adapter. Does not claim workerd conformance.
export function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0001_telemetry.sql', import.meta.url), 'utf8'));
  sql.exec(readFileSync(new URL('../migrations/0002_retention_state.sql', import.meta.url), 'utf8'));
  sql.exec(readFileSync(new URL('../migrations/0003_browser_network.sql', import.meta.url), 'utf8'));
  const wrap = (query, args = []) => ({
    bind(...values) { return wrap(query, values); },
    async first() { return sql.prepare(query).get(...args) ?? null; },
    async all() { return { results: sql.prepare(query).all(...args) }; },
    async run() { return { meta: sql.prepare(query).run(...args) }; },
    _run() { return /^\s*SELECT/i.test(query) ? { results: sql.prepare(query).all(...args) } : { meta: sql.prepare(query).run(...args) }; },
  });
  return {
    sql,
    prepare: query => wrap(query),
    async batch(statements) {
      sql.exec('BEGIN');
      try { const result = statements.map(s => s._run()); sql.exec('COMMIT'); return result; }
      catch (e) { sql.exec('ROLLBACK'); throw e; }
    },
    close() { sql.close(); },
  };
}
