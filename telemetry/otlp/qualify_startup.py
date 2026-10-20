# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = [
#   "opentelemetry-api==1.42.1",
#   "opentelemetry-sdk==1.42.1",
#   "opentelemetry-exporter-otlp==1.42.1",
#   "fastapi==0.136.3",
#   "sqlalchemy==2.0.50",
#   "httpx==0.28.1",
#   "psycopg2-binary==2.9.12",
# ]
# ///
"""Qualify the installed boot artifact, using only loopback and synthetic rows.

Not a full OWUI container or PostgreSQL qualification. No production requests.
"""
import hashlib
import asyncio
from dataclasses import replace
import contextlib
import io
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import types
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch as mock_patch

from fastapi import FastAPI, Request, Response
from fastapi.testclient import TestClient
from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import ExportMetricsServiceRequest
from sqlalchemy import Column, Integer, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session
from sqlalchemy.engine import make_url

from startup_patch import patch, validate_environment, validate_versions
import startup_patch

HERE = Path(__file__).resolve().parent
captures = []
validate_versions()


class Sink(BaseHTTPRequestHandler):
    def do_POST(self):
        captures.append((dict(self.headers), self.rfile.read(int(self.headers["content-length"]))))
        self.send_response(200)
        self.send_header("Content-Type", "application/x-protobuf")
        self.end_headers()

    def log_message(self, *args):
        pass


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def rejects(function):
    try:
        function()
    except ValueError:
        return
    raise AssertionError("expected fail-closed rejection")


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "user"
    id = Column(Integer, primary_key=True)
    last_active_at = Column(Integer)


