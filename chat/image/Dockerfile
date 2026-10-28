# Build from repository root. Pin a resolved image digest at release time using
# --build-arg OWUI_IMAGE=ghcr.io/open-webui/open-webui:v0.12.4@sha256:...
# Source checks below are mandatory even with an immutable image digest.
ARG OWUI_IMAGE=ghcr.io/open-webui/open-webui:v0.12.4@sha256:a5b9e403d19154796850679c8c5d1295301cee954be8b84ddd62af92426558f7
FROM ${OWUI_IMAGE}
COPY chat/image/startup_patch.py chat/image/source_policy.py chat/image/runtime.py /opt/bayleaf-otlp/
COPY chat/image/upstream/ /opt/bayleaf-otlp/upstream/
COPY chat/image/browser_assets.py /opt/bayleaf-otlp/
COPY telemetry/browser/chat-gate.js telemetry/browser/chat-client.mjs /opt/bayleaf-otlp/browser/
RUN python -c 'import sys; from pathlib import Path; sys.path.insert(0,"/opt/bayleaf-otlp"); from startup_patch import patch, validate_versions; validate_versions(); patch(Path("/app/backend"))'
RUN python -c 'import sys; sys.path.insert(0,"/opt/bayleaf-otlp"); from browser_assets import install; install()'
# DO run_command overrides CMD: update it to this same single-line command.
# The Python entrypoint checks the guarded image and execs start.sh.
CMD ["python", "/opt/bayleaf-otlp/startup_patch.py"]
