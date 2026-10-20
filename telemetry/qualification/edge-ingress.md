# Native-client edge ingress qualification

Qualified 2026-10-20, approximately 19:34–19:35 UTC, under explicit authorization
for a telemetry-host-only Cloudflare configuration change. Tracks issue #112.

## Finding and narrowly scoped change

Before the change, stock Python `urllib.request` GET to
`https://telemetry.bayleaf.dev/v1/read/status?from=1792520000000&to=1792520001000&limit=1`
returned HTTP 403, `text/plain`, body `error code: 1010`, with
`Server-Timing: cfEdge;dur=16,cfOrigin;dur=0`. Curl returned the receiver's
HTTP 401 JSON `{"error":"unauthorized"}`. The zone's `browser_check` was `on`.
The successful targeted exception confirms Browser Integrity Check caused this
native-client block, rather than receiver authentication or payload validation.

Identity and scope were verified with `cf auth whoami --profile ucsc` and
`cf zones list --profile ucsc`:

- Account: BayLeaf, `1a49fb69291d42e23c4ed4dcffce5bbc`.
- Active zone: `bayleaf.dev`, `2cdc9d687b938704965a00188f8877ad`.
- No `CLOUDFLARE_API_TOKEN` environment override was set.
- All operations used supported `cf` commands and explicit profile/zone selection.
  No private OAuth API fallback was needed.

The inspected zone ruleset inventory contained no `http_config_settings` entry.
Created one zone entrypoint, `Telemetry API configuration`:

- Ruleset ID: `dc779bb975754a9da5c9757e9d256dc6`, version 1.
- Phase: `http_config_settings`.
- Rule ID: `90482dd1dcaf414e942113893c1bfa04`, version 1.
- Created: `2026-10-20T19:34:27.639668Z`.

Exact sole rule:

```json
{
  "ref": "telemetry_native_clients_bic",
  "description": "Allow native telemetry API clients without Browser Integrity Check; telemetry host only",
  "expression": "http.host eq \"telemetry.bayleaf.dev\"",
  "action": "set_config",
  "action_parameters": { "bic": false },
  "enabled": true
}
```

Cloudflare's configuration-rule API calls this setting `bic`, not
`browser_check`. The latter is the zone-default setting name. See
<https://developers.cloudflare.com/rules/configuration-rules/create-api/>.

## Verification

Stock/default user agents were used, without browser impersonation or credentials.
For each of Python `urllib.request`, Python `requests`, Python `httpx`, and curl:

| Request | Result | JSON body |
| --- | --- | --- |
| GET read/status with the query above | 401 | `{"error":"unauthorized"}` |
| POST `/v1/metrics`, body `{}`, no authorization | 401 | `{"error":"unauthorized"}` |
| POST `/v1/metrics?invalid=1`, body `{}`, no authorization | 400 | `{"error":"invalid_request"}` |

All twelve responses had `Content-Type: application/json`. Requests reached the
receiver without the former edge 1010 rejection. The invalid-query check runs
before admission/budget/storage work; unauthenticated metrics requests fail
before admission. No synthetic observations were ingested and no credentials
were read or transmitted. No authenticated read was necessary. Unsupported-media
415 was not tested: the metrics authentication gate correctly returns 401 first.

After creation, `cf rulesets account-rulesets get` verified the exact sole rule
above. A fresh ruleset inventory was compared programmatically against the
pre-change inventory: all four pre-existing entries were identical, including
their versions and last-updated fields:

- `70339d97bdb34195bbf054b1ebe81f76`: normalization, managed.
- `77454fe2d30c4220b5701f6fdfb893ba`: managed free ruleset.
- `4d21379b4f9f4bb088e0729962c8b3cf`: L7 DDoS, managed.
- `023bd4fe1ab644718d9195a5661a70c3`: existing dynamic redirect entrypoint.

The only added entry was the configuration ruleset above. A fresh zone setting
read still returned `browser_check: on`, `modified_on: null`. The exception
matches only the exact telemetry hostname, not other subdomains or the apex.
No WAF/DDoS bypass, zone-default edit, billing/plan change, Worker deployment,
or exporter/source modification was performed.

## Rollback

Inspect the current ruleset before rolling back. If it still contains only this
rule, delete this newly created configuration entrypoint:

```sh
cf rulesets account-rulesets delete dc779bb975754a9da5c9757e9d256dc6 \
  --zone 2cdc9d687b938704965a00188f8877ad --profile ucsc
```

If additional rules have since been added, remove only rule
`90482dd1dcaf414e942113893c1bfa04`, preserving all others. Do not replace the
ruleset from this historical snapshot. Verify the zone default remains on and
repeat the native-client check. Rollback restores inherited Browser Integrity
Check for telemetry, including the observed Python 1010 failure.

