"""Shared source-minimization policy. Apply before native SDK aggregation.

Do not mistake receiver filtering for source minimization. OWUI's View filters
attribute *keys*, not literal route values. startup_patch.py is the reviewed boot
artifact entrypoint; importing these helpers alone does not install anything.
"""

ROUTES = frozenset({"/health", "/api/version", "/api/chat/completions", "/api/v1/chats/{id}", "/_other"})
METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"})


def safe_route(value):
    return value if value in ROUTES else "/_other"


def safe_method(value):
    return value if value in METHODS else "OTHER"


def minimized_source(source):
    """Fail-closed patch of the inspected v0.13.0 middleware only.

    A production integration should patch upstream source/build explicitly and
    qualify that artifact, not import this ad hoc executor. Always use
    Resource(attributes={}), never Resource.create(), in the metrics provider.
    """
    old = "route_path = getattr(route, 'path', None)"
    method = "'http.method': request.method,"
    if source.count(old) != 1 or source.count(method) != 1:
        raise ValueError("unsupported_tagged_source")
    # The production pure-ASGI adapter replaces this middleware. Remove the new
    # URL-exclusion helpers too: they reconstruct full URLs, and BayLeaf retains
    # its fixed route policy rather than upstream's configurable exclusions.
    for fragment in (
        "from opentelemetry.instrumentation.asgi import get_host_port_url_tuple\n",
        "from opentelemetry.util.http import get_excluded_urls\n",
        "    # OTEL_PYTHON_FASTAPI_EXCLUDED_URLS, shared with traces\n    excluded_urls = get_excluded_urls('FASTAPI')\n\n",
        "        _, _, url = get_host_port_url_tuple(request.scope)\n        if excluded_urls.url_disabled(url):\n            return await call_next(request)\n\n",
    ):
        if source.count(fragment) != 1:
            raise ValueError("unsupported_tagged_source")
        source = source.replace(fragment, "")
    return source.replace(old, "route_path = safe_route(getattr(route, 'path', None))").replace(method, "'http.method': safe_method(request.method),")


def minimized_setup_source(source):
    """Resource.create merges env/detected attributes, so replace it too."""
    old = "resource = Resource.create(attributes={SERVICE_NAME: OTEL_SERVICE_NAME})"
    if source.count(old) != 1:
        raise ValueError("unsupported_tagged_source")
    return source.replace(old, "resource = Resource(attributes={})")
