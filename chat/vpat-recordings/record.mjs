import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
import { chromium } from 'playwright';

const exec = promisify(execFile);
const origin = 'https://chat.bayleaf.dev';
const accountId = '1a49fb69291d42e23c4ed4dcffce5bbc';
const apiRoot = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering`;
const prompts = [
  'What is BayLeaf? Answer in two sentences.',
  'In one sentence, who can use it?',
];
const flowId = '2.1.1-keyboard-two-turn-delete';
const uuid = /^[0-9a-f-]{36}$/;
const markerPattern = /^bayleaf-vpat-v1:(\d{13}):[0-9a-f-]{36}$/;
const here = new URL('.', import.meta.url);
const probeDir = new URL('../probe/', here);
const outputDir = new URL('../../politics/vpat-chat-videos/', here);
const manifestPath = new URL(`${flowId}.json`, outputDir);
const webmPath = new URL(`${flowId}.webm`, outputDir);
const videoPath = new URL(`${flowId}.mp4`, outputDir);

let sessionToken;
let userId;
let chatId;
let marker;
let browser;
let cloudflareToken;
let stage = 'credentials';
let outputsMayBeCreated = false;
let artifactsComplete = false;

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function chatApi(path, options = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...options,
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
    headers: {
      'Content-Type': 'application/json',
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      ...options.headers,
    },
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    return { status: response.status };
  }
  return { status: 200, data: await response.json() };
}

async function cloudflare(path, options = {}) {
  const response = await fetch(`${apiRoot}${path}`, {
    ...options,
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${cloudflareToken}`, ...options.headers },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`cloudflare_${response.status}`);
  return data?.result ?? data;
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: here, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command}_${code}`)));
  });
}

async function assertMissing(path) {
  try {
    await access(path);
    assert.fail(`refusing to overwrite ${path.pathname}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function renderVideo(events, expectedDuration) {
  const playerScript = await readFile(new URL('node_modules/rrweb-player/dist/rrweb-player.umd.cjs', here), 'utf8');
  const playerStyle = await readFile(new URL('node_modules/rrweb-player/dist/style.css', here), 'utf8');
  const replayDir = await mkdtemp(join(tmpdir(), 'bayleaf-vpat-'));
  let localBrowser;
  let context;
  try {
    localBrowser = await chromium.launch({ headless: true });
    context = await localBrowser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: replayDir, size: { width: 1280, height: 720 } },
    });
    const page = await context.newPage();
    let resolveFinished;
    let rejectFinished;
    const finished = new Promise((resolve, reject) => {
      resolveFinished = resolve;
      rejectFinished = reject;
    });
    await page.exposeFunction('__bayleafReplayFinished', resolveFinished);
    await page.exposeFunction('__bayleafReplayFailed', message => rejectFinished(new Error(message)));
    const escapedScript = playerScript.replaceAll('</script>', '<\\/script>');
    const escapedEvents = JSON.stringify(events).replaceAll('</script>', '<\\/script>');
    await page.setContent(`<!doctype html>
      <html><head><meta charset="utf-8"><style>${playerStyle}</style>
      <style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff}.rr-player{box-shadow:none}</style>
      </head><body><script>${escapedScript}</script><script>
      try {
        const Player = rrwebPlayer.default ?? rrwebPlayer;
        const player = new Player({ target: document.body, props: {
          events: ${escapedEvents}, width: 1280, height: 720,
          showController: false, autoPlay: false, skipInactive: false
        }});
        player.addEventListener('finish', () => window.__bayleafReplayFinished());
        player.play();
      } catch (error) {
        window.__bayleafReplayFailed(String(error));
      }
      </script></body></html>`, { waitUntil: 'load' });
    await Promise.race([
      finished,
      sleep(expectedDuration + 120000).then(() => { throw new Error('replay_timeout'); }),
    ]);
    const video = page.video();
    await context.close();
    const recordedPath = await video.path();
    await rename(recordedPath, webmPath);
  } finally {
    await context?.close().catch(() => {});
    await localBrowser?.close().catch(() => {});
    await rm(replayDir, { recursive: true, force: true });
  }

  await run('ffmpeg', ['-y', '-i', webmPath.pathname, '-c:v', 'libx264', '-crf', '18',
    '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', videoPath.pathname]);
  await rm(webmPath, { force: true });
  const probe = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'json', videoPath.pathname]);
  const video = JSON.parse(probe.stdout).format;
  assert.ok(Number(video.duration) >= Math.max(1, expectedDuration / 1000 - 3));
  assert.ok(Number(video.size) > 10000);
  return { duration_seconds: Number(video.duration), size_bytes: Number(video.size) };
}

