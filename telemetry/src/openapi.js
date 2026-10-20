// Documentation only: validate.js remains the admission authority. Derive policy
// vocabularies here, not a second runtime validator or a general schema framework.
import { LIMITS, SCHEMA_VERSION, POLICY_VERSION, DESTINATIONS, ORIGINS, SOURCE_JOBS,
  OUTCOMES, LAYERS, PHASES, EVENTS, PROBE_RESULTS, DELETION_COUNTS, METRICS, ROUTES } from './policies.js';
import { BROWSER_SCHEMA_VERSION, BROWSER_POLICY_VERSION, NETWORK_LOCATIONS } from './browser-policy.js';
import { LIMITS as OTLP_LIMITS, DEFAULT_ROUTES } from '../otlp/normalize.mjs';
import { TABLES } from './store.js';

const integer = (maximum = 1e12) => ({ type: 'integer', minimum: 0, maximum });
const number = (maximum = 1e12) => ({ type: 'number', minimum: 0, maximum });
const time = { ...integer(1e15), description: 'UTC epoch milliseconds. Observations must be newer than the effective retention cutoff and no more than 60 seconds ahead of receipt.' };
const choice = values => ({ type: 'string', enum: [...values] });
const fixed = value => ({ const: value });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const map = (names, value) => object(Object.fromEntries(names.map(name => [name, value])), []);
const array = (items, maxItems, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const nano = { type: 'string', pattern: '^(0|[1-9][0-9]{0,19})$', description: 'Unsigned uint64 decimal nanoseconds, at most 18446744073709551615. Floor(ns / 1000000) must equal the corresponding millisecond field.' };
const batch = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$', description: 'Job/probe run or metric export receipt, stable on retry. Never an account identifier.' };
const common = { schema_version: fixed(SCHEMA_VERSION), source: choice([]), batch_id: batch, observed_at: time };
const run = { outcome: choice(OUTCOMES), duration_ms: number(3_600_000) };
const runTimes = { started_at: time, ended_at: time };
const runDescription = 'If supplied, started_at and ended_at must both be present; started_at <= ended_at = observed_at. Run bounds may start up to one day before the retention window. Durations use an independent monotonic clock.';
const counts = source => map(DELETION_COUNTS[source], integer());
const deletion = source => ({ ...object({ ...common, source: fixed(source), job: choice(SOURCE_JOBS[source]), ...run,
  deleted: integer(), extensions: object({ dry_run: { type: 'boolean' }, scanned: integer(), eligible: integer(), pending: integer(), failed: integer(),
    ...runTimes, counts: counts(source), mode: choice(['delete', 'dry-run', 'disabled']), retention_days: integer(),
    orphan_grace_seconds: integer(), user_retention_months: integer(), file_sweep: fixed('skipped_no_eligible_files') }, []) }),
  description: `${runDescription} dry_run=true or mode=dry-run|disabled requires deleted=0. Missing counters are unknown, not zero. Counts and jobs are restricted to this authenticated source.` });
const result = { type: 'string', anyOf: [choice(PROBE_RESULTS), { pattern: '^(chat|openrouter|api|sealed)_http_[1-5][0-9]{2}$' }] };
const probe = { ...object({ ...common, source: fixed('probe'), layer: choice(LAYERS), ...run,
  phases_ms: map(PHASES, number(3_600_000)), events_ms: map(EVENTS, number(3_600_000)),
  extensions: object({ failed_phase: choice([...PHASES, 'gates']), cleanup: choice(['confirmed', 'failed', 'not_needed']),
    close: choice(['not_started', 'unconfirmed', 'confirmed', 'failed']), http_status: { type: 'integer', minimum: 100, maximum: 599 },
    accounted_ms: number(3_600_000), unaccounted_ms: number(3_600_000), ...runTimes, result, work_result: result }, []) }),
  description: `${runDescription} Sum of additive phases <= duration_ms + 1; each event offset <= duration_ms + 1. Do not add event offsets to durations. accounted_ms must equal phase sum within 1ms; unaccounted_ms <= duration_ms + 1; supplied accounted + unaccounted must equal duration within 1ms. Fixed synthetic results only, never errors or response text.` };

const attributeSchemas = { method: choice(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'OTHER']),
  route: choice(ROUTES), status_code: { type: 'integer', minimum: 100, maximum: 599 },
  instance: choice(['worker-1', 'worker-2', 'worker-3', 'worker-4', 'single']) };
