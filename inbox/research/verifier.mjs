import { Buffer } from 'node:buffer';
import { dkimVerify } from 'mailauth/lib/dkim/verify';

// Research policy only. Limits are deliberately smaller than production's mail cap.
export async function verify(raw, resolver) {
  try {
    const bytes = Buffer.from(raw);
    if (bytes.length > 1024 * 1024) return { accepted: false, reason: 'size' };
    const end = bytes.indexOf('\r\n\r\n');
    if (end < 0 || end > 32768) return { accepted: false, reason: 'headers' };
    const headers = bytes.subarray(0, end).toString('latin1');
    if ((headers.match(/^DKIM-Signature:/gim) || []).length > 4 ||
        (headers.match(/^ARC-/gim) || []).length > 0 ||
        headers.split('\r\n').length > 200) return { accepted: false, reason: 'complexity' };
    let queries = 0;
    const boundedResolver = async (name, type) => {
      if (++queries > 4 || type !== 'TXT' || name.length > 253) throw new Error('DNS bound');
      let timer;
      try {
        const answer = await Promise.race([
          resolver(name, type),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), 250); })
        ]);
        // mailauth reads only answer[0], so reject ambiguous/missing records here.
        if (!Array.isArray(answer) || answer.length !== 1 ||
            answer.some(rr => !Array.isArray(rr) || rr.some(s => typeof s !== 'string')) ||
            answer.flat().reduce((n, s) => n + s.length, 0) > 8192) throw new Error('DNS answer bound');
        return answer;
      } finally { clearTimeout(timer); }
    };
    const result = await dkimVerify(bytes, { strict: true, minBitLength: 2048, resolver: boundedResolver });
    const author = result.fromFields === 1 && result.fromSyntax === 'valid' &&
      result.headerFrom.length === 1 && result.headerFrom[0] === 'amsmith@ucsc.edu';
    const accepted = author && result.results.some(r =>
      r.status.result === 'pass' && r.signingDomain.toLowerCase() === 'ucsc.edu' &&
      r.algo === 'rsa-sha256' && r.signatureTimeValid === true &&
      r.canonBodyLengthLimited === false && r.canonBodyLength === r.canonBodyLengthTotal &&
      r.signingHeaders.keys.toLowerCase().split(':').map(s => s.trim()).includes('from'));
    return { accepted, queries, result };
  } catch (error) {
    return { accepted: false, reason: 'exception', error: error.message };
  }
}

export default {
  async fetch(request) {
    // Synthetic fixtures and mocked DNS only, never a production endpoint.
    const { raw, key, dnsFailure, dnsHang } = await request.json();
    return Response.json(await verify(raw, async (name, type) => {
      if (dnsHang) return new Promise(() => {});
      if (dnsFailure) throw Object.assign(new Error('mock DNS unavailable'), { code: 'ETIMEOUT' });
      if (type !== 'TXT' || !/^poc\._domainkey\.(ucsc\.edu|other\.example)$/.test(name)) {
        throw Object.assign(new Error('mock NXDOMAIN'), { code: 'ENOTFOUND' });
      }
      // Two strings in one TXT RR: the library must join chunks, not records.
      return [[key.slice(0, 100), key.slice(100)]];
    }));
  }
};
