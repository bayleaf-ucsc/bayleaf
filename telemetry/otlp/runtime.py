"""Source-side callback isolation. No SQL or failure details are logged."""
from bisect import bisect_right
from dataclasses import replace
import logging
import time

from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.sdk.metrics.export import AggregationTemporality, MetricExportResult

from sqlalchemy import create_engine
from sqlalchemy.pool import QueuePool

from .bayleaf_source_policy import safe_method, safe_route


class MinimizedMetricsMiddleware:
    """Pure ASGI: no BaseHTTPMiddleware task group or cancellation scope.

    Like native call_next timing, duration ends at response headers, not EOF.
    Sanitization occurs here, before either instrument sees attributes.
    """
    def __init__(self, app, counter, histogram):
        self.app, self.counter, self.histogram = app, counter, histogram

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        started = time.perf_counter()
        recorded = False
        def record(status):
            nonlocal recorded
            recorded = True
            attributes = {
                "http.method": safe_method(scope["method"]),
                "http.route": safe_route(getattr(scope.get("route"), "path", scope["path"])),
                "http.status_code": status,
            }
            self.counter.add(1, attributes)
            self.histogram.record((time.perf_counter() - started) * 1000, attributes)
        async def measured_send(message):
            if message["type"] == "http.response.start" and not recorded:
                record(message["status"])
            await send(message)
        try:
            await self.app(scope, receive, measured_send)
        finally:
            if not recorded:
                record(500)


class WindowedHttpMetricExporter(OTLPMetricExporter):
    """Fair pages of complete cumulative series, never truncate aggregates.

    At most 48 HTTP tuples (96 points) plus 3 gauges per export. A tuple's
    counter and histogram travel together. Cumulative SDK state is untouched:
    omitted tuples return in later pages with their original start/reset time.
    """
    _after = None

    def export(self, metrics_data, timeout_millis=10000, **kwargs):
        if len(metrics_data.resource_metrics) != 1:
            raise ValueError("unsupported_metric_layout")
        resource = metrics_data.resource_metrics[0]
        if resource.resource.attributes or len(resource.scope_metrics) != 1:
            raise ValueError("unsupported_metric_layout")
        scope = resource.scope_metrics[0]
        pairs = {}
        def key(point):
            a = point.attributes
            return (a["http.route"], a["http.method"], a["http.status_code"])
        for metric in scope.metrics:
            if metric.name.startswith("http.server."):
                if metric.name not in ("http.server.requests", "http.server.duration") or metric.data.aggregation_temporality != AggregationTemporality.CUMULATIVE:
                    raise ValueError("unsupported_metric_layout")
                for point in metric.data.data_points:
                    pairs.setdefault(key(point), set()).add(metric.name)
            elif metric.name not in ("webui.users.total", "webui.users.active", "webui.users.active.today") or len(metric.data.data_points) > 1:
                raise ValueError("unsupported_metric_layout")
        if len(scope.metrics) > 5:
            raise ValueError("unsupported_metric_layout")
        # SDK collection can straddle a tuple's first counter/histogram update.
        # Defer only that incomplete pair, not the rest of the complete batch.
        keys = sorted(k for k, names in pairs.items() if len(names) == 2)
        start = bisect_right(keys, self._after) if self._after is not None else 0
        ordered = keys[start:] + keys[:start]
        page = ordered[:48]
        chosen = set(page)
        selected = []
        for metric in scope.metrics:
            points = metric.data.data_points
            if metric.name.startswith("http.server."):
                points = tuple(p for p in points if key(p) in chosen)
            if points:
                selected.append(replace(metric, data=replace(metric.data, data_points=points)))
        outgoing = replace(metrics_data, resource_metrics=(replace(resource, scope_metrics=(replace(scope, metrics=tuple(selected)),)),))
        result = super().export(outgoing, timeout_millis=timeout_millis, **kwargs)
        if result == MetricExportResult.SUCCESS and page:
            self._after = page[-1]
        return result


def bounded_engine(application_engine):
    if application_engine.dialect.name != "postgresql":
        raise ValueError("unsupported_metrics_database")
    # One extra connection, never a checkout from the application's pool.
    # psycopg2 is pinned by the upstream v0.12.3 image's requirements.
    return create_engine(
        application_engine.url.set(drivername="postgresql+psycopg2"),
        poolclass=QueuePool, pool_size=1, max_overflow=0, pool_timeout=0.1,
        echo=False, hide_parameters=True, logging_name="bayleaf_otlp",
        pool_logging_name="bayleaf_otlp",
        connect_args={
            "application_name": "bayleaf-otlp",
            "connect_timeout": 2,
            "options": "-c statement_timeout=200 -c lock_timeout=100 -c default_transaction_read_only=on",
            "keepalives": 1, "keepalives_idle": 2,
            "keepalives_interval": 1, "keepalives_count": 2,
            "tcp_user_timeout": 3000,
        },
    )


def gauge_value(count, engine):
    # All three native callbacks share this dedicated engine and the periodic
    # reader serializes collections. One failed DB attempt suppresses the other
    # callbacks for a minute, rather than repeating a connect timeout three times.
    if time.monotonic() < getattr(engine, "_bayleaf_retry_at", 0):
        return None
    try:
        return count(engine)
    except Exception:
        engine._bayleaf_retry_at = time.monotonic() + 60
        return None


def quiet_exporter_logs():
    # Exporter/SDK exception strings can contain endpoint and DB diagnostics.
    # Absence/staleness is detected at the receiver, not through raw local logs.
    # Parent logger filters do not apply to descendant loggers' handlers.
    class Drop(logging.Handler):
        def emit(self, record):
            pass
    for name in ("opentelemetry", "sqlalchemy.engine.Engine.bayleaf_otlp", "sqlalchemy.pool.impl.QueuePool.bayleaf_otlp"):
        logger = logging.getLogger(name)
        logger.handlers = [Drop()]
        logger.propagate = False
