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
