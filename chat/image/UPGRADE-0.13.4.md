# Open WebUI v0.13.4 qualification

Prepared and deployed 2026-11-20 after the operator's personal-instance soak.

- [Upstream release](https://github.com/open-webui/open-webui/releases/tag/v0.13.4):
  commit `0666e59d26a4d056e0bacee41742486badd71cf8`, standard image index
  `sha256:d5168bfbc28609eff5bea1b438dd864cf64d185cf6582c02244865e18385b901`.
  The Alembic migration file names and Git blob SHAs are identical to v0.13.3.
  The DigitalOcean managed PostgreSQL backup dated 2026-11-20 01:53 UTC was
  verified and the live app spec captured privately.
- v0.13.4 replaces Direct Connections with Tether. A renewable human session
  can pair a desktop bridge and register user-only models. Endpoint addresses
  and keys stay on the desktop; model requests still pass through Open WebUI
  to the registered endpoint. `ENABLE_TOOL_SERVERS` does not gate those model
  requests. At the operator's direction, the candidate keeps upstream Tether
  opt-in. BayLeaf's managed model routing remains unchanged; personal endpoints
  are not covered by the managed inference ZDR promise. No new shared terminal,
  tool, model, or provider was configured.
- The seven upstream references match the release exactly. The native telemetry
  sources and six guarded runtime package pins are unchanged. Browser asset
  guards were refreshed against the new image; the stock loader is still empty.
  With the opt-in candidate, both architecture builds, amd64 boot and
  synthetic inference, and arm64 five-minute PostgreSQL/TLS export passed.
  Chromium arrival checks passed with the source enabled and disabled, and
  both fixtures reported `features.tether: true`. This does not test desktop
  pairing or personal-model inference. No production requests were used.
- The first private pre-upgrade pull returned 401. With a refreshed admin
  credential, the private backup captured all four resource classes, the hidden
  Basic base model, tool/function admin valves, and admin/global configuration.
  The snapshot confirmed Direct Connections was enabled and the shared tool
  and terminal connection lists were empty.
- DigitalOcean deployment `9532730e-2d52-49ea-88fc-c6464624b29d`
  reached ACTIVE. The running image matched the checkout fingerprint;
  the startup guard and server PID 1, health, version, Tether discovery,
  and authenticated Basic and Help API checks passed. Desktop pairing
  and human browser acceptance remain unverified.
- The post-upgrade pull found models, tools, functions, skills, hidden base,
  and admin valves unchanged. The app spec changed only the Open WebUI image
  reference from digest to fingerprint-named tag. Six global config defaults
  appeared; no existing global or admin values changed.
