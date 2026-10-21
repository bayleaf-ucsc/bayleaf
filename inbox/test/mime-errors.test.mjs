// Contract with the installed maintained parser, not synthetic Error fixtures.
// postal-mime 4.0.11 has no structured resource-error code.
import test from 'node:test';
import assert from 'node:assert/strict';
import PostalMime from 'postal-mime';

test('installed postal-mime resource errors keep the ingress rejection classification', async () => {
  const nested = 'Content-Type: multipart/mixed; boundary=a\r\n\r\n--a\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\n\r\nx\r\n--b--\r\n--a--\r\n';
  for (const [raw, options, exact] of [
    [nested, { maxNestingDepth: 1 }, 'Maximum MIME nesting depth of 1 levels exceeded'],
    [nested, { maxPartCount: 1 }, 'Maximum MIME part count of 1 parts exceeded'],
    ['Subject: ' + 'x'.repeat(100) + '\r\n\r\nbody', { maxHeadersSize: 16 }, 'Maximum header size of 16 bytes exceeded'],
  ]) {
    await assert.rejects(PostalMime.parse(raw, options), error => {
      assert.equal(error.message, exact);
      assert.match(error.message, /^Maximum (?:MIME |header |forwarded address )/);
      return true;
    });
  }
});