const metric = ([name, spec]) => {
  const base = { name: fixed(name), kind: fixed(spec.kind), unit: fixed(spec.unit), observed_at: time,
    attributes: object(Object.fromEntries(spec.attributes.map(key => [key, attributeSchemas[key]])), []), time_unix_nano: nano };
  const required = ['name', 'kind', 'unit', 'observed_at', 'attributes'];
  if (spec.kind === 'gauge') return object({ ...base, value: integer() }, [...required, 'value']);
  const timed = { ...base, start_at: { ...integer(1e15), description: 'Exact series/window start, not inferred process start. May predate retention; must be <= observed_at - 10000.' },
    temporality: choice(['delta', 'cumulative']), start_time_unix_nano: nano };
  required.push('start_at', 'temporality');
  if (spec.kind === 'sum') return object({ ...timed, monotonic: fixed(true), value: integer() }, [...required, 'monotonic', 'value']);
  return { ...object({ ...timed, count: integer(), sum: number(), min: number(), max: number(), bounds: array(number(), 64), bucket_counts: array(integer(), 65, 1) },
    [...required, 'count', 'bounds', 'bucket_counts']), description: 'Strictly increasing bounds, disjoint buckets including overflow. bucket_counts.length = bounds.length + 1; sum(bucket_counts) = count. min <= max. Zero count requires absent min/max and absent or zero sum.' };
};

