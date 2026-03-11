/**
 * Live Chat DAL — real Open WebUI admin API calls
 *
 * All requests use the admin JWT for authentication.
 * ZDR inference via OpenRouter.
 */

import type { Bindings } from '../types';
import type { ChatDAL, ChatUser, ChatModel, AccessGrant } from './types';

export function createLiveChatDAL(env: Bindings): ChatDAL {
  const base = env.OWUI_BASE_URL;
  const headers = {
    'Authorization': `Bearer ${env.OWUI_ADMIN_JWT}`,
    'Content-Type': 'application/json',
  };

  return {
    async searchUserByEmail(email) {
      const res = await fetch(`${base}/api/v1/users/search?query=${encodeURIComponent(email)}`, { headers });
      if (!res.ok) {
        console.error(`[chat-dal] User search failed: ${res.status}`);
        return null;
      }
      const data = await res.json() as { users: ChatUser[] };
      // Search is fuzzy (ILIKE), so filter for exact email match
      return data.users.find((u) => u.email === email) ?? null;
    },

    async createModel(id, name, baseModelId, systemPrompt, accessGrants) {
      const res = await fetch(`${base}/api/v1/models/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id,
          name,
          base_model_id: baseModelId,
          meta: { description: `Course model: ${name}` },
          params: { system: systemPrompt },
          access_grants: accessGrants,
          is_active: true,
        }),
      });
      if (!res.ok) {
        console.error(`[chat-dal] Create model failed: ${res.status} ${await res.text()}`);
        return null;
      }
      return await res.json() as ChatModel;
    },

    async updateModelPrompt(id, systemPrompt) {
      // Full model replace — first fetch current model to preserve other fields
      const getRes = await fetch(`${base}/api/v1/models/model?id=${encodeURIComponent(id)}`, { headers });
      if (!getRes.ok) {
        console.error(`[chat-dal] Get model failed: ${getRes.status}`);
        return null;
      }
      const current = await getRes.json() as ChatModel;

      const res = await fetch(`${base}/api/v1/models/model/update`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: current.id,
          name: current.name,
          base_model_id: current.base_model_id,
          meta: current.meta,
          params: { ...current.params, system: systemPrompt },
          is_active: current.is_active,
        }),
      });
      if (!res.ok) {
        console.error(`[chat-dal] Update model failed: ${res.status} ${await res.text()}`);
        return null;
      }
      return await res.json() as ChatModel;
    },

    async getModelAccessGrants(id) {
      const res = await fetch(`${base}/api/v1/models/model?id=${encodeURIComponent(id)}`, { headers });
      if (!res.ok) return [];
      const model = await res.json() as ChatModel;
      return model.access_grants.map(({ principal_type, principal_id, permission }) => ({
        principal_type,
        principal_id,
        permission,
      }));
    },

    async setModelAccessGrants(id, grants) {
      const res = await fetch(`${base}/api/v1/models/model/access/update`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id, access_grants: grants }),
      });
      if (!res.ok) {
        console.error(`[chat-dal] Set access grants failed: ${res.status} ${await res.text()}`);
        return null;
      }
      return await res.json() as ChatModel;
    },

    async deleteModel(id) {
      const res = await fetch(`${base}/api/v1/models/model/delete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        console.error(`[chat-dal] Delete model failed: ${res.status}`);
        return false;
      }
      return true;
    },
  };
}
