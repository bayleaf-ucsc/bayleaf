// Test-only endpoint. Never imported by the production Worker.
import { Buffer } from 'node:buffer';
import { authenticate } from '../src/dkim-verifier.mjs';
export { authenticate, POLICY, dohResolver, parseTxtData } from '../src/dkim-verifier.mjs';

export default {
  async fetch(request) {
    const { raw: text, rawBase64, allowedDomains, selectorPins, records, dns, now, strict } = await request.json();
    const raw = rawBase64 ? Buffer.from(rawBase64, 'base64') : text;
    const { dohResolver } = await import('../src/dkim-verifier.mjs');
    const resolver = dns === 'doh' ? dohResolver() : async (name, type) => {
      const entry = records?.[name.toLowerCase()];
      if (entry === 'hang') return new Promise(() => {});
      if (entry === 'servfail') throw Object.assign(new Error('mock SERVFAIL'), { code: 'ETIMEOUT' });
      if (type !== 'TXT' || !entry) throw Object.assign(new Error('mock NXDOMAIN'), { code: 'ENOTFOUND' });
      return entry;
    };
    const started = Date.now();
    const verdict = await authenticate(raw, { resolver, allowedDomains, selectorPins, now, strict });
    return Response.json({ ...verdict, ms: Date.now() - started });
  }
};
