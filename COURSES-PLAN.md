# courses.bayleaf.dev — Development Plan (v2)

Revised from the original plan after Q&A. This version reflects all
decisions made and includes specific codebase references to accelerate
implementation.

---

## Decisions Log

| Question | Decision |
|----------|----------|
| OAuth client | Reuse the same `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` as `api/`; Adam adds redirect URIs |
| OWUI admin JWT | Adam snarfs from browser for dev; long-lived token later |
| Canvas token | Adam's personal access token (broad read); political move |
| Base model | Single `DEFAULT_BASE_MODEL` env var, Adam-managed |
| Prompt source | Always Canvas — full page body of "BayLeaf AI" page, HTML stripped |
| Prompt mode toggle | Dropped; Canvas-only |
| OWUI groups | Dropped; model-level `access_grants` instead |
| User resolution | Require prior OWUI login; show message if lookup fails |
| OWUI deep link | `https://chat.bayleaf.dev/?model=course-{id}` (confirmed working) |
| Quarter grouping | Deferred until multi-quarter data exists |
| Cron sync | Deferred; staff get a manual "Refresh from Canvas" button |
| OpenAPI spec | Not needed; plain Hono routes + JSX templates |
| Repo structure | `courses/` as peer to `api/` in monorepo |

---

## Architecture

### Actors

- **Staff** — anyone who completes the Canvas claim flow for a course.
  Multiple staff per course. Any staff member can revoke another's
  staff status (legitimate users re-claim).
- **Users** — anyone with a `@ucsc.edu` Google account who installs a
  course model. Must have logged into chat.bayleaf.dev at least once
  (OWUI user ID resolution requirement).

### External Systems

| System | Credential | Purpose |
|--------|-----------|---------|
| Open WebUI (chat.bayleaf.dev) | Admin JWT (`OWUI_ADMIN_JWT`) | Model CRUD, access grants, user search |
| Canvas (canvas.ucsc.edu) | Adam's token (`CANVAS_TOKEN`) | Claim verification, prompt sync |
| Google OAuth (UCSC) | Same client as `api/` | User authentication |

### OWUI Model Management

Uses the 0.8.x `access_grants` system (not groups):

- **Create model**: `POST /api/v1/models/create` with `id`, `name`,
  `base_model_id`, `params` (system prompt), `access_grants`
- **Update access**: `POST /api/v1/models/model/access/update` — full
  replace of grants list. Read-modify-write pattern required.
- **Resolve email → OWUI ID**: `GET /api/v1/users/search?query={email}`,
  filter results for exact match. User must exist (prior login required).
- **Grant format**: `{"principal_type": "user", "principal_id": "<uuid>", "permission": "read"}`

Model ID format: `course-{canvas_course_id}` (e.g. `course-85291`).
Display name: `Course: CMPM 121 — Generative AI` (from Canvas course name).

### Canvas Claim Flow

1. Service generates a short claim code for the teacher.
2. Teacher creates a Canvas page titled "BayLeaf AI" in their course
   and pastes the claim code anywhere on it.
3. Service reads that page via admin Canvas token and verifies the code.
4. Teacher is registered as staff on that course.
5. The full page body (HTML-stripped) also becomes the model's system
   prompt. Staff can update it in Canvas and hit "Refresh" on the
   courses site.

Canvas course URL parsing: teacher pastes full URL like
`https://canvas.ucsc.edu/courses/85291`, we extract the numeric ID.

### D1 Schema

```sql
CREATE TABLE courses (
  canvas_course_id  INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,          -- from Canvas or teacher input
  base_model        TEXT NOT NULL,          -- defaults to DEFAULT_BASE_MODEL
  prompt_text       TEXT DEFAULT '',        -- last-synced prompt from Canvas
  canvas_page_url   TEXT,                   -- full URL to the "BayLeaf AI" page
  owui_model_id     TEXT,                   -- 'course-{id}', set on publish
  published         INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE memberships (
  canvas_course_id  INTEGER NOT NULL,
  email             TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('staff', 'user')),
  owui_user_id      TEXT,                   -- cached OWUI UUID, null if pending
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (canvas_course_id, email),
  FOREIGN KEY (canvas_course_id) REFERENCES courses(canvas_course_id)
);
```

### Runtime Stack

Cloudflare Worker with Hono + TypeScript + D1. Same patterns as `api/`.

---

## Codebase References

Files in `api/` to mirror or reference during implementation:

| Concern | Reference | Key Lines |
|---------|-----------|-----------|
| Entry point / app setup | `api/src/index.ts` | L28 app creation, L41-46 CORS, L86-91 route mounting, L132-139 error handling |
| Type definitions | `api/src/types.ts` | L6-33 `Bindings`, L35-40 `Session`, L80-83 `AppEnv` |
| Google OIDC login | `api/src/routes/auth.tsx` | L20-34 `/login`, L39-102 `/callback`, L107-109 `/logout` |
| Session JWT | `api/src/utils/session.ts` | L16-24 `getSession`, L29-40 `setSessionCookie` |
| Constants | `api/src/constants.ts` | L5-9 `GOOGLE_OIDC` endpoints, L13-14 session config |
| Dashboard pattern | `api/src/routes/dashboard.tsx` | L18-22 landing vs dashboard redirect, L25-79 session guard + data fetch + render |
| HTML layout | `api/src/templates/layout.tsx` | L179-200 `BaseLayout`, L100-175 shared CSS |
| Wrangler config | `api/wrangler.jsonc` | L2-5 worker name/entry, L14-16 custom domain, L21-27 D1 binding |
| Package setup | `api/package.json` | Three runtime deps: `hono`, `zod`, `@hono/zod-openapi` |
| TypeScript config | `api/tsconfig.json` | L8-9 JSX via `hono/jsx` |

