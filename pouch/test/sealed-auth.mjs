// Shared UI sign-in for live Sealed suites (#149). The green shield verifies
// the enclave, not the key: it can already be green while the key check waits.
import assert from 'node:assert/strict';

export async function signInSealed(page, keyText) {
  await page.click('#auth');
  await page.waitForSelector('#sheet[open] #key-input', { timeout: 10000 });
  await page.fill('#key-input', keyText);
  await page.click('#sheet .key-form button[type=submit]');
  await page.waitForSelector('#auth.on', { timeout: 60000 });
  await page.waitForSelector('#sheet[open]', { state: 'hidden', timeout: 60000 });
  await page.waitForSelector('#badge.ok', { timeout: 60000 });
}

export function assertLiveRequests(sent, cap) {
  assert.ok(sent > 0, 'the live journey must send at least one model request');
  assert.ok(sent <= cap, `request cap exceeded (${sent} > ${cap})`);
}