const stored = { schema_version: integer(), policy_version: integer(), observed_at: integer(1e15), received_at: integer(1e15), expires_at: integer(1e15) };
const serviceStored = { id: integer(), ...stored, source: { type: 'string' }, batch_id: batch };
const jsonString = { type: 'string', description: 'Serialized validated JSON, not a nested object in this response.' };
const rowSchemas = {
  BrowserRow: { ...object({ id: integer(), ...stored, destination: choice(DESTINATIONS), referring_hostname: nullable({ type: 'string' }), network_location: choice(NETWORK_LOCATIONS) }),
    description: `New rows: schema ${BROWSER_SCHEMA_VERSION}, policy ${BROWSER_POLICY_VERSION}. Historical rows preserve original versions; migration assigns unknown network location without IP backfill.` },
  DeletionRow: object({ ...serviceStored, job: { type: 'string' }, ...run, deleted: integer(), extensions_json: jsonString }),
  ProbeRow: object({ ...serviceStored, layer: choice(LAYERS), ...run, phases_json: jsonString, events_json: jsonString, extensions_json: jsonString }),
  MetricRow: object({ ...serviceStored, point_index: integer(), name: choice(Object.keys(METRICS)), kind: choice(['sum', 'histogram', 'gauge']), unit: choice(['1', 'ms', 'users']),
    start_at: nullable(integer(1e15)), time_unix_nano: nullable(nano), start_time_unix_nano: nullable(nano), temporality: nullable(choice(['delta', 'cumulative'])),
    monotonic: nullable({ type: 'integer', enum: [0, 1] }), value: nullable(number()), count: nullable(integer()), sum: nullable(number()), min: nullable(number()), max: nullable(number()),
    attributes_json: jsonString, bounds_json: nullable(jsonString), bucket_counts_json: nullable(jsonString) }),
  StatusRow: { ...object({ source: { type: 'string' }, class: choice(['metrics', 'deletions', 'probes']), ...stored }),
    description: 'Latest accepted service observation per source/class, not live health or proof of delivery. Browser arrivals do not create source-status rows. Retries do not manufacture fresh status.' },
};
const rows = { browser: 'BrowserRow', metrics: 'MetricRow', deletions: 'DeletionRow', probes: 'ProbeRow', status: 'StatusRow' };
const schemas = {
  BrowserPayload: { ...object({ schema_version: fixed(SCHEMA_VERSION), destination: choice(DESTINATIONS), referring_hostname: nullable({ type: 'string', maxLength: 253 }) }),
    description: 'Exactly three wire fields. referring_hostname is a DNS hostname only, lowercased and trailing dot removed: no URL, port, path, query, fragment, IP literal, private/local suffix, long or identifier-like label. Labels <=48 characters; unapproved BayLeaf subdomains rejected. null means unknown, not proven direct traffic. No client timestamp, ID, cookie, IP or UA. Server-only enrichment assigns observed/received/expiry times and network_location from transient CF-Connecting-IP classification. The address is never stored. Network location is not campus affiliation; VPN/visitor egress can differ. Client-supplied enrichment is rejected.',
    example: { schema_version: SCHEMA_VERSION, destination: 'landing', referring_hostname: 'example.org' } },
  DeletionPayload: { oneOf: Object.keys(SOURCE_JOBS).map(deletion) },
  ProbePayload: probe,
  MetricPoint: { oneOf: Object.entries(METRICS).map(metric) },
  MetricsPayload: { ...object({ ...common, source: fixed('owui'), points: array(ref('MetricPoint'), LIMITS.points, 1) }),
    description: 'Normalized internal JSON, NOT OTLP JSON. Each point observed_at <= envelope observed_at. All point observations independently satisfy retention and clock bounds. Unknown fields rejected recursively.' },
  Accepted: object({ accepted: fixed(true), duplicate: { type: 'boolean' } }),
  Error: object({ error: choice(['disabled', 'configuration', 'unauthorized', 'forbidden', 'invalid_request', 'invalid_payload', 'not_found', 'method_not_allowed', 'rate_limited', 'batch_conflict', 'unavailable']) }),
  ...rowSchemas,
};
for (const [klass, row] of Object.entries(rows)) schemas[`${row}Response`] = object({
  schema_version: fixed(klass === 'browser' ? BROWSER_SCHEMA_VERSION : SCHEMA_VERSION),
  policy_version: fixed(klass === 'browser' ? BROWSER_POLICY_VERSION : POLICY_VERSION),
  as_of: integer(1e15), from: integer(Number.MAX_SAFE_INTEGER), to: integer(Number.MAX_SAFE_INTEGER), limit: { type: 'integer', minimum: 1, maximum: LIMITS.readRows },
  truncated: { type: 'boolean' }, rows: array(ref(row), LIMITS.readRows),
});
const content = schema => ({ 'application/json': { schema } });
const error = description => ({ description, content: content(ref('Error')) });
const failures = { 400: error('invalid_payload: strict validation, JSON/body/encoding/deadline failure; invalid_request: query on a write route.'),
  401: error('unauthorized: missing, wrong or wrong-scope service bearer.'), 405: error('method_not_allowed'),
  409: error('batch_conflict: retained source/class/batch_id reused with changed normalized content.'),
  429: error('rate_limited: admission budget exhausted. Invalid attempts and retries consume budget.'),
  503: error('disabled, configuration or unavailable. No payload, exception, SQL diagnostics or credential echoed.') };
