// Local qualification helper, not a production server. No raw input logging.
import { normalizeOtlp, LIMITS, OtlpError } from './normalize.mjs';
const chunks = []; let size = 0;
try {
  for await (const c of process.stdin) { size += c.length; if (size > LIMITS.bytes) throw new OtlpError('payload_too_large', 413); chunks.push(c); }
  console.log(JSON.stringify(await normalizeOtlp(Buffer.concat(chunks))));
} catch (e) {
  console.error(e instanceof OtlpError ? e.code : 'qualification_failure');
  process.exitCode = 1;
}
