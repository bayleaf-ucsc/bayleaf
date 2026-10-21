// Independent-signer check: verify real archived messages against live public DNS.
// Usage: node real-world.mjs <message.eml>...   (files are untrusted data; keep them
// outside this directory). Node uses node:dns; workerd uses bounded DoH via fetch.
// The allowlist is set to each message's own From domain to exercise the policy.
import { readFile } from 'node:fs/promises';
import { promises as dns } from 'node:dns';
import { Miniflare, convertV4MiniflareOptions } from '../node_modules/miniflare/dist/src/index.js';
import { bundle } from './build.mjs';

const { code } = await bundle({ shim: true });
const baseline = await bundle({ shim: false });
const { authenticate } = await import(`data:text/javascript;base64,${Buffer.from(baseline.code).toString('base64')}`);
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: code,
  compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'] }));
const crlf = s => s.replace(/\r?\n/g, '\r\n');
const sigs = v => v.result?.results?.map(r =>
  `${r.signingDomain}/${r.selector} ${r.algo} ${r.status?.result}${r.status?.comment ? ` (${r.status.comment})` : ''}`);
const args = process.argv.slice(2);
const strict = !args.includes('--lenient');  // measurement only, see DKIM.md
try {
  for (const path of args.filter(a => a !== '--lenient')) {
    // latin1 maps bytes 1:1, so this LF to CRLF rewrite is byte-exact.
    const raw = Buffer.from(crlf(await readFile(path, 'latin1')), 'latin1');
    const from = raw.toString('latin1').match(/^From:.*?([\w.+-]+@([\w.-]+))/im)?.[2]?.toLowerCase();
    const allowedDomains = from ? [from] : [];
    const node = await authenticate(raw, { resolver: (n, t) => dns.resolve(n, t), allowedDomains, strict });
    const worker = await (await mf.dispatchFetch('http://research.test', { method: 'POST',
      body: JSON.stringify({ rawBase64: raw.toString('base64'), allowedDomains, dns: 'doh', strict }) })).json();
    console.log(JSON.stringify({ path, from, node: { trusted: node.trusted, reason: node.reason, sigs: sigs(node) },
      workerd: { trusted: worker.trusted, reason: worker.reason, sigs: sigs(worker), ms: worker.ms } }));
  }
} finally { await mf.dispose(); }
