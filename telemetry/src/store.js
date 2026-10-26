import { LIMITS, retentionMs } from './policies.js';
import { canonical, Invalid } from './validate.js';
import { NETWORK_LOCATIONS } from './browser-policy.js';

export const TABLES = Object.freeze({ browser: 'browser_observations', metrics: 'metric_points',
  deletions: 'deletion_runs', probes: 'probe_runs', lifecycle: 'lifecycle_buckets', status: 'source_status' });
const ALL_TABLES = [...Object.values(TABLES), 'receipts', 'ingress_budgets'];
const bind = (db, sql, values) => db.prepare(sql).bind(...values);
const CLASSES = ['browser', 'metrics', 'deletions', 'probes', 'lifecycle'];
// Included in the same D1 transaction as admission, read or purge, never a
// read/modify/write in JS. Stale concurrent configurations cannot raise a ceiling.
function policy(db, klass, ttl, now) {
  return bind(db, `INSERT INTO retention_state(class,ttl_ms,cutoff_ms) VALUES (?,?,?)
    ON CONFLICT(class) DO UPDATE SET ttl_ms=MIN(ttl_ms,excluded.ttl_ms),
    cutoff_ms=MAX(cutoff_ms,excluded.cutoff_ms,?-MIN(ttl_ms,excluded.ttl_ms))`,
  [klass, ttl, now - ttl, now]);
}
const cutoff = klass => `(SELECT cutoff_ms FROM retention_state WHERE class='${klass}')`;
const cappedExpiry = klass => `MIN(?, ? + (SELECT ttl_ms FROM retention_state WHERE class='${klass}'))`;
async function digest(x) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(x)));
  return [...new Uint8Array(b)].map(v => v.toString(16).padStart(2, '0')).join('');
}
export async function takeBudget(db, source, klass, now, points = null) {
  const bucket = `${source}:${klass}:${points === null ? 'attempts' : 'points'}:${Math.floor(now / 60_000)}`;
  const cap = points === null ? (klass === 'browser' ? LIMITS.browserPerMinute : LIMITS.serviceBatchesPerMinute)
    : LIMITS.metricPointsPerMinute;
  const weight = points ?? 1;
  const row = await bind(db, `INSERT INTO ingress_budgets(bucket,used,expires_at) VALUES (?,?,?)
    ON CONFLICT(bucket) DO UPDATE SET used=used+excluded.used WHERE used+excluded.used <= ? RETURNING used`,
  [bucket, weight, now + 120_000, cap]).first();
  return !!row;
}

