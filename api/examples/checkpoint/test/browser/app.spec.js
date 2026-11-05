import { test, expect } from '@playwright/test';

async function open(page) {
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#checkpoint')).toBeEnabled();
}
async function edit(page, text, selector = '#editor') {
  const editor = page.locator(`${selector} .ProseMirror`);
  await editor.fill(text);
}
async function checkpoint(page, note) {
  await page.locator('#checkpoint-note').fill(note);
  await page.locator('#checkpoint').click();
  await expect(page.locator('#inspection h3')).toHaveText(note);
}
test('edit, checkpoint, historical policy, reload, export and import', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await open(page);
  await edit(page, 'The editorial speaks for its editor, not all residents.');
  await checkpoint(page, 'Distinguish the speaker');
  await page.locator('#policy-tab').click();
  await edit(page, 'Ask about the audience. Do not rewrite.', '#policy-editor');
  await page.locator('#draft-tab').click();
  await edit(page, 'The editorial addresses property owners.');
  await checkpoint(page, 'Identify the audience');
  await expect(page.locator('#history button')).toHaveCount(2);
  await page.locator('#history button').last().click();
  await page.getByText('Policy at this checkpoint', { exact: true }).click();
  await expect(page.locator('#inspection')).toContainText('thoughtful reader');
  await page.reload();
  await expect(page.locator('#editor .ProseMirror')).toContainText('property owners');
  await expect(page.locator('#history button')).toHaveCount(2);
  const downloading = page.waitForEvent('download'); await page.locator('#export').click();
  const download = await downloading; const path = await download.path();
  await edit(page, 'Uncheckpointed text to retain in the old workspace.');
  await expect(page.locator('#save-status')).toHaveText('Saved locally');
  await page.locator('#import-file').setInputFiles(path);
  await expect(page.locator('#editor .ProseMirror')).toContainText('property owners');
  await expect(page.locator('#history button')).toHaveCount(2);
  expect(errors).toEqual([]);
});
test('a second tab cannot write; phone layout fits', async ({ page, context }) => {
  await open(page);
  const second = await context.newPage(); await second.goto('/');
  await expect(second.locator('#notice')).toContainText('another tab');
  await expect(second.locator('#app')).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('mocked grant consent and review preserve checkpoint association and exclude tokens from export', async ({ page }) => {
  await page.route('https://api.bayleaf.dev/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/grants/clients') return route.fulfill({ json: { client_id: 'test-descriptor' } });
    if (url.pathname === '/grants/authorize') {
      const callback = 'http://127.0.0.1:5174/?code=mock-code&state=' + url.searchParams.get('state');
      return route.fulfill({ status: 302, headers: { location: callback } });
    }
    if (url.pathname === '/grants/token') return route.fulfill({ json: { access_token: 'SECRET-TEST-TOKEN', models: ['openrouter:test/model'], expires_at: Math.floor(Date.now() / 1000) + 3600 } });
    if (url.pathname === '/v1/chat/completions') {
      const body = route.request().postDataJSON();
      expect(route.request().headers().authorization).toBe('Bearer SECRET-TEST-TOKEN');
      expect(body.messages[0].content).toContain('Ask only about evidence');
      expect(JSON.parse(body.messages[1].content).currentDraft).toContain('Original checkpoint text');
      return route.fulfill({ json: { choices: [{ message: { content: '## A question\n\nWhat **evidence** supports that inference?\n\n- Consider the audience.\n\n<script>window.BAD=true</script>' } }] } });
    }
    return route.fulfill({ status: 404 });
  });
  await open(page);
  await page.locator('#policy-tab').click();
  await edit(page, 'Ask only about evidence', '#policy-editor');
  await page.locator('#draft-tab').click();
  await edit(page, 'Original checkpoint text');
  await page.locator('#critic-menu > summary').click(); await page.locator('#model').fill('openrouter:test/model');
  await page.locator('#connect').click();
  await expect(page.locator('#connection')).toContainText('Connected until');
  await expect(page).toHaveURL('http://127.0.0.1:5174/');
  await checkpoint(page, 'Testing a review');
  await expect(page.locator('.review-body h2')).toHaveText('A question');
  await expect(page.locator('.review-body strong')).toHaveText('evidence');
  await expect(page.locator('.review-body li')).toHaveText('Consider the audience.');
  await expect(page.getByText('Exact request sent to the model', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.BAD)).toBeUndefined();
  await expect(page.locator('#checkpoint')).toBeEnabled();
  const downloading = page.waitForEvent('download'); await page.locator('#export').click();
  const download = await downloading; const stream = await download.createReadStream();
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const archive = JSON.parse(Buffer.concat(chunks).toString());
  const decoded = archive.files.map(file => Buffer.from(file.data, 'base64').toString()).join('\n');
  expect(decoded).toContain('What **evidence** supports');
  expect(decoded).not.toContain('SECRET-TEST-TOKEN');
  await page.reload(); await expect(page.locator('#connection')).toContainText('Not connected');
  await expect(page.locator('.review')).toContainText('What evidence supports');
});

