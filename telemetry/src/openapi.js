// Operator read reference only. Admission policy and validation live elsewhere.
import { LIMITS, SCHEMA_VERSION, POLICY_VERSION, DESTINATIONS, OUTCOMES, LAYERS, METRICS } from './policies.js';
import { BROWSER_SCHEMA_VERSION, BROWSER_POLICY_VERSION, NETWORK_LOCATIONS } from './browser-policy.js';
import { STATES } from '../daytona/policy.js';

const integer = (maximum = 1e12) => ({ type: 'integer', minimum: 0, maximum });
const number = () => ({ type: 'number', minimum: 0, maximum: 1e12 });
const choice = values => ({ type: 'string', enum: [...values] });
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const field = (schema, description) => ({ ...schema, description });
const time = description => field(integer(1e15), `${description} UTC epoch milliseconds.`);
const nano = { type: 'string', pattern: '^(0|[1-9][0-9]{0,19})$', description: 'Exact uint64 decimal nanoseconds; milliseconds are floored, not rounded.' };
const stored = {
  schema_version: field(integer(), 'Stored row version, which may differ from the response envelope.'),
  policy_version: integer(), observed_at: time('Observation time.'), received_at: time('Collector receipt time.'),
  expires_at: time('Expiry anchored to observation, not receipt or retry; retired/expired rows are excluded from reads.'),
};
const serviceStored = { id: integer(), ...stored, source: { type: 'string' },
  batch_id: field({ type: 'string', format: 'uuid' }, 'Run/export receipt ID, stable on retry.'),
};
const run = { outcome: choice(OUTCOMES), duration_ms: field(number(), 'Monotonic elapsed milliseconds.') };
const jsonString = description => field({ type: 'string' }, `JSON-encoded string. ${description}`);
const schemas = {
  LifecycleRow: object({ id: integer(), schema_version: integer(), policy_version: integer(),
    source: choice(['daytona']), observed_at: time('UTC 15-minute bucket start, not an exact event time.'),
    expires_at: time('Expiry anchored to bucket start.'), event: choice(['sandbox.created', 'sandbox.state.updated']),
    old_state: field(choice(['', ...STATES]), 'Empty for creation events.'), new_state: choice(STATES),
    count: field(integer(), 'Deduplicated transition events, not distinct sandboxes or people. Missing buckets are not proven zero.') }),
  BrowserRow: object({ id: integer(), ...stored, destination: choice(DESTINATIONS),
    referring_hostname: field(nullable({ type: 'string' }), 'Hostname only; null means unknown, not necessarily direct traffic.'),
    network_location: field(choice(NETWORK_LOCATIONS), 'Collector-derived network category, not affiliation. Older rows may be unknown.'),
  }),
  DeletionRow: object({ ...serviceStored, job: { type: 'string' }, ...run,
    deleted: field(integer(), 'Confirmed deletions; dry-run and disabled reports use zero.'),
    extensions_json: jsonString('Run bounds, mode and source-specific aggregate counters. Omitted counters are unknown, not zero.'),
  }),
  ProbeRow: object({ ...serviceStored, layer: choice(LAYERS), ...run,
    phases_json: jsonString('Additive phase durations in milliseconds.'),
    events_json: jsonString('Offsets from run start in milliseconds; do not add these to phase durations.'),
    extensions_json: jsonString('Result codes, cleanup/close outcomes and optional run bounds.'),
  }),
  MetricRow: { ...object({ ...serviceStored, point_index: integer(), name: choice(Object.keys(METRICS)),
    kind: choice(['sum', 'histogram', 'gauge']), unit: choice([...new Set(Object.values(METRICS).map(metric => metric.unit))]),
    start_at: field(nullable(integer(1e15)), 'Series/window start in epoch milliseconds; null for gauges. Reset metadata may predate retention.'),
    time_unix_nano: nullable(nano), start_time_unix_nano: nullable(nano),
    temporality: nullable(choice(['delta', 'cumulative'])),
    monotonic: field(nullable({ type: 'integer', enum: [0, 1] }), 'SQLite integer flag, not a JSON boolean; null when inapplicable.'),
    value: nullable(number()), count: nullable(integer()), sum: nullable(number()), min: nullable(number()), max: nullable(number()),
    attributes_json: jsonString('Native HTTP: method, sanitized route, status_code, instance. Native user gauges: {}. Daytona organization gauges: reviewed region and sandbox_class; never sum snapshots across time or overlapping GPU regions. Inbox delta counts use fixed transport/outcome enums in aligned 15-minute windows, never recipient dimensions.'),
    bounds_json: nullable(jsonString('Increasing histogram bounds.')),
    bucket_counts_json: nullable(jsonString('Disjoint histogram buckets, including overflow; counts sum to count.')),
  }), description: 'Derive deltas from cumulative counters/histograms using same-series exact reset timestamps; do not sum successive readings. Native user gauges are global snapshots: select one authoritative sample, never sum across workers or times. Export batches may overlap: deduplicate exact points before totals. HTTP duration is not completed-SSE latency; null statistics are unknown, not zero.' },
  StatusRow: { ...object({ source: { type: 'string' }, class: choice(['metrics', 'deletions', 'probes', 'lifecycle']), ...stored }),
    description: 'Latest accepted service observation per source/class, not live health. Browser arrivals have no status row; retries do not refresh it.' },
  Error: object({ error: choice(['invalid_payload', 'unauthorized', 'disabled', 'configuration', 'unavailable']) }),
};
const rows = { browser: ['Browser arrivals', 'BrowserRow'], metrics: ['Metrics', 'MetricRow'],
  lifecycle: ['Sandbox lifecycle counts', 'LifecycleRow'],
  probes: ['Probe runs', 'ProbeRow'], deletions: ['Deletion reports', 'DeletionRow'], status: ['Source status', 'StatusRow'] };
