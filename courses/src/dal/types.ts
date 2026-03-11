/**
 * Data Access Layer — Shared Types
 *
 * Interfaces for external system integrations (OWUI Chat, Canvas).
 * Mock and live implementations conform to these interfaces.
 */

// ── Chat DAL (Open WebUI) ───────────────────────────────────────

/** Minimal OWUI user info returned by search */
export interface ChatUser {
  id: string;       // OWUI UUID
  name: string;
  email: string;
}

/** Access grant as sent to/from the OWUI API */
export interface AccessGrant {
  principal_type: 'user' | 'group';
  principal_id: string;
  permission: 'read' | 'write';
}

/** Full access grant as returned by OWUI (includes server-generated fields) */
export interface AccessGrantFull extends AccessGrant {
  id: string;
  resource_type: string;
  resource_id: string;
  created_at: number;
}

/** OWUI model as returned by the API */
export interface ChatModel {
  id: string;
  name: string;
  base_model_id: string | null;
  params: Record<string, unknown>;
  meta: Record<string, unknown>;
  access_grants: AccessGrantFull[];
  is_active: boolean;
}

export interface ChatDAL {
  /** Search for an OWUI user by exact email. Returns null if not found. */
  searchUserByEmail(email: string): Promise<ChatUser | null>;

  /** Create a new workspace model in OWUI. */
  createModel(
    id: string,
    name: string,
    baseModelId: string,
    systemPrompt: string,
    accessGrants: AccessGrant[],
  ): Promise<ChatModel | null>;

  /** Update a model's system prompt (full model replace). */
  updateModelPrompt(id: string, systemPrompt: string): Promise<ChatModel | null>;

  /** Get the current access grants for a model. */
  getModelAccessGrants(id: string): Promise<AccessGrant[]>;

  /** Replace all access grants on a model. */
  setModelAccessGrants(id: string, grants: AccessGrant[]): Promise<ChatModel | null>;

  /** Delete a model. */
  deleteModel(id: string): Promise<boolean>;
}

// ── Canvas DAL ──────────────────────────────────────────────────

export interface CanvasCourseInfo {
  id: number;
  name: string;         // e.g. "CMPM 121 — Generative AI"
  course_code: string;  // e.g. "CMPM 121"
}

export interface CanvasPageContent {
  title: string;
  body: string;   // raw HTML
  url: string;    // Canvas page URL slug
}

export interface CanvasDAL {
  /** Get basic course info by Canvas course ID. */
  getCourseInfo(courseId: number): Promise<CanvasCourseInfo | null>;

  /** Get a specific page by title slug (e.g. "bayleaf-ai"). */
  getPageByTitle(courseId: number, titleSlug: string): Promise<CanvasPageContent | null>;
}