test('failed reviews can retry their original context while writing continues', async ({ page }) => {
  let requests = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('https://api.bayleaf.dev/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/grants/clients') return route.fulfill({ json: { client_id: 'descriptor' } });
    if (url.pathname === '/grants/authorize') return route.fulfill({ status: 302, headers: { location: 'http://127.0.0.1:5174/?code=code&state=' + url.searchParams.get('state') } });
    if (url.pathname === '/grants/token') return route.fulfill({ json: { access_token: 'TEMP', models: ['openrouter:test/model'], expires_at: Math.floor(Date.now() / 1000) + 3600 } });
    if (url.pathname === '/v1/chat/completions') {
      requests++;
      expect(JSON.parse(route.request().postDataJSON().messages[1].content).currentDraft).toContain('Committed text');
      if (requests === 1) return route.fulfill({ status: 429, json: { error: 'quota' } });
      await gate;
      return route.fulfill({ json: { choices: [{ message: { content: 'A delayed response to the original checkpoint.' } }] } });
    }
    return route.fulfill({ status: 404 });
  });
  await open(page);
  await edit(page, 'Committed text');
  await page.locator('#critic-menu > summary').click(); await page.locator('#model').fill('openrouter:test/model'); await page.locator('#connect').click();
  await expect(page.locator('#connection')).toContainText('Connected until');
  await checkpoint(page, 'A durable checkpoint');
  await expect(page.locator('.review')).toContainText('429');
  await expect(page.locator('#history button')).toHaveCount(1);
  await page.getByRole('button', { name: 'Review again' }).click();
  await expect(page.locator('#notice')).toContainText('Asking your critic');
  await expect(page.locator('.review[aria-busy="true"] .review-placeholder')).toBeVisible();
  await expect(page.locator('.review-waiting')).toHaveText('Reading this checkpoint…');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('.review-skeleton').evaluate(node => getComputedStyle(node).animationName)).toBe('none');
  await edit(page, 'New working text while the response is in flight.');
  release();
  await expect(page.locator('.review').first()).toContainText('delayed response');
  await expect(page.locator('.review-placeholder')).toHaveCount(0);
  await expect(page.locator('#editor .ProseMirror')).toContainText('New working text');
  await expect(page.locator('.review')).toHaveCount(2);
  await expect(page.locator('#history button')).toHaveCount(1);
  await page.getByText('Draft at this checkpoint', { exact: true }).click();
  await expect(page.locator('#inspection details').filter({ hasText: 'Draft at this checkpoint' })).toContainText('Committed text');
  // Each attempt is independently removable without rewriting the checkpoint.
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Delete review', exact: true }).first().click();
  await expect(page.locator('.review')).toHaveCount(2);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete review', exact: true }).first().click();
  await expect(page.locator('.review')).toHaveCount(1);
  await expect(page.locator('.review')).toContainText('429');
  await expect(page.locator('#history button')).toHaveCount(1);
  await expect(page.locator('#save-status')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('.review')).toHaveCount(1);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete review', exact: true }).click();
  await expect(page.locator('.review')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Request feedback', exact: true })).toBeVisible();
  await expect(page.locator('#history button')).toHaveCount(1);
});

test('restore keeps history and policy; invalid import does not replace the workspace', async ({ page }) => {
  await open(page); await edit(page, 'A saved draft'); await checkpoint(page, 'First');
  await edit(page, 'A newer draft'); await checkpoint(page, 'Second');
  await page.locator('#history button').last().click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Copy this draft into editor' }).click();
  await expect(page.locator('#editor .ProseMirror')).toContainText('A saved draft');
  await expect(page.locator('#history button')).toHaveCount(2);
  await page.locator('#import-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"not-a-workspace"}') });
  await expect(page.locator('#notice')).toContainText('Not a supported');
  await expect(page.locator('#editor .ProseMirror')).toHaveAttribute('contenteditable', 'true');
  await expect(page.locator('#history button')).toHaveCount(2);
  await expect(page.locator('#editor .ProseMirror')).toContainText('A saved draft');
});

test('authorization state mismatch fails without exchanging a token', async ({ page }) => {
  let exchanged = false;
  await page.route('https://api.bayleaf.dev/grants/token', route => { exchanged = true; return route.fulfill({ status: 500 }); });
  await page.goto('/?code=untrusted&state=wrong');
  await expect(page.locator('#notice')).toContainText('did not match');
  await expect(page).toHaveURL('http://127.0.0.1:5174/');
  expect(exchanged).toBe(false);
  await edit(page, 'Still able to write'); await checkpoint(page, 'Offline checkpoint');
});