---

## Development Roadmap

### Phase 0 — Scaffold & Deploy Placeholder

Goal: get `courses.bayleaf.dev` live with a placeholder page so Adam
can configure Cloudflare DNS/custom domain in parallel with development.

1. **Initialize `courses/` as a Cloudflare Worker project.** Mirror
   `api/` structure: `wrangler.jsonc`, `package.json`, `tsconfig.json`,
   `src/index.ts`. Hono + TypeScript. No `@hono/zod-openapi` needed
   (plain routes only).

2. **Placeholder landing page.** A single `GET /` route serving a
   styled HTML page (using `hono/jsx` + `hono/css`, same as
   `api/src/templates/layout.tsx`). Content:
   - BayLeaf Courses heading + brief description ("Self-service course
     AI models for the UC Santa Cruz community").
   - "Coming soon" teaser listing planned features: Canvas-linked
     course models, one-click student install, instructor self-service.
   - Link to the GitHub repo (`https://github.com/rndmcnlly/bayleaf`)
     so people can follow development.
   - Same visual style as `api/` (system-ui font, `#003c6c` headings,
     700px max-width).

3. **Configure `wrangler.jsonc`** with worker name `bayleaf-courses`,
   custom domain `courses.bayleaf.dev`, D1 binding (database name
   `bayleaf-courses`), compatibility flags. Include placeholder `vars`
   for `ALLOWED_EMAIL_DOMAIN`, `DEFAULT_BASE_MODEL`, `OWUI_BASE_URL`.

4. **Deploy.** `npm run deploy` from `courses/`. Adam configures the
   custom domain in Cloudflare if needed. Verify the placeholder is
   live.

5. **D1 schema.** Write the migration for `courses` and `memberships`
   tables (schema above). Apply via `wrangler d1 migrations apply`.

### Phase 1 — Auth & Session

6. **Add Google OIDC auth routes.** Port directly from
   `api/src/routes/auth.tsx` (L20-109). Same flow: `/login` →
   Google → `/callback` → session cookie → redirect. Same session
   management from `api/src/utils/session.ts`. Redirect URI will be
   `https://courses.bayleaf.dev/callback` (Adam adds to the OAuth
   client).

7. **Session-gated landing page.** Update the placeholder: if logged
   in, show the user's email and a logout link. If not, show a
   "Sign in with UCSC Google" button. This proves auth works before
   building any course logic.

### Phase 2 — DALs with Mocks

8. **Define the Chat DAL interface.** TypeScript interface for OWUI
   operations:
   - `searchUserByEmail(email: string): Promise<{id: string, name: string} | null>`
   - `createModel(id, name, baseModel, systemPrompt, accessGrants): Promise<void>`
   - `updateModelPrompt(id, systemPrompt): Promise<void>`
   - `getModelAccessGrants(id): Promise<AccessGrant[]>`
   - `setModelAccessGrants(id, grants: AccessGrant[]): Promise<void>`
   - `deleteModel(id): Promise<void>`

   Write a mock implementation with canned data (a few fake users,
   one existing model). Follow the stateless-function pattern from
   `api/src/openrouter.ts` — functions take `env: Bindings`.

9. **Define the Canvas DAL interface.** TypeScript interface:
   - `getCourseInfo(courseId: number): Promise<{name: string} | null>`
   - `getPageByTitle(courseId: number, title: string): Promise<{body: string} | null>`

   Mock implementation with canned course data and a fake "BayLeaf AI"
   page containing a claim code.

10. **Wire DALs into Hono context.** Middleware that injects the DAL
    implementations into `c.var` or `c.env`. Tests and dev use mocks;
    production uses live implementations. Keep it simple — a boolean
    env var `USE_MOCK_DALS` or just swap at build time.

### Phase 3 — Core Flows (Against Mocks)

11. **Course creation + claim flow.**
    - `POST /courses` — accepts a Canvas URL
      (`https://canvas.ucsc.edu/courses/85291`), extracts the course
      ID, calls Canvas DAL for course info, generates a claim code,
      inserts into D1, returns the claim code + instructions.
    - `POST /courses/:id/verify` — reads the "BayLeaf AI" page via
      Canvas DAL, checks for the claim code, registers the caller as
      staff in `memberships`, strips HTML from page body and stores
      as `prompt_text`.

12. **Course publishing.** Staff action that:
    - Calls Chat DAL to create the workspace model (`course-{id}`)
      with the stored prompt as `params.system` and
      `DEFAULT_BASE_MODEL` as `base_model_id`.
    - Sets `published = 1` and `owui_model_id` in D1.
    - Grants the staff member write access on the model.

13. **User install (join).**
    - `POST /courses/:id/join` — resolves the caller's email to an
      OWUI user ID via Chat DAL. If not found, returns an error
      message telling them to log into chat.bayleaf.dev first.
    - Reads current access grants, appends the user with read
      permission, writes back.
    - Records membership in D1.
    - Returns a success page with a direct link:
      `https://chat.bayleaf.dev/?model=course-{id}`

14. **User leave.**
    - `POST /courses/:id/leave` — removes the user's access grant
      from the model, deletes the membership row.

15. **Prompt refresh.** Staff action:
    - `POST /courses/:id/refresh` — re-reads the "BayLeaf AI"
      Canvas page, strips HTML, updates `prompt_text` in D1, calls
      Chat DAL to update the model's `params.system`.

16. **Staff revocation.**
    - `POST /courses/:id/staff/:email/revoke` — any staff member
      can remove another staff member. Deletes the membership row
      and removes their write access grant.

### Phase 4 — Landing Page & Browse UI

17. **Landing page (logged in).** Two-panel layout:
    - **Staff panel:** "Register a Course" button → form that
      accepts a Canvas course URL.
    - **User panel:** List of published courses with "Install" /
      "Leave" buttons and user counts.

18. **Course detail page.** `/courses/:id` — shows course name,
    staff list, user count, current prompt preview. Staff see
    edit controls (refresh prompt, unpublish, revoke staff).
    Users see install/leave button.

19. **Staff dashboard.** After claiming a course, staff land on the
    course detail page with the claim code instructions (if not yet
    verified) or the management controls (if verified).

### Phase 5 — Live DAL Implementations

20. **Chat DAL — live implementation.** Hit the real OWUI admin API
    at `OWUI_BASE_URL` with `OWUI_ADMIN_JWT`. Follow the stateless
    function pattern from `api/src/openrouter.ts`. Key endpoints:
    - `POST /api/v1/models/create`
    - `POST /api/v1/models/model/update`
    - `POST /api/v1/models/model/access/update`
    - `POST /api/v1/models/model/delete`
    - `GET /api/v1/users/search?query={email}`

21. **Canvas DAL — live implementation.** Hit the Canvas REST API
    at `https://canvas.ucsc.edu/api/v1` with `CANVAS_TOKEN`.
    - `GET /api/v1/courses/:id` — course info
    - `GET /api/v1/courses/:id/pages/bayleaf-ai` — the claim page
      (Canvas slugifies the title)

22. **Swap DALs.** Flip to live implementations. Test manually
    against real OWUI and Canvas.

### Phase 6 — Secret Management & Deployment

23. **Provision worker secrets:**
    - `OWUI_ADMIN_JWT` — admin JWT for chat.bayleaf.dev
    - `CANVAS_TOKEN` — Adam's Canvas API token
    - `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` — same as `api/`
    - `SESSION_SECRET` — HMAC key for session cookies

24. **D1 database creation + migration.**
    `wrangler d1 create bayleaf-courses`, then
    `wrangler d1 migrations apply`.

25. **Full deploy.** `npm run deploy`. Verify custom domain, auth
    flow, and at least one end-to-end course creation.

### Phase 7 — Agentic Manual Testing

26. **Write `courses/TESTING.md` runbook.** Curl-based smoke tests:
    - Unauthenticated: landing page returns 200.
    - Auth: `/login` redirects to Google.
    - Course creation: POST with a real Canvas URL.
    - Claim verification: end-to-end with a real Canvas page.
    - Student install: verify access grant appears in OWUI.
    - Student leave: verify access grant removed.
    - Prompt refresh: update Canvas page, hit refresh, verify OWUI
      model updated.

27. **Run the runbook.** Fix anything that breaks.

### Phase 8 — Deferred / Future

- Canvas prompt sync cron (replace manual refresh button).
- Quarter grouping in the course listing.
- TA co-editor support.
- Canvas enrollment sync (restrict to enrolled students).
- Usage analytics surfaced to teachers.
- Quarterly auto-archival based on Canvas term dates.
- Teacher toolkit admin model (`course-{id}-admin`).

---

## Development Principles

- **DALs are the testing seam.** Every external call goes through a
  DAL. Tests inject mocks. Production injects live implementations.
- **Same stack as `api/`.** Hono, TypeScript, D1, Wrangler,
  `strict: true`. Follow the code style in `api/AGENTS.md`.
- **No secrets in the repo.** All credentials in worker secrets.
- **UI is server-rendered HTML.** Hono JSX templates, no frontend
  framework. Same patterns as `api/src/templates/`.
- **OWUI user resolution requires prior login.** If a user's email
  can't be resolved via the OWUI search API, tell them to visit
  chat.bayleaf.dev and log in first, then come back.
- **Access grants are full-replace.** Always read current grants,
  modify in memory, write back the full list. Never assume the
  current state.
- **Canvas page = source of truth for prompts.** The "BayLeaf AI"
  page body (HTML-stripped) is the system prompt. Staff refresh it
  manually via a button on the courses site.
