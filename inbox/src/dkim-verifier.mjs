import { Buffer } from 'node:buffer';
import { dkimVerify } from 'mailauth/lib/dkim/verify';

// Domain authorization boundary (DESIGN.md, research/DKIM.md).
// The only trusted output is: a DKIM signature that passed, made
// by a domain on the owner's allowlist, and exactly equal to the single From
// mailbox's domain. A From match alone, or a copied Authentication-Results
// header, is never trusted.
export const POLICY = Object.freeze({
  maxBytes: 1024 * 1024,     // hard restricted-mail cap; no 25 MiB verification claim
  maxHeaderBytes: 32768,
  maxHeaderLines: 200,
  maxSignatures: 4,
  maxDnsQueries: 4,
  dnsTimeoutMs: 1500,
  maxTxtBytes: 8192,
  maxDohBytes: 32768,
  minBitLength: 2048,
  algorithms: Object.freeze(['rsa-sha256', 'ed25519-sha256'])
});

const reject = (reason, extra = {}) => ({ trusted: false, reason, ...extra });

// `strict: false` exists only to measure real-world syntax deviations (DKIM.md);
// production keeps strict mode plus the guarded selector compatibility extension.
export async function authenticate(raw, { resolver, allowedDomains, selectorPins = {}, now, strict = true } = {}) {
  try {
    const allowed = new Set((allowedDomains || []).map(d => d.toLowerCase()));
    if (!allowed.size) return reject('no-allowlist');
    const bytes = Buffer.from(raw);
    if (bytes.length > POLICY.maxBytes) return reject('size');
    const end = bytes.indexOf('\r\n\r\n');
    if (end < 0 || end > POLICY.maxHeaderBytes) return reject('headers');
    const headers = bytes.subarray(0, end).toString('latin1');
    if ((headers.match(/^DKIM-Signature:/gim) || []).length > POLICY.maxSignatures ||
        headers.split('\r\n').length > POLICY.maxHeaderLines) return reject('complexity');

    let queries = 0;
    const boundedResolver = async (name, type) => {
      if (++queries > POLICY.maxDnsQueries || type !== 'TXT' || name.length > 253) {
        throw Object.assign(new Error('DNS bound'), { code: 'EREFUSED' });
      }
      let timer;
      try {
        const answer = await Promise.race([
          resolver(name, type),
          new Promise((_, fail) => {
            timer = setTimeout(() => fail(Object.assign(new Error('DNS timeout'), { code: 'ETIMEOUT' })), POLICY.dnsTimeoutMs);
          })
        ]);
        // mailauth reads only answer[0]; refuse ambiguous answers instead.
        if (!Array.isArray(answer) || answer.length !== 1 ||
            answer.some(rr => !Array.isArray(rr) || rr.some(s => typeof s !== 'string')) ||
            answer.flat().reduce((n, s) => n + s.length, 0) > POLICY.maxTxtBytes) {
          throw Object.assign(new Error('DNS answer bound'), { code: 'EINVALIDANSWER' });
        }
        return answer;
      } finally { clearTimeout(timer); }
    };

    const result = await dkimVerify(bytes, {
      strict, rejectRsaSha1: true, minBitLength: POLICY.minBitLength, resolver: boundedResolver,
      ...(now ? { curTime: new Date(now) } : {})
    });
    if (result.fromFields !== 1 || result.fromSyntax !== 'valid' || result.headerFrom.length !== 1) {
      return reject('from-header', { queries, result });
    }
    const author = result.headerFrom[0].toLowerCase();
    const authorDomain = author.slice(author.lastIndexOf('@') + 1);
    const passing = result.results.filter(r => r.status?.result === 'pass');
    const signature = passing.find(r => {
      const d = (r.signingDomain || '').toLowerCase();
      // Pins are per-domain exact selector sets (DNS case-insensitive), not keys
      // or people. An explicit empty set denies every selector for that domain.
      const pin = Object.entries(selectorPins).find(([domain]) => domain.toLowerCase() === d);
      const selectorAllowed = !pin || (Array.isArray(pin[1]) &&
        pin[1].some(s => typeof s === 'string' && s.toLowerCase() === r.selector?.toLowerCase()));
      return d === authorDomain && allowed.has(d) &&
        selectorAllowed &&
        POLICY.algorithms.includes(r.algo) && r.signatureTimeValid === true &&
        !r.status.testing &&
        r.canonBodyLengthLimited === false && r.canonBodyLength === r.canonBodyLengthTotal &&
        r.signingHeaders.keys.toLowerCase().split(':').map(s => s.trim()).includes('from');
    });
    if (!signature) {
      return reject(passing.length ? 'no-qualifying-signature' : 'no-passing-signature', { queries, result });
    }
    return {
      trusted: true, domain: signature.signingDomain.toLowerCase(), selector: signature.selector,
      algo: signature.algo, from: author, queries, result
    };
  } catch (error) {
    return reject('exception', { error: error.message });
  }
}

// Bounded DNS-over-HTTPS TXT lookup for workerd (no node:dns resolver needed).
// Trusts the recursive resolver's answer: no DNSSEC validation happens here.
export function dohResolver(fetchImpl = fetch, endpoint = 'https://cloudflare-dns.com/dns-query') {
  return async (name, type) => {
    const url = `${endpoint}?name=${encodeURIComponent(name)}&type=${type}`;
    const res = await fetchImpl(url, { redirect: 'manual', headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(POLICY.dnsTimeoutMs) });
    if (!res.ok) throw Object.assign(new Error(`DoH ${res.status}`), { code: 'ETIMEOUT' });
    // Bound the response before JSON.parse, including chunked/lying responses.
    const reader = res.body?.getReader();
    if (!reader) throw new Error('Empty DNS response');
    let total = 0;
    const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > POLICY.maxDohBytes) throw new Error('DNS response bound');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (body.Status === 3) throw Object.assign(new Error('NXDOMAIN'), { code: 'ENOTFOUND' });
    if (body.Status !== 0) throw Object.assign(new Error(`DNS rcode ${body.Status}`), { code: 'ETIMEOUT' });
    const records = (body.Answer || []).filter(a => a.type === 16).map(a => parseTxtData(a.data));
    if (!records.length) throw Object.assign(new Error('NODATA'), { code: 'ENODATA' });
    return records;
  };
}

// Fixed-policy entrypoint used by production: no strict-mode or DNS override from
// the owner/message. Injectable fetch exists only for local endpoint tests.
export async function verifyEmailDomain(raw, policy, fetchImpl = fetch) {
  let timer;
  try {
    const verdict = await Promise.race([
      authenticate(raw, { resolver: dohResolver(fetchImpl), allowedDomains: policy.domains,
        selectorPins: policy.selector_pins || {} }),
      new Promise(resolve => { timer = setTimeout(() => resolve({ trusted: false, temporary: true }), 6500); })
    ]);
    if (verdict.trusted) return { trusted: true, domain: verdict.domain, selector: verdict.selector, algo: verdict.algo };
    return { trusted: false, temporary: verdict.temporary === true ||
      verdict.result?.results?.some(r => r.status?.result === 'temperror') === true };
  } finally { clearTimeout(timer); }
}

// DoH JSON renders one TXT RR as space-separated quoted chunks with \" and \DDD escapes.
export function parseTxtData(data) {
  const chunks = [];
  for (const m of data.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    chunks.push(m[1].replace(/\\(\d{3}|.)/g, (_, e) => e.length === 3 ? String.fromCharCode(Number(e)) : e));
  }
  return chunks.length ? chunks : [data];
}
