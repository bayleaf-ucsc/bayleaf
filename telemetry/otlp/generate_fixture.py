# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = [
#   "opentelemetry-api==1.42.1",
#   "opentelemetry-sdk==1.42.1",
#   "opentelemetry-exporter-otlp==1.42.1",
#   "fastapi==0.136.3",
#   "sqlalchemy==2.0.50",
#   "httpx==0.28.1",
# ]
# ///
"""Run actual tagged middleware + pinned exporter against a loopback HTTP sink.

Only synthetic SQLite rows. Unsafe export stays in memory and is inspected in a
separate child process. Only minimized protobuf and content-free proof are saved.
"""
import base64
import hashlib
import importlib.metadata
import json
import os
import pathlib
import subprocess
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, HTTPServer

from fastapi import FastAPI
from fastapi.testclient import TestClient
from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import ExportMetricsServiceRequest
from opentelemetry.sdk.resources import Resource
from sqlalchemy import Column, Integer, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session

from source_policy import minimized_source, minimized_setup_source, safe_method, safe_route

HERE = pathlib.Path(__file__).resolve().parent
UNSAFE = "--unsafe" in sys.argv
captures = []
responses = []
normalized = []


class Sink(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["content-length"]))
        captures.append((self.path, dict(self.headers), body))
        if not UNSAFE:
            checked = subprocess.run(["node", str(HERE / "normalize-stdin.mjs")], input=body, capture_output=True, check=True)
            normalized.append(json.loads(checked.stdout))
        self.send_response(responses.pop(0) if responses else 200)
        self.send_header("Content-Type", "application/x-protobuf")
        self.end_headers()  # Empty ExportMetricsServiceResponse protobuf.

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), Sink)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "user"
    id = Column(Integer, primary_key=True)
    last_active_at = Column(Integer)


