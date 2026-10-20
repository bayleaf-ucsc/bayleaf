# Open WebUI public/sign-in customization research

Research date: 2026-10-20. Target: BayLeaf Chat's pinned **v0.12.3**.
Research only: no service access, runtime edits, deployment, activation, commits or pushes.
Read `chat/AGENTS.md`, infrastructure/authentication/customization context in
`chat/DESIGN.md`, and `telemetry/AGENTS.md`. Existing rollout files were not changed.

## Bottom line

**v0.12.3 already loads `/static/custom.css` and `/static/loader.js` on every
SPA page, including sign-in.** These are real upstream seams, not an invented
`CUSTOM_JS` environment variable. Minimal auth-scoped CSS or a carefully gated
first-party arrival script does not require an OWUI frontend fork. However,
delivery to everyone is not anonymous-only execution: that restriction must be
implemented and tested. There is no verified turnkey anonymous-arrival plugin or
public landing-page editor in this release.

For BayLeaf, exhaust existing auth configuration, then evaluate a **small,
auditable asset addition** through the existing customization ladder. Do not
install an entire theming engine just to count public arrivals. Keep richer public
explanation on the existing `bayleaf.dev` page rather than create another public
surface. Full sign-in redesign should be a separately approved project.

## Three different surfaces

1. **Anonymous `/` arrival:** not a separate configurable marketing page. In
   authenticated mode, the `(app)` layout routes a missing user to
   `/auth?redirect=...`. This is client-side navigation, so instrumenting only
   the initial HTTP document path is not equivalent to observing the sign-in UI.
2. **`/auth`:** the actual sign-in/signup/MFA/pending-approval screen. v0.12.3 has
   `#auth-page`, `#auth-container` and `#auth-login-card`. A signed-in user can
   briefly visit this route before being redirected; `?state=logout` changes
   behavior. Route name alone does not prove absence of a session.
3. **Authenticated welcome/new-chat screen:** prompt suggestions, chat background,
   model greeting and the user setting called **Landing Page Mode** belong here,
   not to the public sign-in page. Admin Banners likewise are not an arbitrary
   public-page JS hook: the authenticated app layout fetches them.

