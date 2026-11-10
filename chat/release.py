#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6,<7"]
# ///
"""Deploy BayLeaf Chat images from this checkout, before committing them.

  chat/release.py deploy <component> [--dry-run]   build amd64, push to GHCR, run it in prod
  chat/release.py check [--record]                 does this checkout match what prod runs?

Components: open-webui (the Chat service), retention-cleanup (the scheduled job).

Each image carries a fingerprint of every file its Dockerfile copies. `check`
compares the running fingerprints with the files on disk; `--record` writes
chat/DEPLOYED.json only when every component matches, so the commit that
records an accepted version cannot describe something other than what runs.
The fingerprint is a bookkeeping aid, not tamper resistance.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

import yaml

ROOT = Path(__file__).resolve().parents[1]
RECORD = ROOT / "chat/DEPLOYED.json"
APP = "f1a1e758-62e9-4e99-90cb-212cab12958d"
# One public package; tags name the component.
REGISTRY, PACKAGE = "bayleaf-ucsc", "bayleaf-chat"
REPOSITORY = f"ghcr.io/{REGISTRY}/{PACKAGE}"
LABEL = "dev.bayleaf.fingerprint"
COMPONENTS = {
    "open-webui": ("services", ROOT / "chat/image/Dockerfile"),
    "retention-cleanup": ("jobs", ROOT / "chat/Dockerfile.retention"),
}


def run(*args, capture=True):
    print("+", " ".join(args), file=sys.stderr, flush=True)
    result = subprocess.run(args, cwd=ROOT, check=True, text=True,
                            stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else None


def copied_files(dockerfile):
    """Every source path named by a COPY in the Dockerfile, plus the Dockerfile."""
    paths = [dockerfile]
    for line in dockerfile.read_text().splitlines():
        words = line.split()
        if words[:1] == ["COPY"] and not any(w.startswith("--from") for w in words):
            for source in words[1:-1]:
                path = ROOT / source
                if not path.exists():
                    sys.exit(f"{dockerfile.name} copies missing path: {source}")
                paths += sorted(p for p in path.rglob("*") if p.is_file()
                                and "__pycache__" not in p.parts) if path.is_dir() else [path]
    return sorted(set(paths))


def fingerprint(component):
    digest = hashlib.sha256()
    for path in copied_files(COMPONENTS[component][1]):
        digest.update(str(path.relative_to(ROOT)).encode() + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def owui_version():
    match = re.search(r"open-webui:(v[\w.]+)@", COMPONENTS["open-webui"][1].read_text())
    return match.group(1) if match else "unknown"


def live_spec():
    return yaml.safe_load(run("doctl", "apps", "spec", "get", APP, "--context", "bayleaf"))


def entry(spec, component):
    kind = COMPONENTS[component][0]
    return next(c for c in spec[kind] if c["name"] == component)


def reference(image):
    """The pullable reference for a spec image entry (tag or digest)."""
    if image.get("tag"):
        return f"{REPOSITORY}:{image['tag']}"
    return f"{REPOSITORY}@{image['digest']}" if image.get("digest") else None


def resolve(ref):
    return json.loads(run("docker", "buildx", "imagetools", "inspect", ref,
                          "--format", "{{json .Manifest}}"))["digest"]


def image_fingerprint(ref):
    config = json.loads(run("docker", "buildx", "imagetools", "inspect",
                            ref, "--format", "{{json .Image}}"))
    if "config" not in config:  # an index: one entry per platform
        config = config.get("linux/amd64", next(iter(config.values())))
    return (config.get("config", {}).get("Labels") or {}).get(LABEL)


def deploy(component, dry_run):
    dockerfile = COMPONENTS[component][1]
    fp = fingerprint(component)
    version = f"-{owui_version()}" if component == "open-webui" else ""
    tag = f"{REPOSITORY}:{component}{version}-{fp[:12]}"
    run("docker", "build", "--platform", "linux/amd64", "--provenance=false",
        "--label", f"{LABEL}={fp}",
        "--label", "org.opencontainers.image.source=https://github.com/bayleaf-ucsc/bayleaf",
        "-f", str(dockerfile.relative_to(ROOT)), "-t", tag, ".", capture=False)
    run("docker", "push", tag, capture=False)
    digest = resolve(tag)
    if image_fingerprint(tag) != fp:
        sys.exit("Pushed image does not carry this checkout's fingerprint")

    spec = live_spec()
    target = entry(spec, component)
    for key in ("github", "dockerfile_path", "source_dir"):
        target.pop(key, None)
    # By tag, not digest: on 2026-11-10 DigitalOcean rejected a digest it had not
    # already deployed ("this specific version is not" configured) but accepted a
    # new tag. Tags embed the fingerprint and are never reused, so they pin a build.
    target["image"] = {"registry_type": "GHCR", "registry": REGISTRY,
                       "repository": PACKAGE, "tag": tag.split(":")[-1]}
    print(f"\n{component} -> {tag}\n  = {REPOSITORY}@{digest}\nfingerprint {fp[:12]}")
    if dry_run:
        print("Dry run: image pushed, production spec not changed.")
        return
    # The spec holds only DO-encrypted secret values; keep it private and short-lived.
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "spec.yaml"
        path.write_text(yaml.safe_dump(spec, sort_keys=False, width=1 << 20))
        os.chmod(path, 0o600)
        run("doctl", "apps", "update", APP, "--spec", str(path), "--wait",
            "--context", "bayleaf", capture=False)
    print("Deployed. When you like it: chat/release.py check --record, then commit.")


def check(record):
    spec, results, ok = live_spec(), {}, True
    for component in COMPONENTS:
        ref = reference(entry(spec, component).get("image") or {})
        digest = resolve(ref) if ref else None
        local = fingerprint(component)
        running = image_fingerprint(ref) if ref else None
        match = running == local
        ok &= match
        print(f"{component}: {'MATCH' if match else 'MISMATCH'}\n"
              f"  running  {ref or 'not a GHCR image'}\n           {digest}\n"
              f"           {running}\n  checkout {local}")
        results[component] = {"image": ref, "digest": digest, "fingerprint": local}
        if component == "open-webui":
            results[component] = {"owui": owui_version(), **results[component]}
    if not ok:
        sys.exit("Not recorded: redeploy, or restore the files that were deployed.")
    print("This checkout is what production runs.")
    if record:
        RECORD.write_text(json.dumps(results, indent=2) + "\n")
        print(f"Wrote {RECORD.relative_to(ROOT)}; commit it with the matching files.")


if __name__ == "__main__":
    args = sys.argv[1:]
    flags = {a for a in args if a.startswith("--")}
    words = [a for a in args if not a.startswith("--")]
    if words[:1] == ["deploy"] and len(words) == 2 and words[1] in COMPONENTS \
            and flags <= {"--dry-run"}:
        deploy(words[1], "--dry-run" in flags)
    elif words == ["check"] and flags <= {"--record"}:
        check("--record" in flags)
    else:
        sys.exit(__doc__)
