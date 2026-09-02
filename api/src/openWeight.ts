import { OPENROUTER_API } from './constants';
import type { Bindings } from './types';

const CACHE_TTL_SECONDS = 24 * 60 * 60;
const CACHE_KEY_PREFIX = 'open-weight:v1:';

interface OpenRouterModelMetadata {
  id?: unknown;
  canonical_slug?: unknown;
  hugging_face_id?: unknown;
}

export type OpenWeightDecision = 'open' | 'closed' | 'unknown';

/** Strip BayLeaf's optional namespace before consulting or calling OpenRouter. */
export function openRouterSlug(modelId: string): string {
  return modelId.startsWith('openrouter:')
    ? modelId.slice('openrouter:'.length)
    : modelId;
}

/** The inexpensive first half of the policy, also used to prune /v1/models. */
export function hasPublishedWeights(model: OpenRouterModelMetadata): boolean {
  return typeof model.hugging_face_id === 'string' && model.hugging_face_id.trim().length > 0;
}

async function cacheDecision(kv: KVNamespace, modelId: string, decision: 'open' | 'closed'): Promise<void> {
  try {
    await kv.put(`${CACHE_KEY_PREFIX}${modelId}`, decision, { expirationTtl: CACHE_TTL_SECONDS });
  } catch {
    // A cache outage may add lookup latency, but must not decide model policy.
  }
}

/**
 * Apply BayLeaf's operational open-weight evidence rule.
 *
 * A model is allowed only when OpenRouter publishes a nonempty Hugging Face ID
 * and that repository resolves successfully. Definite positive and negative
 * results are cached for 24 hours. Upstream and malformed-response failures are
 * unknown and deliberately not cached, so a transient outage denies this
 * request without extending the outage for another day.
 */
export async function checkOpenWeightModel(
  modelId: string,
  env: Pick<Bindings, 'MODEL_STATUS'>,
): Promise<OpenWeightDecision> {
  const slug = openRouterSlug(modelId);
  if (!slug) return 'closed';

  const cacheKey = `${CACHE_KEY_PREFIX}${slug}`;
  try {
    const cached = await env.MODEL_STATUS.get(cacheKey);
    if (cached === 'open' || cached === 'closed') return cached;
  } catch {
    // Fall through to authoritative lookups. Failure remains closed below.
  }

  let modelsResponse: Response;
  try {
    modelsResponse = await fetch(`${OPENROUTER_API}/models`);
  } catch {
    return 'unknown';
  }
  if (!modelsResponse.ok) return 'unknown';

  let models: OpenRouterModelMetadata[];
  try {
    const payload = await modelsResponse.json() as { data?: unknown };
    if (!Array.isArray(payload.data)) return 'unknown';
    models = payload.data as OpenRouterModelMetadata[];
  } catch {
    return 'unknown';
  }

  const metadata = models.find((model) => model.id === slug || model.canonical_slug === slug);
  if (!metadata || !hasPublishedWeights(metadata)) {
    await cacheDecision(env.MODEL_STATUS, slug, 'closed');
    return 'closed';
  }

  const huggingFaceId = (metadata.hugging_face_id as string).trim();
  let huggingFaceResponse: Response;
  try {
    huggingFaceResponse = await fetch(`https://huggingface.co/${huggingFaceId}`, { redirect: 'follow' });
  } catch {
    return 'unknown';
  }

  if (huggingFaceResponse.ok) {
    await cacheDecision(env.MODEL_STATUS, slug, 'open');
    return 'open';
  }

  // These statuses definitively fail the public-resolution rule. Do not turn
  // rate limiting, timeouts, or server trouble into a cached 24-hour denial.
  if ([400, 401, 403, 404, 410].includes(huggingFaceResponse.status)) {
    await cacheDecision(env.MODEL_STATUS, slug, 'closed');
    return 'closed';
  }
  return 'unknown';
}
