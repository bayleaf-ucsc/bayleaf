# bayleaf-lti container image.
#
# Single-stage uv-based build. The image bundles only the connector itself;
# secrets (LTI_1P1_SHARED_SECRET, LTI_PRIVATE_KEY_PEM, LTI_PUBLIC_KEY_PEM,
# CANVAS_*, etc.) are injected as runtime env vars by DO App Platform, not
# baked into the image. This is intentional: the image is published publicly
# to ghcr.io/bayleaf-ucsc/lti.
#
# Build:    docker build -t ghcr.io/bayleaf-ucsc/lti:latest -f lti/Dockerfile lti
# Run:      docker run --rm -p 8765:8765 -e PORT=8765 ghcr.io/bayleaf-ucsc/lti:latest

FROM python:3.12-slim

# uv binary, copied straight from the upstream distroless image. Avoids
# pip-installing uv into our runtime, and keeps the image deterministic.
COPY --from=ghcr.io/astral-sh/uv:0.5.13 /uv /uvx /usr/local/bin/

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv

WORKDIR /app

# Install dependencies first (own layer, cached unless lockfile changes).
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Now copy the project itself and install it editable into the same env.
COPY src/ ./src/
RUN uv sync --frozen --no-dev

ENV PATH="/opt/venv/bin:${PATH}" \
    PORT=8080

EXPOSE 8080

# DO App Platform terminates TLS at its frontend and forwards plain HTTP
# to the container with X-Forwarded-Proto / X-Forwarded-Host headers. We
# trust them so request.url reflects the public https://lti.bayleaf.dev URL
# Canvas signed against (and clients see the right scheme in redirects).
# `--forwarded-allow-ips="*"` is safe here because the only network reaching
# us is DO's frontend; we are not directly internet-facing.
CMD ["sh", "-c", "uvicorn connector.main:app --host 0.0.0.0 --port ${PORT} --app-dir src --proxy-headers --forwarded-allow-ips=\"*\""]