export async function ingest(db, klass, data, now, env = {}) {
  if (!CLASSES.includes(klass)) throw new Invalid();
  const ttl = Math.min(retentionMs(env, klass), data.expires_at - data.observed_at);
  const oldest = Math.min(data.observed_at, ...(data.points ?? []).map(p => p.observed_at));
  const admissible = `? > ${cutoff(klass)}`;
  const statements = [policy(db, klass, ttl, now)];
  if (klass === 'browser') {
    const network = data.network_location ?? 'unknown';
    if (!NETWORK_LOCATIONS.includes(network)) throw new Invalid();
    statements.push(bind(db, `INSERT INTO browser_observations
      (schema_version,policy_version,observed_at,received_at,expires_at,destination,referring_hostname,network_location)
      SELECT ?,?,?,?,${cappedExpiry(klass)},?,?,? WHERE ${admissible}`, [data.schema_version, data.policy_version, data.observed_at, now,
      data.expires_at, data.observed_at, data.destination, data.referring_hostname, network, oldest]));
    const results = await db.batch(statements);
    if (!results[1].meta.changes) throw new Invalid();
    return { duplicate: false };
  }
  // Hash normalized semantic content only. Retry time must not change the hash.
  const { expires_at, ...semantic } = data;
  const hash = await digest(semantic);
  const receiptArgs = [data.source, klass, data.batch_id];
  statements.push(bind(db, `INSERT OR IGNORE INTO receipts
    (source,class,batch_id,payload_hash,observed_at,expires_at) SELECT ?,?,?,?,?,${cappedExpiry(klass)} WHERE ${admissible}`,
  [...receiptArgs, hash, data.observed_at, expires_at, data.observed_at, oldest]));
  const guard = ` WHERE ${admissible} AND EXISTS (SELECT 1 FROM receipts WHERE source=? AND class=? AND batch_id=? AND payload_hash=? AND expires_at>?)`;
  const guardArgs = [oldest, ...receiptArgs, hash, now];
  const guardedInsert = (table, row) => {
    const names = Object.keys(row);
    const values = names.flatMap(k => k === 'expires_at' ? [row[k], row.observed_at] : [row[k]]);
    statements.push(bind(db, `INSERT OR IGNORE INTO ${table} (${names.join(',')})
      SELECT ${names.map(k => k === 'expires_at' ? cappedExpiry(klass) : '?').join(',')}${guard}`, [...values, ...guardArgs]));
  };
  const common = { schema_version: data.schema_version, policy_version: data.policy_version,
    source: data.source, batch_id: data.batch_id, observed_at: data.observed_at, received_at: now, expires_at };
  if (klass === 'lifecycle') {
    // Immediately follows receipt insertion in the same atomic transaction.
    // changes()=1 admits exactly one increment, including concurrent retries.
    statements.push(bind(db, `INSERT INTO lifecycle_buckets
      (schema_version,policy_version,source,observed_at,expires_at,event,old_state,new_state,count)
      SELECT ?,?,?,?,${cappedExpiry(klass)},?,?,?,1${guard} AND changes()=1
      ON CONFLICT(source,observed_at,event,old_state,new_state) DO UPDATE SET
      count=count+1,expires_at=MIN(expires_at,excluded.expires_at)`,
    [data.schema_version, data.policy_version, data.source, data.observed_at,
      expires_at, data.observed_at, data.event, data.old_state ?? '', data.new_state, ...guardArgs]));
  }
  if (klass === 'metrics') data.points.forEach((p, i) => guardedInsert('metric_points', {
    ...common, point_index: i, observed_at: p.observed_at,
    // Older points cannot inherit the envelope's newer expiry.
    expires_at: Math.min(expires_at, p.observed_at + ttl),
    name: p.name, kind: p.kind, unit: p.unit, start_at: p.start_at ?? null,
    time_unix_nano: p.time_unix_nano ?? null, start_time_unix_nano: p.start_time_unix_nano ?? null,
    temporality: p.temporality ?? null, monotonic: p.monotonic === undefined ? null : Number(p.monotonic),
    value: p.value ?? null, count: p.count ?? null, sum: p.sum ?? null, min: p.min ?? null, max: p.max ?? null,
    attributes_json: canonical(p.attributes), bounds_json: p.bounds ? canonical(p.bounds) : null,
    bucket_counts_json: p.bucket_counts ? canonical(p.bucket_counts) : null,
  }));
  if (klass === 'deletions') guardedInsert('deletion_runs', { ...common, job: data.job,
    outcome: data.outcome, duration_ms: data.duration_ms, deleted: data.deleted, extensions_json: canonical(data.extensions) });
  if (klass === 'probes') guardedInsert('probe_runs', { ...common, layer: data.layer,
    outcome: data.outcome, duration_ms: data.duration_ms, phases_json: canonical(data.phases_ms),
    events_json: canonical(data.events_ms), extensions_json: canonical(data.extensions) });
  statements.push(bind(db, `INSERT INTO source_status
    (source,class,schema_version,policy_version,observed_at,received_at,expires_at)
    SELECT ?,?,?,?,?,?,${cappedExpiry(klass)}${guard}
    ON CONFLICT(source,class) DO UPDATE SET schema_version=excluded.schema_version,
      policy_version=excluded.policy_version,observed_at=excluded.observed_at,
      received_at=excluded.received_at,expires_at=excluded.expires_at
    WHERE excluded.observed_at > source_status.observed_at`,
  [data.source, klass, data.schema_version, data.policy_version, data.observed_at, now, expires_at, data.observed_at, ...guardArgs]));
  statements.push(bind(db, `SELECT payload_hash,expires_at,${cutoff(klass)} AS cutoff_ms FROM receipts WHERE source=? AND class=? AND batch_id=?`, receiptArgs));
  // D1 batch is transactional. Conflicting concurrent payloads cannot mix points.
  const results = await db.batch(statements);
  const receipt = results.at(-1).results[0];
  if (!receipt || oldest <= receipt.cutoff_ms || receipt.expires_at <= now) throw new Invalid();
  if (receipt.payload_hash !== hash) return { conflict: true };
  return { duplicate: results[1].meta.changes === 0 };
}

