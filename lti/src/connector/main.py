"""BayLeaf LTI connector: FastAPI entry point.

Spike-stage single-file design. Routes:
- GET  /                  Root, lists routes for humans.
- GET  /health            Liveness check.
- GET  /lti/jwks          Public JWKS for Canvas to verify our signed assertions.
- GET  /lti/config.xml    LTI 1.1 cartridge XML for Canvas's "Add App > By URL".
- GET  /lti/register      LTI 1.3 Dynamic Registration entry point (per IMS spec).
                          Canvas's "Add App > By LTI 2 Reg URL" is *not* this:
                          that's the LTI 2.x Tool Proxy flow, separate protocol.
- GET  /lti/login         OIDC third-party-initiated login (LTI 1.3, stub).
- POST /lti/launch        LTI launch endpoint. Auto-detects LTI 1.1 vs 1.3 by
                          inspecting form params. 1.1 path verifies OAuth 1.0a
                          HMAC-SHA1 signature; 1.3 path is still stubbed.

This connector currently supports two installation paths in parallel:

  Plan A (preferred, blocked on Adonis): LTI 1.3 with a Canvas-issued client_id.
  Plan B (DIY, this branch): LTI 1.1 with a manually-shared consumer key
         and shared secret, installed via Canvas's "Add App > By URL".

Both run on the same /lti/launch endpoint via protocol auto-detection.
"""

from __future__ import annotations

import hmac
import html
import ipaddress
import json
import logging
import os
import time
from base64 import urlsafe_b64encode
from pathlib import Path
from urllib.parse import urlparse

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from oauthlib.oauth1 import RequestValidator, SignatureOnlyEndpoint

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("connector")

KEYS_DIR = Path(__file__).resolve().parents[2] / "keys"
PRIVATE_KEY_PATH = KEYS_DIR / "lti_private.pem"
PUBLIC_KEY_PATH = KEYS_DIR / "lti_public.pem"
REGISTRATION_PATH = KEYS_DIR / "registration.json"
KEY_ID = "bayleaf-lti-2026-05"  # stable kid; bump on key rotation

# Public base URL of this connector. Canvas will fetch our /lti/jwks and POST
# launches here. Override via env var if running on a different hostname.
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "https://lti.bayleaf.dev")

# Allowlist of LMS hostnames that may drive LTI 1.3 Dynamic Registration via
# `/lti/register`. The registration endpoint accepts caller-supplied URLs
# (`openid_configuration` and the `registration_endpoint` returned in its
# JSON), then makes outbound HTTP calls to them with our bearer token
# attached. Without an allowlist that's full SSRF (CodeQL py/full-ssrf,
# alert #8 on this repo). Match is exact-host or one-level-suffix:
# `instructure.com` permits `*.instructure.com` but NOT `evil-instructure.com`.
# Comma-separated; trailing dots and case are ignored.
_DEFAULT_CANVAS_HOSTS = "instructure.com,canvas.ucsc.edu"
CANVAS_ALLOWED_HOSTS = tuple(
    h.strip().lower().rstrip(".")
    for h in os.environ.get("LTI_CANVAS_HOSTS", _DEFAULT_CANVAS_HOSTS).split(",")
    if h.strip()
)

app = FastAPI(title="bayleaf-lti", version="0.0.1")


def _h(value: object) -> str:
    """HTML-escape any value for safe interpolation into an HTML response.

    The connector reflects attacker-controllable input into several debug
    HTML pages: launch claims, OIDC login params, registration error
    bodies. Without escaping, these are reflective XSS sinks (CodeQL
    py/reflective-xss alerts #4-#7 on this repo). Use this helper for
    every f-string interpolation into HTML.

    Accepts any type; coerces to str first. `quote=True` so this is also
    safe inside attribute values.
    """
    return html.escape(str(value), quote=True)


def _load_pem(env_var: str, disk_path: Path) -> bytes | None:
    """Resolve a PEM blob from either an env var or disk.

    Env var wins. This lets DO App Platform inject the keypair as encrypted
    secrets without needing a persistent volume; local dev keeps using
    on-disk PEMs in `keys/`.
    """
    pem = os.environ.get(env_var)
    if pem:
        return pem.encode("utf-8")
    if disk_path.exists():
        return disk_path.read_bytes()
    return None


