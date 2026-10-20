"""Hash-locked v0.12.3 boot patch. Never start OWUI after a failed check."""
import hashlib
from importlib.metadata import version
import json
import os
from pathlib import Path
import sys

from source_policy import minimized_setup_source, minimized_source
from browser_assets import install as install_browser_assets

HERE = Path(__file__).resolve().parent


def validate_versions():
    for name, pinned in {
        "opentelemetry-api": "1.42.1", "opentelemetry-sdk": "1.42.1",
        "opentelemetry-exporter-otlp-proto-http": "1.42.1",
        "SQLAlchemy": "2.0.50", "fastapi": "0.136.3",
        "psycopg2-binary": "2.9.12",
    }.items():
        if version(name) != pinned:
            raise ValueError("installed_dependency_version_mismatch")


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise ValueError("unsupported_tagged_source")
    return source.replace(old, new)


def patched_sources():
    metrics = minimized_source((HERE / "upstream/metrics.py").read_text())
    metrics = replace_once(metrics, "from fastapi import FastAPI, Request", "from fastapi import FastAPI, Request\nfrom .bayleaf_runtime import bounded_engine, gauge_value, quiet_exporter_logs, WindowedHttpMetricExporter, MinimizedMetricsMiddleware")
    metrics = replace_once(metrics, "OTLPHttpMetricExporter(endpoint=OTEL_METRICS_EXPORTER_OTLP_ENDPOINT, headers=headers)", "WindowedHttpMetricExporter(endpoint=OTEL_METRICS_EXPORTER_OTLP_ENDPOINT, headers=headers)")
    metrics = replace_once(metrics, "    metrics.set_meter_provider(_build_meter_provider(resource))", "    quiet_exporter_logs()\n    db_engine = bounded_engine(db_engine)\n    metrics.set_meter_provider(_build_meter_provider(resource))")
    # Native debug exceptions can contain SQL, parameters or connection details.
    for message in ("total users", "active users", "users active today"):
        metrics = replace_once(metrics, f"logger.debug('Failed to observe {message}', exc_info=True)", "pass  # Failed observations are absent, never zero or raw diagnostics.")
    for helper in ("_count_total_users", "_count_active_users", "_count_users_active_today"):
        metrics = replace_once(metrics, f"value = {helper}(db_engine)", f"value = gauge_value({helper}, db_engine)")
    marker = "    # FastAPI middleware\n"
    if metrics.count(marker) != 1:
        raise ValueError("unsupported_tagged_source")
    metrics = metrics.split(marker)[0] + "    app.add_middleware(MinimizedMetricsMiddleware, counter=request_counter, histogram=duration_histogram)\n"
    setup = minimized_setup_source((HERE / "upstream/setup.py").read_text())
    return {"metrics.py": metrics.encode(), "setup.py": setup.encode()}


def patch(backend):
    manifest = json.loads((HERE / "upstream/SOURCE.json").read_text())["files"]
    for name, digest in manifest.items():
        if hashlib.sha256((HERE / "upstream" / name).read_bytes()).hexdigest() != digest:
            raise ValueError("reference_hash_mismatch")
    destination = backend / "open_webui/utils/telemetry"
    outputs = patched_sources()
    checks = {destination / name: manifest[name] for name in ("metrics.py", "setup.py", "instrumentors.py")}
    checks[backend / "open_webui/env.py"] = manifest["env.py"]
    checks[backend / "requirements.txt"] = manifest["requirements.txt"]
    for path, digest in checks.items():
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != digest and data != outputs.get(path.name):
            raise ValueError("installed_source_hash_mismatch")
    outputs["bayleaf_source_policy.py"] = (HERE / "source_policy.py").read_bytes()
    outputs["bayleaf_runtime.py"] = (HERE / "runtime.py").read_bytes()
    for name, data in outputs.items():
        path = destination / name
        if name.startswith("bayleaf_") and path.exists() and path.read_bytes() != data:
            raise ValueError("installed_adapter_mismatch")
        compile(data, str(path), "exec")
    # Validate everything before writing. Each file replacement is atomic.
    for name, data in outputs.items():
        path = destination / name
        if path.exists() and path.read_bytes() == data:
            continue
        temporary = path.with_suffix(".bayleaf-tmp")
        temporary.write_bytes(data)
        temporary.replace(path)


def validate_environment():
    # An explicit source kill switch keeps Chat bootable without an image swap.
    # All four flags must be false; partial/ambiguous disablement is refused.
    if all(os.environ.get(k) == "false" for k in ("ENABLE_OTEL", "ENABLE_OTEL_METRICS", "ENABLE_OTEL_TRACES", "ENABLE_OTEL_LOGS")):
        return
    required = {
        "ENABLE_OTEL": "true", "ENABLE_OTEL_METRICS": "true",
        "ENABLE_OTEL_TRACES": "false", "ENABLE_OTEL_LOGS": "false",
        "OTEL_METRICS_OTLP_SPAN_EXPORTER": "http",
        "OTEL_EXPORTER_OTLP_METRICS_TIMEOUT": "2",
        "OTEL_METRIC_EXPORT_TIMEOUT": "3000",
        "OTEL_EXPORTER_OTLP_METRICS_COMPRESSION": "none",
        "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE": "CUMULATIVE",
        "OTEL_METRICS_EXPORTER_OTLP_ENDPOINT": "https://telemetry.bayleaf.dev/v1/otlp/metrics",
        "OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED": "false",
        "OTEL_TRACES_EXPORTER": "none", "OTEL_LOGS_EXPORTER": "none",
        "OTEL_METRICS_EXEMPLAR_FILTER": "always_off",
    }
    if any(os.environ.get(k) != v for k, v in required.items()):
        raise ValueError("unsafe_exporter_configuration")
    if os.environ.get("OTEL_METRICS_EXPORT_INTERVAL_MILLIS") not in ("60000", "300000"):
        raise ValueError("unsafe_exporter_configuration")
    if any(os.environ.get(k) for k in ("OTEL_BASIC_AUTH_USERNAME", "OTEL_BASIC_AUTH_PASSWORD", "OTEL_METRICS_BASIC_AUTH_USERNAME", "OTEL_METRICS_BASIC_AUTH_PASSWORD", "OTEL_EXPORTER_OTLP_HEADERS", "OTEL_RESOURCE_ATTRIBUTES", "OTEL_PYTHON_AUTO_INSTRUMENTATION_AGENT_PATH")):
        raise ValueError("unsafe_exporter_configuration")
    header = os.environ.get("OTEL_EXPORTER_OTLP_METRICS_HEADERS", "")
    token = header.removeprefix("Authorization=Bearer ")
    if token == header or len(token) < 32 or not all(c.isascii() and (c.isalnum() or c in "-._~") for c in token):
        raise ValueError("unsafe_exporter_configuration")


def main():
    print("[bayleaf] rung-3 harness alive (extend this run_command for boot logic; ends with exec bash start.sh)", flush=True)
    try:
        validate_versions()
        validate_environment()
        patch(Path("/app/backend"))
        install_browser_assets()
    except Exception:
        print("[bayleaf] OTLP startup refused: source/configuration check failed", file=sys.stderr, flush=True)
        return 1
    print("[bayleaf] v0.12.3 metrics source minimization verified", flush=True)
    os.chdir("/app/backend")
    os.execvp("bash", ["bash", "start.sh"])


if __name__ == "__main__":
    sys.exit(main())
