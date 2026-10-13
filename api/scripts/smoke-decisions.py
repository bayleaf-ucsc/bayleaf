# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx"]
# ///
"""Bounded production qualification with synthetic content and exact grant cleanup.

Source ~/.tokens/bayleaf-api first. Never prints or persists credentials.
"""
import json
import os

import httpx

BASE = os.environ.get("BAYLEAF_SMOKE_BASE", "https://api.bayleaf.dev")
KEY = os.environ["BAYLEAF_API_KEY"]
DECISION_MODELS = ["openrouter:cloudflare/clef-flash", "openrouter:cloudflare/clef"]
QUESTIONS = {
    "outage": {"type": "noul", "instructions": "Is a service currently unavailable?"},
    "team": {"type": "choice", "instructions": "Which team should investigate?", "criteria": {
        "engineering": "Service crashes and HTTP errors", "accounts": "Account profile changes",
    }},
    "severity": {"type": "score", "instructions": "Rate the current service disruption.",
        "criteria": ["None", "Some users affected", "All users blocked"]},
}
STATE = {"incident": "Synthetic test: checkout returns HTTP 503 for every customer right now."}
results = []
grants = []

with httpx.Client(base_url=BASE, timeout=90, follow_redirects=False) as client:
    def request(label, method, path, body=None, key=KEY, status=200):
        response = client.request(method, path, json=body,
            headers={"Authorization": f"Bearer {key}"} if key else {})
        results.append({"check": label, "status": response.status_code})
        if response.status_code != status:
            raise AssertionError(f"{label}: expected HTTP {status}, received {response.status_code}")
        return response.json()

    def decisions(label, model, key=KEY):
        value = request(label, "POST", "/v1/decisions", {
            "model": model, "state": STATE, "questions": QUESTIONS,
        }, key=key)
        answers = value["answers"]
        assert set(answers) == set(QUESTIONS)
        assert answers["outage"]["type"] == "noul" and 0 <= answers["outage"]["noul"] <= 1
        assert answers["team"]["type"] == "choice" and answers["team"]["choice"] in QUESTIONS["team"]["criteria"]
        assert answers["severity"]["type"] == "score" and 0 <= answers["severity"]["score"] <= 2
        assert value["usage"]["input_tokens"] > 0
        results[-1].update(model=value["model"], cost=value["usage"].get("cost"),
            input_tokens=value["usage"]["input_tokens"], output_tokens=value["usage"]["output_tokens"])
        return value

    try:
        catalog = request("combined model catalog", "GET", "/v1/models")["data"]
        ids = {model["id"] for model in catalog}
        assert set(DECISION_MODELS) <= ids
        text_model = next(model for model in ["openrouter:google/gemma-4-26b-a4b-it",
            "openrouter:qwen/qwen3.8-27b"] if model in ids)
        assert "openrouter:typesafe/jev-1.13" not in ids
        before = request("owner allowance before", "GET", "/v1/auth/key")["data"]
        campus = request("caller Campus Pass assessment", "GET", "/campus-pass", key=None)
        for model in DECISION_MODELS:
            decisions("ordinary key typed decisions", model)
        token = request("multi-model token issuance", "POST", "/grants", {
            "models": [text_model, *DECISION_MODELS], "expires_in": 180,
        })
        grants.append(token["grant_id"])
        assert token["models"] == [text_model, *DECISION_MODELS]
        token_key = token["access_token"]
        decisions("model-set token typed decisions", DECISION_MODELS[0], key=token_key)
        chat = request("model-set token text inference", "POST", "/v1/chat/completions", {
            "model": text_model, "messages": [{"role": "user", "content": "Reply with exactly OK."}],
            "max_tokens": 512, "reasoning": {"enabled": False},
        }, key=token_key)
        assert chat["choices"][0]["message"].get("content"), "No text completion returned"
        results[-1].update(model=chat.get("model"), cost=chat.get("usage", {}).get("cost"))
        fallback = request("ordinary-key eligible fallback routing", "POST", "/v1/chat/completions", {
            "model": text_model, "models": [text_model], "route": "fallback",
            "messages": [{"role": "user", "content": "Reply with exactly OK."}],
            "max_tokens": 512, "reasoning": {"enabled": False},
        })
        assert fallback["choices"][0]["message"].get("content")
        results[-1].update(model=fallback.get("model"), cost=fallback.get("usage", {}).get("cost"))
        for path in ["/v1/chat/completions", "/v1/responses", "/v1/completions"]:
            for candidate, expected in [(DECISION_MODELS[0], 400), ("openrouter:typesafe/jev-1.13", 403)]:
                request(f"fallback policy denial on {path}", "POST", path, {
                    "model": text_model, "models": [candidate], "route": "fallback",
                    "messages": [{"role": "user", "content": "Synthetic"}], "input": "Synthetic",
                }, status=expected)
        request("wrong text slug in decisions slot", "POST", "/v1/decisions", {
            "model": text_model, "state": STATE, "questions": QUESTIONS,
        }, key=token_key, status=400)
        request("wrong decision slug in chat slot", "POST", "/v1/chat/completions", {
            "model": DECISION_MODELS[0], "messages": [{"role": "user", "content": "Synthetic"}],
        }, key=token_key, status=400)
        request("unapproved decision model outside token set", "POST", "/v1/decisions", {
            "model": "openrouter:typesafe/jev-1.13", "state": STATE, "questions": QUESTIONS,
        }, key=token_key, status=403)
        for field, content_type in [("images", "image/png"), ("audio", "audio/wav"), ("videos", "video/mp4")]:
            request(f"{field} remains blocked", "POST", "/v1/decisions", {
                "model": DECISION_MODELS[0], "state": STATE, "questions": QUESTIONS,
                field: [{"content_type": content_type, "base64": "YWJjZA=="}],
            }, key=token_key, status=400)
        request("Campus Pass follows the caller's actual network eligibility", "POST", "/v1/decisions", {
            "model": DECISION_MODELS[0], "state": STATE, "questions": QUESTIONS,
        }, key=None, status=200 if campus["campus_network"] and campus["enabled"] else 401)
        after = request("owner allowance after", "GET", "/v1/auth/key")["data"]
        assert before.get("limit") == after.get("limit")
        assert after.get("usage", 0) >= before.get("usage", 0)
        results.append({"check": "shared owner accounting", "limit": after.get("limit"),
            "observed_usage_delta": after.get("usage", 0) - before.get("usage", 0),
            "note": "Provider usage may settle later; a zero immediate delta is not spend reconciliation."})
        request("revoke exact test grant", "DELETE", f"/grants/{token['grant_id']}")
        grants.remove(token["grant_id"])
        request("revoked token denied", "POST", "/v1/decisions", {
            "model": DECISION_MODELS[0], "state": STATE, "questions": QUESTIONS,
        }, key=token_key, status=401)
        remaining = request("verify test grant absent", "GET", "/grants")["grants"]
        assert not any(grant["id"] == token["grant_id"] for grant in remaining)
    finally:
        for grant_id in grants:
            response = client.delete(f"/grants/{grant_id}", headers={"Authorization": f"Bearer {KEY}"})
            if response.status_code != 200:
                raise RuntimeError("Could not revoke an exact smoke-test grant; owner cleanup required")

print(json.dumps({"base": BASE, "results": results}, indent=2))