Version-pinned sources: [app layout](https://github.com/open-webui/open-webui/blob/v0.12.3/src/routes/%28app%29/%2Blayout.svelte),
[auth page](https://github.com/open-webui/open-webui/blob/v0.12.3/src/routes/auth/%2Bpage.svelte),
[HTML shell](https://github.com/open-webui/open-webui/blob/v0.12.3/src/app.html).

## Concrete methods and evidence

| Method | Actual example / evidence | Scope and upgrade implications | Anonymous arrival instrumentation |
|---|---|---|---|
| Native env/auth configuration | BayLeaf already uses `WEBUI_NAME=BayLeaf`, `OAUTH_PROVIDER_NAME=UCSC`, `ENABLE_LOGIN_FORM=false`, OAuth signup and exact-domain restriction. Upstream v0.12.3 also implements `OAUTH_AUTO_REDIRECT`. [Auth source](https://github.com/open-webui/open-webui/blob/v0.12.3/src/routes/auth/%2Bpage.svelte), [env reference](https://docs.openwebui.com/reference/env-configuration/) | Supported, lowest maintenance. Provider label and visible auth methods affect sign-in; application name affects more than public pages. Auto-redirect skips the sign-in UI in unambiguous single-provider SSO configurations, with explicit exceptions. Not a layout/content editor. | No custom event hook. Auto-redirect can bypass the public notice/arrival screen, so do not enable it as a customization shortcut. |
| Static CSS in a thin derived image | Jonas Scholz/Sliplane, **2025-07-28**, publishes a working Dockerfile copying `custom.css` to `/app/build/static/custom.css`, pinned to an upstream image. [Article](https://dev.to/code42cate/how-to-build-custom-open-webui-themes-55hh), [repository](https://github.com/sliplane/open-webui-theme) | Demonstrated whole-app theming. Auth-only rules can instead be scoped under `#auth-page`. Upstream deliberately merged `#auth-login-card` for CSS targeting on **2026-06-16**: [PR #26060](https://github.com/open-webui/open-webui/pull/26060), present in v0.12.3. Selectors still need upgrade requalification. Do not copy the article's optional favicon replacement without checking license rights. | CSS is appropriate for styling, not a telemetry mechanism. Avoid remote fonts/images or CSS URL-based tracking. |
| Loader JS / historical HTML injection | Admin Taylor Wilsdon describes Google Analytics injection into container `index.html` and later a container-build patch script, on **2025-02-18 / 2025-03-08**: [discussion #10298](https://github.com/open-webui/open-webui/discussions/10298). v0.12.3's HTML shell directly loads `loader.js`; no need to reproduce the old shell patch. | Concrete production-admin account of analytics injection, but old HTML patching is erased by upgrades. Modern loader delivery is narrower and avoids editing hashed Svelte bundles. Loader still executes in the real app origin and can access sensitive page/session state; it is not sandboxed. | Technically suitable for a tiny first-party script, **not evidence that GA or whole-app tracking fits BayLeaf**. Gate before loading collection logic; handle SPA route transitions and auth resolution. |
| Plugin-driven instance theming | [Theme Designer Pro Event Function](https://github.com/silentoplayz/theme-designer-pro-presets/tree/main/event-function), README observed **2026-10-20**, version **1.16.6**, claims OWUI **≥0.11.0**. Official docs [highlight it, explicitly without vetting](https://docs.openwebui.com/features/extensibility/community/). Publishes through `loader.js`/`custom.css`, with independent **Show on Auth Pages** and **Only on Auth Pages** switches. | Real community implementation using Event Functions plus a plugin-maintained shared asset registry and dynamic routes. Not a native core theme editor or stable core asset-registry API. Uses server-side `DATA_DIR/theme/` persistence and SSE. BayLeaf's ephemeral local disk plus PostgreSQL/Spaces means file persistence needs a specific plan. Not runtime-qualified on BayLeaf. | Auth-only appearance exists, but global JS delivery/SSE and optional chat DOM/WebSocket observation make this **far broader than needed** for arrival telemetry. Do not mistake its legacy per-browser Tool variant for an instance-wide anonymous theme. |
| Separate public page / reverse proxy | External-page-to-chat pattern is described in a real private-fork deployment account, **2026-03-31**, [PR #23270](https://github.com/open-webui/open-webui/pull/23270): `datameesters.nl` login → chatbot subdomain → Clerk OIDC, with Caddy. Author confirms PR was accidentally sent upstream and belongs to a private fork. Separately, [#10298](https://github.com/open-webui/open-webui/discussions/10298) includes proxy injection as a suggestion, not a demonstrated configuration. | Separate site is a clean architectural boundary. **I did not find a verified, maintained recipe for replacing only anonymous `/` while leaving signed-in `/` untouched.** Serving a static root unconditionally would also replace the app's root for signed-in users. Same-origin interception needs explicit routing/session/cache design, OAuth callback preservation and deep-link tests. BayLeaf currently has no user-controlled proxy on Chat's ingress. | Existing `bayleaf.dev` is an easy boundary for its own arrivals, but misses direct Chat arrivals. A separate Chat public page would give strong code separation but adds a surface and infrastructure. Cookie presence alone is not valid session verification; anonymous responses must not leak through shared caches. |
| Frontend fork/build | Oreegami sign-in/signup/admin-onboarding redesign, **2026-08-03**, [PR #28057](https://github.com/open-webui/open-webui/pull/28057), with screenshot and source changes; closed unmerged, branding bot says organizational branding changes belong in a fork subject to license. [#23270](https://github.com/open-webui/open-webui/pull/23270) also reports a working branded private fork. | Concrete examples, not upstream features or independently verified compliance/deployments. Can change auth-page markup precisely, but adds Svelte build/rebase/security-update maintenance. A compiled-asset string patch is an especially brittle alternative. | Can put a hook directly after resolved anonymous auth state, but a fork is disproportionate for one event. |

### Important configuration limits

- **`WEBUI_NAME` is not public-only.** In v0.12.3,
  [env.py](https://github.com/open-webui/open-webui/blob/v0.12.3/backend/open_webui/env.py)
  appends ` (Open WebUI)` to a non-default name.
- **`CUSTOM_NAME` is legacy, not an arbitrary local theme name:**
  [config.py](https://github.com/open-webui/open-webui/blob/v0.12.3/backend/open_webui/config.py)
  resolves it against `api.openwebui.com/api/v1/custom/{name}` for supplied branding.
  It is not a general local public-page extension mechanism.
- **`login_footer` and `auth_logo_position` are real but license-metadata-backed:**
  [main.py `/api/config`](https://github.com/open-webui/open-webui/blob/v0.12.3/backend/open_webui/main.py)
  puts them in public metadata only when `LICENSE_METADATA` exists. The auth
  footer renders sanitized Markdown using DOMPurify. Do not propose an invented
  `LOGIN_FOOTER` env setting or script injection through this sanitized field.
- **Startup copying matters:** v0.12.3 `config.py` clears top-level files in
  `STATIC_DIR` then repopulates from the frontend static source directory. Merely
  writing the served destination *before* Python imports config can be undone.
  Sliplane's build-source copy illustrates the correct distinction. Exact image
  paths/order need qualification before any BayLeaf rung-3 startup wrapper.
- **Supported seam is not a full supported plugin asset API:** official
  [plugin-loader documentation](https://docs.openwebui.com/features/extensibility/plugin/development/under-the-hood/)
  distinguishes serving a plugin's own route from injecting into the actual SPA,
  and explicitly calls the latter indirect/fragile without a dedicated primitive.
  Ordinary filter/tool hooks do not run on every anonymous page view.

## Upstream direction: what is and is not promised

- **2026-07-14:** [issue #27068](https://github.com/open-webui/open-webui/issues/27068)
  requested Admin Interface CSS/JS textareas. Maintainer Classic298 closed it:
  “already possible by adding it to the static folder, wont be added to the admin
  panel.” This is stronger evidence than old tutorials claiming no customization.
- **2026-06-07–25:** [PR #25807](https://github.com/open-webui/open-webui/pull/25807)
  proposed an admin Extension type with lifecycle and aggregated JS/CSS injection.
  It was **closed without merging**. Event Functions now cover lifecycle work,
  but this PR is not proof a supported `assets()` API shipped.
- **2026-10-14:** [PR #32413](https://github.com/open-webui/open-webui/pull/32413)
  proposed external consent/landing page → `/guest` trial sessions. It was
  **closed unmerged**, and its test plan is unchecked. Not a v0.12.3 guest mode or
  credible commitment to future public landing support.
- The [published roadmap](https://docs.openwebui.com/roadmap/), read 2026-10-20,
  does **not** promise a public landing-page builder or dedicated anonymous asset
  hook. Enterprise [customization](https://docs.openwebui.com/enterprise/customization/)
  advertises white-labeling/theming, not an open-release public-page editor.

## Licensing/branding: verify, do not copy old advice

The [v0.12.3 LICENSE](https://github.com/open-webui/open-webui/blob/v0.12.3/LICENSE)
allows modification but prohibits altering/removing/obscuring/replacing Open
WebUI branding except: **≤50 natural-person end users with direct access in any
rolling 30-day period**, specific prior written permission, or an executed
enterprise license permitting it. Academic/nonprofit status alone is not an
exception. We did not establish BayLeaf's count or permission status.

The current [upstream interpretation](https://docs.openwebui.com/license/)
specifically disallows equal-prominence co-branding and moving/shrinking/recoloring
the original brand, while allowing subordinate “Managed by…” notices and analytics
that leave branding untouched. It offers a **requested, time-limited research
exemption**, not general university white-label permission. This interpretation
is stricter/more detailed than the license text; distinguish the binding pinned
license from the explanatory web page, and obtain written clarification for
ambiguous designs. A “Powered by” footer is not presented as a substitute for
removing original branding. No compliance judgment about existing BayLeaf is made.

## Recommended BayLeaf ladder (proposal, not implementation approval)

1. **Existing configuration first:** retain native SSO and upstream attribution.
   For basic explanation/link additions, determine whether authorized license
   metadata already supplies a footer, or keep explanation on `bayleaf.dev`.
2. **Public visual changes:** small `#auth-page`-scoped CSS through the upstream
   static seam; do not recolor/replace brand identifiers. Test both themes,
   mobile/reflow, keyboard order and sign-in/MFA/error/logout variants.
3. **Arrival event only:** evaluate a very small first-party loader addition,
   delivered through the existing rung-3 harness if robustly reproducible, or a
   thin rung-4 derived image if assets/order exceed that rung. It must preserve
   any existing loader content rather than claim sole ownership. A small Event
   Function could serve/compose assets, but that is not automatically less risky:
   dynamic route precedence, boot timing, rollback and persistence need tests.
4. **Richer public content:** prefer the existing public landing site. A separate
   Chat landing route/proxy requires a new architecture decision, not a covert
   telemetry change. No extra proxy merely to avoid a tiny local asset addition.
5. **Full redesigned auth experience:** only then consider a maintained frontend
   patch/fork or enterprise work, with explicit branding rights and an upgrade
   acceptance checklist. Avoid editing generated hashed bundles.

### Privacy acceptance criteria for any later arrival proof of concept

These are design requirements, not a finding that an existing snippet satisfies them:

- Global asset delivery must remain inert outside the confirmed public sign-in
  state. Do not download/run collection code in chat merely because a script can
  later decide not to send. `/auth` path alone is insufficient during SSO return,
  existing-session redirects, MFA and logout. Define whether those count first.
- Observe stable UI arrival, including SPA `/` → `/auth` navigation, without
  counting every DOM mutation or asset request as another arrival. Do not add a
  persistent dedup identifier: the existing browser policy expressly has none.
- No full URL, query string (`redirect`, errors and OAuth state can be sensitive),
  referrer, account/session token, DOM text, message content, IP/UA, identity,
  stable pseudonym or client timestamp in observations. Do not read auth tokens
  for analytics; if minimal session gating needs to inspect state, keep it local
  and distinct from telemetry construction and transport.
- A first-party collector is not automatically privacy-preserving: validate the
  approved schema, credential handling, request headers/referrer policy,
  infrastructure logging, enable switch and retention. Do not re-enable the
  currently configured browser collector as a side effect of customization.
- Disable/uninstall and upgrade must restore stock behavior without stale
  routes, duplicate injection or unremoved observers. Community-plugin popularity
  is not a security review.

**Evidence limits:** primary v0.12.3 source and live public documents were inspected;
GitHub API verified PR merged/unmerged status and dated comments. No candidate
was installed, no browser experiment was performed, and no external admin's live
deployment was independently audited. Community README compatibility claims are
not BayLeaf production qualification. Search did not establish a widely used
anonymous-only reverse-proxy recipe or a committed upstream landing-page roadmap.
