#!/usr/bin/env python3
"""Coordinate the BayLeaf Lathe rollout while OWUI dispatch is paused."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
from http.client import HTTPException, HTTPSConnection
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'chat/tools/lathe/tool.py'
SKILL_SOURCE = ROOT / 'chat/skills/code-sandbox/skill.md'
OWUI_HOST = 'chat.bayleaf.dev'
TOOL = '/api/v1/tools/id/lathe'
SKILL = '/api/v1/skills/id/code-sandbox'
APP = 'f1a1e758-62e9-4e99-90cb-212cab12958d'
RETAINED = ('preview_wrapper_url', 'preview_wrapper_key', 'preview_expiry_seconds',
            'deployment_label', 'foreground_timeout_seconds', 'onboarding_instructions',
            'handbook_url')
RESOURCE_FIELDS = ('id', 'user_id', 'name')
SKILL_FIELDS = (*RESOURCE_FIELDS, 'meta', 'description', 'is_active')
V2_TOOLS = {'lathe', 'destroy', 'onboard', 'bash', 'read', 'glob', 'grep', 'write', 'edit',
            'interpret', 'view', 'show', 'peek', 'poke', 'expose'}


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def environment():
    entries = shlex.split((Path.home() / '.tokens/owui/chat-bayleaf-dev').read_text(), comments=True)
    env = {**os.environ, **dict(item.split('=', 1) for item in entries if '=' in item)}
    require(env.get('OWUI_URL', '').rstrip('/') == f'https://{OWUI_HOST}' and env.get('OWUI_TOKEN'),
            'Expected BayLeaf Chat URL and credential in the operator token file')
    env.pop('LATHE_DAYTONA_V2_KEY', None)
    return env


def cli(*args):
    result = subprocess.run(['uvx', 'owui-cli==0.7.1', *map(str, args)],
                            env=environment(), capture_output=True, text=True)
    require(result.returncode == 0, f'OWUI export failed: {args[0]} {args[1]}')


def request(host, path, token, payload=None, *, method='GET'):
    # Fixed HTTPS host, no redirects or retries. A timed-out toggle may have committed.
    connection = HTTPSConnection(host, timeout=120 if method == 'POST' else 20)
    try:
        headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/json'}
        if payload is not None:
            headers['Content-Type'] = 'application/json'
        connection.request(method, path, None if payload is None else json.dumps(payload), headers)
        response = connection.getresponse()
        require(200 <= response.status < 300, f'{method} {path} failed (HTTP {response.status})')
        return json.load(response)
    except (OSError, HTTPException, ValueError):
        raise SystemExit(f'{method} {path} failed; check live state before retrying') from None
    finally:
        connection.close()


def owui(path, payload=None, *, method='GET'):
    return request(OWUI_HOST, path, environment()['OWUI_TOKEN'], payload, method=method)


def private_directory(path):
    require(path.is_dir() and path.stat().st_mode & 0o077 == 0,
            'Snapshot directory must be private (mode 0700)')


def snapshot_path(path):
    path = path.expanduser().resolve()
    require(path != ROOT and ROOT not in path.parents,
            'Secret-bearing snapshot directory must be outside the repository')
    return path


@contextmanager
def snapshot_lock(path):
    private_directory(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('Another rollout command is using this snapshot') from None
        yield
    finally:
        os.close(descriptor)


def save_json(path, value):
    handle = tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False)
    temp = Path(handle.name)
    try:
        with handle:
            json.dump(value, handle)
            handle.write('\n')
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def load_json(path):
    try:
        require(path.is_file() and not path.is_symlink() and path.stat().st_mode & 0o077 == 0,
                f'Missing or non-private snapshot artifact: {path.name}')
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        raise SystemExit(f'Cannot read snapshot artifact: {path.name}') from None
    require(isinstance(data, dict), f'Invalid snapshot artifact: {path.name}')
    return data


def grants(resource):
    items = resource.get('access_grants')
    require(isinstance(items, list), 'Missing OWUI access grants')
    fields = ('principal_type', 'principal_id', 'permission')
    require(all(isinstance(item, dict) and all(isinstance(item.get(key), str) and item[key]
                                             for key in fields) for item in items),
            'Malformed OWUI access grants')
    # Grant IDs and timestamps can rotate without changing permission.
    return sorted(tuple(item[key] for key in fields) for item in items)


def check_resource(resource, resource_id):
    require(isinstance(resource, dict) and resource.get('id') == resource_id and
            all(isinstance(resource.get(key), str) and resource[key]
                for key in (*RESOURCE_FIELDS, 'content')) and
            isinstance(resource.get('meta'), dict) and type(resource.get('is_active')) is bool,
            f'Incomplete OWUI resource: {resource_id}')
    grants(resource)


def spec_names(specs):
    require(isinstance(specs, list) and specs and all(
        isinstance(spec, dict) and isinstance(spec.get('name'), str) and
        isinstance(spec.get('parameters'), dict) for spec in specs), 'Missing or malformed Lathe schema')
    names = {spec['name'] for spec in specs}
    require(len(names) == len(specs), 'Duplicate callable in Lathe schema')
    return names


def read_tool():
    tool = owui(TOOL)
    check_resource(tool, 'lathe')
    require(tool.get('write_access') is True, 'Operator lacks OWUI tool write access')
    spec_names(tool.get('specs'))
    return tool


def read_state():
    skill = owui(SKILL)
    check_resource(skill, 'code-sandbox')
    require(skill.get('write_access') is True and isinstance(skill.get('version_id'), str) and skill['version_id'],
            'Operator lacks skill write access or the live skill version is missing')
    valves = owui(f'{TOOL}/valves')
    require(isinstance(valves, dict), 'Missing OWUI Lathe valves')
    return {'tool': read_tool(), 'skill': skill, 'valves': valves}


def validate_valves(valves):
    require(isinstance(valves, dict) and
            all(isinstance(valves.get(key), str) and valves[key].strip()
                for key in ('daytona_api_key', 'preview_wrapper_key')) and
            valves.get('deployment_label') == OWUI_HOST and
            valves.get('preview_wrapper_url') == 'https://api.bayleaf.dev/previews/registrations' and
            type(valves.get('preview_expiry_seconds')) is int and
            60 <= valves['preview_expiry_seconds'] <= 86400 and
            valves.get('auto_create_sandbox') is False and
            all(value is not None for value in valves.values()),
            'Lathe valves are incomplete or inconsistent with BayLeaf provisioning and previews')


def load_snapshot(path):
    state = load_json(path)
    check_resource(state.get('tool'), 'lathe')
    check_resource(state.get('skill'), 'code-sandbox')
    require('description' in state['skill'], 'Snapshot is missing the skill description')
    validate_valves(state.get('valves'))
    return state


def load_before(path):
    before = load_snapshot(path / 'before.json')
    spec_names(before['tool'].get('specs'))
    require(before['valves'].get('daytona_api_url') == 'https://app.daytona.io/api' and
            before['valves'].get('daytona_proxy_url') == 'https://proxy.app.daytona.io/toolbox',
            'Snapshot must contain the old v0 control plane and Toolbox valves')
    return before


def export_resources(path):
    for resource in ('tools', 'functions', 'skills', 'models'):
        cli(resource, 'pull-all', path / resource)
    for item in path.rglob('*'):
        item.chmod(0o700 if item.is_dir() else 0o600)


def backup(path):
    require(not path.exists(), 'Snapshot already exists; refusing to overwrite it')
    before = read_state()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Publish the directory only after every pull succeeds. An interrupted export
    # cannot leave a usable-looking partial snapshot at the requested path.
    with tempfile.TemporaryDirectory(dir=path.parent, prefix='.lathe-backup-') as directory:
        staged = Path(directory) / 'snapshot'
        staged.mkdir(mode=0o700)
        save_json(staged / 'before.json', before)
        load_before(staged)
        app = subprocess.run(['doctl', 'apps', 'get', APP, '--context', 'bayleaf', '--output', 'json'],
                             capture_output=True, text=True)
        require(app.returncode == 0, 'DigitalOcean application snapshot failed')
        try:
            app_info = json.loads(app.stdout)
        except ValueError:
            raise SystemExit('Invalid DigitalOcean application snapshot') from None
        require(isinstance(app_info, list) and len(app_info) == 1 and isinstance(app_info[0], dict)
                and app_info[0].get('id') == APP and isinstance(app_info[0].get('spec'), dict),
                'Incomplete DigitalOcean application snapshot')
        save_json(staged / 'app.json', app_info)
        export_resources(staged)
        verify_state(read_state(), before, active=before['tool']['is_active'])
        require(not path.exists(), 'Snapshot already exists; refusing to overwrite it')
        staged.rename(path)
    print(f'Complete rollback snapshot saved: {path}')


def check_access(live, expected, fields=RESOURCE_FIELDS):
    require(all(live.get(field) == expected.get(field) for field in fields) and
            grants(live) == grants(expected), f'OWUI ownership, metadata or access drift: {expected["id"]}')


def check_inactive(tool):
    require(tool['is_active'] is False,
            'Lathe dispatch is active. Run pause and drain in-flight calls before continuing')


def pause(path):
    before = load_before(path)
    live = read_tool()
    require(live['user_id'] == before['tool']['user_id'], 'Lathe owner changed since backup')
    if live['is_active']:
        toggled = owui(f'{TOOL}/toggle', method='POST')
        require(isinstance(toggled, dict) and toggled.get('id') == 'lathe' and
                toggled.get('is_active') is False, 'OWUI did not confirm the Lathe pause; inspect live state')
    check_inactive(read_tool())
    print('Lathe dispatch is inactive. Drain already-running calls before continuing.')


def verify_state(live, expected, *, active=False):
    check_access(live['tool'], expected['tool'])
    require(live['tool']['is_active'] is active, 'Unexpected Lathe activation state')
    for field in ('content', 'specs', 'meta'):
        require(live['tool'][field] == expected['tool'][field], f'Lathe {field} readback mismatch')
    require(live['valves'] == expected['valves'], 'Lathe valve readback mismatch')
    check_access(live['skill'], expected['skill'], SKILL_FIELDS)
    require(live['skill']['content'] == expected['skill']['content'], 'Code Sandbox skill readback mismatch')


def candidate_state(before):
    key = os.environ.get('LATHE_DAYTONA_V2_KEY')
    require(key, 'Set LATHE_DAYTONA_V2_KEY to the dedicated v2-only Daytona project key')
    old = before['valves']
    candidate_key = request('api.daytona.com', '/api-keys/current', key)
    old_key = request('api.daytona.com', '/api-keys/current', old['daytona_api_key'])
    require(isinstance(candidate_key, dict) and isinstance(old_key, dict), 'Invalid Daytona key metadata')
    scopes = candidate_key.get('project_permissions')
    require(candidate_key.get('project_id') and candidate_key['project_id'] == old_key.get('project_id') and
            candidate_key.get('sync_to_v0') is False and isinstance(scopes, list) and
            all(isinstance(scope, str) for scope in scopes) and
            sorted(scopes) == ['read:sandboxes', 'write:sandboxes'],
            'The Lathe key must be v2-only in the same project with exactly read/write sandbox permissions')

    overrides = json.loads(SOURCE.with_name('valves.public.json').read_text())
    require(isinstance(overrides, dict) and set(overrides) == {
        'daytona_api_url', 'daytona_proxy_url', 'auto_create_sandbox',
        'sandbox_create_overrides', 'sandbox_missing_message',
    }, 'Unexpected candidate valve fields')
    valves = {name: old[name] for name in RETAINED if name in old}
    valves.update(overrides)
    valves['daytona_api_key'] = key
    validate_valves(valves)
    require(valves.get('daytona_api_url') == 'https://api.daytona.com' and
            valves.get('daytona_proxy_url') == '' and valves.get('sandbox_create_overrides') == '' and
            isinstance(valves.get('sandbox_missing_message'), str) and valves['sandbox_missing_message'].strip(),
            'Unexpected candidate valve policy')
    source = SOURCE.read_text()
    version = re.search(r'^version:\s*(2\.\d+\.\d+)$', source, re.MULTILINE)
    require(version, 'Expected vendored Lathe v2 source')
    # Match owui-cli's handling of the checked-in skill frontmatter.
    skill = re.match(r'^---\n.*?\n---\n(.*)$', SKILL_SOURCE.read_text(), re.DOTALL)
    require(skill and skill[1].strip(), 'Missing Code Sandbox skill body')
    for content in (source, skill[1], SOURCE.with_name('meta.json').read_text()):
        require(not any(secret in content for secret in (old['daytona_api_key'], old['preview_wrapper_key'], key)),
                'Credential unexpectedly present in a repository artifact')
    return {'tool': {**before['tool'], 'content': source, 'is_active': False, 'specs': None},
            'skill': {**before['skill'], 'content': skill[1]}, 'valves': valves}


def apply(live, target, *, promotion=False):
    """Update only existing resources. The toggle is deliberately a separate action."""
    tool = target['tool']
    skill = target['skill']

    def check_dispatch():
        current = read_tool()
        check_inactive(current)
        check_access(current, tool)

    if live['tool']['content'] != tool['content']:
        check_dispatch()
        updated = owui(f'{TOOL}/update', {key: tool[key] for key in ('id', 'name', 'content', 'meta')}, method='POST')
        check_resource(updated, 'lathe')
        check_inactive(updated)
        check_access(updated, tool)
        require(updated['content'] == tool['content'], 'Updated Lathe source differs from the rollout source')
        if promotion:
            require(spec_names(updated.get('specs')) == V2_TOOLS, 'Unexpected Lathe v2 callable schema')
            # OWUI regenerates the specs and manifest at source update. Require
            # a fresh independent GET to agree with its compiled response.
            tool['specs'] = updated['specs']
            tool['meta'] = updated['meta']
        else:
            require(all(updated.get(field) == tool[field] for field in ('meta', 'specs')),
                    'Restored Lathe manifest or schema does not match the snapshot')
    if live['valves'] != target['valves']:
        check_dispatch()
        owui(f'{TOOL}/valves/update', target['valves'], method='POST')
    if live['skill']['content'] != skill['content']:
        check_dispatch()
        owui(f'{SKILL}/update', {'id': skill['id'], 'name': skill['name'], 'content': skill['content'],
                               'expected_version_id': live['skill']['version_id']}, method='POST')
    verify_state(read_state(), target)


def report(state):
    print(json.dumps({'source_sha256': hashlib.sha256(state['tool']['content'].encode()).hexdigest(),
                      'upstream_lifetime_seconds': state['valves']['preview_expiry_seconds'],
                      'lathe_active': False, 'skill_active': state['skill']['is_active'],
                      'access_grants_preserved': True}))
    print('Verified while inactive. Re-enable Lathe explicitly in OWUI after operator checks.')


def promote(path, api_v2_ready):
    require(api_v2_ready, 'Confirm the shared API v2 cutover and bindings with --api-v2-ready first')
    before = load_before(path)
    live = read_state()
    check_inactive(live['tool'])
    verify_state(live, before)
    candidate = candidate_state(before)
    require(candidate['tool']['content'] != before['tool']['content'], 'Candidate source is unchanged')
    # Replace stale intent only after full baseline verification. Even a partial
    # promotion now has a durable record of the exact values to recognize.
    save_json(path / 'candidate.json', candidate)
    apply(live, candidate, promotion=True)
    save_json(path / 'candidate.json', candidate)
    report(candidate)


def rollback(path):
    before = load_before(path)
    live = read_state()
    check_inactive(live['tool'])
    check_access(live['tool'], before['tool'])
    check_access(live['skill'], before['skill'], SKILL_FIELDS)
    intent = path / 'candidate.json'
    candidate = load_snapshot(intent) if intent.exists() else before
    require(all(live[resource]['content'] in (before[resource]['content'], candidate[resource]['content'])
                for resource in ('tool', 'skill')) and live['valves'] in (before['valves'], candidate['valves']),
            'Live source, valves or skill do not match a known rollout state; review drift before rollback')
    if live['tool']['content'] == before['tool']['content']:
        require(all(live['tool'][field] == before['tool'][field] for field in ('meta', 'specs')),
                'Live v0 manifest or schema drifted; review before rollback')
    apply(live, before)
    report(before)


def verify(path, restored):
    before = load_before(path)
    expected = before if restored else load_snapshot(path / 'candidate.json')
    if not restored:
        require(expected['tool'].get('specs') is not None, 'Promotion verification is incomplete')
        require(spec_names(expected['tool']['specs']) == V2_TOOLS, 'Unexpected Lathe v2 callable schema')
        check_access(expected['tool'], before['tool'])
        check_access(expected['skill'], before['skill'], SKILL_FIELDS)
    verify_state(read_state(), expected)
    report(expected)


def reconcile(path):
    destination = path / 'after'
    require(not destination.exists(), 'After snapshot already exists; inspect it before replacing')
    destination.mkdir(mode=0o700)
    export_resources(destination)
    print(f'Full post-rollout snapshot saved for drift review: {destination}')


def reconcile_repo(path):
    candidate = SOURCE.read_bytes()
    require((path / 'after/tools/lathe/tool.py').read_bytes() == candidate,
            'After snapshot does not match the pinned candidate')
    for resource in ('tools', 'functions', 'skills', 'models'):
        cli(resource, 'pull-all', ROOT / 'chat' / resource)
    require(SOURCE.read_bytes() == candidate, 'Vendored Lathe differs from the verified after snapshot')
    print('All four resource types pulled; vendored Lathe matches the snapshot exactly')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('backup', 'pause', 'promote', 'verify', 'rollback',
                                          'reconcile', 'reconcile-repo'))
    parser.add_argument('--snapshot-dir', type=Path, required=True,
                        help='Explicit private, outside-repo directory used for every rollout command')
    parser.add_argument('--api-v2-ready', action='store_true', help='Confirm API/bindings are ready for promotion')
    parser.add_argument('--restored', action='store_true', help='With verify, check the restored v0 state')
    args = parser.parse_args()
    if (args.api_v2_ready and args.action != 'promote') or (args.restored and args.action != 'verify'):
        parser.error('--api-v2-ready is for promote; --restored is for verify')
    path = snapshot_path(args.snapshot_dir)
    if args.action == 'backup':
        backup(path)
        return
    actions = {'pause': pause, 'promote': lambda directory: promote(directory, args.api_v2_ready),
               'verify': lambda directory: verify(directory, args.restored), 'rollback': rollback,
               'reconcile': reconcile, 'reconcile-repo': reconcile_repo}
    with snapshot_lock(path):
        actions[args.action](path)


if __name__ == '__main__':
    main()
