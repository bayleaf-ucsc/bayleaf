/**
 * OpenRouter API Helpers
 */

import type { Bindings, OpenRouterKey, OpenRouterKeyCreated } from './types';
import { OPENROUTER_API, VERTEX_MODELS } from './constants';

/**
 * Generate the key name for a user based on their email
 */
export function getKeyName(email: string, template: string): string {
  return template.replace('$email', email);
}

/**
 * List all keys and find one by name.
 * Used during migration to adopt pre-existing OR keys.
 */
export async function findKeyByName(name: string, env: Bindings): Promise<OpenRouterKey | null> {
  let offset = 0;
  const limit = 100;
  
  while (true) {
    const response = await fetch(`${OPENROUTER_API}/keys?offset=${offset}&limit=${limit}`, {
      headers: {
        'Authorization': `Bearer ${env.OPENROUTER_PROVISIONING_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    
    if (!response.ok) {
      console.error('Failed to list keys:', await response.text());
      return null;
    }
    
    const result = await response.json() as { data: OpenRouterKey[] };
    const key = result.data.find(k => k.name === name);
    if (key) return key;
    
    if (result.data.length < limit) break;
    offset += limit;
  }
  
  return null;
}

/**
 * Look up a specific key by its hash.
 * Used for state reconciliation (checking if an OR key is still alive).
 */
export async function findKeyByHash(hash: string, env: Bindings): Promise<OpenRouterKey | null> {
  const response = await fetch(`${OPENROUTER_API}/keys/${hash}`, {
    headers: {
      'Authorization': `Bearer ${env.OPENROUTER_PROVISIONING_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) return null;

  const result = await response.json() as { data: OpenRouterKey };
  return result.data ?? null;
}

/**
 * Create a new API key (no expiry -- the OR key lives forever).
 */
export async function createKey(name: string, env: Bindings): Promise<OpenRouterKeyCreated | null> {
  const response = await fetch(`${OPENROUTER_API}/keys`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENROUTER_PROVISIONING_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      limit: parseFloat(env.SPENDING_LIMIT_DOLLARS) || 5.0,
      limit_reset: env.SPENDING_LIMIT_RESET || 'daily',
    }),
  });
  
  const responseText = await response.text();
  console.log('OpenRouter create key response:', response.status, responseText);
  
  if (!response.ok) {
    return null;
  }
  
  const result = JSON.parse(responseText) as { data: OpenRouterKeyCreated; key?: string };
  // Key might be at top level or nested in data
  const keyData = result.data || result as unknown as OpenRouterKeyCreated;
  if (result.key) keyData.key = result.key;
  return keyData;
}

/** Per-million-token cost breakdown for a model. */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Raw per-token cost strings from OpenRouter (used for Goose, which expects per-token USD). */
export interface ModelCostRaw {
  prompt: string;
  completion: string;
}

/** Model metadata returned by getModelInfo. */
export interface ModelInfo {
  name: string;
  /** Pricing details. May be null for namespaces where we don't track pricing
   * uniformly (e.g. Vertex MaaS partner models). */
  cost: ModelCost | null;
  /** Raw OpenRouter per-token cost strings. Only populated for openrouter: models. */
  costRaw: ModelCostRaw | null;
}

/** Convert OpenRouter's per-token USD string to per-million-token USD number. */
function toPerMillion(v?: string): number {
  const n = parseFloat(v ?? '0');
  return isNaN(n) ? 0 : Math.round(n * 1_000_000 * 1000) / 1000;
}

/**
 * Look up a model's display name and pricing.
 *
 * Accepts BayLeaf's namespaced model IDs:
 *   - `openrouter:<slug>` — fetched from OpenRouter's public /models list (with pricing).
 *   - `vertex:<slug>`     — looked up in the local VERTEX_MODELS table. Pricing is
 *                           only returned when our static table includes it (Gemini),
 *                           and we never expose `costRaw` for Vertex since the
 *                           Goose-style per-token-string format is OpenRouter-specific.
 *   - bare `<slug>`       — treated as OpenRouter for backwards compatibility.
 *
 * Returns null if the model can't be resolved.
 */
export async function getModelInfo(modelId: string): Promise<ModelInfo | null> {
  if (modelId.startsWith('vertex:')) {
    const entry = VERTEX_MODELS.find((m) => m.id === modelId);
    if (!entry) return null;
    const p = (entry as { pricing?: { prompt?: string; completion?: string } }).pricing;
    return {
      name: entry.name,
      cost: p
        ? {
            input: toPerMillion(p.prompt),
            output: toPerMillion(p.completion),
            cacheRead: 0,
            cacheWrite: 0,
          }
        : null,
      costRaw: null, // Vertex pricing isn't surfaced in OR's per-token-string format.
    };
  }

  // openrouter: prefix or bare slug — both query OpenRouter's /models endpoint.
  const orSlug = modelId.startsWith('openrouter:') ? modelId.slice('openrouter:'.length) : modelId;

  const response = await fetch(`${OPENROUTER_API}/models`);
  if (!response.ok) return null;

  const result = await response.json() as {
    data: {
      id: string;
      name: string;
      pricing: {
        prompt?: string;
        completion?: string;
        input_cache_read?: string;
        input_cache_write?: string;
      };
    }[];
  };
  const model = result.data.find((m) => m.id === orSlug);
  if (!model) return null;

  const p = model.pricing;
  return {
    name: model.name,
    cost: {
      input: toPerMillion(p.prompt),
      output: toPerMillion(p.completion),
      cacheRead: toPerMillion(p.input_cache_read),
      cacheWrite: toPerMillion(p.input_cache_write),
    },
    costRaw: {
      prompt: p.prompt ?? '0',
      completion: p.completion ?? '0',
    },
  };
}

/**
 * Update a key's spending limit on OpenRouter (PATCH).
 * Used for lazy migration when the default limit increases.
 */
export async function updateKeyLimit(hash: string, newLimit: number, env: Bindings): Promise<boolean> {
  const response = await fetch(`${OPENROUTER_API}/keys/${hash}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${env.OPENROUTER_PROVISIONING_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      limit: newLimit,
      limit_reset: env.SPENDING_LIMIT_RESET || 'daily',
    }),
  });

  if (!response.ok) {
    console.error('Failed to update key limit:', hash, await response.text());
    return false;
  }

  return true;
}

/**
 * Delete an API key by hash
 */
export async function deleteKey(hash: string, env: Bindings): Promise<boolean> {
  const response = await fetch(`${OPENROUTER_API}/keys/${hash}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${env.OPENROUTER_PROVISIONING_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  
  return response.ok;
}
