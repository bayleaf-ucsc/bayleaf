import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DAY } from '../src/policies.js';
import { validate, Invalid } from '../src/validate.js';
import { ingest, readRows, purge } from '../src/store.js';

// Shared by real SQLite and actual D1, exercising identical policy transactions.
export async function retentionScenarios(db) {
  const initialBrowser = await db.prepare('SELECT ttl_ms FROM retention_state WHERE class=?').bind('browser').first();
  const start = 1_800_000_000_000, transition = start + 1.5 * DAY;
  const long = { RETENTION_DAYS: '90' }, short = { RETENTION_DAYS: '1' };
  const run = (at = start) => ({ schema_version: 1, source: 'chat-retention', batch_id: randomUUID(),
    observed_at: at, job: 'chat-retention', outcome: 'success', duration_ms: 1, deleted: 0, extensions: {} });
  const metric = (at, pointTimes) => ({ schema_version: 1, source: 'owui', batch_id: randomUUID(), observed_at: at,
    points: pointTimes.map(observed_at => ({ name: 'webui.users.total', kind: 'gauge', unit: 'users', observed_at, value: 5, attributes: {} })) });
  const range = { from: start - DAY, to: transition + 1, limit: 50 };
  // An older envelope must not give a newer point an early expiry that can
  // subsequently be bypassed by replaying that point in a newer envelope.
  assert.throws(() => validate('metrics', metric(start, [start + DAY]), long, start + DAY), Invalid);
  const original = run();
  const originalMetric = metric(start, [start - DAY / 2, start]);
  await ingest(db, 'deletions', validate('deletions', original, long, start), start, long);
  await ingest(db, 'metrics', validate('metrics', originalMetric, long, start), start, long);
  assert.equal((await readRows(db, 'deletions', range, start, long)).length, 1);
  // A read, not a purge, observes shortening. Increasing before purge cannot undo it.
  assert.equal((await readRows(db, 'deletions', range, transition, short)).length, 0);
  assert.equal((await readRows(db, 'metrics', range, transition, short)).length, 0);
  assert.equal((await readRows(db, 'lifecycle', range, transition, short)).length, 0);
  assert.equal((await readRows(db, 'deletions', range, transition, long)).length, 0);
  assert.equal((await readRows(db, 'metrics', range, transition, long)).length, 0);
  assert.equal((await readRows(db, 'status', range, transition, long)).length, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM deletion_runs').first()).n > 0, true, 'still physically present before purge');
  // New envelope time cannot launder retired points; reject the whole mixed batch.
  const mixed = metric(transition, [start, transition]);
  await assert.rejects(ingest(db, 'metrics', validate('metrics', mixed, long, transition), transition, long), Invalid);
  await assert.rejects(ingest(db, 'metrics', validate('metrics', originalMetric, long, transition), transition, long), Invalid);
  assert.equal(await db.prepare('SELECT batch_id FROM receipts WHERE batch_id=?').bind(mixed.batch_id).first(), null);
  // Competing old config cannot raise policy, even with a payload validated earlier.
  const racing = validate('deletions', run(), long, transition);
  await Promise.allSettled([
    readRows(db, 'deletions', range, transition, short),
    ingest(db, 'deletions', racing, transition, long),
  ]);
  assert.equal((await readRows(db, 'deletions', range, transition, long)).length, 0);
  // Race the *first* shortening of another class against old-policy admission.
  // Either serialization is valid, but no retired run may be visible afterward.
  const oldProbe = { schema_version: 1, source: 'probe', batch_id: randomUUID(), observed_at: start,
    layer: 'owui', outcome: 'success', duration_ms: 0, phases_ms: {}, events_ms: {}, extensions: {} };
  await Promise.allSettled([
    ingest(db, 'probes', validate('probes', oldProbe, long, transition), transition, long),
    readRows(db, 'probes', range, transition, short),
  ]);
  assert.equal((await readRows(db, 'probes', range, transition, long)).length, 0);
  const fresh = run(transition);
  await ingest(db, 'deletions', validate('deletions', fresh, long, transition), transition, long);
  const accepted = await db.prepare('SELECT expires_at FROM deletion_runs WHERE batch_id=?').bind(fresh.batch_id).first();
  assert.equal(accepted.expires_at, transition + DAY, 'increases remain prohibited for new observations too');
  await purge(db, transition, long);
  assert.equal(await db.prepare('SELECT batch_id FROM receipts WHERE batch_id=?').bind(original.batch_id).first(), null);
  await assert.rejects(ingest(db, 'deletions', validate('deletions', original, long, transition), transition, long), Invalid);
  await assert.rejects(ingest(db, 'deletions', validate('deletions', { ...original, batch_id: randomUUID() }, long, transition), transition, long), Invalid);
  await assert.rejects(ingest(db, 'metrics', validate('metrics', mixed, long, transition), transition, long), Invalid);
  // Advancing expiry then rolling back clock/config cannot resurrect a receipt or point.
  await purge(db, transition + 2 * DAY, long);
  await assert.rejects(ingest(db, 'deletions', validate('deletions', fresh, long, transition), transition, long), Invalid);
  const states = (await db.prepare('SELECT * FROM retention_state ORDER BY class').all()).results;
  assert.equal(states.length, 5, 'only five durable content-free rows survive purge');
  for (const state of states) assert.equal(state.ttl_ms, state.class === 'browser' ? Math.min(initialBrowser?.ttl_ms ?? 90 * DAY, 90 * DAY) : DAY);
}
