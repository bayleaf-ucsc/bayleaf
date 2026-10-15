"""Optional live OpenCode qualification. Never print or persist client output."""
import json
import os
import re
import subprocess
import tempfile


def assistant_text(stdout):
    parts = []
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            continue
        if isinstance(event, dict) and event.get("type") == "text":
            part = event.get("part", {})
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
    return "".join(parts)


def verdict(control, mutated, canary):
    if control.returncode != 0 or assistant_text(control.stdout).strip() != canary:
        return "INCONCLUSIVE"
    if assistant_text(mutated.stdout).strip():
        return "FAIL"
    diagnostic = mutated.stderr + "\n" + mutated.stdout
    # Unknown verifier wording needs investigation, not a false PASS.
    unrelated = r"plugin.{0,40}(?:load|install|not found)|unauthorized|invalid api key|model.{0,20}not found|ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network|timed? ?out|TLS|HTTP.{0,10}(?:401|403|429|5\d\d)"
    # This optional case mutates only the digest. A generic 'attestation failed'
    # may wrap a transport error, so require a digest-specific verifier diagnostic.
    refusal = r"digest.{0,60}(?:mismatch|does not match|verification failed)|invalid (?:attestation |bundle )?digest"
    if re.search(unrelated, diagnostic, re.I):
        return "INCONCLUSIVE"
    if mutated.returncode == 0:
        return "INCONCLUSIVE"
    return "PASS" if re.search(refusal, diagnostic, re.I) else "INCONCLUSIVE"


def qualify(base, bundle_url, cert, served, genuine, mutate):
    canary = "SEALED-GENUINE-CONTROL-OK"
    config = {
        "plugin": [["opencode-tinfoil@0.3.1", {"defaultProvider": False}]],
        "provider": {"bayleaf-sealed": {
            "npm": "@ai-sdk/openai-compatible", "name": "BayLeaf Sealed",
            "options": {"apiKey": os.environ.get("SEALED_AUTH", "campus"),
                        "baseURL": f"{base}/v1/",
                        "tinfoil": {"attestationBundleURL": bundle_url, "transport": "ehbp"}},
            "models": {"glm-5-3": {"name": "GLM-5.3"}},
        }},
    }
    # Empty cwd, HOME and XDG roots isolate personal/repo config and credentials.
    # Both fresh standalone processes use the same configuration and state roots.
    with tempfile.TemporaryDirectory(prefix="sealed-opencode-") as directory:
        env = {k: v for k, v in os.environ.items() if k in ("PATH", "TMPDIR", "SYSTEMROOT")}
        env.update(HOME=directory, NODE_EXTRA_CA_CERTS=cert,
                   OPENCODE_CONFIG_CONTENT=json.dumps(config))
        for kind in ("CONFIG", "DATA", "CACHE", "STATE"):
            env[f"XDG_{kind}_HOME"] = os.path.join(directory, kind.lower())
        command = ["opencode", "run", "--standalone", "--format", "json",
                   "-m", "bayleaf-sealed/glm-5-3", f"Reply with exactly {canary}"]
        try:
            served["bundle"] = genuine
            control = subprocess.run(command, cwd=directory, env=env, capture_output=True, text=True, timeout=120)
            if control.returncode != 0 or assistant_text(control.stdout).strip() != canary:
                return "INCONCLUSIVE"
            served["bundle"] = mutate(genuine)
            mutated = subprocess.run(command, cwd=directory, env=env, capture_output=True, text=True, timeout=120)
            return verdict(control, mutated, canary)
        except (OSError, subprocess.TimeoutExpired):
            return "INCONCLUSIVE"
        finally:
            served["bundle"] = genuine
