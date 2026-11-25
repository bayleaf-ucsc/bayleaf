# Open WebUI v0.13.5 qualification

Prepared and deployed 2026-11-25. The release was about ten hours old at
deployment: the operator had used it on a personal instance, but chose to
proceed without the usual full-day soak.

- [Upstream release](https://github.com/open-webui/open-webui/releases/tag/v0.13.5):
  commit `926f826eaef6179c092a936eede6c7363e425975`, standard image index
  `sha256:e0dc5a8bf5c71cadf339d1e7b9408b357da75fb2854f82cad57a1609fadf2a22`.
  It includes security fixes whose advisories are not yet published.
- Four migrations follow `9f6c2a8d1b43`, ending at `5e7a2c9d4b13`. The last one
  moves every conversation out of `chat.chat` into `chat_message` rows.
  **Image-only rollback does not work:** in rehearsal, the v0.13.4 image refused
  to boot on the migrated database (`Can't locate revision`). Undoing the upgrade
  means restoring a database backup and losing later writes.
- A `pg_dump` was taken immediately before deployment (296 chats, 54 tables) over
  a verified TLS connection. Laptop access to the database firewall was added for
  the dump and removed afterward. It was not test-restored, and was
  deleted with the operator's approval after acceptance.
- The telemetry sources and six guarded runtime pins are unchanged. `env.py`,
  `requirements.txt` and `pyproject.toml` changed and were re-pinned, and browser
  asset guards were refreshed. The stock loader is still empty.
- Qualification: both architecture builds, startup/export checks, arm64
  five-minute PostgreSQL/TLS export, amd64 boot and synthetic inference, and all
  16 Chromium arrival cases passed. A synthetic v0.13.4 database with 250
  branching chats upgraded with no mismatches and unchanged `updated_at`. The
  retention script, run dry against it, flagged only the true orphan file, and
  chat deletion removed its message rows.
- Upstream moved `search_users` (name and email lookup across all accounts) from
  the disabled `chats` builtin category to a new `users` category that defaults
  on. Builtin categories are not merged per key with the global defaults, so
  `users: false` was written before deployment to the global defaults and to the
  two models with their own lists (Basic Canary and Brace3).
- At the operator's direction, model-driven authoring is blocked. `tools: false`
  in the same three places removes `create_tool`. `create_skill` shares its switch
  with `view_skill`, so the global `authoring_block_filter` removes it instead.
  Default permissions and all 16 groups already denied both to non-admins. The
  filter was proved in a synthetic v0.13.5 admin chat (35 tools to 33, `view_skill`
  kept); the production admin case was not exercised. `update_skill_files` is not
  blocked.
- DigitalOcean deployment `5830cd44-3739-4feb-8f63-9ea4ffb5323d` reached ACTIVE.
  The running image matches the checkout fingerprint; guards, server PID 1,
  health, version and authenticated Basic and Help checks passed, with and
  without the filter. All 296 chats converted, and no chat was updated between
  the start of deployment and the check, although the old instance kept serving
  until cutover. File references were 260 before and after.
- The app spec changed only the image tag. New config defaults include automation
  webhooks (inert: automations are off), an unset tool-output limit and router
  models. Terminal and arena settings were renamed or replaced upstream.
- Afterward the operator turned on skill lazy loading. Before that, Open WebUI
  preloaded every attached skill body and recorded the calls as the model's own
  hidden tool calls. The operator confirmed that a greeting loads no skill and a
  Canvas question loads `canvas-api`. The `terminal` default capability was turned
  on deliberately. The hidden `video_generation` default was filled in as true;
  site-wide video generation is off.
- Startup logged one socket-session `KeyError` and one failed OAuth token refresh.
  Neither was traced. File upload, Code Sandbox, branching chats and fresh sign-in
  were not reported as tested.
