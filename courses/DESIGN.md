# courses.bayleaf.dev — Design Document

A lightweight sidecar service that lets UC Santa Cruz instructors stand up
course-specific AI models on BayLeaf Chat and lets students subscribe to them —
without invite codes, without Filters, and with about two minutes of setup per
quarter.

---

## Contents

1. [Motivation](#motivation)
2. [Architecture Overview](#architecture-overview)
3. [Key Design Decisions](#key-design-decisions)
4. [Data Model](#data-model)
5. [OWUI Integration](#owui-integration)
6. [Canvas Integration](#canvas-integration)
7. [API Routes](#api-routes)
8. [Usage Flows](#usage-flows)
   - [Teacher: First-Time Setup](#teacher-first-time-setup)
   - [Teacher: Returning to Edit](#teacher-returning-to-edit)
   - [Student: Joining a Course Model](#student-joining-a-course-model)
   - [Student: Leaving a Course Model](#student-leaving-a-course-model)
   - [Multi-Course: One Teacher, Two Courses](#multi-course-one-teacher-two-courses)
   - [Multi-Course: One Student, Two Courses](#multi-course-one-student-two-courses)
9. [Prompt Management](#prompt-management)
10. [Teacher Toolkit Model](#teacher-toolkit-model)
11. [Comparison with the Brace System](#comparison-with-the-brace-system)
12. [Security & Privacy](#security--privacy)
13. [Future Considerations](#future-considerations)

---

## Motivation

The current Brace system (CMPM 121 Fall 2025) proved that course-specific AI
models are valuable: a custom system prompt, Canvas-aware tools, and a scoped
user group let instructors shape the AI experience for their class. But Brace is
hand-wired — every new course requires Adam to manually create a workspace model,
a user group, a Filter, and an invite flow. The courses service automates all of
that through deterministic REST API calls to Open WebUI and Canvas.

Goals:

- **Self-service** — Instructors set up their own course models without admin
  intervention.
- **Minimal friction** — ~2 minutes of instructor time once per quarter; students
  click one link.
- **No invite codes** — Students join via the courses site, not by pasting JWTs
  into chat.
- **No per-course Filters** — System prompts are baked into OWUI workspace model
  configuration, updated via the courses service or periodic Canvas sync.
- **Deterministic** — All group/model management happens via REST API calls, not
  LLM function calling.

---

## Architecture Overview

```
┌────────────────────┐      OWUI Admin API       ┌──────────────────────┐
│                    │  ◄───────────────────────► │                      │
│  courses.bayleaf   │   (long-lived admin JWT)   │   chat.bayleaf.dev   │
│  .dev              │                            │   (Open WebUI)       │
│                    │                            │                      │
│  Cloudflare Worker │      Canvas REST API       └──────────────────────┘
│  + D1 Database     │  ◄──────────────────────►         ▲
│                    │   (Adam's Canvas token)            │
└────────┬───────────┘                                   │
         │                                               │
         │  Google OAuth (UCSC)                 students & teachers
         ▼                                      use chat normally
    ┌─────────┐
    │ Teacher  │  sets up course in ~2 min
    │ Student  │  joins/leaves in ~10 sec
    └─────────┘
```

**Runtime:** Cloudflare Worker (same stack as `api.bayleaf.dev` — Hono,
TypeScript, D1).

**External dependencies:**

| System | Credential | Purpose |
|--------|-----------|---------|
| Open WebUI API | Long-lived admin JWT | Create/update workspace models, manage groups and memberships |
| Canvas LMS API | Adam's personal token | Verify course ownership, optionally pull system prompts |
| Google OAuth | OIDC client (UCSC) | Authenticate teachers and students |

All credentials are stored in Cloudflare Worker secrets, never in the repository.

---

## Key Design Decisions

### No per-course Filters

Brace used a custom `brace_filter` to dynamically inject the system prompt and
force-add the toolkit at chat time. This was necessary because OWUI workspace
models can hold a static system prompt but Brace needed to pull it from Canvas
on the fly.

The courses service eliminates per-course Filters entirely:

- **Static prompts** are written directly into the workspace model's
  `params.system` field via the OWUI API.
- **Canvas-synced prompts** are pulled by a scheduled cron trigger on the Worker
  (e.g. every 15 minutes) and written into `params.system`. The model config is
  the single source of truth at chat time — no Filter intercepts needed.

If a shared Filter or Toolkit is needed in the future (e.g. a `course_toolkit`
for Canvas submission), it would be a single shared tool/filter attached to all
course models — not one per course.

### No invite codes

The old `accept_invites_toolkit` required teachers to generate JWT invite codes
and distribute them — students then pasted them into chat. This was confusing
and fragile.

The courses service replaces this with a simple web flow:

1. Student visits `courses.bayleaf.dev`.
2. Student sees available courses (filtered to courses that are "published").
3. Student clicks **Join** next to a course.
4. The service calls the OWUI API to add the student to the course's usage group.
5. The model appears in the student's dropdown.

No JWTs, no pasting into chat, no toolkit invocation.

### Course ownership via Canvas page claim

Instead of asking for each teacher's Canvas token (privacy/security concern), the
service uses a single admin Canvas token and verifies ownership through a
"claim" mechanism:

1. The courses service generates a short unique claim code for the teacher.
2. The teacher pastes the claim code into a designated Canvas page in their
   course (e.g. a page titled "BayLeaf AI").
3. The service reads that page via the admin Canvas token and verifies the code.
4. Once verified, the teacher is registered as the owner of that course.

This proves the teacher has edit access to the Canvas course without requiring
their personal token.

### Access by interest, not enrollment

Anybody with a UCSC Google account can join any published course model. We
intentionally do not enforce enrollment — students self-select which models they
want in their dropdown. This mirrors the current BayLeaf philosophy: the
platform is open to the campus community.

---

## Data Model

Stored in a Cloudflare D1 database.

### `courses` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `canvas_course_id` | INTEGER UNIQUE | Canvas course ID (e.g. `85291`) |
| `name` | TEXT | Display name (e.g. "CMPM 121 — Game Development Patterns") |
| `owner_email` | TEXT | UCSC email of the claiming teacher |
| `claim_code` | TEXT | Short code used for Canvas page verification |
| `claimed_at` | TEXT | ISO 8601 timestamp of successful claim |
| `owui_model_id` | TEXT | OWUI workspace model ID (e.g. `course-85291`) |
| `owui_group_id` | TEXT | OWUI usage group UUID |
| `base_model` | TEXT | OpenRouter model ID (e.g. `openrouter.z-ai/glm-5`) |
| `prompt_mode` | TEXT | `"static"` or `"canvas"` |
| `prompt_text` | TEXT | Static system prompt (when `prompt_mode = "static"`) |
| `prompt_canvas_page` | TEXT | Canvas page slug (when `prompt_mode = "canvas"`) |
| `published` | INTEGER | `1` if visible to students, `0` if draft |
| `created_at` | TEXT | ISO 8601 |
| `updated_at` | TEXT | ISO 8601 |

### `memberships` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `course_id` | TEXT FK | References `courses.id` |
| `user_email` | TEXT | UCSC email of the student |
| `owui_user_id` | TEXT | OWUI user UUID (resolved on join) |
| `joined_at` | TEXT | ISO 8601 |

Unique constraint on `(course_id, user_email)`.

---

## OWUI Integration

The courses service calls the Open WebUI API as an admin user (via a long-lived
JWT configured as a Worker secret). Key operations:

### Creating a course model

When a teacher finishes setup, the service creates:

1. **A usage group** — `POST /api/v1/groups/create` with a deterministic name
   like `Course: CMPM 121 (85291)`.
2. **A workspace model** — `POST /api/v1/models/create` with:
   - `id`: `course-{canvas_course_id}` (e.g. `course-85291`)
   - `base_model_id`: teacher's chosen OpenRouter model
   - `params.system`: the system prompt
   - `access_grants`: `[{ principal_type: "group", principal_id: "<group_uuid>" }]`
   - Optional `meta.toolIds` for shared tools (e.g. web search)

### Adding a student to a course

When a student joins:

1. **Resolve OWUI user ID** — `GET /api/v1/users/` filtered by email.
2. **Add to group** — `POST /api/v1/groups/{group_id}/members` with the user ID.
3. **Record membership** in the local D1 database.

### Removing a student from a course

When a student leaves:

1. **Remove from group** — `DELETE /api/v1/groups/{group_id}/members/{user_id}`.
2. **Delete membership** from the local D1 database.

### Updating a course model

When a teacher edits the system prompt or base model:

1. **Update workspace model** — `POST /api/v1/models/update` with the new
   configuration.

### Deleting a course

When a teacher unpublishes or deletes:

1. **Remove all members** from the OWUI group.
2. **Delete the group** and **workspace model** via OWUI API.
3. **Mark as deleted** in D1 (soft delete).

---

## Canvas Integration

All Canvas API calls use Adam's personal token (stored as a Worker secret).
The service interacts with Canvas in two ways:

### Course claiming (one-time)

1. Teacher provides their Canvas course URL (e.g.
   `https://canvas.ucsc.edu/courses/85291`).
2. Service extracts the course ID and generates a random claim code (e.g.
   `bayleaf-claim-a7x9`).
3. Teacher creates (or edits) a Canvas page titled **"BayLeaf AI"** in their
   course and pastes the claim code.
4. Service calls `GET /api/v1/courses/{id}/pages/bayleaf-ai` to read the page
   body and verify the claim code is present.
5. On success, the course record is created and linked to the teacher.

The Canvas page only needs to be public within the institution (the default for
published pages).

### System prompt sync (optional, recurring)

For courses with `prompt_mode = "canvas"`:

1. A Cloudflare Cron Trigger fires every 15 minutes.
2. For each canvas-synced course, the Worker fetches the designated Canvas page
   (e.g. `GET /api/v1/courses/{id}/pages/{slug}`).
3. The page body (HTML) is converted to plain text and written into the OWUI
   workspace model's `params.system` field.
4. This means instructors can edit their system prompt in Canvas and have it
   reflected in BayLeaf Chat within 15 minutes.

---

## API Routes

All routes are under `courses.bayleaf.dev`.

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| GET | `/login` | Initiate Google OAuth (UCSC) |
| GET | `/callback` | OAuth callback |
| GET | `/logout` | Clear session |

### Teacher routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Landing page — list of teacher's courses + "Create" button |
| POST | `/courses` | Begin course creation (accepts Canvas course URL) |
| GET | `/courses/:id/claim` | Show claim instructions and verify status |
| POST | `/courses/:id/claim/verify` | Check Canvas page for claim code |
| GET | `/courses/:id/edit` | Edit course settings (prompt, model, tools) |
| POST | `/courses/:id` | Save course settings |
| POST | `/courses/:id/publish` | Publish course (visible to students) |
| POST | `/courses/:id/unpublish` | Unpublish course |
| DELETE | `/courses/:id` | Delete course (soft delete) |

### Student routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/browse` | List all published courses |
| POST | `/courses/:id/join` | Join a course (add to OWUI group) |
| POST | `/courses/:id/leave` | Leave a course (remove from OWUI group) |

### Internal / cron

| Method | Path | Description |
|--------|------|-------------|
| GET | `/cron/sync-prompts` | Triggered by Cron — sync Canvas prompts to OWUI models |

---

## Usage Flows

### Teacher: First-Time Setup

> Professor Rivera teaches CMPM 121 and wants to set up a course-specific AI
> model for her students.

1. Rivera visits `courses.bayleaf.dev` and signs in with her UCSC Google
   account.
2. She clicks **"Create Course"** and pastes her Canvas course URL:
   `https://canvas.ucsc.edu/courses/85291`.
3. The service shows a claim code: `bayleaf-claim-a7x9` with instructions:
   *"Create a page titled 'BayLeaf AI' in your Canvas course and paste this
   code anywhere on the page."*
4. Rivera opens Canvas, creates the page, pastes the code, and publishes it.
5. Back on the courses site, she clicks **"Verify"**. The service reads the
   Canvas page and confirms the code.
6. She now sees the course editor:
   - **Course name:** auto-populated from Canvas (e.g. "CMPM 121 — Game
     Development Patterns")
   - **Base model:** dropdown of available OpenRouter models (default: GLM-5)
   - **System prompt:** text area for a custom prompt, with an option to switch
     to "Sync from Canvas page" mode
   - She writes a system prompt tailored to game development patterns.
7. She clicks **"Publish"**. The service:
   - Creates an OWUI usage group `Course: CMPM 121 (85291)`
   - Creates an OWUI workspace model `course-85291` with her system prompt and
     access restricted to the group
   - Marks the course as published
8. She shares the link `courses.bayleaf.dev/browse` with her class (or just
   tells them to visit the courses site).

**Total time:** ~2 minutes.

### Teacher: Returning to Edit

> Rivera wants to update her system prompt mid-quarter.

1. Rivera visits `courses.bayleaf.dev` and signs in.
2. She sees her course listed under "My Courses" and clicks **"Edit"**.
3. She updates the system prompt text and clicks **"Save"**.
4. The service calls the OWUI API to update the workspace model's
   `params.system`.
5. All subsequent student conversations use the new prompt immediately.

**Total time:** ~30 seconds.

### Student: Joining a Course Model

> Alex is a student in CMPM 121 and wants to use the course-specific AI model.

1. Alex visits `courses.bayleaf.dev/browse` (linked from the course syllabus or
   announced in class).
2. Alex signs in with their UCSC Google account.
3. They see a list of published courses. CMPM 121 is listed with the
   description "Game Development Patterns."
4. Alex clicks **"Join"** next to CMPM 121.
5. The service:
   - Looks up Alex's OWUI user ID by email
   - Adds Alex to the `Course: CMPM 121 (85291)` group via the OWUI API
   - Records the membership locally
6. Alex opens `chat.bayleaf.dev`. The model "CMPM 121 — Game Development
   Patterns" now appears in their model dropdown.
7. Alex selects it and starts chatting with a game-development-aware assistant.

**Total time:** ~10 seconds.

### Student: Leaving a Course Model

> Alex finished the quarter and wants to clean up their model dropdown.

1. Alex visits `courses.bayleaf.dev/browse` and signs in.
2. Next to CMPM 121, the button now says **"Leave"** (since they're a member).
3. Alex clicks **"Leave"**.
4. The service removes Alex from the OWUI group and deletes the local
   membership record.
5. The model disappears from Alex's dropdown in BayLeaf Chat.

### Multi-Course: One Teacher, Two Courses

> Professor Rivera also teaches ARTG 80H in the same quarter.

1. Rivera visits `courses.bayleaf.dev` and sees her existing CMPM 121 course.
2. She clicks **"Create Course"** again and pastes her ARTG 80H Canvas URL:
   `https://canvas.ucsc.edu/courses/90412`.
3. She goes through the same claim → verify → configure → publish flow.
4. A second workspace model `course-90412` is created with a different system
   prompt and its own usage group.
5. Rivera's dashboard now shows both courses. She can edit each independently.

**Key point:** Each course is fully independent — different model IDs, different
groups, different prompts. Rivera manages them from the same dashboard.

### Multi-Course: One Student, Two Courses

> Jordan is enrolled in both CMPM 121 and ARTG 80H.

1. Jordan visits `courses.bayleaf.dev/browse` and sees both courses listed.
2. Jordan clicks **"Join"** on CMPM 121 and **"Join"** on ARTG 80H.
3. The service adds Jordan to both OWUI groups.
4. In BayLeaf Chat, Jordan now sees two additional models in their dropdown:
   - "CMPM 121 — Game Development Patterns"
   - "ARTG 80H — Introduction to Computational Media"
5. Jordan can switch between them depending on which class they need help with.
6. At the end of the quarter, Jordan visits the courses site and clicks
   **"Leave"** on both.

---

## Prompt Management

### Static prompts

The teacher writes a system prompt directly on the courses site. It is stored
in the D1 database and written to the OWUI workspace model's `params.system`
field. Changes take effect immediately.

### Canvas-synced prompts

The teacher chooses "Sync from Canvas page" and specifies a Canvas page slug
(or accepts the default `bayleaf-ai-prompt`). The service:

1. Stores `prompt_mode = "canvas"` and `prompt_canvas_page = "<slug>"` in D1.
2. On each cron tick (every 15 min), fetches the page via Canvas API.
3. Strips HTML tags to extract plain text.
4. Compares with the current `params.system` on the OWUI model.
5. If changed, updates the OWUI model via API.

This lets instructors manage their prompt in a familiar environment (Canvas)
and collaborate with TAs who also have edit access to the Canvas page.

---

## Teacher Toolkit Model

For each course, the service optionally creates a second workspace model that
serves as the teacher's management interface within BayLeaf Chat itself:

- **ID:** `course-{canvas_course_id}-admin`
- **Name:** `CMPM 121 Admin` (only visible to the teacher)
- **Access:** restricted to a group containing only the teacher (and any TAs)
- **Tools:** a shared `course_toolkit` that can:
  - List current group members
  - Preview the active system prompt
  - Trigger an immediate Canvas prompt sync
  - View basic usage statistics

This is a future enhancement. The MVP focuses on the web-based management
interface at `courses.bayleaf.dev`.

---

## Comparison with the Brace System

| Aspect | Brace (current) | Courses service (proposed) |
|--------|-----------------|---------------------------|
| Setup | Adam manually creates model, group, filter, action | Teacher self-serves via courses.bayleaf.dev |
| System prompt | Fetched at chat time by `brace_filter` from Canvas | Written into OWUI model config; optionally synced from Canvas on cron |
| Filters | Per-course `brace_filter` function | None — prompt is in model config |
| Toolkits | Per-course `brace_toolkit` (admin-only) | Optional shared `course_toolkit` for teacher admin model |
| Student access | JWT invite codes via `accept_invites_toolkit` | Click "Join" on courses.bayleaf.dev |
| Submission | `brace_submit_action` converts chat to HTML and uploads to Canvas | Out of scope for MVP; could be added as shared action later |
| Multi-course | Each course is a separate bespoke setup | Self-service, repeatable, independent per course |
| Admin burden | High — Adam provisions everything | Low — teachers self-serve, Adam manages infrastructure only |
| Canvas tokens | Adam's token (in toolkit valves) | Adam's token (in Worker secrets) |

---

## Security & Privacy

- **No secrets in the repository.** The OWUI admin JWT, Canvas token, and OAuth
  credentials are stored as Cloudflare Worker secrets.
- **ZDR providers only.** All underlying LLM inference goes through OpenRouter
  with zero-data-retention providers, same as the rest of BayLeaf.
- **Minimal data stored.** The D1 database stores course metadata and membership
  records (email + course ID). No conversation data, no Canvas grades, no
  student PII beyond email.
- **Canvas token scope.** Adam's token is used read-only for two purposes:
  verifying claim codes and fetching prompt pages. It is never exposed to
  teachers or students.
- **OWUI admin JWT scope.** Used for model/group CRUD only. The JWT is never
  sent to the browser.

---

## Future Considerations

- **TA support** — Allow teachers to add TAs as co-editors of a course. TAs
  would also be able to edit the system prompt and view group membership.
- **Canvas enrollment sync** — Optionally sync group membership with Canvas
  enrollment, for courses that want to restrict access to enrolled students
  only.
- **Shared tools** — A `course_toolkit` that provides Canvas-aware actions
  (assignment submission, grade lookup) shared across all course models.
- **Usage analytics** — Surface per-course usage statistics (message counts,
  active users) to teachers via the courses dashboard.
- **Archival** — Automatically unpublish and archive courses at the end of each
  quarter based on Canvas term dates.
- **Bulk operations** — Allow a department to pre-configure courses for an
  entire quarter.