export async function readRows(db, klass, { from, to, limit }, now, env) {
  const table = TABLES[klass];
  if (!table) throw new Error('invalid_class');
  const classes = klass === 'status' ? CLASSES : [klass];
  const statements = classes.map(k => policy(db, k, retentionMs(env, k), now));
  const boundary = klass === 'status' ? '(SELECT cutoff_ms FROM retention_state WHERE class=source_status.class)' : cutoff(klass);
  const params = [from, to, now];
  params.push(limit);
  statements.push(bind(db, `SELECT * FROM ${table}
    WHERE observed_at>=? AND observed_at<? AND expires_at>?
    AND observed_at>${boundary}
    ORDER BY observed_at ASC${klass === 'status' ? ', source, class' : ', id'} LIMIT ?`, params));
  return (await db.batch(statements)).at(-1).results;
}

// Exact duplicate points (overlapping export batches) collapse before counting or
// summing. Same-millisecond latest points that disagree are flagged, not resolved.
export async function readMetricBuckets(db, { from, to, name, bucket, limit }, now, env) {
  const latest = column => `MAX(CASE WHEN rank=1 THEN ${column} END)`;
  return (await db.batch([policy(db, 'metrics', retentionMs(env, 'metrics'), now), bind(db, `
    WITH points AS (
      SELECT MAX(id) AS id, MIN(expires_at) AS expires_at, observed_at - (observed_at % ?) AS bucket_start, source, attributes_json,
        kind, unit, temporality, observed_at, start_at, value, count, sum, bounds_json, bucket_counts_json
      FROM metric_points
      WHERE name=? AND observed_at>=? AND observed_at<? AND expires_at>? AND observed_at>${cutoff('metrics')}
      GROUP BY source, attributes_json, kind, unit, temporality, observed_at, start_at, time_unix_nano,
        start_time_unix_nano, monotonic, value, count, sum, min, max, bounds_json, bucket_counts_json
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER series AS rank, MAX(observed_at) OVER series AS newest FROM points
      WINDOW series AS (PARTITION BY bucket_start, source, attributes_json ORDER BY observed_at DESC, id DESC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
    )
    SELECT bucket_start, source, attributes_json, ${latest('kind')} AS kind, ${latest('unit')} AS unit,
      ${latest('temporality')} AS temporality, COUNT(*) AS samples,
      MIN(observed_at) AS first_at, MAX(observed_at) AS last_at, MIN(expires_at) AS min_expires_at, MIN(value) AS min_value, MAX(value) AS max_value,
      ${latest('value')} AS last_value, ${latest('count')} AS last_count, ${latest('sum')} AS last_sum,
      ${latest('start_at')} AS last_start_at, ${latest('bucket_counts_json')} AS last_bucket_counts_json,
      ${latest('bounds_json')} AS last_bounds_json,
      COUNT(DISTINCT CASE WHEN observed_at=newest THEN quote(value)||','||quote(count)||','||quote(sum) END)>1 AS conflict,
      CASE WHEN MIN(temporality IS 'delta') THEN SUM(value) END AS delta_sum
    FROM ranked GROUP BY bucket_start, source, attributes_json
    ORDER BY bucket_start, source, attributes_json LIMIT ?`, [bucket, name, from, to, now, limit])])).at(-1).results;
}

export async function purge(db, now, env) {
  const statements = CLASSES.map(k => policy(db, k, retentionMs(env, k), now));
  statements.push(...ALL_TABLES.map(table => {
    const klass = Object.keys(TABLES).find(k => TABLES[k] === table);
    const byClass = klass === 'status' || table === 'receipts';
    const clause = klass && klass !== 'status' ? ` OR observed_at<=${cutoff(klass)}` : byClass
      ? ` OR observed_at<=(SELECT cutoff_ms FROM retention_state WHERE class=${table}.class)` : '';
    const args = [now];
    args.push(LIMITS.purgeRowsPerTable);
    return bind(db, `DELETE FROM ${table} WHERE rowid IN
      (SELECT rowid FROM ${table} WHERE expires_at<=?${clause} ORDER BY expires_at LIMIT ?)`, args);
  }));
  return db.batch(statements);
}