def ensure_keypair() -> None:
    """Resolve a usable RSA keypair, or fail loudly.

    Three states, evaluated in order:

    1. **Production (DO):** both `LTI_PRIVATE_KEY_PEM` and `LTI_PUBLIC_KEY_PEM`
       env vars are set. Use them. The container filesystem is ephemeral on
       App Platform, so we never write to disk in this mode.

    2. **Local dev with existing keys:** env vars unset, but PEMs exist on
       disk at `keys/lti_*.pem`. Use them.

    3. **Local dev first run:** env vars unset, no on-disk PEMs, AND the
       opt-in `LTI_DEV_AUTOGEN_KEYS=1` flag is set. Generate a fresh keypair
       and persist to disk so subsequent runs find it. The opt-in is
       deliberate: silent generation in production would create a JWKS
       Canvas can't trust, with the symptom delayed until the next launch.

    Anything else is a misconfiguration and we refuse to start.
    """
    has_priv = bool(os.environ.get("LTI_PRIVATE_KEY_PEM"))
    has_pub = bool(os.environ.get("LTI_PUBLIC_KEY_PEM"))

    if has_priv and has_pub:
        log.info("keypair sourced from env vars; kid=%s", KEY_ID)
        return

    if has_priv ^ has_pub:
        # One but not both: almost certainly a deploy-time slip. Don't quietly
        # fall through to disk; the operator's intent was env-var injection.
        raise RuntimeError(
            "LTI keypair env vars are partially set: "
            f"LTI_PRIVATE_KEY_PEM={'set' if has_priv else 'unset'}, "
            f"LTI_PUBLIC_KEY_PEM={'set' if has_pub else 'unset'}. "
            "Set both or neither."
        )

    if PRIVATE_KEY_PATH.exists() and PUBLIC_KEY_PATH.exists():
        log.info("keypair sourced from disk at %s; kid=%s", KEYS_DIR, KEY_ID)
        return

    if os.environ.get("LTI_DEV_AUTOGEN_KEYS") != "1":
        raise RuntimeError(
            "No LTI keypair available. Set LTI_PRIVATE_KEY_PEM and "
            "LTI_PUBLIC_KEY_PEM env vars (production), or place PEMs at "
            f"{PRIVATE_KEY_PATH} and {PUBLIC_KEY_PATH} (local dev), or "
            "set LTI_DEV_AUTOGEN_KEYS=1 to generate fresh dev keys on disk."
        )

    log.warning(
        "LTI_DEV_AUTOGEN_KEYS=1 -- generating fresh RSA-2048 keypair at %s. "
        "Do NOT use this in production.",
        KEYS_DIR,
    )
    KEYS_DIR.mkdir(exist_ok=True)
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    PRIVATE_KEY_PATH.write_bytes(
        private.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    PUBLIC_KEY_PATH.write_bytes(
        private.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    )
    log.info("keypair written; kid=%s", KEY_ID)


def warn_if_lti_1p1_unconfigured() -> None:
    """Surface missing LTI 1.1 credentials at startup, not on first launch.

    LTI 1.1 launches will be rejected with a clear message by the verify
    path even without these set, but a startup-time warning makes prod
    misconfig visible in container boot logs instead of mid-incident.
    """
    have_key = bool(os.environ.get("LTI_1P1_CONSUMER_KEY"))
    have_secret = bool(os.environ.get("LTI_1P1_SHARED_SECRET"))
    if not (have_key and have_secret):
        log.warning(
            "LTI 1.1 not configured: LTI_1P1_CONSUMER_KEY=%s, "
            "LTI_1P1_SHARED_SECRET=%s. Launches via Canvas's "
            "Add App > By URL path will be rejected until both are set.",
            "set" if have_key else "unset",
            "set" if have_secret else "unset",
        )


def public_key_jwk() -> dict:
    """Render the public key as a JWK (RFC 7517) suitable for /lti/jwks."""
    pem = _load_pem("LTI_PUBLIC_KEY_PEM", PUBLIC_KEY_PATH)
    if pem is None:
        raise RuntimeError("public key not available (env var unset and disk path missing)")
    pub = serialization.load_pem_public_key(pem)
    nums = pub.public_numbers()  # type: ignore[attr-defined]

    def b64u_int(i: int) -> str:
        b = i.to_bytes((i.bit_length() + 7) // 8, "big")
        return urlsafe_b64encode(b).rstrip(b"=").decode("ascii")

    return {
        "kty": "RSA",
        "use": "sig",
        "alg": "RS256",
        "kid": KEY_ID,
        "n": b64u_int(nums.n),
        "e": b64u_int(nums.e),
    }


@app.on_event("startup")
def _startup() -> None:
    ensure_keypair()
    warn_if_lti_1p1_unconfigured()


@app.get("/", response_class=HTMLResponse)
def root() -> str:
    return """<!doctype html>
<html><head><title>bayleaf-lti</title></head>
<body style="font-family: system-ui; max-width: 40rem; margin: 2rem auto;">
<h1>bayleaf-lti</h1>
<p>LTI 1.1 / 1.3 connector spike. See <a href="https://github.com/bayleaf-ucsc/bayleaf/issues/42">issue #42</a>.</p>
<ul>
  <li><a href="/health">/health</a></li>
  <li><a href="/lti/jwks">/lti/jwks</a> (LTI 1.3 public JWKS)</li>
  <li><a href="/lti/config.xml">/lti/config.xml</a> (LTI 1.1 cartridge for Canvas Add App &gt; By URL)</li>
  <li><code>GET /lti/register</code> (LTI 1.3 Dynamic Registration)</li>
  <li><a href="/lti/login">/lti/login</a> (OIDC initiation, stub)</li>
  <li><code>POST /lti/launch</code> (auto-detects 1.1 vs 1.3)</li>
</ul>
</body></html>
"""


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "bayleaf-lti", "version": app.version}


@app.get("/lti/jwks")
def jwks() -> JSONResponse:
    """Public JWKS endpoint. Canvas fetches and caches this to verify our JWTs."""
    return JSONResponse({"keys": [public_key_jwk()]})


# ---------------------------------------------------------------------------
# LTI 1.3 Dynamic Registration (IMS spec, also used by Canvas's "Add App by
# Registration URL" admin UI). The flow:
#   1. Admin pastes <PUBLIC_BASE_URL>/lti/register into Canvas's Add App dialog.
#   2. Canvas iframes us with ?openid_configuration=...&registration_token=...
#   3. We GET the openid_configuration URL (Bearer registration_token) to learn
#      Canvas's registration_endpoint and its OIDC metadata.
#   4. We POST our LTI Registration body to that registration_endpoint
#      (Bearer registration_token) and get a client_id back.
#   5. We render an HTML page in the iframe that posts the LTI close message
#      to the parent window, dismissing the modal so Canvas can show the
#      admin a confirmation screen.
# ---------------------------------------------------------------------------


def build_registration_body(canvas_openid_config: dict) -> dict:
    """Build our LTI 1.3 Registration request body.

    Single-placement spike: course_navigation, LtiResourceLinkRequest. We
    request no LTI Advantage scopes (no scope string) and rely on Canvas
    fetching our JWKS for signature verification (no public_jwk inline).
    """

    base = PUBLIC_BASE_URL.rstrip("/")
    return {
        "application_type": "web",
        "grant_types": ["client_credentials", "implicit"],
        "response_types": ["id_token"],
        "token_endpoint_auth_method": "private_key_jwt",
        "client_name": "BayLeaf LTI Connector (spike)",
        "client_uri": base,
        "initiate_login_uri": f"{base}/lti/login",
        "redirect_uris": [f"{base}/lti/launch"],
        "jwks_uri": f"{base}/lti/jwks",
        "scope": "",  # no LTI Advantage services for the spike
        "https://purl.imsglobal.org/spec/lti-tool-configuration": {
            "domain": "lti.bayleaf.dev",
            "target_link_uri": f"{base}/lti/launch",
            "description": "BayLeaf LTI connector spike. Issue #42.",
            "claims": ["sub", "iss", "name", "given_name", "family_name", "email"],
            "messages": [
                {
                    "type": "LtiResourceLinkRequest",
                    "label": "BayLeaf (spike)",
                    "placements": ["course_navigation"],
                    "target_link_uri": f"{base}/lti/launch",
                    "https://canvas.instructure.com/lti/visibility": "admins",
                }
            ],
            "https://canvas.instructure.com/lti/privacy_level": "public",
            "https://canvas.instructure.com/lti/tool_id": "bayleaf-lti-spike",
            "https://canvas.instructure.com/lti/vendor": "BayLeaf / UCSC",
        },
    }


def _host_is_allowed(host: str) -> bool:
    """Match `host` against `CANVAS_ALLOWED_HOSTS`, exact or one-level suffix.

    `instructure.com` allows `instructure.com` and `*.instructure.com`,
    but NOT `evil-instructure.com` (the `.` boundary blocks substring tricks).
    """
    host = host.lower().rstrip(".")
    for allowed in CANVAS_ALLOWED_HOSTS:
        if host == allowed or host.endswith("." + allowed):
            return True
    return False


def _validate_canvas_url(url: str, *, label: str) -> str:
    """Reject anything that isn't a plausible Canvas URL.

    The connector accepts caller-supplied URLs at `/lti/register` and then
    makes authenticated outbound HTTP calls to them. Without validation
    that's a server-side request forgery primitive (CodeQL py/full-ssrf).
    Defense in layers:

    1. Must parse as an absolute https URL.
    2. Hostname must be in the configured allowlist (`LTI_CANVAS_HOSTS`).
    3. Hostname must not be a literal IP address (private or otherwise);
       Canvas Cloud only ever uses DNS names, so an IP literal is either
       a misconfiguration or an attacker probing internal infra.

    Returns the URL unchanged on success; raises HTTPException(400) on
    rejection. The `label` is included in the error message so the
    operator can tell which field tripped the check.
    """
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise HTTPException(
            status_code=400,
            detail=f"{label} must be an https:// URL (got scheme={parsed.scheme!r})",
        )
    host = parsed.hostname or ""
    if not host:
        raise HTTPException(status_code=400, detail=f"{label} has no hostname")

    # Reject IP literals outright. Canvas always uses DNS names.
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass  # not an IP literal, proceed to allowlist check
    else:
        raise HTTPException(
            status_code=400,
            detail=f"{label} hostname must be a DNS name, not an IP literal",
        )

    if not _host_is_allowed(host):
        raise HTTPException(
            status_code=400,
            detail=(
                f"{label} hostname {host!r} is not in the configured Canvas "
                f"allowlist. Set LTI_CANVAS_HOSTS to include it if this is a "
                f"legitimate LMS tenant."
            ),
        )
    return url


@app.api_route("/lti/register", methods=["GET", "POST"])
async def lti_register(request: Request) -> HTMLResponse:
    """LTI 1.3 Dynamic Registration entry point.

    Canvas iframes this URL with ?openid_configuration=...&registration_token=...
    after the admin pastes our URL into the Add App dialog. Canvas may use
    either GET or POST; the IMS spec permits both. The query string carries
    the parameters in either case.

    NOTE: Canvas's "Add App > By LTI 2 Registration URL" admin flow is
    *not* this; that's the LTI 2.x Tool Proxy flow, which doesn't apply
    to LTI 1.3 tools. Real Canvas dynamic registration arrives via a
    different admin UI (typically /developer_keys with a feature flag on).
    """
    # Be permissive about where Canvas puts the params: query string OR
    # form body (the IMS spec allows either).
    openid_url = request.query_params.get("openid_configuration")
    reg_token = request.query_params.get("registration_token")

    if (not openid_url or not reg_token) and request.method == "POST":
        try:
            form = await request.form()
            openid_url = openid_url or form.get("openid_configuration")
            reg_token = reg_token or form.get("registration_token")
        except Exception:
            pass

    if not openid_url or not reg_token:
        # Direct-browse case: explain what this endpoint does.
        return HTMLResponse(
            """<!doctype html>
<html><head><title>LTI Dynamic Registration</title></head>
<body style="font-family: system-ui; max-width: 40rem; margin: 2rem auto;">
<h1>LTI 1.3 Dynamic Registration endpoint</h1>
<p>This URL is meant to be pasted into a Canvas
<em>Admin -> Apps -> View App Configurations -> Add App -> By LTI 2 Registration URL</em>
dialog. Canvas will iframe this page with two query parameters
(<code>openid_configuration</code> and <code>registration_token</code>) to drive the
flow.</p>
<p>If you are seeing this page directly in your browser, you opened the URL
manually. That's fine; nothing has happened.</p>
</body></html>
""",
            status_code=200,
        )

    log.info(
        "dynamic registration initiated; openid_configuration=%s token_prefix=%s...",
        openid_url,
        reg_token[:6],
    )

    # Validate the caller-supplied URL BEFORE making any outbound request.
    # Without this, /lti/register is a full SSRF primitive: an attacker can
    # send us any URL and we'll GET it with a bearer token attached
    # (CodeQL py/full-ssrf, alert #8).
    openid_url = _validate_canvas_url(openid_url, label="openid_configuration")

    headers = {
        "Authorization": f"Bearer {reg_token}",
        "User-Agent": "bayleaf-lti/0.0.1",
        "Accept": "application/json",
    }

    async with httpx.AsyncClient(timeout=20.0, follow_redirects=False) as c:
        r = await c.get(openid_url, headers=headers)
        if r.status_code != 200:
            log.error("openid_configuration fetch failed: %s %s", r.status_code, r.text[:500])
            raise HTTPException(
                status_code=502,
                detail=f"Canvas openid_configuration fetch failed: {r.status_code}",
            )
        canvas_cfg = r.json()
        registration_endpoint = canvas_cfg.get("registration_endpoint")
        if not registration_endpoint:
            raise HTTPException(
                status_code=502, detail="Canvas openid_configuration missing registration_endpoint"
            )
        # Re-validate: even though we just fetched canvas_cfg from an
        # allowlisted host, the JSON body itself is attacker-influenceable
        # (an allowlisted host could be MITM'd, or a sub-host could be
        # compromised). Belt and suspenders.
        registration_endpoint = _validate_canvas_url(
            registration_endpoint, label="registration_endpoint"
        )
        log.info("registration_endpoint=%s", registration_endpoint)

        body = build_registration_body(canvas_cfg)
        log.info(
            "POST registration body: client_name=%s redirect_uris=%s scope=%r",
            body["client_name"],
            body["redirect_uris"],
            body["scope"],
        )

        post_headers = {
            **headers,
            "Content-Type": "application/json",
        }
        rr = await c.post(registration_endpoint, headers=post_headers, json=body)
        log.info("registration POST -> %s", rr.status_code)
        if rr.status_code not in (200, 201):
            # Surface Canvas's error so the admin can see what went wrong.
            log.error("registration POST failed: %s %s", rr.status_code, rr.text[:1000])
            safe_status = _h(rr.status_code)
            safe_text = _h(rr.text[:2000])
            safe_body = _h(json.dumps(body, indent=2))
            return HTMLResponse(
                f"""<!doctype html>
<html><head><title>Registration failed</title></head>
<body style="font-family: system-ui; max-width: 50rem; margin: 2rem auto;">
<h1>Registration failed</h1>
<p>Canvas rejected our registration with HTTP {safe_status}.</p>
<pre style="background:#fee;padding:1rem;white-space:pre-wrap;">{safe_text}</pre>
<p>Posted body:</p>
<pre style="background:#eef;padding:1rem;white-space:pre-wrap;">{safe_body}</pre>
</body></html>""",
                status_code=200,  # 200 so Canvas's iframe shows our error page
            )

        canvas_response = rr.json()
        client_id = canvas_response.get("client_id")
        log.info("registration created; client_id=%s", client_id)

        # Persist what we got back. The client_id is the load-bearing piece;
        # we'll need it on every future launch and service token request.
        REGISTRATION_PATH.write_text(json.dumps(canvas_response, indent=2))
        log.info("wrote %s", REGISTRATION_PATH)

    # Tell the parent Canvas window to close the iframe and show its
    # confirmation screen.
    return HTMLResponse(
        f"""<!doctype html>
<html><head><title>Registration complete</title></head>
<body style="font-family: system-ui; max-width: 40rem; margin: 2rem auto;">
<h1>Registration complete</h1>
<p>Tool registered with Canvas. <code>client_id = {_h(client_id)}</code></p>
<p>Click below to return to Canvas and confirm the installation.</p>
<button id="close-btn" onclick="closeRegistration()" style="font-size:1rem;padding:0.5rem 1rem;">
  Return to Canvas
</button>
<script>
  function closeRegistration() {{
    window.parent.postMessage({{ subject: 'org.imsglobal.lti.close' }}, '*');
  }}
  // Auto-close after a short delay; the button is a fallback if the
  // postMessage was missed.
  setTimeout(closeRegistration, 1500);
</script>
</body></html>
"""
    )


@app.get("/lti/login")
def lti_login(request: Request) -> HTMLResponse:
    """OIDC third-party-initiated login. Stubbed; will validate iss / login_hint
    and redirect to Canvas's authorization endpoint with state+nonce.
    """
    params = dict(request.query_params)
    return HTMLResponse(
        f"<h1>/lti/login (stub)</h1><pre>{_h(json.dumps(params, indent=2))}</pre>"
    )


@app.post("/lti/launch")
async def lti_launch(request: Request) -> HTMLResponse:
    """LTI launch endpoint, auto-detecting LTI 1.1 vs LTI 1.3.

    Canvas posts form-encoded data either way:
    - 1.1 launches carry oauth_consumer_key, oauth_signature, lti_message_type, etc.
    - 1.3 launches carry id_token (a JWT) and state.

    Verification:
    - 1.1: oauthlib's SignatureOnlyEndpoint with our shared secret, plus a
      replay-window check on oauth_timestamp.
    - 1.3: stubbed; will verify id_token against Canvas's JWKS once we have a
      registered client_id.
    """
    form = await request.form()
    payload = {k: str(v) for k, v in form.items()}

    if "id_token" in payload:
        # LTI 1.3 launch path. Stub for now; needs Canvas-issued client_id.
        return HTMLResponse(_render_launch_debug(
            title="/lti/launch (LTI 1.3, stub)",
            note="Real verification requires a registered client_id. Currently dumping raw form.",
            payload=payload,
        ))

    if "oauth_consumer_key" in payload and "oauth_signature" in payload:
        # LTI 1.1 launch path. Verify OAuth 1.0a HMAC-SHA1 signature.
        ok, why = _verify_lti_1p1(request, payload)
        if not ok:
            log.warning("LTI 1.1 launch REJECTED: %s", why)
            return HTMLResponse(
                f"<h1>Launch rejected</h1><p>{_h(why)}</p>"
                f"<details><summary>params</summary>"
                f"<pre>{_h(json.dumps(payload, indent=2))}</pre></details>",
                status_code=401,
            )
        log.info(
            "LTI 1.1 launch VERIFIED: user=%r role=%r context=%r",
            payload.get("lis_person_name_full"),
            payload.get("roles"),
            payload.get("context_title"),
        )
        return HTMLResponse(_render_launch_debug(
            title="/lti/launch (LTI 1.1, signature verified)",
            note=f"Welcome, {payload.get('lis_person_name_full', '?')}.",
            payload=payload,
        ))

    return HTMLResponse(
        f"<h1>/lti/launch</h1><p>Unrecognized launch shape (no id_token, no oauth_*).</p>"
        f"<pre>{_h(json.dumps(payload, indent=2))}</pre>",
        status_code=400,
    )


# ---------------------------------------------------------------------------
# LTI 1.1 launch verification (OAuth 1.0a HMAC-SHA1).
# ---------------------------------------------------------------------------


def _expected_consumer_key() -> str:
    return os.environ.get("LTI_1P1_CONSUMER_KEY", "")


def _expected_shared_secret() -> str:
    return os.environ.get("LTI_1P1_SHARED_SECRET", "")


# In-memory nonce cache. Crude but adequate for a spike with a single launching
# user. A production implementation would use Redis or a DB with TTL eviction.
_seen_nonces: dict[str, float] = {}
_NONCE_WINDOW_SECONDS = 5 * 60  # accept timestamps within +/- 5 minutes


class _BayLeafOAuth1Validator(RequestValidator):
    """oauthlib RequestValidator wired to our single-secret configuration.

    oauthlib's design assumes a multi-tenant OAuth provider. We have exactly
    one consumer (Canvas) and one shared secret (in .env). Most callbacks
    just answer 'is this our key' and 'what's its secret'.
    """

    enforce_ssl = True
    timestamp_lifetime = _NONCE_WINDOW_SECONDS
    # oauthlib has length floors that are stricter than what Canvas sends.
    # Canvas's oauth_nonce is typically ~32 chars, well above any realistic floor.
    nonce_length = (20, 64)
    client_key_length = (10, 60)

    @property
    def allowed_signature_methods(self) -> list[str]:
        # Canvas sends HMAC-SHA1 by default; PLAINTEXT and RSA-SHA1 are also
        # in the OAuth 1.0a spec but Canvas does not use them for LTI 1.1.
        return ["HMAC-SHA1"]

    @property
    def safe_characters(self) -> set[str]:
        # Default oauthlib safe set excludes some characters Canvas uses
        # in oauth_nonce. Permissive: any printable ASCII.
        return set(chr(i) for i in range(0x20, 0x7F))

    def get_client_secret(self, client_key: str, request) -> str:
        # The "&" suffix is OAuth 1.0a's signing-key construction for the
        # 2-legged flow (no token secret). oauthlib appends the "&" itself
        # in `signature.signing_base_string`; here we just return the secret.
        return _expected_shared_secret()

    def validate_client_key(self, client_key: str, request) -> bool:
        return hmac.compare_digest(client_key, _expected_consumer_key())

    def validate_timestamp_and_nonce(
        self, client_key, timestamp, nonce, request, request_token=None, access_token=None
    ) -> bool:
        # oauthlib already checks timestamp is within `timestamp_lifetime`.
        # Add a per-process nonce cache for replay protection.
        now = time.time()
        # Evict old entries while we're here (cheap O(n) cleanup).
        for k, t in list(_seen_nonces.items()):
            if now - t > _NONCE_WINDOW_SECONDS:
                _seen_nonces.pop(k, None)
        cache_key = f"{client_key}:{timestamp}:{nonce}"
        if cache_key in _seen_nonces:
            return False
        _seen_nonces[cache_key] = now
        return True

    # The remaining required methods are for 3-legged OAuth (request tokens,
    # access tokens, callback URIs). LTI 1.1 launches are 2-legged so these
    # never run; oauthlib still requires them to exist.
    @property
    def dummy_client(self) -> str:
        return "dummy_client"

    @property
    def dummy_request_token(self) -> str:
        return "dummy_request_token"

    @property
    def dummy_access_token(self) -> str:
        return "dummy_access_token"

    def validate_request_token(self, *a, **k) -> bool: return False
    def validate_access_token(self, *a, **k) -> bool: return False
    def validate_redirect_uri(self, *a, **k) -> bool: return True
    def validate_realms(self, *a, **k) -> bool: return True
    def validate_requested_realms(self, *a, **k) -> bool: return True
    def validate_verifier(self, *a, **k) -> bool: return False
    def get_default_realms(self, *a, **k) -> list[str]: return []
    def get_realms(self, *a, **k) -> list[str]: return []
    def get_redirect_uri(self, *a, **k) -> str: return ""
    def get_request_token_secret(self, *a, **k) -> str: return ""
    def get_access_token_secret(self, *a, **k) -> str: return ""
    def save_request_token(self, *a, **k) -> None: return None
    def save_access_token(self, *a, **k) -> None: return None
    def save_verifier(self, *a, **k) -> None: return None


def _verify_lti_1p1(request: Request, payload: dict[str, str]) -> tuple[bool, str]:
    """Verify an LTI 1.1 launch's OAuth 1.0a signature.

    Returns (ok, reason). On failure, reason is a short human-readable
    explanation suitable to render on a debug page; do not include any
    cryptographic detail that would help forge a future request.
    """
    if not _expected_consumer_key() or not _expected_shared_secret():
        return False, "server is not configured for LTI 1.1 (missing key/secret)"

    # We need to give oauthlib the EXACT URI Canvas signed against. Since
    # this connector lives behind Cloudflare Tunnel, request.url already
    # reflects the public URL Canvas posted to; that's what we want.
    uri = str(request.url)
    method = request.method
    headers = dict(request.headers)
    body = "&".join(
        f"{_pct(k)}={_pct(v)}" for k, v in payload.items()
    )

    endpoint = SignatureOnlyEndpoint(_BayLeafOAuth1Validator())
    valid, _request_obj = endpoint.validate_request(uri, method, body, headers)
    return (valid, "ok" if valid else "OAuth 1.0a signature verification failed")


def _pct(s: str) -> str:
    """OAuth 1.0a percent-encoding: RFC 3986 unreserved + everything else %-encoded."""
    from urllib.parse import quote
    return quote(s, safe="-._~")


# ---------------------------------------------------------------------------
# LTI 1.1 cartridge XML for Canvas's "Add App > By URL" admin install path.
# Canvas fetches this URL and parses the placement metadata. After install,
# Canvas POSTs LTI 1.1 launches to <launch_url> with an OAuth 1.0a signature
# computed against the shared secret we manually agreed on at install time.
# ---------------------------------------------------------------------------


@app.get("/lti/config.xml")
def lti_1p1_cartridge() -> Response:
    base = PUBLIC_BASE_URL.rstrip("/")
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<cartridge_basiclti_link
    xmlns="http://www.imsglobal.org/xsd/imslticc_v1p0"
    xmlns:blti="http://www.imsglobal.org/xsd/imsbasiclti_v1p0"
    xmlns:lticm="http://www.imsglobal.org/xsd/imslticm_v1p0"
    xmlns:lticp="http://www.imsglobal.org/xsd/imslticp_v1p0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://www.imsglobal.org/xsd/imslticc_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticc_v1p0.xsd
                        http://www.imsglobal.org/xsd/imsbasiclti_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imsbasiclti_v1p0p1.xsd
                        http://www.imsglobal.org/xsd/imslticm_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticm_v1p0.xsd
                        http://www.imsglobal.org/xsd/imslticp_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticp_v1p0.xsd">
  <blti:title>BayLeaf (spike)</blti:title>
  <blti:description>BayLeaf LTI connector spike. Issue #42.</blti:description>
  <blti:launch_url>{base}/lti/launch</blti:launch_url>
  <blti:secure_launch_url>{base}/lti/launch</blti:secure_launch_url>
  <blti:vendor>
    <lticp:code>bayleaf-ucsc</lticp:code>
    <lticp:name>BayLeaf / UCSC</lticp:name>
  </blti:vendor>
  <blti:extensions platform="canvas.instructure.com">
    <lticm:property name="tool_id">bayleaf-lti-spike</lticm:property>
    <lticm:property name="privacy_level">public</lticm:property>
    <lticm:property name="domain">lti.bayleaf.dev</lticm:property>
    <lticm:options name="course_navigation">
      <lticm:property name="text">BayLeaf (spike)</lticm:property>
      <lticm:property name="enabled">true</lticm:property>
      <lticm:property name="default">enabled</lticm:property>
      <lticm:property name="visibility">admins</lticm:property>
    </lticm:options>
  </blti:extensions>
  <cartridge_bundle identifierref="BLTI001_Bundle"/>
  <cartridge_icon identifierref="BLTI001_Icon"/>
</cartridge_basiclti_link>
"""
    return Response(content=xml, media_type="application/xml; charset=utf-8")


# ---------------------------------------------------------------------------
# Shared launch debug rendering.
# ---------------------------------------------------------------------------


def _render_launch_debug(*, title: str, note: str, payload: dict) -> str:
    """Render the launch debug page. ALL inputs are HTML-escaped: callers
    pass plain text, never pre-formatted HTML. This is the inversion of
    the original design and the load-bearing piece of the XSS fix."""
    safe_title = _h(title)
    safe_note = _h(note)
    safe_payload = _h(json.dumps(payload, indent=2))
    return f"""<!doctype html>
<html><head><title>{safe_title}</title></head>
<body style="font-family: system-ui; max-width: 50rem; margin: 2rem auto;">
<h1>{safe_title}</h1>
<p>{safe_note}</p>
<h2>Launch claims</h2>
<pre style="background:#eef;padding:1rem;white-space:pre-wrap;">{safe_payload}</pre>
</body></html>"""


# ---------------------------------------------------------------------------
# Debug echo. Useful for inspecting tunnel/proxy behavior. Disabled by default.
# Enable with DEBUG_ECHO=1 in .env. Not for production.
# ---------------------------------------------------------------------------
if os.environ.get("DEBUG_ECHO") == "1":

    @app.api_route("/debug/echo", methods=["GET", "POST"])
    async def debug_echo(request: Request) -> JSONResponse:
        body = (await request.body()).decode("utf-8", errors="replace")
        return JSONResponse(
            {
                "method": request.method,
                "url": str(request.url),
                "client": (request.client.host if request.client else None),
                "headers": dict(request.headers),
                "query": dict(request.query_params),
                "body": body[:2000],
            }
        )
