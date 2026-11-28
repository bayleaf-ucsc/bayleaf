# Run evidence: qualify-preview-gateway

Dated record of past runs of [`qualify-preview-gateway.md`](../playbooks/qualify-preview-gateway.md), newest first unless noted.
Consult for diagnosis; current procedure lives in the linked file.

- 2026-10-27 (bayleaf#118, Lathe #111/#112): header passthrough and app error
  bodies. Harness 39/39 and sandbox-browser 33/33; deployed
  `30d5e815-9621-48ad-906b-a5d9e73fede7`; live script 25/25. Found Daytona's
  appended `X-Forwarded-Host` and the trust header's inertness on signed URLs.
  First run of this playbook (written from that session); expect deviations.
- 2026-10-27 (open-question pass): Go 1.25+ `http.CrossOriginProtection`
  rejected same-origin POSTs behind BayLeaf (no `Sec-Fetch-Site`, `Host` is
  localhost). Forwarded `Sec-Fetch-*` as browser basics and added
  `X-Daytona-Disable-CORS`; deployed `066869e8-0779-4673-9b25-55bd2c4fff02`;
  Go check 200 and contract script 25/25. Daytona source audit used the
  archived repo; see Daytona references.

- 2026-11-27 (bayleaf#172): A local Worker with the real Daytona v2 preview
  initially corrupted the noVNC greeting while direct Daytona returned RFB.
  Selecting `arraybuffer` on both relay sockets restored private noVNC HTTP,
  binary RFB, non-owner denial, and link reuse after pause/resume. Disposable
  resources removed. The shared gateway was not changed.

## Moved from the body

Original wording, verbatim, as it stood in the procedure.

Step 1 check count (since outgrown):

```text
`cd api && npm run test:previews` (39 checks) and
```

Step 7:

```text
7. **Record.** Evidence and version ID in `api/PREVIEWS.md`; conformance
   changes in the Lathe contract §12; a line in the log below.
```
