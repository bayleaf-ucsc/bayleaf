#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tinfoil", "httpx"]
# ///
"""Local, fail-closed OpenAI-compatible transport for BayLeaf Sealed.

The process is intentionally boring: any OpenAI-compatible client talks JSON
to localhost, while TinfoilAI verifies the enclave and performs EHBP locally.
BayLeaf sees only the encrypted request and the caller's relay credential.
"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import httpx
from tinfoil import TinfoilAI
from tinfoil.client import SecureClient

BASE = os.environ.get("BAYLEAF_SEALED_URL", "https://api.bayleaf.dev/sealed").rstrip("/")
KEY = os.environ.get("BAYLEAF_API_KEY")
HOST = os.environ.get("BAYLEAF_SEALED_BIND", "127.0.0.1")
PORT = int(os.environ.get("BAYLEAF_SEALED_PORT", "3310"))

if not KEY:
    raise SystemExit("BAYLEAF_API_KEY is required (use an sk-bayleaf- key or Campus Pass)")


def bayleaf_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {KEY}"}


def models() -> dict:
    response = httpx.get(f"{BASE}/models", headers=bayleaf_headers(), timeout=30)
    response.raise_for_status()
    payload = response.json()
    return {"object": "list", "data": payload.get("data", [])}


# Verify before opening the local listener. This is deliberately separate from
# the first completion so a misconfigured client cannot look healthy in the UI.
verifier = SecureClient(base_url=f"{BASE}/v1/", attestation_bundle_url=BASE)
verifier.verify()

client = TinfoilAI(
    api_key=KEY,
    base_url=f"{BASE}/v1/",
    attestation_bundle_url=BASE,
)


class Handler(BaseHTTPRequestHandler):
    server_version = "BayLeaf-Sealed-Proxy/1"

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/v1/models":
            try:
                self.send_json(200, models())
            except Exception as exc:
                self.send_json(502, {"error": {"message": f"Sealed model discovery failed: {exc}"}})
            return
        self.send_json(404, {"error": {"message": "Not found"}})

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/v1/chat/completions":
            self.send_json(404, {"error": {"message": "Only chat completions are supported"}})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            request = json.loads(self.rfile.read(length))
            response = client.chat.completions.create(**request)
            if request.get("stream"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                for event in response:
                    self.wfile.write(f"data: {event.model_dump_json()}\n\n".encode())
                    self.wfile.flush()
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                self.close_connection = True
                return
            self.send_json(200, response.model_dump())
        except Exception as exc:
            self.send_json(502, {"error": {"message": f"Sealed inference failed: {exc}"}})

    def log_message(self, fmt: str, *args: object) -> None:
        print(fmt % args, file=sys.stderr)


if __name__ == "__main__":
    print(f"BayLeaf Sealed verified proxy: http://{HOST}:{PORT}/v1", file=sys.stderr)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