const serviceSecurity = [{ SourceBearer: [] }];
const browserOrigins = Object.entries(ORIGINS).map(([origin, destination]) => `${origin} → ${destination}`).join('; ');
const paths = {};
for (const [klass, schema] of Object.entries({ browser: 'BrowserPayload', deletions: 'DeletionPayload', probes: 'ProbePayload', metrics: 'MetricsPayload' })) {
  paths[`/v1/${klass}`] = { post: { operationId: `submit_${klass}`, tags: ['Ingestion'], summary: `Submit ${klass}`,
    security: klass === 'browser' ? [] : serviceSecurity,
    description: klass === 'browser' ? `Both collection switches must be true. Exact Origin must match destination: ${browserOrigins}. Origin is a browser gate, not authentication or bot protection. Global, non-identity D1 budget ${LIMITS.browserPerMinute}/minute plus optional shared edge limiter. No visitor dedup: duplicate is always false.`
      : `TELEMETRY_ENABLED must equal "true". Dedicated source bearer restricted to its class and source field; not a BayLeaf inference key or Chat admin credential. ${LIMITS.serviceBatchesPerMinute} attempts per source/class/fixed UTC minute${klass === 'metrics' ? ` plus ${LIMITS.metricPointsPerMinute} points/minute` : ''}.`,
    ...(klass === 'browser' ? { parameters: [{ name: 'Origin', in: 'header', required: true, schema: choice(Object.keys(ORIGINS)) }] } : {}),
    requestBody: { required: true, description: `application/json; identity encoding only; <=${LIMITS.bodyBytes} bytes, <=2048 chunks, 2-second body deadline.`, content: content(ref(schema)) },
    responses: { 202: { description: 'Durable admission. Identical service retry returns duplicate=true without renewing expiry. Browser returns duplicate=false.', content: content(ref('Accepted')) },
      ...Object.fromEntries(Object.entries(failures).filter(([status]) => klass !== 'browser' || !['401', '409'].includes(status))),
      ...(klass === 'browser' ? { 403: error('forbidden: absent or unapproved Origin.') } : {}) } } };
}
paths['/v1/browser'].options = { operationId: 'browser_preflight', tags: ['Ingestion'], summary: 'Approved browser CORS preflight', security: [],
  description: 'Both switches must be true and Origin approved. Allows POST and Content-Type only, no credentials. Success and explicit admission-rate responses include exact Origin/Vary headers; validation failures need not include CORS headers.',
  parameters: [{ name: 'Origin', in: 'header', required: true, schema: choice(Object.keys(ORIGINS)) }], responses: { 204: { description: 'Empty preflight response.' }, 405: error('Unapproved Origin does not receive preflight approval.'), 503: failures[503] } };
paths['/v1/otlp/metrics'] = { post: { operationId: 'submit_otlp_metrics', tags: ['Ingestion'], summary: 'Native OWUI OTLP/HTTP binary metrics', security: serviceSecurity,
  description: `Actual ExportMetricsServiceRequest protobuf, not OTLP JSON or normalized JSON. Default Worker installs the decoder; createWorker without a hook has no route. Dedicated owui bearer only. No gzip: absent/identity encoding. <=${OTLP_LIMITS.bytes} bytes, ${OTLP_LIMITS.chunks} chunks, ${OTLP_LIMITS.bodyMs}ms deadline; decoder caps ${OTLP_LIMITS.fields} fields, ${OTLP_LIMITS.metrics} metrics, ${OTLP_LIMITS.points} raw points and ${OTLP_LIMITS.buckets} bucket entries. Bridge admits 1–${LIMITS.points} minimized points. Only approved metric names/native units, integer sums/gauges and explicit histograms. No resource attributes, schema URLs, exemplars, arbitrary scope/version/description or labels. Optional scope name must be open_webui.utils.telemetry.metrics; optional descriptions must match native definitions. HTTP points require exactly http.method, http.route, http.status_code; default routes: ${DEFAULT_ROUTES.join(', ')}. Gauges have no attributes. Unknown fields fail closed, not generic OTLP compatibility. Unknown/zero starts rejected; nongauge startup windows <10 seconds omitted, never stretched; all omitted gives 422. Exact uint64 ns times preserved as decimal strings. Exact duplicate wire points collapse; conflicting duplicates rejected. Canonical minimized content yields stable receipt ID. Rate caps are shared with normalized owui metrics; overload is 503, not 429, for qualified Python exporter retry behavior. Retries must remain bounded.`,
  requestBody: { required: true, content: { 'application/x-protobuf': { schema: { type: 'string', format: 'binary', description: 'Binary opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest.' } } } },
  responses: { 200: { description: 'Durable admission or identical retry. Empty ExportMetricsServiceResponse protobuf (zero bytes), no partial-success payload.', content: { 'application/x-protobuf': { schema: { type: 'string', format: 'binary', maxLength: 0 } } } },
    400: error('invalid_payload: malformed/unsupported protobuf or normalized-policy failure; invalid_request: query on write route.'),
    401: failures[401], 405: failures[405], 408: error('invalid_payload: body deadline.'), 409: failures[409],
    413: error('invalid_payload: byte/chunk or bridge point limit.'), 415: error('invalid_payload: unsupported media type or encoding.'),
    422: error('invalid_payload: storage/window policy (including no aggregate points).'), 503: error('disabled, configuration, unavailable or rate_limited. Retryable overload, not 429.') } } };