const parameters = [
  { name: 'from', in: 'query', required: true, schema: integer(Number.MAX_SAFE_INTEGER),
    description: `Inclusive observation time, UTC epoch milliseconds. from < to; maximum window ${LIMITS.readWindowMs / 86_400_000} days.` },
  { name: 'to', in: 'query', required: true, schema: integer(Number.MAX_SAFE_INTEGER),
    description: `Exclusive observation time, UTC epoch milliseconds. At most ${LIMITS.futureMs / 1000} seconds ahead of collector time.` },
  { name: 'limit', in: 'query', required: true, schema: { type: 'integer', minimum: 1, maximum: LIMITS.readRows },
    description: 'Required row cap. Parameters must occur once, as decimal digits; unknown parameters are rejected.' },
];
const content = schema => ({ 'application/json': { schema } });
const error = description => ({ description, content: content(ref('Error')) });
const paths = {};
for (const [klass, [label, row]] of Object.entries(rows)) {
  schemas[`${row}Response`] = object({
    schema_version: { const: klass === 'browser' ? BROWSER_SCHEMA_VERSION : SCHEMA_VERSION },
    policy_version: { const: klass === 'browser' ? BROWSER_POLICY_VERSION : POLICY_VERSION },
    as_of: time('Collector time at query.'), from: integer(Number.MAX_SAFE_INTEGER), to: integer(Number.MAX_SAFE_INTEGER),
    limit: parameters[2].schema,
    truncated: field({ type: 'boolean' }, `True when rows.length equals limit, not proof more rows exist. Narrow/split the time window if the ${LIMITS.readRows}-row cap is reached; no cursor or exhaustive same-millisecond pagination.`),
    rows: { type: 'array', items: ref(row), maxItems: LIMITS.readRows },
  });
  paths[`/v1/read/${klass}`] = { get: { operationId: `read_${klass}`, tags: ['Reads'], summary: label,
    description: `Oldest observation first; ties ordered by ${klass === 'status' ? 'source, class' : 'id'}.`,
    security: [{ OperatorBearer: [] }], parameters,
    responses: { 200: { description: 'Rows in [from, to), excluding expiry and retired observations. No-store.', content: content(ref(`${row}Response`)) },
      400: error('invalid_payload: missing, repeated, unknown or out-of-bounds query parameters.'),
      401: error('unauthorized: missing or incorrect operator bearer.'),
      503: error('disabled (TELEMETRY_ENABLED is not true), configuration (invalid credential setup), or unavailable (storage failure).'),
    },
  } };
}
export const openapi = {
  openapi: '3.1.0', info: { title: 'BayLeaf telemetry', version: '1',
    description: 'Use the operator read bearer, not a sk-bayleaf inference key or source write key. Supply from, to and limit for each query.' },
  servers: [{ url: '/' }], tags: [{ name: 'Reads' }], paths,
  components: { schemas, securitySchemes: {
    OperatorBearer: { type: 'http', scheme: 'bearer', description: 'READ_SECRET operator capability.' },
  } },
};
