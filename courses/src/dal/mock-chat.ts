/**
 * Mock Chat DAL — canned data for development and testing
 */

import type { ChatDAL, ChatUser, ChatModel, AccessGrant, AccessGrantFull } from './types';

const MOCK_USERS: ChatUser[] = [
  { id: 'uuid-adam', name: 'Adam Smith', email: 'amsmith@ucsc.edu' },
  { id: 'uuid-student1', name: 'Alice Banana', email: 'abanana@ucsc.edu' },
  { id: 'uuid-student2', name: 'Bob Cherry', email: 'bcherry@ucsc.edu' },
];

// In-memory model store for mock
const models = new Map<string, ChatModel>();

function toFullGrant(modelId: string, grant: AccessGrant): AccessGrantFull {
  return {
    ...grant,
    id: crypto.randomUUID(),
    resource_type: 'model',
    resource_id: modelId,
    created_at: Math.floor(Date.now() / 1000),
  };
}

export function createMockChatDAL(): ChatDAL {
  return {
    async searchUserByEmail(email) {
      return MOCK_USERS.find((u) => u.email === email) ?? null;
    },

    async createModel(id, name, baseModelId, systemPrompt, accessGrants) {
      const model: ChatModel = {
        id,
        name,
        base_model_id: baseModelId,
        params: { system: systemPrompt },
        meta: { description: `Course model: ${name}` },
        access_grants: accessGrants.map((g) => toFullGrant(id, g)),
        is_active: true,
      };
      models.set(id, model);
      console.log(`[mock-chat] Created model ${id}: ${name}`);
      return model;
    },

    async updateModelPrompt(id, systemPrompt) {
      const model = models.get(id);
      if (!model) return null;
      model.params = { ...model.params, system: systemPrompt };
      console.log(`[mock-chat] Updated prompt for model ${id}`);
      return model;
    },

    async getModelAccessGrants(id) {
      const model = models.get(id);
      if (!model) return [];
      return model.access_grants.map(({ principal_type, principal_id, permission }) => ({
        principal_type,
        principal_id,
        permission,
      }));
    },

    async setModelAccessGrants(id, grants) {
      const model = models.get(id);
      if (!model) return null;
      model.access_grants = grants.map((g) => toFullGrant(id, g));
      console.log(`[mock-chat] Set ${grants.length} grants on model ${id}`);
      return model;
    },

    async deleteModel(id) {
      const deleted = models.delete(id);
      console.log(`[mock-chat] Delete model ${id}: ${deleted}`);
      return deleted;
    },
  };
}
