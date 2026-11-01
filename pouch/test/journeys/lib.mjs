import { chromium } from 'playwright';
export const URL = process.env.POUCH_URL ?? 'http://127.0.0.1:8742/pouch.html';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ mobile = false, userDataDir = '/tmp/pouch-qa/profile' + (mobile ? '-m' : ''), fresh = false } = {}) {
  if (fresh) (await import('node:fs')).rmSync(userDataDir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true, acceptDownloads: true,
    viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 900 },
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : {}),
  });
  return ctx;
}

export function instrument(page, tag = '') {
  const errors = [];
  page.dialogQueue = []; // answers for prompt/confirm, in order
  page.dialogLog = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${tag}[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${tag}[pageerror] ${e.message}`));
  page.on('dialog', async (d) => {
    page.dialogLog.push(`${d.type()}: ${d.message().slice(0, 160)}`);
    const a = page.dialogQueue.shift();
    if (d.type() === 'alert') return d.accept();
    if (a === false) return d.dismiss();
    return d.accept(typeof a === 'string' ? a : undefined);
  });
  return errors;
}

export async function rows(page) {
  return page.$$eval('#tree .row', (rs) => rs.map((r) => r.querySelector('.name')?.title ?? r.textContent));
}
export async function rowMore(page, path) {
  await ensurePanel(page, 'files');
  await page.locator(`#tree .row:has(.name[title="${path}"]) .more`).first().click();
  await page.waitForSelector('#sheet[open]');
}
export async function sheetClick(page, label) {
  await page.locator('#sheet-actions button', { hasText: label }).first().click();
}
export async function waitRow(page, path, present = true, timeout = 5000) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    const has = (await rows(page)).includes(path);
    if (has === present) return true;
    await sleep(100);
  }
  throw new Error(`row ${path} ${present ? 'never appeared' : 'never left'}`);
}

// The new frame (layout.js): one right panel at a time, sessions in a sidebar.
export async function ensurePanel(page, name) {
  if ((await page.getAttribute('#app', 'data-panel')) !== name) await page.click(`#rail button[data-panel="${name}"]`);
  await page.waitForFunction((n) => document.querySelector('#app').dataset.panel === n, name);
}
export async function showChat(page) {
  if (await page.isVisible('#rail button[data-panel="chat"]')) await page.click('#rail button[data-panel="chat"]');
  else if (await page.getAttribute('#app', 'data-panel')) await page.click(`#rail button[data-panel="${await page.getAttribute('#app', 'data-panel')}"]`);
}
export async function openSidebar(page, open = true) {
  const now = await page.$eval('#app', (a) => a.classList.contains('side-open'));
  if (now !== open) await page.click(open || !(await page.isVisible('#side-close')) ? '#flipper' : '#side-close');
  await sleep(250);
}
export async function newSession(page) {
  if (await page.isVisible('#new-top')) await page.click('#new-top');
  else { await openSidebar(page); await page.click('#new'); }
}
export const currentSession = (page) => page.$eval('#session-list .session[aria-current="true"]', (e) => e.dataset.id).catch(() => null);
export const sessionIds = (page) => page.$$eval('#session-list .session', (s) => s.map((x) => x.dataset.id));
export async function pickSession(page, id) {
  await openSidebar(page);
  await page.click(`#session-list .session[data-id="${id}"] .s-open`);
}
export async function sessionMenu(page, id) {
  await openSidebar(page);
  await page.click(`#session-list .session${id ? `[data-id="${id}"]` : '[aria-current="true"]'} .s-more`);
  await page.waitForSelector('#sheet[open]');
}
export const waitSignedIn = (page) => page.waitForFunction(() => document.querySelector('#auth').getAttribute('aria-label') === 'Forget key');
export const authLabel = (page) => page.getAttribute('#auth', 'aria-label');
