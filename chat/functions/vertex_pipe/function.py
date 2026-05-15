"""
title: Vertex Pipe
author: Adam Smith
description: Lean OpenAI-compatible manifold pipe to Google Vertex AI. Holds a service-account JSON in an admin valve, mints short-lived access tokens locally (PyJWT), and proxies chat completions to the Vertex OpenAI-compatible endpoint. Surfaces an admin-curated list of publisher/model ids (Gemini, Claude-on-Vertex, Mistral, etc.) as selectable models.
version: 0.2.3
"""

# Why this exists:
#
#   Vertex AI exposes an OpenAI-compatible Chat Completions endpoint, but
#   authentication is OAuth (a 1-hour bearer token), not a static API key.
#   OWUI's Connections feature wants a static key, so it can't drive Vertex
#   directly. The community owndev/google_gemini Pipe handles this via
#   Application Default Credentials (a key file on disk), which on
#   DigitalOcean App Platform requires either a custom image or a fragile
#   run_command stunt to materialize the key.
#
#   This Pipe avoids that entire problem: the SA JSON lives in an admin
#   valve (encrypted at rest because WEBUI_SECRET_KEY is set), we sign a
#   service-account JWT in-process, exchange it for an access token at
#   oauth2.googleapis.com/token, cache the token until a minute before
#   expiry, and proxy chat completions through. Pure rung-1 plugin.
#
#   This is a manifold pipe: a single valve (MODELS) holds an admin-curated
#   list of publisher/model ids, and pipes() exposes each as its own
#   selectable model in the OWUI picker. The Vertex OpenAI-compat endpoint
#   accepts any publisher's id with the appropriate prefix, so the same
#   token + endpoint serve google/gemini-*, anthropic/claude-* (Claude on
#   Vertex), mistralai/*, etc.
#
#   To discover what's currently available in the project, hit:
#
#       GET https://aiplatform.googleapis.com/v1beta1/publishers/<pub>/models
#       Authorization: Bearer <SA token>
#       X-Goog-User-Project: <PROJECT_ID>
#
#   for pub in {google, anthropic, mistralai, ...} and read launchStage.
#
#   ZDR posture: Vertex AI under a UCSC GCP project is governed by UC's
#   Google Cloud agreement (P3-eligible). No prompt or completion content
#   leaves UCSC's Google tenancy via this code path.

import json
import re
import time
import logging
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple, Union

import httpx
import jwt  # PyJWT[crypto] (ships with OWUI)
from pydantic import BaseModel, Field


# Google's OAuth 2.0 token endpoint, used to exchange a signed service-account
# JWT for a short-lived access token. See:
# https://developers.google.com/identity/protocols/oauth2/service-account
_TOKEN_URL = "https://oauth2.googleapis.com/token"
_SCOPE = "https://www.googleapis.com/auth/cloud-platform"

# Default access token lifetime is 3600s; we refresh 60s before that to avoid
# in-flight expiry on long completions.
_TOKEN_REFRESH_LEEWAY = 60

# OWUI uses '.' as the function_id / model_id separator on the wire (so the
# model arrives as 'vertex_pipe.<entry-id>'), and historically has been finicky
# about '/' in entry ids. We expose ids as 'publisher__model' and convert back
# to the publisher/model form Vertex wants only inside _shape_request.
_PUB_SEP = "__"

# Default curated catalog. Edit MODELS valve (or this default) to add/remove.
# Format: comma-separated entries of the form '<publisher>/<model>',
# optionally followed by ' = <display name>'. Newlines and semicolons are
# also accepted as separators (so a textarea-style edit still works), and
# entries whose publisher/model substring starts with '#' are ignored.
_DEFAULT_MODELS = (
    "google/gemini-3.1-pro-preview = Gemini 3.1 Pro (preview), "
    "google/gemma-4-26b-a4b-it-maas = Gemma 4 26B-A4B IT (MaaS), "
    "zai-org/glm-5-maas = GLM 5 (MaaS)"
)


class _TokenCache:
    """Process-local cache of one access token per (client_email, scope).

    The Pipe is a long-lived singleton inside OWUI, so caching here eliminates
    a JWT sign + token round-trip on every chat turn.
    """

    def __init__(self) -> None:
        self._token: Optional[str] = None
        self._expires_at: float = 0.0
        self._key_fingerprint: Optional[str] = None

    def get(self, key_fingerprint: str) -> Optional[str]:
        if (
            self._token
            and self._key_fingerprint == key_fingerprint
            and time.time() < self._expires_at - _TOKEN_REFRESH_LEEWAY
        ):
            return self._token
        return None

    def set(self, key_fingerprint: str, token: str, ttl_seconds: int) -> None:
        self._key_fingerprint = key_fingerprint
        self._token = token
        self._expires_at = time.time() + ttl_seconds


