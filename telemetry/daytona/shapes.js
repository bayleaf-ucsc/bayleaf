// Qualification-only structural diagnostics. Fixed names and keys, no attribute
// values, descriptions, scope names or arbitrary user-supplied labels retained.
import { schema, one, many, str } from '../otlp/normalize.mjs';
import { DAYTONA_METRICS, REGIONS, CLASSES } from './policy.js';
const allowedKeys = ['organization.id', 'region.id', 'sandbox.class', 'service.name', 'service.instance.id',
  'service.version', 'telemetry.sdk.name', 'telemetry.sdk.language', 'telemetry.sdk.version',
  'daytona_organization_id', 'daytona_region_id', 'daytona_snapshot'];
function attributeKeys(raws, budget) {
  const names = [];
  for (const raw of raws) {
    const kv = schema(raw, [1, 2], budget), name = str(one(kv, 1, 2, true));
    names.push(allowedKeys.includes(name) ? name : '<excluded>');
  }
  return [...new Set(names)].sort();
}
function approvedDimensions(raws, budget) {
  const values = {};
  for (const raw of raws) {
    const kv = schema(raw, [1, 2], budget), key = str(one(kv, 1, 2, true));
    const choices = key === 'region.id' ? REGIONS : key === 'sandbox.class' ? CLASSES : null;
    if (!choices) continue;
    const av = schema(one(kv, 2, 2, true), [1, 2, 3, 4, 5, 6, 7], budget), rawValue = one(av, 1, 2);
    const value = rawValue ? str(rawValue) : null;
    values[key] = choices.includes(value) ? value : '<excluded>';
  }
  return values;
}
export function shapes(bytes) {
  const budget = { fields: 0 }, out = [];
  for (const raw of many(schema(bytes, [1], budget), 1, 2)) {
    const rm = schema(raw, [1, 2, 3], budget), r = one(rm, 1, 2);
    const resource = r ? schema(r, [1, 2], budget) : new Map();
    const resourceKeys = attributeKeys(many(resource, 1, 2), budget);
    for (const scopeRaw of many(rm, 2, 2)) {
      const scope = schema(scopeRaw, [1, 2, 3], budget);
      for (const metricRaw of many(scope, 2, 2)) {
        const m = schema(metricRaw, [1, 2, 3, 5, 7, 9, 10, 11, 12], budget);
        const name = str(one(m, 1, 2, true));
        if (!Object.hasOwn(DAYTONA_METRICS, name)) continue;
        const unitRaw = one(m, 3, 2), unit = unitRaw ? str(unitRaw) : '';
        const units = ['', '1', 'cores', '{core}', '{cpu}', '{gpu}', 'GiBy', 'GiB', 'By', 'bytes'];
        const type = [5, 7, 9, 10, 11].filter(k => m.has(k));
        const data = type.length === 1 ? schema(one(m, type[0], 2, true), [1, 2, 3], budget) : new Map();
        const pRaw = many(data, 1, 2)[0];
        const p = pRaw ? schema(pRaw, [2, 3, 4, 6, 7, 8], budget) : new Map();
        out.push({ name, unit: units.includes(unit) ? unit : '<excluded>', type,
          temporality: Number(one(data, 2, 0) ?? 0n), monotonic: Number(one(data, 3, 0) ?? 0n),
          numeric: p.has(4) ? 'double' : p.has(6) ? 'integer' : 'unknown', resource_keys: resourceKeys,
          point_keys: attributeKeys(many(p, 7, 2), budget),
          dimensions: approvedDimensions(many(p, 7, 2), budget) });
        if (out.length >= 32) return out;
      }
    }
  }
  return out;
}
