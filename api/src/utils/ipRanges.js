// Shared Campus Pass / browser-arrival matcher. No address leaves this function.
import campusNetworks from './campus-networks.json' with { type: 'json' };

function ipv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some(p => !/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255)) return null;
  return parts.reduce((n, p) => (n << 8n) | BigInt(p), 0n);
}
function address(ip) {
  if (typeof ip !== 'string' || !ip) return null;
  if (!ip.includes(':')) {
    const value = ipv4(ip);
    return value === null ? null : { value, bits: 32 };
  }
  // Embedded IPv4 is valid only in the final 32 bits, never a port or zone ID.
  if (ip.includes('.')) {
    const tail = ip.slice(ip.lastIndexOf(':') + 1), value = ipv4(tail);
    if (value === null) return null;
    ip = ip.slice(0, -tail.length) + `${(value >> 16n).toString(16)}:${(value & 65535n).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  let parts;
  if (halves.length === 2) {
    const before = halves[0] ? halves[0].split(':') : [];
    const after = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - before.length - after.length;
    if (missing < 1) return null;
    parts = [...before, ...Array(missing).fill('0'), ...after];
  } else parts = ip.split(':');
  if (parts.length !== 8 || parts.some(p => !/^[0-9a-fA-F]{1,4}$/.test(p))) return null;
  return { value: parts.reduce((n, p) => (n << 16n) | BigInt(`0x${p}`), 0n), bits: 128 };
}

// null distinguishes an unavailable/invalid address or range configuration from
// a valid noncampus address. Existing explicit CIDR configuration remains valid.
export function campusAddressStatus(ip, rangesConfig = '@ucsc') {
  const parsed = address(ip);
  if (!parsed || typeof rangesConfig !== 'string' || !rangesConfig) return null;
  const ranges = rangesConfig === '@ucsc' ? campusNetworks : rangesConfig.split(',').map(x => x.trim());
  let matched = false;
  for (const cidr of ranges) {
    const parts = cidr.split('/'), range = address(parts[0]);
    if (parts.length !== 2 || !range || !/^\d{1,3}$/.test(parts[1]) || Number(parts[1]) > range.bits) return null;
    if (parsed.bits === range.bits) {
      const shift = BigInt(range.bits - Number(parts[1]));
      if ((parsed.value >> shift) === (range.value >> shift)) matched = true;
    }
  }
  return matched;
}
