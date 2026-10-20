# Build from repository root. Pin a resolved image digest at release time using
# --build-arg OWUI_IMAGE=ghcr.io/open-webui/open-webui:v0.12.3@sha256:...
# Source checks below are mandatory even with an immutable image digest.
ARG OWUI_IMAGE=ghcr.io/open-webui/open-webui:v0.12.3@sha256:a537bbe1e6b428820f52ed4a029d7fff97062e24d5cf32c365fba36fd0542def
FROM ${OWUI_IMAGE}
COPY telemetry/otlp/startup_patch.py telemetry/otlp/source_policy.py telemetry/otlp/runtime.py /opt/bayleaf-otlp/
COPY telemetry/otlp/upstream/ /opt/bayleaf-otlp/upstream/
RUN python -c 'import sys; from pathlib import Path; sys.path.insert(0,"/opt/bayleaf-otlp"); from startup_patch import patch, validate_versions; validate_versions(); patch(Path("/app/backend"))'
# DO run_command overrides CMD: update it to this same single-line command.
# The Python entrypoint preserves the existing rung-3 sentinel and execs start.sh.
CMD ["python", "/opt/bayleaf-otlp/startup_patch.py"]
