"""
title: Vertex Pipe
author: Adam Smith
description: Lean OpenAI-compatible pipe to Google Vertex AI. Holds a service-account JSON in an admin valve, mints short-lived access tokens locally (PyJWT), and proxies chat completions to the Vertex OpenAI-compatible endpoint. Used to demonstrate the P3-eligible inference path on BayLeaf Chat.
version: 0.1.0
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
#   ZDR posture: Vertex AI under a UCSC GCP project is governed by UC's
#   Google Cloud agreement (P3-eligible). No prompt or completion content
#   leaves UCSC's Google tenancy via this code path.

import json
import time
import logging
from typing import Any, AsyncIterator, Dict, List, Optional, Union

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


def _mint_access_token(sa_info: Dict[str, Any]) -> tuple[str, int]:
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


class Pipe:
    """OWUI Pipe presenting one Vertex AI model as a selectable model.

    Each instance of this Pipe surfaces a single Gemini model id (configured
    in valves) so admins can wire one workspace model to it with a clear,
    auditable identity ("BayLeaf Vertex Demo"). To expose multiple Vertex
    models, install the function multiple times under different ids. We
    deliberately avoid auto-discovering the model catalog: the demo's value
    is precisely that one specific model is on a P3-eligible path.
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
        MODEL_ID: str = Field(
            default="gemini-2.5-flash",
            description=(
                "Gemini model id to call. Sent to Vertex as 'google/<MODEL_ID>'. "
                "Examples: gemini-2.5-flash, gemini-2.5-pro, gemini-2.0-flash."
            ),
        )
        TIMEOUT_SECONDS: int = Field(
            default=300,
            description="Request timeout for chat completions (large to allow streaming).",
        )

    def __init__(self) -> None:
        self.valves = self.Valves()
        self.name = "Vertex AI: "
        self._token_cache = _TokenCache()
        self._log = logging.getLogger("vertex_pipe")
        # OWUI's plugin loader sets a sensible level; default INFO is fine.

    # ---- model surface ----------------------------------------------------

    def pipes(self) -> List[Dict[str, str]]:
        """Models this pipe exposes. OWUI calls this to populate the picker."""
        model_id = self.valves.MODEL_ID or "unconfigured"
        return [
            {
                "id": model_id,
                "name": f"{model_id} (Vertex)",
            }
        ]

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
    def _shape_request(body: Dict[str, Any], model_id: str) -> Dict[str, Any]:
        """Map OWUI's outgoing body to Vertex's OpenAI-compat schema.

        OWUI sends the model id namespaced as '<function_id>.<MODEL_ID>'.
        Vertex wants the bare model id prefixed with the publisher 'google/'.
        We also drop OWUI-internal metadata fields that Vertex would reject.
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
        cleaned["model"] = f"google/{model_id}"
        return cleaned

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

        payload = self._shape_request(body, self.valves.MODEL_ID)
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
                    return f"Vertex error {resp.status_code}: {resp.text[:500]}"
                return resp.json()

        async def _stream() -> AsyncIterator[str]:
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream(
                    "POST", url, headers=headers, json=payload
                ) as resp:
                    if resp.status_code >= 400:
                        # Drain body for diagnostic context, then yield error.
                        text = (await resp.aread()).decode("utf-8", errors="replace")
                        yield f"Vertex error {resp.status_code}: {text[:500]}"
                        return
                    async for line in resp.aiter_lines():
                        # Pass SSE through verbatim; OWUI's stream parser
                        # already handles 'data: {...}' / 'data: [DONE]'.
                        if line:
                            yield f"{line}\n"

        return _stream()
