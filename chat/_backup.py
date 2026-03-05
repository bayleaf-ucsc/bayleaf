#!/usr/bin/env python3
"""
Backup script for BayLeaf Chat (OWUI) configuration.
Pulls models, tools, and functions from the OWUI API and writes them
into the chat/ directory structure for version control.

Usage:
    OWUI_TOKEN=<bearer-token> python3 chat/_backup.py

This script is disposable — delete it after running, or keep it for future backups.
"""

import os
import sys
import json
import base64
import urllib.request
import urllib.error

BASE_URL = "https://bayleaf.chat"
TOKEN = os.environ.get("OWUI_TOKEN", "")
CHAT_DIR = os.path.dirname(os.path.abspath(__file__))

MODEL_IDS = ["basic", "help", "brace-85291", "everett-program", "gambit", "procurement"]

# Procurement has a massive inline context; split threshold in chars
PROCUREMENT_CONTEXT_MARKER = "# PROCUREMENT CONTEXT"


def api_get(path):
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req) as resp:
            data = resp.read()
            return json.loads(data)
    except urllib.error.HTTPError as e:
        print(f"  ERROR {e.code} fetching {path}: {e.read().decode()[:200]}")
        return None


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"  wrote {path}")


def write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)
    print(f"  wrote {path}")


def write_binary(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    print(f"  wrote {path}")


def extract_profile_image(meta, model_dir):
    """Extract base64 profile image to a file, replace with relative path."""
    img_url = meta.get("profile_image_url", "")
    if img_url and img_url.startswith("data:image/"):
        # Parse data URI: data:image/png;base64,<data>
        header, b64data = img_url.split(",", 1)
        # Determine extension
        mime = header.split(";")[0].replace("data:", "")
        ext = mime.split("/")[1] if "/" in mime else "png"
        img_bytes = base64.b64decode(b64data)
        img_path = os.path.join(model_dir, f"profile.{ext}")
        write_binary(img_path, img_bytes)
        meta["profile_image_url"] = f"profile.{ext}"
    return meta


def backup_models():
    print("\n=== Models ===")
    for model_id in MODEL_IDS:
        print(f"\n--- {model_id} ---")
        data = api_get(f"/api/v1/models/model?id={model_id}")
        if not data:
            print(f"  SKIP: could not fetch {model_id}")
            continue

        model_dir = os.path.join(CHAT_DIR, "models", model_id)
        os.makedirs(model_dir, exist_ok=True)

        # Extract profile image from meta
        if "meta" in data and data["meta"]:
            data["meta"] = extract_profile_image(data["meta"], model_dir)

        # Special handling for procurement: split huge system prompt
        if model_id == "procurement" and "params" in data and "system" in data.get("params", {}):
            system = data["params"]["system"]
            marker_idx = system.find(PROCUREMENT_CONTEXT_MARKER)
            if marker_idx > 0:
                preamble = system[:marker_idx].rstrip()
                context = system[marker_idx:]
                data["params"]["system"] = preamble + f"\n\n<!-- Policy context extracted to context.md ({len(context)} chars) -->"
                write_text(os.path.join(model_dir, "context.md"), context)

        write_json(os.path.join(model_dir, "model.json"), data)


def backup_tools():
    print("\n=== Tools ===")
    tools = api_get("/api/v1/tools/")
    if not tools:
        print("  SKIP: could not fetch tools")
        return

    for tool in tools:
        tool_id = tool["id"]
        print(f"\n--- {tool_id} ---")
        tool_dir = os.path.join(CHAT_DIR, "tools", tool_id)
        os.makedirs(tool_dir, exist_ok=True)

        # Write Python source
        source = tool.pop("content", "")
        write_text(os.path.join(tool_dir, "tool.py"), source)

        # Write metadata (everything except source)
        write_json(os.path.join(tool_dir, "meta.json"), tool)


def backup_functions():
    print("\n=== Functions ===")
    # Functions list endpoint
    fn_list = api_get("/api/v1/functions/")
    if not fn_list:
        # Try fetching individually
        fn_ids = ["rate_limit_filter", "depth_limit_filter", "brace_submit_action", "brace_filter"]
        fn_list = []
        for fn_id in fn_ids:
            fn = api_get(f"/api/v1/functions/id/{fn_id}")
            if fn:
                fn_list.append(fn)

    for fn in fn_list:
        fn_id = fn["id"]
        print(f"\n--- {fn_id} ---")
        fn_dir = os.path.join(CHAT_DIR, "functions", fn_id)
        os.makedirs(fn_dir, exist_ok=True)

        # Write Python source
        source = fn.pop("content", "")
        write_text(os.path.join(fn_dir, "function.py"), source)

        # Write metadata
        write_json(os.path.join(fn_dir, "meta.json"), fn)


def main():
    if not TOKEN:
        print("Set OWUI_TOKEN environment variable to a valid bearer token.")
        sys.exit(1)

    print(f"Backing up OWUI config from {BASE_URL} to {CHAT_DIR}/")
    backup_models()
    backup_tools()
    backup_functions()
    print("\n=== Done ===")


if __name__ == "__main__":
    main()
