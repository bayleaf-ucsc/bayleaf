# Run evidence: retire-managed-app

Dated record of past runs of [`retire-managed-app.md`](../playbooks/retire-managed-app.md), newest first.
Consult for diagnosis; current procedure lives in the linked file.

- 2026-11-28: Retired hosted OpenChamber (OpenCode Web replaces it). Playbook
  derived from this run and the earlier Nanobot/CollabMD retirement (commit
  `90c135b`). Deployed plugin `d4f8ae0`, API `74b94721` then `9d1e0ef5` then
  `dd231334`, Sandboxes `d3711627`; repo `e2eafc7`. Surprises: the app was the
  controller's implicit default (unnamed DO key, argparse default, service-less
  public routes); the sandbox CLI read its credential root first; a gateway
  framing exception keyed on its slot. Concurrent sessions caused two API
  redeploys and a late migration (0024 for #173); see `maintain-sandbox.md`
  evidence. Adam verified a signed-in OpenCode Web launch on the new pin.