async function deleteSyntheticChat() {
  if (!chatId && marker) {
    const listing = await chatApi('/api/v1/chats/list?page=1&include_pinned=true&include_folders=true');
    assert.equal(listing.status, 200);
    assert.ok(Array.isArray(listing.data) && listing.data.length <= 5);
    for (const row of listing.data) {
      assert.match(row.id, uuid);
      const candidate = await chatApi(`/api/v1/chats/${row.id}`);
      if (candidate.status === 200 && candidate.data.variables?.bayleaf_probe === marker) {
        assert.equal(chatId, undefined);
        chatId = row.id;
      }
    }
  }
  if (!chatId) return 'not_created';
  const record = await chatApi(`/api/v1/chats/${chatId}`);
  assert.equal(record.status, 200);
  assert.equal(record.data.user_id, userId);
  assert.equal(record.data.variables?.bayleaf_probe, marker);
  assert.deepEqual(record.data.chat?.models, ['basic']);
  const messages = Object.values(record.data.chat?.history?.messages ?? {});
  const users = messages.filter(message => message.role === 'user');
  assert.ok(users.length >= 1 && users.length <= prompts.length);
  users.forEach((message, index) => assert.equal(message.content, prompts[index]));
  assert.match(marker, markerPattern);

  const removed = await chatApi(`/api/v1/chats/${chatId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.data, true);
  const absent = await chatApi(`/api/v1/chats/${chatId}`);
  assert.equal(absent.status, 401);
  const listing = await chatApi('/api/v1/chats/list?page=1&include_pinned=true&include_folders=true');
  assert.equal(listing.status, 200);
  assert.ok(Array.isArray(listing.data));
  assert.ok(!listing.data.some(row => row.id === chatId));
  chatId = null;
  return 'confirmed';
}

async function validatePersisted(expectedTurns) {
  assert.ok(chatId);
  const record = await chatApi(`/api/v1/chats/${chatId}`);
  assert.equal(record.status, 200);
  assert.equal(record.data.user_id, userId);
  assert.equal(record.data.variables?.bayleaf_probe, marker);
  assert.deepEqual(record.data.chat?.models, ['basic']);
  const messages = Object.values(record.data.chat?.history?.messages ?? {});
  const users = messages.filter(message => message.role === 'user');
  const assistants = messages.filter(message => message.role === 'assistant');
  assert.equal(users.length, expectedTurns);
  users.forEach((message, index) => assert.equal(message.content, prompts[index]));
  assert.equal(assistants.length, expectedTurns);
  assert.ok(assistants.every(message => message.done === true && !message.error &&
    typeof message.content === 'string' && message.content.trim()));
}

async function waitForRecording(sessionId) {
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      return await cloudflare(`/recording/${sessionId}`);
    } catch (error) {
      if (error.message !== 'cloudflare_404' || attempt === 20) throw error;
      await sleep(1000);
    }
  }
  throw new Error('recording_unavailable');
}

try {
  await Promise.all([
    assertMissing(manifestPath),
    assertMissing(videoPath),
    assertMissing(webmPath),
  ]);
  outputsMayBeCreated = true;

  const bootstrapPath = process.env.BAYLEAF_PROBE_BOOTSTRAP || new URL('bootstrap.secrets.json', probeDir);
  const bootstrapStat = await stat(bootstrapPath);
  assert.equal(bootstrapStat.mode & 0o077, 0, 'bootstrap credentials must not be group/world accessible');
  const bootstrap = JSON.parse(await readFile(bootstrapPath, 'utf8'));
  assert.equal(bootstrap.role, 'user');
  assert.ok(bootstrap.email && bootstrap.password && bootstrap.id);

  const auth = await exec('npx', ['wrangler', 'auth', 'token', '--json'], {
    cwd: probeDir, maxBuffer: 1024 * 1024,
  });
  const wranglerAuth = JSON.parse(auth.stdout);
  assert.equal(wranglerAuth.type, 'oauth');
  assert.ok(wranglerAuth.token);
  cloudflareToken = wranglerAuth.token;

  stage = 'signin';
  const identity = await chatApi('/api/v1/auths/signin', {
    method: 'POST',
    body: JSON.stringify({ email: bootstrap.email, password: bootstrap.password }),
  });
  assert.equal(identity.status, 200);
  assert.equal(identity.data.role, 'user');
  assert.equal(identity.data.id, bootstrap.id);
  sessionToken = identity.data.token;
  userId = identity.data.id;

  stage = 'baseline';
  const baseline = await chatApi('/api/v1/chats/list?page=1&include_pinned=true&include_folders=true');
  assert.equal(baseline.status, 200);
  assert.deepEqual(baseline.data, []);

  stage = 'browser_acquisition';
  const acquired = await cloudflare('/devtools/browser?keep_alive=600000&recording=true', { method: 'POST' });
  assert.match(acquired.sessionId, uuid);
  assert.ok(acquired.webSocketDebuggerUrl?.startsWith('wss://'));
  const sessionId = acquired.sessionId;
  browser = await puppeteer.connect({
    browserWSEndpoint: acquired.webSocketDebuggerUrl,
    headers: { Authorization: `Bearer ${cloudflareToken}` },
  });

  stage = 'browser_setup';
  const pages = await browser.pages();
  const page = pages[0] ?? await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  page.setDefaultTimeout(30000);
  await page.evaluateOnNewDocument((targetOrigin, token) => {
    if (location.origin === targetOrigin) localStorage.setItem('token', token);
  }, origin, sessionToken);

  marker = `bayleaf-vpat-v1:${Date.now()}:${crypto.randomUUID()}`;
  let creationRequest;
  let completionCount = 0;
  let resolveCreation;
  const creation = new Promise(resolve => { resolveCreation = resolve; });
  await page.setRequestInterception(true);
  page.on('request', request => {
    void (async () => {
      if (request.url() === `${origin}/api/chat/completions` && request.method() === 'POST') {
        const body = JSON.parse(request.postData());
        assert.equal(body.model, 'basic');
        if (completionCount === 0) {
          assert.equal(body.chat_id, undefined);
          assert.equal(body.parent_id, null);
          assert.equal(body.user_message?.content, prompts[0]);
          body.chat_variables = { ...body.chat_variables, bayleaf_probe: marker };
          creationRequest = request;
        } else if (completionCount === 1) {
          assert.equal(body.chat_id, chatId);
          assert.equal(body.user_message?.content, prompts[1]);
        } else {
          return request.abort();
        }
        completionCount++;
        return request.continue({ postData: JSON.stringify(body) });
      }
      if (request.method() === 'POST' && request.url() === `${origin}/api/v1/chats/new`) {
        return request.abort();
      }
      return request.continue();
    })().catch(() => { void request.abort().catch(() => {}); });
  });
  page.on('response', response => {
    if (response.request() !== creationRequest) return;
    void response.json().then(data => {
      if (response.status() === 200 && uuid.test(data?.chat_id)) chatId = data.chat_id;
      resolveCreation(Boolean(chatId));
    }).catch(() => resolveCreation(false));
  });

  stage = 'navigation';
  await page.goto(`${origin}/?model=basic`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chat-input', { visible: true });
  await sleep(1200);

  stage = 'keyboard_traversal';
  await page.evaluate(() => {
    document.activeElement?.blur();
    document.body.tabIndex = -1;
    document.body.focus();
  });
  const focusTrail = [];
  let reachedComposer = false;
  for (let index = 0; index < 20; index++) {
    await page.keyboard.down('Shift');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Shift');
    await sleep(250);
    const focus = await page.evaluate(() => {
      const element = document.activeElement;
      const style = getComputedStyle(element);
      return {
        tag: element?.tagName?.toLowerCase() ?? null,
        id: element?.id || null,
        role: element?.getAttribute?.('role') || null,
        label: element?.getAttribute?.('aria-label') || null,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
      };
    });
    focusTrail.push(focus);
    if (focus.id === 'chat-input') { reachedComposer = true; break; }
  }
  assert.ok(reachedComposer, 'composer was not reachable by Shift+Tab');
  await sleep(800);

  stage = 'keyboard_submission';
  await page.keyboard.type(prompts[0], { delay: 40 });
  assert.equal(await page.$eval('#chat-input', input => input.textContent), prompts[0]);
  await sleep(800);
  await page.keyboard.press('Enter');
  assert.equal(await creation, true);

  stage = 'rendered_answer';
  await page.waitForFunction(expected =>
    document.querySelectorAll('button.copy-response-button').length >= expected, {}, 1);
  await validatePersisted(1);
  await sleep(900);

  stage = 'follow_up';
  await page.focus('#chat-input');
  await page.keyboard.type(prompts[1], { delay: 40 });
  assert.equal(await page.$eval('#chat-input', input => input.textContent), prompts[1]);
  await sleep(500);
  await page.keyboard.press('Enter');

  stage = 'follow_up_answer';
  await page.waitForFunction(expected =>
    document.querySelectorAll('button.copy-response-button').length >= expected, {}, 2);
  await validatePersisted(2);
  await sleep(1000);

  stage = 'ui_delete_dialog';
  await page.evaluate(() => {
    document.activeElement?.blur();
    document.body.focus();
  });
  const deleteFocusTrail = [];
  let reachedChatMenu = false;
  for (let index = 0; index < 30; index++) {
    await page.keyboard.press('Tab');
    await sleep(180);
    const focus = await page.evaluate(() => ({
      id: document.activeElement?.id || null,
      text: document.activeElement?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) || null,
      label: document.activeElement?.getAttribute?.('aria-label') || null,
    }));
    deleteFocusTrail.push(focus);
    if (focus.id === 'chat-context-menu-button' || focus.label === 'Chat actions') {
      reachedChatMenu = true;
      break;
    }
  }
  assert.ok(reachedChatMenu, 'chat actions menu was not keyboard reachable');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button =>
    button.textContent?.trim() === 'Delete' && button.getClientRects().length));
  let reachedDelete = false;
  let deleteMenuTabs = 0;
  for (let index = 0; index < 15; index++) {
    await page.keyboard.press('Tab');
    deleteMenuTabs++;
    await sleep(180);
    const activeText = await page.evaluate(() => document.activeElement?.textContent?.trim());
    if (activeText === 'Delete') { reachedDelete = true; break; }
  }
  assert.ok(reachedDelete, 'delete menu item was not keyboard reachable');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[role="dialog"][aria-label="Delete chat?"]', { visible: true });
  await sleep(800);
  let confirmFocused = false;
  let confirmationTabs = 0;
  for (let index = 0; index < 3; index++) {
    const activeText = await page.evaluate(() => document.activeElement?.textContent?.trim());
    if (activeText === 'Confirm') { confirmFocused = true; break; }
    await page.keyboard.press('Tab');
    confirmationTabs++;
    await sleep(300);
  }
  assert.ok(confirmFocused, 'delete confirmation was not keyboard reachable');

  stage = 'ui_delete';
  await Promise.all([
    page.waitForResponse(response =>
      response.url() === `${origin}/api/v1/chats/${chatId}` &&
      response.request().method() === 'DELETE' && response.status() === 200),
    page.keyboard.press('Enter'),
  ]);
  await page.waitForFunction(() => location.pathname === '/' &&
    Boolean(document.querySelector('#chat-input')));
  const absent = await chatApi(`/api/v1/chats/${chatId}`);
  assert.equal(absent.status, 401);
  const empty = await chatApi('/api/v1/chats/list?page=1&include_pinned=true&include_folders=true');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data, []);
  chatId = null;
  const cleanup = 'confirmed_ui';
  await sleep(1200);

  stage = 'browser_close';
  await browser.close();
  browser = null;

  stage = 'recording_download';
  const recording = await waitForRecording(sessionId);
  assert.ok(recording.events && typeof recording.events === 'object');
  const targets = Object.entries(recording.events).filter(([, events]) => Array.isArray(events));
  assert.ok(targets.length > 0);
  targets.sort((left, right) => right[1].length - left[1].length);
  const [targetId, events] = targets[0];
  assert.ok(events.length > 1);

  stage = 'artifact_write';
  await mkdir(outputDir, { recursive: true });
  const manifest = {
    schema: 2,
    flow: flowId,
    captured_at: new Date().toISOString(),
    surface: origin,
    viewport: { width: 1280, height: 720 },
    model: 'basic',
    prompts,
    cloudflare_recording: { duration_ms: recording.duration, target: targetId, event_count: events.length },
    evidence: {
      shift_tab_reached_composer: true,
      first_prompt_submitted: true,
      first_answer_completed: true,
      follow_up_submitted: true,
      follow_up_answer_completed: true,
      chat_menu_keyboard_reached: true,
      delete_command_keyboard_reached: true,
      delete_dialog_keyboard_confirmed: true,
      exact_chat_deleted_in_ui: true,
    },
    navigation: {
      shift_tabs_to_composer: focusTrail.length,
      tabs_to_chat_actions: deleteFocusTrail.length,
      tabs_from_chat_actions_to_delete: deleteMenuTabs,
      tabs_from_dialog_entry_to_confirm: confirmationTabs,
    },
    focus_trail: focusTrail,
    delete_focus_trail: deleteFocusTrail,
    cleanup,
  };
  stage = 'video_render';
  const video = await renderVideo(events, recording.duration);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  artifactsComplete = true;

  output({ result: 'ok', flow: flowId, video: videoPath.pathname, cleanup, ...video });
} catch (error) {
  if (outputsMayBeCreated && !artifactsComplete) {
    await Promise.allSettled([
      rm(manifestPath, { force: true }),
      rm(videoPath, { force: true }),
      rm(webmPath, { force: true }),
    ]);
  }
  process.stderr.write(`${JSON.stringify({ result: 'failed', stage, error: error.message })}\n`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (chatId) {
    try {
      const cleanup = await deleteSyntheticChat();
      output({ final_cleanup: cleanup });
    } catch {
      process.stderr.write(`${JSON.stringify({ result: 'cleanup_failed', chat_id: chatId })}\n`);
      process.exitCode = 1;
    }
  }
}
