/**
 * OpenRouter API Helpers
 */

import type { Bindings, OpenRouterKey, OpenRouterKeyCreated } from './types';
import { OPENROUTER_API } from './constants';

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
      limit: parseFloat(env.SPENDING_LIMIT_DOLLARS) || 1.0,
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
  cost: ModelCost;
  costRaw: ModelCostRaw;
}

/**
 * Look up a model's display name and pricing from the OpenRouter public models list.
 * Pricing is converted from OpenRouter's per-token strings to per-million-token numbers.
 * Returns null if the model isn't found or the request fails.
 */
export async function getModelInfo(modelId: string): Promise<ModelInfo | null> {
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
  const model = result.data.find((m) => m.id === modelId);
  if (!model) return null;

  const toPerMillion = (v?: string): number => {
    const n = parseFloat(v ?? '0');
    return isNaN(n) ? 0 : Math.round(n * 1_000_000 * 1000) / 1000;
  };

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