# Temporary file-backed SQLite allows native callback's background collection.
import tempfile
import time
temp_root = pathlib.Path(tempfile.gettempdir()) / "opencode"
temp_root.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix="bayleaf-otlp-synthetic-", dir=temp_root) as temp:
    engine = create_engine("sqlite:///" + temp + "/synthetic.db")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add_all([User(last_active_at=int(time.time())), User(last_active_at=1)])
        session.commit()
    env = types.ModuleType("open_webui.env")
    values = dict(OTEL_METRICS_BASIC_AUTH_USERNAME="synthetic", OTEL_METRICS_BASIC_AUTH_PASSWORD="local-only", OTEL_METRICS_EXPORT_INTERVAL_MILLIS=3600000, OTEL_METRICS_EXPORTER_OTLP_ENDPOINT=f"http://127.0.0.1:{server.server_port}/v1/metrics", OTEL_METRICS_EXPORTER_OTLP_INSECURE=False, OTEL_METRICS_OTLP_SPAN_EXPORTER="http", OTEL_SERVICE_NAME="open-webui")
    for k, v in values.items():
        setattr(env, k, v)
    users = types.ModuleType("open_webui.models.users")
    users.User = User
    sys.modules["open_webui.env"] = env
    sys.modules["open_webui.models.users"] = users
    name = "open_webui.utils.telemetry.metrics"
    native = types.ModuleType(name)
    native.safe_route, native.safe_method = safe_route, safe_method
    source = (HERE / "upstream/metrics.py").read_text()
    assert "resource = Resource(attributes={})" in minimized_setup_source((HERE / "upstream/setup.py").read_text())
    exec(compile(source if UNSAFE else minimized_source(source), "tagged-v0.12.3-metrics.py", "exec"), native.__dict__)
    app = FastAPI()

    @app.get("/health")
    def health():
        return {"ok": True}

    @app.get("/api/v1/chats/{id}")
    def synthetic_template(id: str):
        return {"ok": True}

    native.setup_metrics(app, Resource.create({"service.name": "FAKE_RESOURCE_SECRET"}) if UNSAFE else Resource(attributes={}), engine)
    with TestClient(app) as client:
        client.get("/health")
        client.get("/api/v1/chats/FAKE_CHAT_SECRET")
        client.get("/FAKE_UNMATCHED_SECRET?token=FAKE_QUERY_SECRET")
        client.request("FAKE_METHOD_SECRET", "/FAKE_UNMATCHED_SECRET")
    if not UNSAFE:
        # Qualification fixture has real aggregate age, not invented start times.
        time.sleep(10.05)
    provider = native.metrics.get_meter_provider()
    reader = provider._sdk_config.metric_readers[0]
    queries = []
    def count_query(_conn, _cursor, statement, _parameters, _context, _executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            queries.append(1)  # No SQL or parameters retained.
    event.listen(engine, "before_cursor_execute", count_query)
    reader.collect(timeout_millis=3000)
    event.remove(engine, "before_cursor_execute", count_query)
    assert len(queries) == 3
    assert captures, "no actual exporter HTTP request"
    path, headers, wire = captures[0]
    decoded = ExportMetricsServiceRequest.FromString(wire)
    assert path == "/v1/metrics"
    assert headers["Content-Type"] == "application/x-protobuf"
    assert headers["authorization"] == "Basic " + base64.b64encode(b"synthetic:local-only").decode()
    assert not headers.get("Content-Encoding")
    if UNSAFE:
        assert b"FAKE_UNMATCHED_SECRET" in wire and b"FAKE_RESOURCE_SECRET" in wire and b"FAKE_METHOD_SECRET" in wire
        assert b"FAKE_CHAT_SECRET" not in wire and b"FAKE_QUERY_SECRET" not in wire
        print(json.dumps({"unsafe_native_literal_path_observed": True, "unsafe_native_method_observed": True, "unsafe_native_resource_observed": True, "template_identity_absent": True, "query_absent": True}))
    else:
        assert b"FAKE_" not in wire
        HERE.joinpath("fixture.pb").write_bytes(wire)
        HERE.joinpath("fixture.normalized.json").write_text(json.dumps(normalized[0], indent=2) + "\n")
        proof = json.loads(subprocess.check_output([sys.executable, __file__, "--unsafe"], text=True))
        metrics = [m for r in decoded.resource_metrics for s in r.scope_metrics for m in s.metrics]
        proof.update({"exporter": "opentelemetry-exporter-otlp-proto-http", "sdk_version": importlib.metadata.version("opentelemetry-sdk"), "path": path, "content_type": headers["Content-Type"], "compression": "identity", "basic_auth_verified": True, "safe_payload_bytes": len(wire), "safe_payload_sha256": hashlib.sha256(wire).hexdigest(), "safe_payload_has_no_fake_secrets": True, "metric_names": [m.name for m in metrics], "observed_temporalities": {m.name: m.sum.aggregation_temporality if m.HasField("sum") else m.histogram.aggregation_temporality if m.HasField("histogram") else 0 for m in metrics}})
        proof["native_gauge_select_queries_per_collection"] = len(queries)
        proof["native_source_minimum_window_ms"] = 10000
        # Actual pinned exporter's retry loop against the local normalizing sink.
        # Internal API is intentional qualification, not proposed application API.
        exporter = reader._exporter
        exporter._timeout = 3
        from opentelemetry.sdk.metrics.export import MetricExportResult
        before = len(captures)
        responses[:] = [503, 200]
        result = exporter._export_with_retries(decoded, time.time() + 3, len(metrics))
        assert result == MetricExportResult.SUCCESS and len(captures) == before + 2
        assert captures[-1][2] == captures[-2][2] == wire
        proof["503_retry_identical_bytes"] = True
        for status in [400, 401, 413, 415, 429]:
            before = len(captures)
            responses[:] = [status]
            result = exporter._export_with_retries(decoded, time.time() + 3, len(metrics))
            assert result == MetricExportResult.FAILURE and len(captures) == before + 1
        proof["non_retried_statuses"] = [400, 401, 413, 415, 429]
        responses[:] = [503] * 8
        before = len(captures)
        started = time.monotonic()
        result = exporter._export_with_retries(decoded, time.time() + 3, len(metrics))
        elapsed = time.monotonic() - started
        assert result == MetricExportResult.FAILURE and elapsed < 4 and len(captures) - before <= 3
        responses.clear()
        proof["failed_sink_timeout_seconds"] = 3
        proof["failed_sink_observed_seconds"] = round(elapsed, 3)
        proof["failed_sink_attempts"] = len(captures) - before
        proof["loopback_sink_ran_js_normalizer_before_response"] = True
        # With native Basic env vars unset, native _build_meter_provider passes
        # headers=[], which this pinned exporter resolves from the standard env.
        os.environ["OTEL_EXPORTER_OTLP_METRICS_HEADERS"] = "Authorization=Bearer synthetic-local-only-write-capability"
        bearer_exporter = native.OTLPHttpMetricExporter(endpoint=values["OTEL_METRICS_EXPORTER_OTLP_ENDPOINT"], headers=[], timeout=3)
        result = bearer_exporter._export_with_retries(decoded, time.time() + 3, len(metrics))
        assert result == MetricExportResult.SUCCESS
        assert {k.lower(): v for k, v in captures[-1][1].items()}["authorization"] == "Bearer synthetic-local-only-write-capability"
        proof["standard_env_bearer_header_override_verified"] = True
        bearer_exporter.shutdown()
        del os.environ["OTEL_EXPORTER_OTLP_METRICS_HEADERS"]
        HERE.joinpath("fixture-proof.json").write_text(json.dumps(proof, indent=2) + "\n")
        print(json.dumps(proof, indent=2))
    provider.shutdown(timeout_millis=3000)
    engine.dispose()
server.shutdown()
server.server_close()