## Telemetry-only Cloudflare Web Analytics exclusion (2026-10-20)

Qualified at 21:25 UTC under explicit authorization to remove the Cloudflare
beacon from this hostname only, without weakening CSP or changing other hosts.
Before the change, both `/` and `/docs` returned HTTP 200 HTML containing an
automatically injected `static.cloudflareinsights.com/beacon.min.js` script with
`data-cf-beacon`. Its public site token matched the BayLeaf account's
`bayleaf.dev` Cloudflare Web Analytics site, identifying the injecting product:

- Web Analytics site: `22465db8e69e41d6b34406f24a2004c2`, `auto_install: true`.
- RUM ruleset: `701c031d-9f75-4dd2-a2dc-e62094435157`, enabled, `lite: true`.
- Existing sole RUM rule: `1cfdffe4-ae6d-4e01-845c-60e73f1550da`, host `*`,
  paths `["*"]`, inclusive, not paused, priority 1000.

`cf auth whoami --profile ucsc` confirmed the BayLeaf account above. Neither
`CLOUDFLARE_API_TOKEN` nor `CLOUDFLARE_ACCOUNT_ID` was set in the environment.
Account-scoped calls explicitly selected account
`1a49fb69291d42e23c4ed4dcffce5bbc`. No credential contents were printed.

An attempted exact-host exclusion using `cf rum rules create` returned HTTP 409,
`[10012] web_analytics.configuration.api.maxRulesError`. A fresh read confirmed
the RUM rules remained unchanged. No plan/subscription change was made.
Cloudflare's documented Configuration Rules setting `disable_rum` provides the
same narrowly scoped outcome and takes precedence over Web Analytics rules:
<https://developers.cloudflare.com/rules/configuration-rules/settings/>.

Added one separate rule to the existing `http_config_settings` entrypoint,
preserving the original BIC rule verbatim:

```sh
cf rulesets account-rulesets rules create dc779bb975754a9da5c9757e9d256dc6 \
  --zone 2cdc9d687b938704965a00188f8877ad --profile ucsc \
  --body '{"ref":"telemetry_disable_rum","description":"Disable Cloudflare Web Analytics beacon injection on telemetry host only","expression":"http.host eq \"telemetry.bayleaf.dev\"","action":"set_config","action_parameters":{"disable_rum":true},"enabled":true}'
```

- New rule ID: `b527c4da3c7a4fb6a5c1f62eedc60387`, version 1.
- Created: `2026-10-20T21:24:49.544696Z`.
- Configuration ruleset advanced from version 1 to version 2.
- Original BIC rule `90482dd1dcaf414e942113893c1bfa04` remained byte-for-byte
  equal as parsed JSON, including version 1 and its original update timestamp.
- All five account Web Analytics site configurations and the full `bayleaf.dev`
  RUM rules response compared equal before and after. The wildcard inclusion and
  auto-install remain enabled for other hosts. The new expression matches only
  `telemetry.bayleaf.dev`; it changes no WAF, DDoS, zone-default or billing settings.

Actual returned HTML was checked after the change with both stock Python
`urllib.request` and `User-Agent: Mozilla/5.0`. All four GETs (`/` and `/docs`)
returned HTTP 200 `text/html; charset=utf-8`, with neither
`static.cloudflareinsights.com` nor `data-cf-beacon` anywhere in the response.
Representative CF-Ray IDs: root `a4db17c9ae46ed3f-SJC`, docs
`a4db17cb4f1c6cd4-SJC`. Root retained `default-src 'none'` without a script
allowance; docs retained its pinned Scalar script allowance, with no Cloudflare
beacon allowance. A concurrent, separately owned Scalar source-map correction
was visible in the docs CSP; this operation made no CSP or runtime source edits.
The stock Python private-read check from the earlier qualification still returned
HTTP 401 JSON `{"error":"unauthorized"}`, confirming the native-client BIC
exception continued to work. No authenticated reads or writes were performed.

### RUM exclusion rollback

Inspect the current configuration entrypoint first, then delete **only** rule
`b527c4da3c7a4fb6a5c1f62eedc60387`:

```sh
cf rulesets account-rulesets rules delete b527c4da3c7a4fb6a5c1f62eedc60387 \
  --ruleset-id dc779bb975754a9da5c9757e9d256dc6 \
  --zone 2cdc9d687b938704965a00188f8877ad --profile ucsc
```

Do not delete the entrypoint or the original BIC exception. The earlier BIC
rollback's sole-rule precondition no longer holds. Removing this RUM rule restores
inherited Web Analytics injection on telemetry, including its CSP conflict;
repeat root/docs HTML checks and the native-client authentication check.
