// Synthetic wire fixtures only. Not evidence of the real Daytona exporter.
import { createHmac } from 'node:crypto';
export const NOW = 1_792_521_131_000;
export const DAYTONA_ENV = {
  DAYTONA_WEBHOOKS_ENABLED: 'true', DAYTONA_OTLP_ENABLED: 'true',
  DAYTONA_ORGANIZATION_ID: 'synthetic-org', DAYTONA_WEBHOOK_PROTOCOL: 'standard-webhooks',
  DAYTONA_WEBHOOK_SECRET: `whsec_${Buffer.alloc(32, 7).toString('base64')}`,
  DAYTONA_RECEIPT_SECRET: 'synthetic-only-dedup-secret-123456789',
};
export function signedWebhook({ id = 'msg_synthetic', timestamp = Math.floor(NOW / 1000), fields = {}, family = 'webhook' } = {}) {
  const body = JSON.stringify({ event: 'sandbox.state.updated', timestamp: new Date(NOW).toISOString(),
    id: 'FAKE_PRIVATE_SANDBOX', organizationId: 'synthetic-org', oldState: 'started', newState: 'stopped',
    updatedAt: new Date(NOW).toISOString(), ...fields });
  const signature = createHmac('sha256', Buffer.alloc(32, 7)).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { method: 'POST', headers: { 'Content-Type': 'application/json',
    [`${family}-id`]: id, [`${family}-timestamp`]: String(timestamp), [`${family}-signature`]: `v1,${signature}` }, body };
}
const cat = (...xs) => Buffer.concat(xs);
const vi = n => { n = BigInt(n); const a = []; do { const b = Number(n & 127n); n >>= 7n; a.push(b | (n ? 128 : 0)); } while (n); return Buffer.from(a); };
const msg = (id, b) => cat(vi(id * 8 + 2), vi(b.length), b);
const txt = (id, s) => msg(id, Buffer.from(s));
const fixed = (id, n, float = false) => { const b = Buffer.alloc(8); if (float) b.writeDoubleLE(n); else b.writeBigUInt64LE(BigInt(n)); return cat(vi(id * 8 + 1), b); };
const attr = (field, k, v) => msg(field, cat(txt(1, k), msg(2, txt(1, v))));
export function organizationWire({ value = 1.5, name = 'daytona.sandbox.used_cpu', unit = 'cores',
  region = 'us', sandboxClass = 'container', extraDimension = false, sandboxResource = false, organization = 'synthetic-org', time = NOW, integer = false } = {}) {
  const resource = sandboxResource ? cat(attr(1, 'service.instance.id', 'FAKE_PRIVATE_SANDBOX'),
    attr(1, 'daytona_organization_id', organization)) : attr(1, 'organization.id', organization);
  const point = cat(fixed(3, BigInt(time) * 1_000_000n), integer ? fixed(6, value) : fixed(4, value, true),
    attr(7, 'region.id', region), attr(7, 'sandbox.class', sandboxClass),
    extraDimension ? attr(7, 'user.email', 'FAKE_PRIVATE_EMAIL') : Buffer.alloc(0));
  const metric = cat(txt(1, name), txt(3, unit), msg(5, msg(1, point)));
  return msg(1, cat(msg(1, resource), msg(2, msg(2, metric))));
}