for (const klass of Object.keys(TABLES)) paths[`/v1/read/${klass}`] = { get: {
  operationId: `read_${klass}`, tags: ['Private reads'], summary: `Bounded private ${klass} rows`, security: [{ OperatorBearer: [] }],
  description: `Separate operator bearer, not a write key. Requires TELEMETRY_ENABLED="true" even for reads. Exact once-only decimal-digit from/to/limit parameters, no extras; safe integers, from < to, to <= now + ${LIMITS.futureMs}ms, window <= ${LIMITS.readWindowMs}ms. Reads [from,to), oldest observed_at first, ties ${klass === 'status' ? 'source then class' : 'id'}. Expired and durably retired rows excluded before physical purge. Read transaction advances content-free retention state, not observations. truncated = (rows.length === limit): conservative, not proof more rows exist. No cursor/exhaustive dense-same-ms pagination, public read CORS, cookies, SQL or aggregate endpoint. JSON columns remain strings; SQL null and integer monotonic flags are preserved. Envelope versions describe current contract; rows retain their original versions.`,
  parameters: ['from', 'to', 'limit'].map(name => ({ name, in: 'query', required: true, schema: { type: 'integer', minimum: name === 'limit' ? 1 : 0,
    maximum: name === 'limit' ? LIMITS.readRows : Number.MAX_SAFE_INTEGER }, description: name === 'limit' ? 'Required row cap, not an offset.' : 'UTC epoch milliseconds; decimal digits only.' })),
  responses: { 200: { description: 'Bounded raw typed rows, not a complete export.', content: content(ref(`${rows[klass]}Response`)) },
    400: error('invalid_payload: invalid/missing/repeated/unknown query parameters or bounds.'),
    401: error('unauthorized: missing or incorrect operator read bearer; source write keys do not authorize reads.'), 503: failures[503] },
} };
for (const [path, label, media] of [['/', 'Integration-status dashboard', 'text/html'], ['/docs', 'Scalar API reference', 'text/html'], ['/docs/openapi.json', 'OpenAPI contract', 'application/json']]) {
  paths[path] = Object.fromEntries(['get', 'head'].map(method => [method, { operationId: `${method}_${path === '/' ? 'dashboard' : path.slice(1).replace('.', '_')}`,
    tags: ['Public documentation'], summary: label, security: [], description: 'Public and available with ingestion disabled. No credentials or database access. HEAD has no body. Other methods return 405 with Allow: GET, HEAD.',
    responses: { 200: { description: method === 'head' ? 'Headers only.' : label, ...(method === 'get' ? { content: { [media]: { schema: { type: media === 'application/json' ? 'object' : 'string' } } } } : {}) }, 405: { description: 'Method not allowed.' } } }]));
}

