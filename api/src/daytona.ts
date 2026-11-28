/**
 * Daytona Sandbox Provider Client
 *
 * Module-level helpers for managing sandboxes through Daytona v2. Mirrors the
 * pattern of openrouter.ts — all functions are stateless and take env
 * bindings as a parameter. The v2 wire contract lives in daytonaV2.ts; this
 * module owns lifecycle orchestration and the owner-facing operations.
 *
 * All fetch() calls are non-blocking (Workers global fetch is always async).
 */

import type { Bindings } from './types';
import { revokeSandboxCredentials } from './sandboxCredentials';
import { getV2Sandbox, findV2Sandbox, createV2Sandbox, v2Call, v2SandboxPath, v2Toolbox, v2Execute, v2UploadFile } from './daytonaV2';

// ── Types ──────────────────────────────────────────────────────────

export interface SandboxInfo {
  id: string;
  state: string;           // started | stopped | archived | error | starting | stopping | archiving
  name?: string;
  labels?: Record<string, string>;
  recoverable?: boolean;
  errorReason?: string;
  // Resource allocation
  cpu?: number;            // vCPU count
  memory?: number;         // GiB
  disk?: number;           // GiB
  // Class & region
  class?: string;          // e.g. "small"
  target?: string;         // e.g. "us"
  // Lifecycle
  createdAt?: string;      // ISO 8601
  updatedAt?: string;      // ISO 8601
  autoStopInterval?: number;    // minutes
  autoArchiveInterval?: number; // minutes
  idlePauseMinutes?: number;
  lastActivityAt?: string;
  toolboxProxyUrl?: string;
  persistent?: boolean;
  public?: boolean;
  reservedCpu?: number;
  reservedMemory?: number;
}

export interface ExecResult {
  exitCode: number;
  output: string;
}

// ── Internal helpers ───────────────────────────────────────────────

/**
 * Sleep without blocking the event loop.
 * Uses scheduler.wait when available (Cloudflare Workers), falls back to
 * a standard setTimeout promise.
 */
function sleep(ms: number): Promise<void> {
  // scheduler.wait is the CF Workers-native non-blocking sleep
  if (typeof scheduler !== 'undefined' && typeof scheduler.wait === 'function') {
    return scheduler.wait(ms);
  }
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Sandbox CRUD ───────────────────────────────────────────────────

/**
 * Find an existing sandbox for a keyed user by exact deployment label.
 * Returns null if none exists; more than one match throws.
 */
export async function findSandboxByLabel(
  email: string,
  env: Bindings,
): Promise<SandboxInfo | null> {
  return findV2Sandbox(email, env);
}

/**
 * Create a persistent sandbox for a keyed user. The v2 lifecycle policy pauses
 * after an hour idle; the daily BayLeaf reaper owns inactivity retention.
 */
export async function createPersistentSandbox(
  email: string,
  env: Bindings,
): Promise<SandboxInfo> {
  return createV2Sandbox(email, env);
}

/** Wake only a stable idle state; paused v2 machines keep their processes. */
export async function wakeV2Sandbox(m: SandboxInfo, env: Bindings): Promise<void> {
  const action = m.state === 'paused' ? 'resume' : 'start';
  const r = await v2Call(env, `${v2SandboxPath(m.id)}/${action}`, 'POST');
  await r.body?.cancel();
  if (!r.ok && r.status !== 409) throw new Error(`Daytona wake failed (${r.status})`);
}

/** Delete a sandbox entirely, confirming that Daytona no longer reports it. */
export async function deleteSandbox(id: string, env: Bindings): Promise<void> {
  await revokeSandboxCredentials(env, id);
  const r = await v2Call(env, v2SandboxPath(id), 'DELETE');
  await r.body?.cancel();
  if (!r.ok && r.status !== 404) throw new Error(`Daytona delete failed (${r.status})`);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!await getV2Sandbox(id, env)) return;
    await sleep(1000);
  }
  throw new Error('Daytona deletion is pending');
}

/**
 * Refresh the sandbox's last-activity timestamp.
 *
 * Resets the idle timer without changing runtime state. Daytona counts only
 * external interactions as activity; internal processes do not reset it.
 */
export async function refreshActivity(id: string, env: Bindings): Promise<void> {
  const r = await v2Call(env, `${v2SandboxPath(id)}/reset-idle-timer`, 'POST');
  await r.body?.cancel();
  if (!r.ok) throw new Error(`Daytona idle timer reset failed (${r.status})`);
}

/** Get current sandbox info (state, etc.). */
export async function getSandboxInfo(id: string, env: Bindings): Promise<SandboxInfo> {
  const info = await getV2Sandbox(id, env);
  if (!info) throw new Error('Daytona sandbox not found');
  return info;
}

/** Port-scoped credential, kept server-side by the owner-authenticated wrapper. */
export async function createSignedPreview(
  id: string, port: number, env: Bindings, expiresInSeconds = 86400,
): Promise<{ url: string } | null> {
  try {
    const response = await v2Call(env, `${v2SandboxPath(id)}/ports/${port}/signed-preview-urls`, 'POST',
      { expires_in_seconds: expiresInSeconds });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const data = await response.json() as { url?: string };
    return typeof data.url === 'string' ? { url: data.url } : null;
  } catch { return null; } // Fetch errors may contain bearer URLs; never log them.
}

// ── Lifecycle orchestration ────────────────────────────────────────

