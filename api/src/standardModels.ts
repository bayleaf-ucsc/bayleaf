/** Shared standard-inference model identities and discovery. Sealed is separate. */
import type { Bindings } from './types';
import { ALT_BACKENDS, BEDROCK_MANTLE_API, OPENROUTER_API, VERTEX_MODELS, isBackendEnabled } from './constants';
import { checkOpenWeightModel, hasPublishedWeights } from './openWeight';

export function standardModelId(value: string): string | null {
  if (!value || /\s/.test(value)) return null;
  if (value.startsWith('openrouter:')) return value.slice(11).includes('/') ? value : null;
  if (ALT_BACKENDS.some(b => value.startsWith(b.prefix))) return value;
  // OpenRouter's optional variant suffix occurs AFTER the owner/model slash.
  const slash = value.indexOf('/'), colon = value.indexOf(':');
  return slash > 0 && (colon < 0 || colon > slash) ? `openrouter:${value}` : null;
}

/** Existing Bedrock retention filter, shared by both model-listing surfaces.
 * This is NOT proof of published weights. Bedrock remains disabled until its
 * documented enablement gates are met (api/AGENTS.md and wrangler.jsonc). */
export async function fetchBedrockModels(env: Bindings): Promise<any[]> {
  if (!isBackendEnabled(env, 'bedrock')) return [];
  try {
    const res = await fetch(`${BEDROCK_MANTLE_API}/models`, {
      headers: { Authorization: `Bearer ${env.BEDROCK_BEARER_TOKEN}` },
    });
    if (!res.ok) return [];
    const data = await res.json() as { data?: any[] };
    if (!Array.isArray(data.data)) return [];
    return data.data.filter(m => typeof m.id === 'string' && Array.isArray(m.data_retention?.allowed_modes)
      && m.data_retention.allowed_modes.includes('none')).map(m => ({ ...m, id: `bedrock:${m.id}`, name: `Bedrock: ${m.name || m.id}` }));
  } catch { return []; }
}

export async function eligibleStandardModel(id: string, env: Bindings): Promise<boolean> {
  if (id.startsWith('openrouter:')) return await checkOpenWeightModel(id, env) === 'open';
  const backend = ALT_BACKENDS.find(b => id.startsWith(b.prefix));
  if (!backend || !isBackendEnabled(env, backend.key)) return false;
  if (backend.key === 'vertex') return VERTEX_MODELS.some(m => m.id === id);
  if (backend.key === 'bedrock') return (await fetchBedrockModels(env)).some(m => m.id === id);
  return false;
}

export async function standardModelCatalog(env: Bindings) {
  let openrouter: { id: string; name: string }[] = [];
  let openrouterAvailable = false;
  try {
    const res = await fetch(`${OPENROUTER_API}/models`);
    if (res.ok) {
      const data = await res.json() as { data?: any[] };
      if (Array.isArray(data.data)) {
        openrouterAvailable = true;
        openrouter = data.data.filter(m => typeof m.id === 'string' && hasPublishedWeights(m))
          .map(m => ({ id: `openrouter:${m.id}`, name: String(m.name || m.id) }));
      }
    }
  } catch { /* A failed catalog contributes no selectable models. */ }
  const bedrock = await fetchBedrockModels(env);
  return {
    models: [...openrouter, ...(isBackendEnabled(env, 'vertex') ? VERTEX_MODELS : []), ...bedrock]
      .map(m => ({ id: m.id, name: m.name })).sort((a, b) => a.id.localeCompare(b.id)),
    backends: [
      { id: 'openrouter', label: 'OpenRouter', enabled: true, available: openrouterAvailable },
      ...ALT_BACKENDS.map(b => ({ id: b.key, label: b.label, enabled: isBackendEnabled(env, b.key),
        available: isBackendEnabled(env, b.key) && (b.key === 'vertex' || (b.key === 'bedrock' && bedrock.length > 0)) })),
    ],
  };
}
