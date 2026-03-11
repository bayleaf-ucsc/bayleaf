/**
 * BayLeaf Courses Type Definitions
 */

import type { ChatDAL, CanvasDAL } from './dal/types';

/** Cloudflare Worker bindings (env vars + secrets) */
export interface Bindings {
  // D1 database
  DB: D1Database;

  // Public configuration
  ALLOWED_EMAIL_DOMAIN: string;
  DEFAULT_BASE_MODEL: string;        // Default base model for new course models
  OWUI_BASE_URL: string;             // e.g. https://chat.bayleaf.dev
  USE_MOCK_DALS: string;             // "true" in dev, absent in production

  // Secrets (set via wrangler secret put)
  OIDC_CLIENT_ID: string;
  OIDC_CLIENT_SECRET: string;
  SESSION_SECRET: string;            // HMAC key for session cookies
  OWUI_ADMIN_JWT: string;            // Admin JWT for chat.bayleaf.dev
  CANVAS_TOKEN: string;              // Canvas API token (Adam's personal access token)
}

export interface Session {
  email: string;
  name: string;
  picture?: string;
  exp: number; // JWT standard: seconds since epoch
}

/** Hono context variables (set by middleware, read by handlers) */
export interface Variables {
  session: Session;
  chatDAL: ChatDAL;
  canvasDAL: CanvasDAL;
}

/** Hono app environment type */
export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
}

/** D1 row for courses table */
export interface CourseRow {
  canvas_course_id: number;
  name: string;
  base_model: string;
  prompt_text: string;
  canvas_page_url: string | null;
  owui_model_id: string | null;
  published: number;
  claim_email: string | null;      // who initiated the claim (null after verification)
  created_at: string;
}

/** D1 row for memberships table */
export interface MembershipRow {
  canvas_course_id: number;
  email: string;
  role: 'staff' | 'user';
  owui_user_id: string | null;
  created_at: string;
}
