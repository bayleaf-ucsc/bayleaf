"""Diagnostic adapter, not OWUI: call unchanged toolkit internals in two processes.

No real identities, credentials, inference, or cloud sandboxes. GWS_MODE=redis
opts into a lab-only state experiment. Baseline leaves the toolkit unchanged.
"""

import os
import inspect
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import gws
import gws_redis
import httpx
import lathe
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from redis.asyncio import Redis
from redis.exceptions import RedisError

MODE = os.environ.get("GWS_MODE", "baseline")
if MODE not in {"baseline", "redis", "memory", "upstream", "upstream-memory"}:
    raise RuntimeError("Unknown GWS_MODE")
if MODE in {"redis", "memory"}:
    gws = gws_redis.load(Path("/lab/gws.py"))


@asynccontextmanager
async def lifespan(app):
    normal = Redis.from_url(os.environ["REDIS_URL"], socket_connect_timeout=0.3, socket_timeout=0.3)
    broken = Redis.from_url("redis://127.0.0.1:1", socket_connect_timeout=0.3, socket_timeout=0.3)
    app.state.lab_redis = normal
    app.state.broken_redis = broken
    app.state.redis = None if MODE in {"memory", "upstream-memory"} else normal
    if MODE in {"redis", "memory"}:
        # Explicit local startup substitution, not a claimed OWUI plugin hook.
        gws._setup(app, google.valves)
    try:
        yield
    finally:
        await normal.aclose()
        await broken.aclose()


app = FastAPI(lifespan=lifespan)
gws.GOOGLE_AUTH_URL = "http://fixtures:8080/consent"
gws.GOOGLE_TOKEN_URL = "http://fixtures:8080/token"
google = gws.Tools()
google.valves.google_client_id = "synthetic-client"
google.valves.google_client_secret = "not-a-real-secret"
google.valves.base_url = "http://localhost:18351"
google.valves.enabled_capabilities = "calendar.readonly"
# Redirect only the network boundary; preserve the toolkit's HTTP error handling.
original_gws_request = gws._gws_request


async def fixture_request(method, url, *args, **kwargs):
    if not url.startswith("https://www.googleapis.com/"):
        raise RuntimeError("Unexpected API origin in synthetic lab")
    url = url.replace("https://www.googleapis.com/", "http://fixtures:8080/google/", 1)
    return await original_gws_request(method, url, *args, **kwargs)


gws._gws_request = fixture_request
sandbox = lathe.Tools()
sandbox.valves.daytona_api_key = "synthetic-key"
sandbox.valves.daytona_proxy_url = "http://fixtures:8080"


@app.middleware("http")
async def identify(request, call_next):
    response = await call_next(request)
    response.headers["X-Lab-Worker"] = os.environ.get("HOSTNAME", "unknown")
    return response


@app.get("/health")
async def health():
    return {"redis": await app.state.lab_redis.ping(), "mode": MODE,
            "harness": "toolkit-internals"}


@app.exception_handler(RedisError)
async def redis_error(request, exc):
    return JSONResponse({"error": "shared authorization state unavailable"}, status_code=503)


if MODE.startswith("upstream"):
    app.add_exception_handler(gws._StateUnavailable, redis_error)

    @app.exception_handler(gws._AuthorizationPending)
    async def already_pending(request, exc):
        return JSONResponse({"error": "authorization already pending"}, status_code=409)


async def resolve(value):
    return await value if inspect.isawaitable(value) else value


@app.post("/gws/init")
async def init(chat: str = "synthetic-chat", user: str = "synthetic-user"):
    # Match the toolkit's lazy route-registration behavior, not eager startup.
    gws._setup(app, google.valves)
    url = await resolve(gws._build_auth_url(
        app, google.valves, user, chat, "", {"calendar.readonly"}
    ))
    return {"state": parse_qs(urlsplit(url).query)["state"][0]}


@app.get("/gws/status")
async def status(chat: str = "synthetic-chat", user: str = "synthetic-user"):
    # Direct helper calls need the same config binding as public tool methods.
    gws._setup(app, google.valves)
    entry = await resolve(gws._get_chat_token(app, user, chat))
    return {"authorized": entry is not None}


@app.get("/gws/tool-status")
async def tool_status(request: Request, chat: str, user: str = "synthetic-user"):
    return {"output": await google.gws_authorize(
        __user__={"id": user}, __chat_id__=chat, __request__=request)}


@app.post("/lab/redis-fault")
async def redis_fault(unavailable: bool):
    if MODE not in {"redis", "upstream"}:
        return JSONResponse({"error": "requires redis mode"}, status_code=409)
    # Break just this worker's client, without disrupting unrelated services.
    app.state.redis = app.state.broken_redis if unavailable else app.state.lab_redis
    return {"unavailable": unavailable}


@app.get("/gws/action")
async def action(request: Request, chat: str, user: str = "synthetic-user"):
    return {"output": await google.gws_action(
        "calendar.calendars.list", __user__={"id": user},
        __chat_id__=chat, __request__=request)}


@app.post("/lab/expire")
async def expire(kind: str, nonce: str = "", user: str = "synthetic-user", chat: str = ""):
    if MODE not in {"redis", "upstream"} or kind not in {"pending", "token"}:
        return JSONResponse({"error": "requires redis mode and valid key kind"}, status_code=409)
    parts = (nonce,) if kind == "pending" else (user, chat)
    key = (gws._state_key(app, kind, *parts) if MODE == "upstream"
           else gws_redis._key(kind, *parts))
    before_ms = await app.state.redis.pttl(key)
    # Accelerate this exact synthetic key's server-side expiry, never FLUSHDB.
    changed = await app.state.redis.pexpire(key, 80)
    return {"before_ms": before_ms, "changed": changed}


@app.post("/gws/clear")
async def clear(chat: str, user: str = "synthetic-user"):
    await resolve(gws._clear_chat_token(app, user, chat))
    return {"cleared": True}


class Interpretation(BaseModel):
    chat: str = "synthetic-chat"
    code: str


@app.post("/lathe/interpret")
async def interpret(body: Interpretation):
    async with httpx.AsyncClient() as client:
        try:
            output = await lathe._core_interpret(
                sandbox.valves, "synthetic-sandbox", client,
                sandbox._interpreter_state, body.chat, code=body.code,
            )
            ok = True
        except lathe._ToolFailure as exc:
            output, ok = str(exc), False
    state = sandbox._interpreter_state[body.chat]
    return {"ok": ok, "output": output, "context": state.get("id")}


application = app
if MODE.startswith("upstream"):
    from owui_worker import CallbackApp

    async def resolve_upstream(request):
        # The adapter's real OWUI resolver reads source/valves from the database.
        # This toolkit lab substitutes the mounted module and synthetic valves.
        return gws, google.valves

    application = CallbackApp(app, resolve_upstream)