def _mint_access_token(sa_info: Dict[str, Any]) -> Tuple[str, int]:
    """Sign a service-account JWT and exchange it for a Google access token.

    Returns (access_token, expires_in_seconds). Raises on any failure.
    """

    now = int(time.time())
    claim = {
        "iss": sa_info["client_email"],
        "scope": _SCOPE,
        "aud": _TOKEN_URL,
        "iat": now,
        "exp": now + 3600,
    }
    signed_jwt = jwt.encode(
        claim,
        sa_info["private_key"],
        algorithm="RS256",
        headers={"kid": sa_info.get("private_key_id")},
    )

    # Synchronous request: this only runs once per token lifetime (~hourly).
    # Keeping it sync keeps the Pipe surface simple; the per-turn streaming
    # call below uses httpx.AsyncClient.
    resp = httpx.post(
        _TOKEN_URL,
        data={
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": signed_jwt,
        },
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    return body["access_token"], int(body.get("expires_in", 3600))


def _parse_models(spec: str) -> List[Tuple[str, str, str]]:
    """Parse the MODELS valve.

    Accepts a comma-, semicolon-, or newline-separated list of entries.
    Each entry is '<publisher>/<model>', optionally followed by
    ' = <display name>'. Entries whose publisher/model component starts
    with '#' are treated as comments and skipped.

    Returns a list of (entry_id, publisher_model, display_name) triples.
    entry_id is OWUI-safe ('publisher__model'); publisher_model is the
    Vertex-facing form ('publisher/model'); display_name is what shows in
    the model picker.
    """

    out: List[Tuple[str, str, str]] = []
    seen: set[str] = set()
    # Split on any of comma, semicolon, or newline. We deliberately do *not*
    # split on '/' (publisher separator) or '=' (display-name separator).
    for raw in re.split(r"[,;\n]", spec or ""):
        entry = raw.strip()
        if not entry:
            continue
        if "=" in entry:
            left, right = entry.split("=", 1)
            pub_model = left.strip()
            display = right.strip()
        else:
            pub_model = entry
            display = ""
        if pub_model.startswith("#") or "/" not in pub_model:
            # Skip comments and malformed entries silently rather than
            # failing the whole manifold; admins will notice the missing
            # model in the picker.
            continue
        publisher, model = pub_model.split("/", 1)
        publisher = publisher.strip()
        model = model.strip()
        if not publisher or not model:
            continue
        entry_id = f"{publisher}{_PUB_SEP}{model}"
        if entry_id in seen:
            continue
        seen.add(entry_id)
        if not display:
            display = f"{model} ({publisher})"
        out.append((entry_id, f"{publisher}/{model}", display))
    return out


def _entry_to_vertex_model(entry_id: str) -> str:
    """Convert 'publisher__model' (or a prefixed 'vertex_pipe.publisher__model')
    back to the 'publisher/model' form Vertex's OpenAI-compat endpoint wants.
    """

    # OWUI sends body['model'] as '<function_id>.<entry_id>'. The function id
    # is a plain identifier without dots, but entry ids do contain dots
    # (e.g. 'google__gemini-2.5-pro'), so we strip from the left, not the
    # right. We only strip when the resulting entry id still contains the
    # publisher separator, to be safe against future OWUI changes.
    if "." in entry_id:
        head, _, tail = entry_id.partition(".")
        if _PUB_SEP in tail:
            entry_id = tail
    if _PUB_SEP not in entry_id:
        # Fall back to assuming the caller already passed publisher/model.
        return entry_id
    publisher, _, model = entry_id.partition(_PUB_SEP)
    return f"{publisher}/{model}"


class Pipe:
    """OWUI manifold Pipe presenting a curated set of Vertex AI models.

    Each line in the MODELS valve becomes one selectable model in the OWUI
    picker. The Vertex OpenAI-compat endpoint serves multiple publishers on
    one URL, so we keep a single PROJECT_ID/LOCATION and dispatch by the
    model id on each turn.

    Region note: the publishers exposed in any given region differ
    (e.g. Claude-on-Vertex availability varies by region). If a curated
    model isn't served in this LOCATION, Vertex will return 404 and we
    surface that to the chat surface verbatim.
    """

    class Valves(BaseModel):
        SERVICE_ACCOUNT_JSON: str = Field(
            default="",
            description=(
                "Full service-account key JSON (single-line or pretty-printed). "
                "Encrypted at rest by OWUI. Required."
            ),
            json_schema_extra={"input": {"type": "password"}},
        )
        PROJECT_ID: str = Field(
            default="",
            description="Google Cloud project ID. Required.",
        )
        LOCATION: str = Field(
            default="us-central1",
            description="Vertex AI region (e.g. us-central1, us-west1, global).",
        )
        MODELS: str = Field(
            default=_DEFAULT_MODELS,
            description=(
                "Comma-separated curated catalog. Each entry is "
                "'publisher/model' or 'publisher/model = Display Name'. "
                "Newlines and semicolons also work as separators. "
                "Examples: 'google/gemini-2.5-pro, "
                "anthropic/claude-sonnet-4-6 = Claude Sonnet 4.6'."
            ),
        )
        TIMEOUT_SECONDS: int = Field(
            default=300,
            description="Request timeout for chat completions (large to allow streaming).",
        )

    def __init__(self) -> None:
        self.valves = self.Valves()
        # OWUI prepends self.name to each entry's display name in the model
        # picker. Setting it to "" keeps our display names verbatim.
        self.name = ""
        self._token_cache = _TokenCache()
        self._log = logging.getLogger("vertex_pipe")
        # OWUI's plugin loader sets a sensible level; default INFO is fine.

    # ---- model surface ----------------------------------------------------

    def pipes(self) -> List[Dict[str, str]]:
        """Models this pipe exposes. OWUI calls this to populate the picker."""
        entries = _parse_models(self.valves.MODELS or "")
        if not entries:
            return [{"id": "unconfigured", "name": "Vertex (no models configured)"}]
        return [{"id": entry_id, "name": display} for entry_id, _, display in entries]

    # ---- internals --------------------------------------------------------

    def _load_sa(self) -> Dict[str, Any]:
        raw = self.valves.SERVICE_ACCOUNT_JSON.strip()
        if not raw:
            raise RuntimeError(
                "Vertex Pipe is not configured: SERVICE_ACCOUNT_JSON valve is empty."
            )
        try:
            sa = json.loads(raw)
        except json.JSONDecodeError as e:
            raise RuntimeError(
                f"SERVICE_ACCOUNT_JSON is not valid JSON: {e}"
            ) from e
        for required in ("client_email", "private_key"):
            if required not in sa:
                raise RuntimeError(
                    f"SERVICE_ACCOUNT_JSON missing required field '{required}'."
                )
        return sa

    def _bearer_token(self) -> str:
        sa = self._load_sa()
        # Fingerprint the key (not the secret itself) so cache invalidates
        # automatically when the admin rotates the SA.
        fingerprint = sa.get("private_key_id") or sa["client_email"]
        cached = self._token_cache.get(fingerprint)
        if cached:
            return cached
        token, expires_in = _mint_access_token(sa)
        self._token_cache.set(fingerprint, token, expires_in)
        self._log.info(
            "vertex_pipe: minted new access token (sa=%s, ttl=%ss)",
            sa["client_email"],
            expires_in,
        )
        return token

    def _endpoint(self) -> str:
        loc = self.valves.LOCATION or "us-central1"
        if not self.valves.PROJECT_ID:
            raise RuntimeError("Vertex Pipe is not configured: PROJECT_ID is empty.")
        host = "aiplatform.googleapis.com" if loc == "global" else f"{loc}-aiplatform.googleapis.com"
        return (
            f"https://{host}/v1/projects/{self.valves.PROJECT_ID}"
            f"/locations/{loc}/endpoints/openapi/chat/completions"
        )

    @staticmethod
    def _shape_request(body: Dict[str, Any], vertex_model: str) -> Dict[str, Any]:
        """Map OWUI's outgoing body to Vertex's OpenAI-compat schema.

        OWUI sends the model id namespaced as '<function_id>.<entry_id>'.
        We've already resolved that to the bare 'publisher/model' form
        Vertex wants. We also drop OWUI-internal metadata fields that
        Vertex would reject.
        """
        cleaned = {
            k: v
            for k, v in body.items()
            if k
            in {
                "messages",
                "temperature",
                "top_p",
                "max_tokens",
                "stream",
                "stop",
                "presence_penalty",
                "frequency_penalty",
                "seed",
                "tools",
                "tool_choice",
                "response_format",
            }
        }
        cleaned["model"] = vertex_model
        Pipe._backfill_thought_signatures(cleaned.get("messages"))
        return cleaned

    @staticmethod
    def _backfill_thought_signatures(messages: Any) -> None:
        """Inject the dummy thought-signature sentinel on tool calls that lack one.

        Gemini 3+ requires every assistant `function_call` replayed in chat
        history to carry a `thoughtSignature` (a crypto blob over the model's
        prior reasoning). Vertex enforces this strictly: a missing signature
        on any historical tool call yields HTTP 400 INVALID_ARGUMENT, which
        kills the whole conversation.

        OWUI does not preserve Gemini-specific fields when it stores and
        replays chat history, so by the time we see the request the real
        signatures are already gone. Google publishes a sentinel string,
        `skip_thought_signature_validator`, that bypasses validation on both
        Gemini API and Vertex (the other documented sentinel,
        `context_engineering_is_the_way_to_go`, is Gemini-API-only). Using
        it slightly degrades multi-turn reasoning quality (per Google's
        docs) but is far better than a 400 crash.

        The OpenAI-compat shape — empirically validated by the merged fix in
        Vercel's `@ai-sdk/openai-compatible` (PR vercel/ai#11745) — is to
        attach `extra_content.google.thought_signature` to each individual
        `tool_calls[i]`, not to the message itself.

        This is a last-pass backfill: if OWUI ever starts preserving real
        signatures upstream, we don't overwrite them.
        """
        if not isinstance(messages, list):
            return
        sentinel = "skip_thought_signature_validator"
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            if msg.get("role") != "assistant":
                continue
            tool_calls = msg.get("tool_calls")
            if not isinstance(tool_calls, list):
                continue
            for call in tool_calls:
                if not isinstance(call, dict):
                    continue
                extra = call.get("extra_content")
                if not isinstance(extra, dict):
                    extra = {}
                    call["extra_content"] = extra
                google = extra.get("google")
                if not isinstance(google, dict):
                    google = {}
                    extra["google"] = google
                if not google.get("thought_signature"):
                    google["thought_signature"] = sentinel

    # ---- the call ---------------------------------------------------------

    async def pipe(
        self, body: Dict[str, Any]
    ) -> Union[str, AsyncIterator[str], Dict[str, Any]]:
        """Entry point invoked by OWUI per chat turn.

        Streaming path returns an async iterator of raw SSE lines (the OWUI
        front-end already understands Vertex/OpenAI-compatible deltas).
        Non-streaming path returns the parsed JSON dict.
        """
        try:
            token = self._bearer_token()
            url = self._endpoint()
        except Exception as e:
            # Surface configuration errors to the chat surface as plain text;
            # OWUI will render this as the assistant message.
            return f"Vertex Pipe error: {e}"

        # Resolve the OWUI-side entry id back to Vertex's publisher/model form.
        incoming_model = body.get("model", "")
        vertex_model = _entry_to_vertex_model(incoming_model)
        if "/" not in vertex_model:
            return (
                f"Vertex Pipe error: cannot resolve model id '{incoming_model}'. "
                "Expected 'publisher__model' from the manifold; check MODELS valve."
            )

        payload = self._shape_request(body, vertex_model)
        stream = bool(payload.get("stream", False))
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        timeout = httpx.Timeout(self.valves.TIMEOUT_SECONDS, connect=15)

        if not stream:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(url, headers=headers, json=payload)
                if resp.status_code >= 400:
                    self._log.warning(
                        "vertex_pipe non-stream error: status=%s",
                        resp.status_code,
                    )
                    return f"Vertex error {resp.status_code}: {resp.text[:500]}"
                return resp.json()

        async def _stream() -> AsyncIterator[str]:
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream(
                    "POST", url, headers=headers, json=payload
                ) as resp:
                    if resp.status_code >= 400:
                        # Drain body so we can surface it to the chat
                        # surface (the user already saw their own prompt;
                        # echoing it back in the error is fine). Logs
                        # record only the status code: error bodies from
                        # Vertex echo request content and would leak PII.
                        text = (await resp.aread()).decode("utf-8", errors="replace")
                        self._log.warning(
                            "vertex_pipe stream error: status=%s",
                            resp.status_code,
                        )
                        yield f"Vertex error {resp.status_code}: {text[:500]}"
                        return
                    async for line in resp.aiter_lines():
                        # Pass SSE through verbatim; OWUI's stream parser
                        # already handles 'data: {...}' / 'data: [DONE]'.
                        if line:
                            yield f"{line}\n"

        return _stream()