export interface EnsureResult {
  id: string;
  /** True when the ID differs from cachedId — caller should update D1. */
  changed: boolean;
}

/** A legacy (pre-v2) cached ID is a migration hold. Passive or active traffic
 * must never silently rebind it to a different filesystem or clear it on
 * provider error: getV2Sandbox refuses it before any provider call. */
export async function lookupOwnedV2Sandbox(email: string, env: Bindings, cachedId?: string | null) {
  if (cachedId) {
    const current = await getV2Sandbox(cachedId, env);
    if (current) {
      if (current.labels?.[env.DAYTONA_DEPLOYMENT_LABEL] !== email) throw new Error('Sandbox ownership mismatch');
      return current;
    }
  }
  return findV2Sandbox(email, env);
}

/**
 * Ensure a persistent sandbox is running for the given email: cached ID or
 * exact-label lookup, create if missing, wake if paused or stopped, then wait
 * until Toolbox can prepare the workspace directory.
 */
export async function ensureSandbox(
  email: string,
  env: Bindings,
  cachedId?: string | null,
): Promise<EnsureResult> {
  let m = await lookupOwnedV2Sandbox(email, env, cachedId) ?? await createV2Sandbox(email, env);
  const id = m.id;
  const deadline = Date.now() + 120_000;
  let wakeRequested = false;
  while (Date.now() < deadline) {
    if (m.state === 'started') {
      try {
        const ready = await v2Execute(env, m, ['mkdir', '-p', '/home/daytona/workspace'], 5_000);
        if (ready.exitCode === 0) return { id, changed: id !== cachedId };
      } catch { /* Toolbox starts independently of the VM; retry readiness only. */ }
    } else if (m.state === 'paused' || m.state === 'stopped') {
      if (!wakeRequested) {
        await wakeV2Sandbox(m, env);
        wakeRequested = true;
      }
    } else if (!['starting', 'pausing', 'stopping'].includes(m.state)) {
      throw new Error('Daytona sandbox cannot be started in its current state');
    }
    await sleep(1000);
    m = await getSandboxInfo(id, env);
    if (m.labels?.[env.DAYTONA_DEPLOYMENT_LABEL] !== email) throw new Error('Sandbox ownership changed');
  }
  throw new Error('Timed out preparing Daytona sandbox');
}

// ── Toolbox operations ─────────────────────────────────────────────

/**
 * Execute a bash command in a sandbox.
 *
 * Uploads the command verbatim to a request-scoped temp script with
 * `set -e -o pipefail` and non-interactive env vars, then executes it.
 * Passing only the script path avoids argv size limits and quoting issues
 * while keeping concurrent requests isolated from one another.
 *
 * No output truncation — full stdout/stderr is returned.
 */
export async function execCommand(
  sandboxId: string,
  command: string,
  workdir: string,
  env: Bindings,
): Promise<ExecResult> {
  const script =
    '#!/usr/bin/env bash\n' +
    'set -e -o pipefail\n' +
    'export DEBIAN_FRONTEND=noninteractive ' +
    'GIT_TERMINAL_PROMPT=0 ' +
    'PIP_NO_INPUT=1 ' +
    'NPM_CONFIG_YES=true ' +
    'CI=true\n' +
    command + '\n';

  const scriptPath = `/tmp/bayleaf-exec-${crypto.randomUUID()}.sh`;
  const scriptBlob = new Blob([script], { type: 'application/octet-stream' });

  const m = await getSandboxInfo(sandboxId, env);
  try {
    // Linux limits each argv entry; pass only the path even for large scripts.
    await v2UploadFile(env, m, scriptPath, scriptBlob);
    return await v2Execute(env, m, ['bash', scriptPath], 120_000, workdir);
  } finally {
    try {
      await v2Execute(env, m, ['rm', '-f', '--', scriptPath], 5_000);
    } catch {
      // Upload or execution may have failed after writing the file. Cleanup
      // is best-effort and must never replace the command's result or error.
    }
  }
}

/**
 * Download a file from a sandbox.
 * Returns the raw Response so the caller can stream it back to the client.
 */
export async function downloadFile(
  sandboxId: string,
  path: string,
  env: Bindings,
): Promise<Response> {
  return v2Toolbox(env, await getSandboxInfo(sandboxId, env),
    `/files/download?${new URLSearchParams({ path })}`, { signal: AbortSignal.timeout(120_000) });
}

/**
 * Paths uploadFile refuses. Toolbox takes argv directly, so quoting is not the
 * defense here; refusing quotes and control characters keeps the accepted path
 * set unchanged for callers and keeps paths unambiguous in diagnostics.
 */
export function unsafeUploadPath(path: string): boolean {
  return /['\x00-\x1f\x7f]/.test(path);
}

/**
 * Upload a file to a sandbox.
 * Creates parent directories automatically via mkdir -p.
 */
export async function uploadFile(
  sandboxId: string,
  path: string,
  body: ArrayBuffer,
  env: Bindings,
): Promise<void> {
  if (unsafeUploadPath(path)) throw new Error('Unsafe upload path.');
  const parent = path.replace(/\/[^/]+$/, '');
  const m = await getSandboxInfo(sandboxId, env);
  // One argv entry per path, so spaces or `$(…)` can never become extra arguments.
  if (parent && parent !== path && (await v2Execute(env, m, ['mkdir', '-p', '--', parent], 5000)).exitCode !== 0) {
    throw new Error('Could not create upload directory');
  }
  await v2UploadFile(env, m, path, new Blob([body]));
}
