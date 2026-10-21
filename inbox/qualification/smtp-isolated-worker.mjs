// No-retention SMTP fixture, never a production receiver or storage qualification.
import { verifyEmailDomain } from '../.generated/dkim-verifier.mjs';
export default {
  async email(message, env) {
    if (Date.now() > Number(env.QUALIFICATION_EXPIRES) || message.to !== env.QUALIFICATION_RECIPIENT) {
      return message.setReject('5.1.1 Address not found');
    }
    const mode = env.QUALIFICATION_MODE;
    if (!['pin-pass', 'pin-fail', 'domain-fail', 'unknown', 'throw', 'rate-reject'].includes(mode)) throw Error('qualification configuration');
    if (mode === 'unknown') return message.setReject('5.1.1 Address not found');
    if (mode === 'throw') throw Error('qualification injected failure');
    if (mode === 'rate-reject') return message.setReject('4.7.0 Rate limited, try later');
    const rejectSize = () => {
      console.log(JSON.stringify({ qualification: mode, verdict: 'size-rejected', bytes: message.rawSize }));
      return message.setReject('5.3.4 Restricted inbox supports DKIM mail up to 1 MiB');
    };
    if (message.rawSize > 1048576) return rejectSize();
    const chunks = [], reader = message.raw.getReader();
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1048576) { await reader.cancel(); return rejectSize(); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const raw = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
    const policy = mode === 'domain-fail' ? { domains: ['example.invalid'] } : {
      domains: ['ucsc.edu'], selector_pins: { 'ucsc.edu': [mode === 'pin-fail' ? 'qualification-wrong-selector' : 'ucsc-google-2018'] }
    };
    const result = await verifyEmailDomain(raw, policy);
    if (result.temporary) throw Error('qualification DNS unavailable');
    // Fixed verdict only. Never print raw headers, addresses or verifier diagnostics.
    console.log(JSON.stringify({ qualification: mode, verdict: result.trusted ? 'accepted' : 'rejected', bytes: size }));
    if (!result.trusted) message.setReject('5.7.1 DKIM domain authorization required');
  }
};