settings = dict(
    ENABLE_OTEL="true", ENABLE_OTEL_METRICS="true", ENABLE_OTEL_TRACES="false", ENABLE_OTEL_LOGS="false",
    OTEL_METRICS_OTLP_SPAN_EXPORTER="http", OTEL_METRICS_EXPORT_INTERVAL_MILLIS="60000",
    OTEL_EXPORTER_OTLP_METRICS_TIMEOUT="2", OTEL_METRIC_EXPORT_TIMEOUT="3000",
    OTEL_EXPORTER_OTLP_METRICS_COMPRESSION="none", OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE="CUMULATIVE",
    OTEL_METRICS_EXPORTER_OTLP_ENDPOINT="https://telemetry.bayleaf.dev/v1/otlp/metrics",
    OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED="false", OTEL_TRACES_EXPORTER="none", OTEL_LOGS_EXPORTER="none",
    OTEL_METRICS_EXEMPLAR_FILTER="always_off",
    OTEL_EXPORTER_OTLP_METRICS_HEADERS="Authorization=Bearer synthetic-local-only-write-capability",
)
with mock_patch.dict(os.environ, settings, clear=True):
    validate_environment()
    with mock_patch.dict(os.environ, OTEL_METRICS_EXPORT_INTERVAL_MILLIS="300000"):
        validate_environment()
    for bad in (dict(ENABLE_OTEL_TRACES="true"), dict(OTEL_METRICS_EXPORT_INTERVAL_MILLIS="1000"), dict(OTEL_METRICS_BASIC_AUTH_USERNAME="x"), dict(OTEL_EXPORTER_OTLP_METRICS_HEADERS="Authorization=Bearer secret,extra=value"), dict(OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE="DELTA")):
        with mock_patch.dict(os.environ, bad):
            rejects(validate_environment)
    with mock_patch.dict(os.environ, {k: "false" for k in ("ENABLE_OTEL", "ENABLE_OTEL_METRICS", "ENABLE_OTEL_TRACES", "ENABLE_OTEL_LOGS")}):
        validate_environment()
    refused = subprocess.run([sys.executable, str(HERE / "startup_patch.py")], capture_output=True, env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")})
    assert refused.returncode == 1 and b"rung-3 harness alive" in refused.stdout
with mock_patch("startup_patch.version", return_value="unsupported"):
    rejects(validate_versions)
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    with mock_patch.object(startup_patch, "validate_versions"), mock_patch.object(startup_patch, "validate_environment"), mock_patch.object(startup_patch, "patch", side_effect=ValueError("synthetic_mismatch")), mock_patch.object(startup_patch.os, "execvp") as execution:
        assert startup_patch.main() == 1 and not execution.called
    with mock_patch.object(startup_patch, "validate_versions"), mock_patch.object(startup_patch, "validate_environment"), mock_patch.object(startup_patch, "patch"), mock_patch.object(startup_patch, "install_browser_assets"), mock_patch.object(startup_patch.os, "chdir"), mock_patch.object(startup_patch.os, "execvp") as execution:
        startup_patch.main()
        execution.assert_called_once_with("bash", ["bash", "start.sh"])

server = HTTPServer(("127.0.0.1", 0), Sink)
threading.Thread(target=server.serve_forever, daemon=True).start()
temp_root = Path(tempfile.gettempdir()) / "opencode"
temp_root.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix="bayleaf-otlp-rollout-", dir=temp_root) as temp:
    backend = Path(temp)
    destination = backend / "open_webui/utils/telemetry"
    destination.mkdir(parents=True)
    for name in ("metrics.py", "setup.py", "instrumentors.py"):
        shutil.copyfile(HERE / "upstream" / name, destination / name)
    shutil.copyfile(HERE / "upstream/env.py", backend / "open_webui/env.py")
    shutil.copyfile(HERE / "upstream/requirements.txt", backend / "requirements.txt")
    patch(backend)
    installed = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in destination.glob("*.py")}
    patch(backend)
    assert installed == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in destination.glob("*.py")}
    original = (destination / "metrics.py").read_bytes()
    (destination / "metrics.py").write_bytes(original + b"\n# drift\n")
    rejects(lambda: patch(backend))
    (destination / "metrics.py").write_bytes(original)
    adapter = destination / "bayleaf_runtime.py"
    original_adapter = adapter.read_bytes()
    adapter.write_bytes(original_adapter + b"\n# drift\n")
    rejects(lambda: patch(backend))
    adapter.write_bytes(original_adapter)
    for name in ("open_webui", "open_webui.models", "open_webui.utils", "open_webui.utils.telemetry"):
        module = types.ModuleType(name)
        module.__path__ = []
        sys.modules[name] = module
    env = types.ModuleType("open_webui.env")
    values = dict(
        ENABLE_OTEL_METRICS=True, ENABLE_OTEL_TRACES=False,
        OTEL_BASIC_AUTH_PASSWORD="", OTEL_BASIC_AUTH_USERNAME="",
        OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:1/not-used",
        OTEL_EXPORTER_OTLP_INSECURE=False, OTEL_OTLP_SPAN_EXPORTER="http", OTEL_SERVICE_NAME="FAKE_RESOURCE_SECRET",
        OTEL_METRICS_BASIC_AUTH_PASSWORD="", OTEL_METRICS_BASIC_AUTH_USERNAME="",
        OTEL_METRICS_EXPORT_INTERVAL_MILLIS=3600000,
        OTEL_METRICS_EXPORTER_OTLP_ENDPOINT=f"http://127.0.0.1:{server.server_port}/v1/otlp/metrics",
        OTEL_METRICS_EXPORTER_OTLP_INSECURE=False, OTEL_METRICS_OTLP_SPAN_EXPORTER="http",
    )
    for k, v in values.items():
        setattr(env, k, v)
    sys.modules[env.__name__] = env
    users = types.ModuleType("open_webui.models.users")
    users.User = User
    sys.modules[users.__name__] = users
    instrumentors = types.ModuleType("open_webui.utils.telemetry.instrumentors")
    def forbidden_instrumentor(*args, **kwargs):
        raise AssertionError("trace instrumentor was enabled")
    instrumentors.Instrumentor = forbidden_instrumentor
    sys.modules[instrumentors.__name__] = instrumentors
    load("open_webui.utils.telemetry.bayleaf_source_policy", destination / "bayleaf_source_policy.py")
    runtime = load("open_webui.utils.telemetry.bayleaf_runtime", adapter)
    fake_engine = types.SimpleNamespace()
    with mock_patch.object(runtime.time, "monotonic", return_value=100):
        calls = []
        def failing_count(_engine):
            calls.append(1)
            raise RuntimeError("synthetic_database_timeout")
        assert runtime.gauge_value(failing_count, fake_engine) is None
        assert runtime.gauge_value(failing_count, fake_engine) is None
        assert len(calls) == 1
    with mock_patch.object(runtime.time, "monotonic", return_value=161):
        assert runtime.gauge_value(lambda _: 7, fake_engine) == 7
    async def check_asgi():
        calls = []
        task = asyncio.current_task()
        counter = types.SimpleNamespace(add=lambda value, attrs: calls.append((value, attrs)))
        histogram = types.SimpleNamespace(record=lambda *args: None)
        async def downstream(scope, receive, send):
            assert asyncio.current_task() is task
            await send({"type": "http.response.start", "status": 200, "headers": []})
            assert len(calls) == 1  # Headers, not stream EOF, end timing.
            await send({"type": "http.response.body", "body": b"", "more_body": True})
            raise RuntimeError("synthetic_after_headers")
        async def noop(*args):
            pass
        middleware = runtime.MinimizedMetricsMiddleware(downstream, counter, histogram)
        try:
            await middleware({"type": "http", "method": "FAKE_METHOD", "path": "/FAKE_PATH"}, noop, noop)
        except RuntimeError:
            pass
        assert calls == [(1, {"http.method": "OTHER", "http.route": "/_other", "http.status_code": 200})]
        async def early_failure(*args):
            raise RuntimeError("synthetic_before_headers")
        calls.clear()
        middleware = runtime.MinimizedMetricsMiddleware(early_failure, counter, histogram)
        try:
            await middleware({"type": "http", "method": "GET", "path": "/health"}, noop, noop)
        except RuntimeError:
            pass
        assert calls[0][1]["http.status_code"] == 500 and len(calls) == 1
    asyncio.run(check_asgi())
    native = load("open_webui.utils.telemetry.metrics", destination / "metrics.py")
    setup = load("open_webui.utils.telemetry.setup", destination / "setup.py")
    engine = create_engine("sqlite:///" + temp + "/synthetic.db")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add_all([User(last_active_at=int(time.time())), User(last_active_at=1)])
        session.commit()
    # Real bounded-engine constructor is checked separately. The synthetic app
    # substitutes only the DB adapter, not patched setup, middleware or exporter.
    rejects(lambda: runtime.bounded_engine(engine))
    fake_application = types.SimpleNamespace(dialect=types.SimpleNamespace(name="postgresql"), url=types.SimpleNamespace(set=lambda **kwargs: "synthetic-postgres-url"))
    with mock_patch.object(runtime, "create_engine") as constructor:
        runtime.bounded_engine(fake_application)
        options = constructor.call_args.kwargs
        assert options["pool_size"] == 1 and options["max_overflow"] == 0 and options["pool_timeout"] == 0.1
        assert options["connect_args"]["connect_timeout"] == 2
        assert "statement_timeout=200" in options["connect_args"]["options"]
    # Construct the real psycopg2/QueuePool engine without opening a socket.
    fake_application.url = make_url("postgresql://synthetic:local-only@127.0.0.1:1/synthetic")
    bounded = runtime.bounded_engine(fake_application)
    assert bounded.pool.size() == 1 and bounded.pool._max_overflow == 0
    assert bounded.logger.name == "sqlalchemy.engine.Engine.bayleaf_otlp"
    assert bounded.pool.logger.name == "sqlalchemy.pool.impl.QueuePool.bayleaf_otlp"
    bounded.dispose()
    app = FastAPI()
    methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "FAKE_METHOD_SECRET"]
    async def endpoint(request: Request):
        return Response(status_code=int(request.query_params["status"]))
    paths = ["/health", "/api/version", "/api/chat/completions", "/api/v1/chats/{id}", "/FAKE_UNAPPROVED_SECRET/{id}"]
    for path in paths:
        app.add_api_route(path, endpoint, methods=methods)
    os.environ.update({k: v for k, v in settings.items() if k.startswith("OTEL_")})
    os.environ["OTEL_RESOURCE_ATTRIBUTES"] = "secret=FAKE_RESOURCE_SECRET"
    with mock_patch.object(native, "bounded_engine", return_value=engine):
        setup.setup(app, engine)
    provider = native.metrics.get_meter_provider()
    reader = provider._sdk_config.metric_readers[0]
    assert reader._exporter._timeout == 2
    with TestClient(app) as client:
        for path in paths:
            for method in methods:
                for status in (200, 404, 500):
                    client.request(method, path.replace("{id}", "FAKE_ID_SECRET") + f"?status={status}&token=FAKE_QUERY_SECRET")
    time.sleep(10.05)
    queries = []
    def count_query(_connection, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            queries.append(1)
    event.listen(engine, "before_cursor_execute", count_query)
    durations = []
    for _ in range(3):
        started = time.monotonic()
        reader.collect(timeout_millis=3000)
        durations.append(round((time.monotonic() - started) * 1000, 3))
    event.remove(engine, "before_cursor_execute", count_query)
    assert len(queries) == 9 and len(captures) == 3
    seen = set()
    counts = []
    sizes = []
    for headers, wire in captures:
        assert b"FAKE_" not in wire
        assert {k.lower(): v for k, v in headers.items()}["authorization"] == settings["OTEL_EXPORTER_OTLP_METRICS_HEADERS"].split("=", 1)[1]
        decoded = ExportMetricsServiceRequest.FromString(wire)
        assert not decoded.resource_metrics[0].resource.attributes
        metrics = [m for r in decoded.resource_metrics for s in r.scope_metrics for m in s.metrics]
        counter = next(m for m in metrics if m.name == "http.server.requests")
        histogram = next(m for m in metrics if m.name == "http.server.duration")
        def identity(p):
            return tuple(sorted((a.key, a.value.string_value or a.value.int_value) for a in p.attributes))
        keys = {identity(p) for p in counter.sum.data_points}
        assert keys == {identity(p) for p in histogram.histogram.data_points}
        assert len(keys) == 48 and all(p.as_int == 1 for p in counter.sum.data_points)
        seen.update(keys)
        # Run the actual hook AND shared core validator, not just protobuf decode.
        script = f'''import {{ otlpHook }} from {json.dumps((HERE / "worker-adapter.mjs").as_uri())};
import {{ validate }} from {json.dumps((HERE.parent / "src/validate.js").as_uri())};
const chunks=[]; for await(const c of process.stdin) chunks.push(c);
const request=new Request('http://synthetic/v1/otlp/metrics',{{method:'POST',headers:{{'content-type':'application/x-protobuf'}},body:Buffer.concat(chunks)}});
const envelope=await otlpHook(request,{{source:'owui',now:Date.now()}});
const checked=validate('metrics',envelope,{{RETENTION_DAYS:'90'}},Date.now());
console.log(JSON.stringify({{points:checked.points.length,bytes:JSON.stringify(envelope).length}}));'''
        checked = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", script], input=wire))
        assert checked["points"] == 99 and checked["bytes"] <= 65536
        counts.append(checked["points"])
        sizes.append(checked["bytes"])
    assert len(seen) == 120
    # Failure must not advance the page cursor; native retries see identical
    # already-selected MetricsData inside super().export.
    from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
    from opentelemetry.sdk.metrics.export import MetricExportResult
    cursor = reader._exporter._after
    with mock_patch.object(OTLPMetricExporter, "export", return_value=MetricExportResult.FAILURE):
        reader.collect(timeout_millis=3000)
    assert reader._exporter._after == cursor
    with mock_patch.object(OTLPMetricExporter, "export", return_value=MetricExportResult.SUCCESS) as exported:
        reader.collect(timeout_millis=3000)
        data = exported.call_args.args[0]
        r = data.resource_metrics[0]
        s = r.scope_metrics[0]
        items = []
        for m in s.metrics:
            if m.name == "http.server.requests":
                p = m.data.data_points[0]
                incomplete = replace(p, attributes={**p.attributes, "http.status_code": 599})
                m = replace(m, data=replace(m.data, data_points=(*m.data.data_points, incomplete)))
            items.append(m)
        partial = replace(data, resource_metrics=(replace(r, scope_metrics=(replace(s, metrics=tuple(items)),)),))
        reader._exporter.export(partial)
        complete = exported.call_args.args[0]
        assert sum(len(m.data.data_points) for r in complete.resource_metrics for s in r.scope_metrics for m in s.metrics) == 99
    # Gauge failure is omitted, never turned into zero, and common HTTP series
    # still export successfully. No raw callback exception reaches logs.
    with mock_patch.object(native, "_count_active_users", side_effect=RuntimeError("FAKE_DB_SECRET")):
        reader.collect(timeout_millis=3000)
    assert b"FAKE_DB_SECRET" not in captures[-1][1]
    decoded = ExportMetricsServiceRequest.FromString(captures[-1][1])
    assert "webui.users.active" not in [m.name for r in decoded.resource_metrics for s in r.scope_metrics for m in s.metrics]
    proof = dict(
        status="synthetic_artifact_pass_real_container_required", installed_sha256=installed,
        startup_hash_drift_refused=True, adapter_drift_refused=True, idempotent=True,
        unsafe_environment_refused=True, prior_sentinel_preserved=True,
        explicit_all_four_flags_off_supported=True,
        mismatch_never_execs_unsanitized_start=True, success_execs_existing_bash_start=True,
        unsupported_dependency_version_refused=True,
        actual_pinned_package_versions_verified=True,
        real_psycopg2_engine_constructed_without_network=True,
        pure_asgi_same_task_headers_timing_error_paths=True,
        empty_resource_verified=True, traces_never_instrumented=True,
        unknown_route_method_minimized_before_aggregation=True,
        native_http_tuples=120, tuples_per_page=48, points_per_export=counts,
        normalized_envelope_bytes=sizes, all_tuples_seen_after_three_pages=len(seen),
        failed_export_preserves_cursor=True, failed_gauge_absent_not_zero=True,
        incomplete_first_series_pair_deferred_without_batch_loss=True,
        database_failure_backoff_checked=True,
        original_cumulative_counts_preserved=True, synthetic_selects_per_collection=3,
        synthetic_collection_ms=durations, exporter_timeout_seconds=2,
        bearer_header_override_verified=True, production_requests=0,
        postgresql_timeouts="constructor_checked_not_live_qualified",
    )
    (HERE / "rollout-proof.json").write_text(json.dumps(proof, indent=2) + "\n")
    print(json.dumps(proof, indent=2))
    provider.shutdown(timeout_millis=3000)
    engine.dispose()
server.shutdown()
server.server_close()
