/**
 * Daytona Sandbox Provider Client
 *
 * Module-level helpers for managing sandboxes via the Daytona control plane
 * and toolbox proxy APIs. Mirrors the pattern of openrouter.ts — all
 * functions are stateless and take env bindings as a parameter.
 *
 * Control plane: POST/GET/DELETE /sandbox, POST /sandbox/{id}/start
 * Toolbox proxy: POST /process/execute, GET /files/download, POST /files/upload
 *
 * All fetch() calls are non-blocking (Workers global fetch is always async).
 */

import type { Bindings } from './types';
import { DAYTONA_DEFAULT_API_URL, DAYTONA_DEFAULT_PROXY_URL } from './constants';

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
}

export interface ExecResult {
  exitCode: number;
  output: string;
}

// ── Internal helpers ───────────────────────────────────────────────

function apiUrl(env: Bindings, path: string): string {
  return `${(env.DAYTONA_API_URL || DAYTONA_DEFAULT_API_URL).replace(/\/+$/, '')}${path}`;
}

function toolboxUrl(env: Bindings, sandboxId: string, path: string): string {
  return `${(env.DAYTONA_PROXY_URL || DAYTONA_DEFAULT_PROXY_URL).replace(/\/+$/, '')}/${sandboxId}${path}`;
}

