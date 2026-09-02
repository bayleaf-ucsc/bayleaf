# BayLeaf Sealed Local Proxy

This is a generic local OpenAI-compatible proxy backed by the Tinfoil Python
SDK. The SDK verifies the Tinfoil enclave before the listener starts and
EHBP-encrypts every inference body before it reaches BayLeaf. It works with any
client that can target an OpenAI-compatible base URL.

## Run

Requires Python 3.11+ and `uv`:

```bash
export BAYLEAF_API_KEY=sk-bayleaf-...
uv run --script sealed/proxy.py
```

Campus Pass is supported on the UCSC network by setting `BAYLEAF_API_KEY=campus`.
Choose another local port with `BAYLEAF_SEALED_PORT=3311`.

The proxy intentionally has no plaintext fallback. If attestation, the BayLeaf
relay, or EHBP fails, the request fails. Do not point OpenCode at
`https://api.bayleaf.dev/sealed/v1` directly: a generic OpenAI client cannot
produce EHBP ciphertext.

## OpenCode and OpenChamber Example

Add this provider to `opencode.json` (the same OpenCode runtime is used by
OpenChamber):

```json
{
  "model": "bayleaf-sealed/gpt-oss-120b",
  "provider": {
    "bayleaf-sealed": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "BayLeaf Sealed",
      "options": {
        "baseURL": "http://127.0.0.1:3310/v1",
        "apiKey": "local-proxy"
      },
      "models": {
        "gpt-oss-120b": { "name": "gpt-oss-120b" }
      }
    }
  }
}
```

The model IDs must be the bare IDs returned by `GET https://api.bayleaf.dev/sealed/models`.
The `local-proxy` value is not a provider credential and is never forwarded.

BayLeaf receives identity, timing, sizes, request counts, and (for non-streaming
responses) token metadata. BayLeaf and Tinfoil cannot decrypt prompts or
completions. Conversation history remains local to OpenCode/OpenChamber.
