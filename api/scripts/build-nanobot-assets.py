#!/usr/bin/env python3
"""Embed independently pinned Nanobot source; --fixture is local testing only."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

REPOSITORY = 'https://github.com/bayleaf-ucsc/nanobot-sandbox.git'
ORIGINS = {REPOSITORY, REPOSITORY.removesuffix('.git'), 'git@github.com:bayleaf-ucsc/nanobot-sandbox.git'}
FILES = {'nanobot-mcp.mjs':'nanobot-mcp.mjs',
         'bayleaf-sandboxes.md':'skills/bayleaf-sandboxes/SKILL.md'}


class BuildError(Exception):
    pass


def git(package, *args, raw=False):
    try:
        value = subprocess.check_output(['git','-C',str(package),*args],
            stderr=subprocess.DEVNULL, timeout=30).decode('utf-8')
        return value if raw else value.strip()
    except (OSError, subprocess.SubprocessError):
        raise BuildError('Cannot verify Nanobot Git publication; build refused') from None


def build(root, fixture=False):
    package = (root / 'nanobot-sandbox').resolve()
    source = {'repository':REPOSITORY, 'revision':None, 'mode':'fixture'}
    if not fixture:
        # An uninitialized directory must not accidentally inherit the parent repo.
        if Path(git(package,'rev-parse','--show-toplevel')).resolve() != package:
            raise BuildError('Nanobot must be its own initialized repository/submodule')
        revision = git(package,'rev-parse','HEAD')
        if not re.fullmatch('[a-f0-9]{40}',revision):
            raise BuildError('Nanobot needs a full Git revision')
        if git(package,'status','--porcelain','--untracked-files=all'):
            raise BuildError('Nanobot checkout is dirty; commit and publish it before deployment')
        if git(package,'remote','get-url','origin') not in ORIGINS:
            raise BuildError('Nanobot origin must be bayleaf-ucsc/nanobot-sandbox')
        advertised = git(package,'ls-remote','origin')
        refs = sorted(line.split()[1] for line in advertised.splitlines()
            if len(line.split()) == 2 and line.split()[0] == revision
            and line.split()[1].startswith(('refs/heads/','refs/tags/')))
        if not refs:
            raise BuildError('Nanobot revision is not an advertised remote branch/tag; publish a release tag')
        source.update(revision=revision, mode='published', refs=refs)
    assets = {}
    for output, path in FILES.items():
        if fixture:
            text = (package/path).read_bytes().decode('utf-8')
        else:
            # Read the verified commit, not potentially raced working-tree bytes.
            text = git(package,'show',f'{source["revision"]}:{path}',raw=True)
        if not text or len(text.encode()) > 1024*1024:
            raise BuildError('Nanobot asset missing or too large')
        assets[output] = text
    source['sha256'] = {name:hashlib.sha256(text.encode()).hexdigest() for name,text in assets.items()}
    assets['_source'] = source
    target = root / '.nanobot-assets.json'
    stage = target.with_suffix('.json.next')
    stage.write_text(json.dumps(assets)+'\n');stage.replace(target)
    return source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture',action='store_true',help='Explicitly use unpublished local files for isolated tests, not deployment')
    args = parser.parse_args()
    try:
        source = build(Path(__file__).resolve().parents[1],args.fixture)
    except (BuildError,OSError) as error:
        print(str(error) if isinstance(error,BuildError) else 'Nanobot assets unavailable',file=sys.stderr)
        return 1
    print('Built Nanobot FIXTURE assets (UNPUBLISHED; not a deployment pin)' if args.fixture
          else 'Built Nanobot published assets at '+source['revision'])
    return 0


if __name__ == '__main__':sys.exit(main())