export const openapi = {
  openapi: '3.1.0', info: { title: 'BayLeaf telemetry collector', version: `wire-${SCHEMA_VERSION}-policy-${POLICY_VERSION}-browser-${BROWSER_SCHEMA_VERSION}-${BROWSER_POLICY_VERSION}`,
    description: `A bounded first-party warehouse, not a general log collector or public query service. [Integration-status dashboard](/) · [API reference](/docs) · [Raw OpenAPI](/docs/openapi.json).

## Authority and versions
Public documentation grants no data access. Source bearers only submit approved source/class records. The independent operator bearer only authorizes bounded private reads. Both require valid, distinct configured secrets (>=24 non-whitespace characters); malformed configuration fails closed for both. No Campus Pass, inference-key, Chat-admin or cookie authorization. All ingestion and private reads require TELEMETRY_ENABLED="true"; browser ingestion also requires BROWSER_ENABLED="true". Public routes do not require either switch. No prompts, completions, identities, stable pseudonyms, IP/UA, private URLs or raw errors belong in telemetry. Browser wire version ${SCHEMA_VERSION} stays unchanged: server enrichment uses stored schema ${BROWSER_SCHEMA_VERSION}/policy ${BROWSER_POLICY_VERSION}; service records use schema ${SCHEMA_VERSION}/policy ${POLICY_VERSION}. Unknown fields fail closed recursively. JSON Schema describes structure; runtime also enforces hostname, cross-field, clock, credential and durable-retention invariants described here.

## Retention
Default local retention is 7 days; approved production retention is 90 days for all four classes, not a claim about current activation. RETENTION_DAYS and per-class *_RETENTION_DAYS accept integers 1–90. Expiry anchors to observation, not receipt/retry; points cannot inherit a newer envelope expiry. Admission, reads and purge atomically enforce a decreasing durable TTL ceiling and increasing retired-observation cutoff. Raising configuration cannot raise that ceiling or restore retired data: reviewed migration required. Purge continues when ingestion is off, in bounded batches of ${LIMITS.purgeRowsPerTable} rows per table per scheduled invocation. Purge backlog/outages can delay physical deletion; D1 paid Time Travel can retain deleted rows up to 30 additional days. No automatic archive/export. Reports/derived artifacts expire no later than their earliest included observation; restore must reapply durable policy and purge before reads/collection resume. Local TTL is not a guarantee of provider erasure.

## Interpretation and retries
HTTP metrics are aggregate windows, not individual HTTP request events or completed SSE answer latency. Never sum successive cumulative counters/histograms: use same-series exact observation/reset metadata to derive valid deltas, preserving resets rather than inferring them. Histograms retain disjoint buckets and optional sum/min/max. Native user gauges are global database snapshots, not disjoint per-worker populations: select an authoritative reading, never add repeated gauges across workers/times. Different export batches can overlap: deduplicate exact points by source/name/kind/unit/attributes/exact observation and reset times/values before reporting; conflicting values require investigation. Missing/stale samples and omitted counts are unknown, never zero. Service retry key is (source,class,batch_id), with canonical normalized content hash; changed content is 409 while receipt retained, identical retries do not renew TTL. Browser has no identifier/dedup and measures arrivals, not unique people.

## Transport and failures
Responses are no-store. No request bodies, headers, exceptions or SQL diagnostics are logged by the collector. Fixed minute budgets are per source/class, not per person/IP: browser ${LIMITS.browserPerMinute} attempts, service ${LIMITS.serviceBatchesPerMinute} attempts, metrics additionally ${LIMITS.metricPointsPerMinute} points. Invalid attempts and retries consume admitted budgets. These are storage caps, not guarantees against edge/D1 billing abuse; browser has an optional shared edge limiter. JSON failures are content-free {error:code}; errors need not have CORS headers. OTLP success is empty binary protobuf, but OTLP failures are also content-free JSON. No retry-after guarantee. Public docs use an external pinned Scalar script, not a new telemetry destination; use raw OpenAPI to avoid third-party renderer code.` },
  servers: [{ url: '/', description: 'This collector origin' }], security: [],
  tags: [{ name: 'Ingestion' }, { name: 'Private reads' }, { name: 'Public documentation' }], paths,
  components: { schemas, securitySchemes: {
    SourceBearer: { type: 'http', scheme: 'bearer', description: 'Dedicated per-source write credential. Restricted source/class/job, never operator read authority.' },
    OperatorBearer: { type: 'http', scheme: 'bearer', description: 'Separate READ_SECRET for bounded operator reads, never a source write credential.' },
  } },
};