function authHeaders(env: Bindings): Record<string, string> {
  return {
    'Authorization': `Bearer ${env.DAYTONA_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

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
 * Find an existing sandbox for a keyed user by label.
 * Returns null if none exists.
 *
 * Uses the `labels` (plural) query parameter with a JSON-encoded object
 * so the Daytona API performs an exact key=value match.  After filtering
 * server-side we also verify labels client-side and guard against
 * duplicates — see https://github.com/rndmcnlly/lathe/issues/2.
 */
export async function findSandboxByLabel(
  email: string,
  env: Bindings,
): Promise<SandboxInfo | null> {
  const deployLabel = env.DAYTONA_DEPLOYMENT_LABEL;
  const labelsFilter = JSON.stringify({ [deployLabel]: email });
  const url = `${apiUrl(env, '/sandbox')}?labels=${encodeURIComponent(labelsFilter)}`;
  const resp = await fetch(url, { headers: authHeaders(env) });
  if (!resp.ok) return null;

  const sandboxes = (await resp.json() as SandboxInfo[]) ?? [];

  // Client-side verification: only keep sandboxes whose labels exactly match
  const matches = sandboxes.filter(
    s => s.labels?.[deployLabel] === email,
  );

  if (matches.length > 1) {
    const ids = matches.map(s => s.id).join(', ');
    throw new Error(
      `Found ${matches.length} sandboxes labelled ${deployLabel}=${email} (${ids}). ` +
      `Expected at most 1. Delete the extras in the Daytona dashboard and try again.`,
    );
  }

  return matches[0] ?? null;
}

/**
 * Create a persistent sandbox for a keyed user.
 * Auto-stops after 15 min idle, auto-archives after 60 min stopped,
 * auto-deletes after DAYTONA_AUTO_DELETE_MINUTES (default 90 days).
 */
export async function createPersistentSandbox(
  email: string,
  env: Bindings,
): Promise<SandboxInfo> {
  const deployLabel = env.DAYTONA_DEPLOYMENT_LABEL;
  const autoDelete = parseInt(env.DAYTONA_AUTO_DELETE_MINUTES, 10) || -1;
  const resp = await fetch(apiUrl(env, '/sandbox'), {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify({
      language: 'python',
      name: `${deployLabel}/${email}`,
      labels: { [deployLabel]: email },
      autoStopInterval: 15,
      autoArchiveInterval: 60,
      autoDeleteInterval: autoDelete,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to create sandbox: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }

  return await resp.json() as SandboxInfo;
}

/**
 * Create an ephemeral sandbox for campus-pass (anonymous) users.
 * Marked ephemeral so Daytona auto-deletes it when stopped.
 * autoStopInterval=5 is a safety net; we explicitly delete after exec.
 */
export async function createEphemeralSandbox(env: Bindings): Promise<SandboxInfo> {
  const resp = await fetch(apiUrl(env, '/sandbox'), {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify({
      language: 'python',
      ephemeral: true,
      autoStopInterval: 5,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to create ephemeral sandbox: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }

  return await resp.json() as SandboxInfo;
}

/** Start a stopped or archived sandbox. */
export async function startSandbox(id: string, env: Bindings): Promise<void> {
  const resp = await fetch(apiUrl(env, `/sandbox/${id}/start`), {
    method: 'POST',
    headers: authHeaders(env),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to start sandbox: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
}

/** Delete a sandbox entirely. */
export async function deleteSandbox(id: string, env: Bindings): Promise<void> {
  const resp = await fetch(apiUrl(env, `/sandbox/${id}`), {
    method: 'DELETE',
    headers: authHeaders(env),
  });

  // 404 is fine — sandbox already gone
  if (!resp.ok && resp.status !== 404) {
    const text = await resp.text();
    throw new Error(`Failed to delete sandbox: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
}

/** Get current sandbox info (state, etc.). */
export async function getSandboxInfo(id: string, env: Bindings): Promise<SandboxInfo> {
  const resp = await fetch(apiUrl(env, `/sandbox/${id}`), {
    headers: authHeaders(env),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to get sandbox info: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }

  return await resp.json() as SandboxInfo;
}

// ── Lifecycle orchestration ────────────────────────────────────────

/**
 * Poll the toolbox daemon until it responds to an echo probe,
 * then ensure the workspace directory exists.
 * Uses exponential backoff to avoid hammering the API.
 */
export async function waitForReady(id: string, env: Bindings): Promise<void> {
  const maxAttempts = 30;
  let interval = 1000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const resp = await fetch(toolboxUrl(env, id, '/process/execute'), {
        method: 'POST',
        headers: authHeaders(env),
        body: JSON.stringify({ command: 'echo ready', timeout: 5000 }),
      });

      if (resp.ok) {
        const data = await resp.json() as { exitCode?: number; result?: string };
        if (data.exitCode === 0 && (data.result ?? '').includes('ready')) {
          // Ensure workspace directory exists
          await fetch(toolboxUrl(env, id, '/process/execute'), {
            method: 'POST',
            headers: authHeaders(env),
            body: JSON.stringify({
              command: 'mkdir -p /home/daytona/workspace',
              timeout: 5000,
            }),
          });
          return;
        }
      }
    } catch {
      // Toolbox not ready yet — keep polling
    }

    await sleep(interval);
    interval = Math.min(interval * 1.2, 5000);
  }

  throw new Error('Sandbox started but toolbox daemon did not become responsive (30s)');
}

/**
 * Poll the control plane until the sandbox reaches 'started' state.
 * Uses exponential backoff. 120s deadline.
 */
export async function waitForStarted(id: string, env: Bindings): Promise<void> {
  const deadline = Date.now() + 120_000;
  let interval = 1000;

  while (Date.now() < deadline) {
    await sleep(interval);

    const info = await getSandboxInfo(id, env);

    if (info.state === 'started') return;
    if (info.state === 'error') {
      throw new Error(`Sandbox entered error state: ${info.errorReason ?? 'unknown'}`);
    }

    interval = Math.min(interval * 1.2, 5000);
  }

  throw new Error('Timed out waiting for sandbox to start (120s)');
}

export interface EnsureResult {
  id: string;
  /** True when the ID differs from cachedId — caller should update D1. */
  changed: boolean;
}

/**
 * Ensure a persistent sandbox is running for the given email.
 * Handles the full lifecycle: cached-ID fast-path → find-by-label
 * → create if missing → start if stopped/archived → wait for toolbox.
 *
 * When cachedId is provided, we skip the label lookup and go straight
 * to the control plane to check its state.  If the cached ID is stale
 * (404), we fall back to the label-based lookup (and then creation).
 */
