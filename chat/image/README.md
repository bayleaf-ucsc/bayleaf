# BayLeaf Chat image

The production image for BayLeaf Chat: the pinned upstream Open WebUI standard
image plus BayLeaf's hash-guarded startup patch. DigitalOcean App Platform builds
`chat/image/Dockerfile` with the repository root as context (see `../AGENTS.md`
and `../DESIGN.md` §1). Moved here from `telemetry/otlp/`, where native metrics
first required a BayLeaf-built image (#112).

| File | Role |
|---|---|
| `Dockerfile` | Immutable upstream base digest; copies the files below and patches at build |
| `startup_patch.py` | Container entrypoint: version, environment and source-hash guards, then execs OWUI. Never starts OWUI after a failed check |
| `source_policy.py`, `runtime.py` | Telemetry source minimization and exporter runtime installed into OWUI |
| `browser_assets.py` | Installs the optional Chat browser-arrival gate from `telemetry/browser/` |
| `upstream/` | Exact, SHA-256-pinned copies of the OWUI release files the patch edits (`SOURCE.json`) |

`upstream/requirements.txt` and `upstream/pyproject.toml` are OWUI's own
dependency pins, so GitHub reports their advisories as Dependabot alerts. They
describe what Chat runs, but they change only with an OWUI release (or a
deliberate BayLeaf override in this Dockerfile). Triage them per OWUI upgrade.

Local checks (qualification harnesses stay with the collector in `telemetry/otlp/`):

Set `BAYLEAF_QUALIFICATION_OUTPUT` to an existing private temporary directory
when requalifying a new release, so generated proofs do not overwrite historical
evidence. See [v0.12.4 qualification](UPGRADE-0.12.4.md).

```bash
python3 -m unittest discover -s chat/image -p 'test_browser_assets.py'
uv run --python 3.12 --locked --script telemetry/otlp/qualify_startup.py
docker build -f chat/image/Dockerfile -t bayleaf-chat:local .
```