export async function ensureSandbox(
  email: string,
  env: Bindings,
  cachedId?: string | null,
): Promise<EnsureResult> {
  let sandbox: SandboxInfo | null = null;

  // Fast path: try the cached ID first (saves a label-lookup round-trip)
  if (cachedId) {
    try {
      sandbox = await getSandboxInfo(cachedId, env);
    } catch {
      // Stale cached ID (deleted externally, 404, etc.) — fall through
      sandbox = null;
    }
  }

  // Slow path: label-based lookup
  if (!sandbox) {
    sandbox = await findSandboxByLabel(email, env);
  }

  // No sandbox exists at all — create one
  if (!sandbox) {
    sandbox = await createPersistentSandbox(email, env);
  }

  const { id, state } = sandbox;
  const changed = id !== cachedId;

  if (state === 'started') {
    await waitForReady(id, env);
    return { id, changed };
  }

  if (state === 'stopped' || state === 'archived') {
    await startSandbox(id, env);
  } else if (state === 'error' && sandbox.recoverable) {
    await fetch(apiUrl(env, `/sandbox/${id}/recover`), {
      method: 'POST',
      headers: authHeaders(env),
    });
    await startSandbox(id, env);
  } else if (state === 'starting' || state === 'stopping' || state === 'archiving') {
    // Already transitioning — just wait
  } else if (state === 'error') {
    throw new Error(`Sandbox is in non-recoverable error state: ${sandbox.errorReason ?? 'unknown'}`);
  }

  await waitForStarted(id, env);
  await waitForReady(id, env);
  return { id, changed };
}

// ── Toolbox operations ─────────────────────────────────────────────

/**
 * Execute a bash command in a sandbox.
 *
 * Mirrors Lathe's approach: writes the command verbatim to a temp script
 * (/tmp/_cmd.sh) with `set -e -o pipefail` and non-interactive env vars,
 * then executes `bash /tmp/_cmd.sh`. This avoids all quoting/escaping
 * issues with Daytona's argv-splitting execute API.
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

  const scriptPath = '/tmp/_cmd.sh';
  const scriptBlob = new Blob([script], { type: 'application/octet-stream' });

  // Upload the script via multipart form
  const uploadForm = new FormData();
  uploadForm.append('file', scriptBlob, 'file');

  await fetch(
    `${toolboxUrl(env, sandboxId, '/files/upload')}?path=${encodeURIComponent(scriptPath)}`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.DAYTONA_API_KEY}` },
      body: uploadForm,
    },
  );

  // Execute the script
  const resp = await fetch(toolboxUrl(env, sandboxId, '/process/execute'), {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify({
      command: `bash ${scriptPath}`,
      cwd: workdir,
      timeout: 120000,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Command execution failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }

  const data = await resp.json() as { result?: string; exitCode?: number };
  return {
    exitCode: data.exitCode ?? -1,
    output: data.result ?? '',
  };
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
  const url = `${toolboxUrl(env, sandboxId, '/files/download')}?path=${encodeURIComponent(path)}`;
  return fetch(url, {
    headers: { 'Authorization': `Bearer ${env.DAYTONA_API_KEY}` },
  });
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
  // Ensure parent directory exists
  const parent = path.replace(/\/[^/]+$/, '');
  if (parent && parent !== path) {
    await fetch(toolboxUrl(env, sandboxId, '/process/execute'), {
      method: 'POST',
      headers: authHeaders(env),
      body: JSON.stringify({
        command: `mkdir -p ${parent}`,
        timeout: 5000,
      }),
    });
  }

  // Upload via multipart form
  const blob = new Blob([body], { type: 'application/octet-stream' });
  const form = new FormData();
  form.append('file', blob, 'file');

  const resp = await fetch(
    `${toolboxUrl(env, sandboxId, '/files/upload')}?path=${encodeURIComponent(path)}`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.DAYTONA_API_KEY}` },
      body: form,
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`File upload failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
}
