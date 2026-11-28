"""Local contract tests for the production Lathe rollout CLI."""
from contextlib import redirect_stdout
from copy import deepcopy
from importlib.util import module_from_spec, spec_from_file_location
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).with_name('lathe-rollout.py')
spec = spec_from_file_location('lathe_rollout', SCRIPT)
rollout = module_from_spec(spec)
spec.loader.exec_module(rollout)
OLD_KEY = 'synthetic-old-daytona-key'
NEW_KEY = 'synthetic-new-daytona-key'


def schema(names):
    return [{'name': name, 'parameters': {'type': 'object'}} for name in sorted(names)]


def fixture():
    grant = {'principal_type': 'group', 'principal_id': 'test-group', 'permission': 'read'}
    tool = {'id': 'lathe', 'name': 'Code Sandbox', 'user_id': 'test-owner', 'write_access': True,
            'is_active': True, 'access_grants': [grant], 'content': 'old Lathe source\n',
            'specs': schema(['bash']), 'meta': {'manifest': {'version': '1.3.3'}}}
    skill = {'id': 'code-sandbox', 'name': 'code-sandbox', 'user_id': 'test-owner', 'write_access': True,
             'is_active': True, 'access_grants': [grant.copy()], 'content': 'Old skill.\n',
             'meta': {}, 'description': 'Code Sandbox', 'version_id': 'old-skill-version'}
    valves = {'daytona_api_key': OLD_KEY, 'daytona_api_url': 'https://app.daytona.io/api',
              'daytona_proxy_url': 'https://proxy.app.daytona.io/toolbox',
              'auto_create_sandbox': False, 'auto_stop_minutes': 15,
              'preview_wrapper_key': 'synthetic-wrapper-key',
              'preview_wrapper_url': 'https://api.bayleaf.dev/previews/registrations',
              'preview_expiry_seconds': 86400, 'deployment_label': 'chat.bayleaf.dev'}
    return {'tool': tool, 'skill': skill, 'valves': valves}


class RolloutTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'stable'
        self.path.mkdir(mode=0o700)
        self.before = fixture()
        self.live = deepcopy(self.before)
        self.posts = []
        self.fail_post = None
        self.toggle_loses_response = False
        self.activate_after_source = False
        self.scopes = ['read:sandboxes', 'write:sandboxes']
        self.new_key_sync = False
        self.enterContext(patch.object(rollout, 'owui', side_effect=self.owui))
        self.key_request = self.enterContext(patch.object(rollout, 'request', side_effect=self.daytona))
        self.enterContext(patch.dict(os.environ, {'LATHE_DAYTONA_V2_KEY': NEW_KEY}))
        self.output = self.enterContext(redirect_stdout(io.StringIO()))
        rollout.save_json(self.path / 'before.json', self.before)

    def daytona(self, host, path, token):
        self.assertEqual((host, path), ('api.daytona.com', '/api-keys/current'))
        self.assertIn(token, (OLD_KEY, NEW_KEY))
        return {'project_id': 'test-project', 'sync_to_v0': token == OLD_KEY or self.new_key_sync,
                'project_permissions': self.scopes}

    def owui(self, path, payload=None, *, method='GET'):
        tool, skill = self.live['tool'], self.live['skill']
        if method == 'GET':
            return deepcopy({rollout.TOOL: tool, rollout.SKILL: skill,
                             f'{rollout.TOOL}/valves': self.live['valves']}[path])
        self.assertEqual(method, 'POST')
        self.posts.append(path)
        if path == f'{rollout.TOOL}/toggle':
            self.assertIsNone(payload)
            tool['is_active'] = not tool['is_active']
            if self.toggle_loses_response:
                raise SystemExit('Lost toggle response')
            return {'id': tool['id'], 'is_active': tool['is_active']}

        self.assertIs(tool['is_active'], False, 'Mutated OWUI with dispatch active')
        if path == self.fail_post:
            raise SystemExit('Injected write failure')
        if path == f'{rollout.TOOL}/update':
            self.assertEqual(set(payload), {'id', 'name', 'meta', 'content'})
            tool.update(deepcopy(payload))
            if tool['content'] == self.before['tool']['content']:
                tool['specs'] = self.before['tool']['specs']
                tool['meta'] = self.before['tool']['meta']
            else:
                tool['specs'] = schema(rollout.V2_TOOLS)
                tool['meta'] = {'manifest': {'version': '2.0.0'}}
            result = deepcopy(tool)
            if self.activate_after_source:
                tool['is_active'] = True
            return result
        if path == f'{rollout.TOOL}/valves/update':
            self.live['valves'] = deepcopy(payload)
            return deepcopy(payload)
        self.assertEqual(path, f'{rollout.SKILL}/update')
        self.assertEqual(payload['expected_version_id'], skill['version_id'])
        self.assertNotIn('is_active', payload)
        self.assertNotIn('access_grants', payload)
        skill.update(content=payload['content'], version_id=skill['version_id'] + '-updated')
        return deepcopy(skill)

    def test_pause_is_separate_and_an_ambiguous_toggle_is_not_retried(self):
        self.toggle_loses_response = True
        with self.assertRaisesRegex(SystemExit, 'Lost toggle response'):
            rollout.pause(self.path)
        self.assertIs(self.live['tool']['is_active'], False)
        rollout.pause(self.path)
        self.assertEqual(self.posts, [f'{rollout.TOOL}/toggle'])
        self.assertEqual(self.live['valves'], self.before['valves'])
        self.key_request.assert_not_called()

    def test_active_or_drifted_state_and_incomplete_artifacts_block_mutation(self):
        with self.assertRaisesRegex(SystemExit, 'dispatch is active'):
            rollout.promote(self.path, True)
        with self.assertRaisesRegex(SystemExit, 'dispatch is active'):
            rollout.rollback(self.path)
        self.live['tool']['is_active'] = False
        self.live['valves']['preview_wrapper_key'] = 'changed'
        with self.assertRaisesRegex(SystemExit, 'valve readback mismatch'):
            rollout.promote(self.path, True)
        self.live['valves'] = deepcopy(self.before['valves'])
        self.live['skill']['access_grants'] = []
        with self.assertRaisesRegex(SystemExit, 'access drift'):
            rollout.promote(self.path, True)
        with self.assertRaisesRegex(SystemExit, 'access drift'):
            rollout.rollback(self.path)
        incomplete = deepcopy(self.before)
        del incomplete['skill']['content']
        rollout.save_json(self.path / 'before.json', incomplete)
        with self.assertRaisesRegex(SystemExit, 'Incomplete OWUI resource'):
            rollout.rollback(self.path)
        self.assertEqual(self.posts, [])
        self.key_request.assert_not_called()

    def test_restricted_key_preflight_blocks_excess_authority(self):
        self.live['tool']['is_active'] = False
        self.scopes += ['delete:sandboxes']
        with self.assertRaisesRegex(SystemExit, 'exactly read/write'):
            rollout.promote(self.path, True, allow_v0_key_sync=True)
        self.assertEqual(self.posts, [])
        self.assertFalse((self.path / 'candidate.json').exists())

    def test_v0_sync_requires_explicit_operator_override(self):
        self.new_key_sync = True
        with self.assertRaisesRegex(SystemExit, 'explicitly allows it'):
            rollout.candidate_state(self.before)
        candidate = rollout.candidate_state(self.before, allow_v0_key_sync=True)
        self.assertEqual(candidate['valves']['daytona_api_url'], 'https://api.daytona.com')
        self.assertFalse(candidate['valves']['auto_create_sandbox'])
        self.assertEqual(self.posts, [])

    def test_partial_promotion_can_roll_back_and_retry(self):
        rollout.pause(self.path)
        self.fail_post = f'{rollout.SKILL}/update'
        with self.assertRaisesRegex(SystemExit, 'Injected write failure'):
            rollout.promote(self.path, True)
        self.assertEqual(self.live['valves']['daytona_api_key'], NEW_KEY)
        with self.assertRaisesRegex(SystemExit, 'verification is incomplete'):
            rollout.verify(self.path, False)

        self.fail_post = None
        rollout.rollback(self.path)
        rollout.verify(self.path, True)
        self.assertEqual(self.live['valves'], self.before['valves'])
        self.assertEqual(self.live['tool']['content'], self.before['tool']['content'])
        self.assertIs(self.live['tool']['is_active'], False)
        rollout.promote(self.path, True)
        rollout.verify(self.path, False)
        self.assertEqual(self.live['valves']['daytona_api_key'], NEW_KEY)
        self.assertIn('BayLeaf Chat', self.live['skill']['content'])
        self.assertEqual(self.posts.count(f'{rollout.TOOL}/toggle'), 1)
        self.assertFalse(any(key in self.output.getvalue() for key in (OLD_KEY, NEW_KEY)))

    def test_reactivation_between_updates_stops_remaining_writes(self):
        self.live['tool']['is_active'] = False
        self.activate_after_source = True
        with self.assertRaisesRegex(SystemExit, 'dispatch is active'):
            rollout.promote(self.path, True)
        self.assertEqual(self.posts, [f'{rollout.TOOL}/update'])

    def test_rollback_after_promotion_restores_skill_and_preserves_grants(self):
        rollout.pause(self.path)
        rollout.promote(self.path, True)
        self.live['tool']['access_grants'][0]['id'] = 'changed-grant-id'
        self.live['skill']['access_grants'][0]['id'] = 'changed-grant-id'
        rollout.rollback(self.path)
        self.assertEqual(self.live['skill']['content'], self.before['skill']['content'])
        self.assertEqual(self.live['skill']['is_active'], self.before['skill']['is_active'])
        rollout.verify(self.path, True)

    def test_verify_rejects_activation_schema_valve_skill_or_grant_drift(self):
        self.live['tool']['is_active'] = False
        rollout.promote(self.path, True)
        expected = deepcopy(self.live)
        changes = [
            ('tool', 'is_active', True, 'activation state'),
            ('tool', 'specs', schema(['bash']), 'specs readback'),
            ('tool', 'content', 'changed body', 'content readback'),
            ('tool', 'access_grants', [], 'access drift'),
            ('valves', 'daytona_proxy_url', 'unexpected', 'valve readback'),
            ('skill', 'content', 'changed body', 'skill readback'),
            ('skill', 'is_active', False, 'access drift'),
        ]
        for resource, field, value, message in changes:
            with self.subTest(resource=resource, field=field):
                self.live = deepcopy(expected)
                self.live[resource][field] = value
                with self.assertRaisesRegex(SystemExit, message):
                    rollout.verify(self.path, False)

    def test_backup_is_published_only_after_exports_and_readback(self):
        path = self.path.parent / 'new-snapshot'
        app = SimpleNamespace(returncode=0, stdout=json.dumps([{'id': rollout.APP, 'spec': {}}]))
        with patch.object(rollout.subprocess, 'run', return_value=app), \
                patch.object(rollout, 'export_resources', side_effect=SystemExit('Export failed')):
            with self.assertRaisesRegex(SystemExit, 'Export failed'):
                rollout.backup(path)
        self.assertFalse(path.exists())
        with patch.object(rollout.subprocess, 'run', return_value=app), \
                patch.object(rollout, 'export_resources'):
            rollout.backup(path)
        self.assertEqual(rollout.load_before(path), self.before)
        self.assertEqual(path.stat().st_mode & 0o777, 0o700)
        self.assertEqual((path / 'app.json').stat().st_mode & 0o777, 0o600)
        with self.assertRaisesRegex(SystemExit, 'already exists'):
            rollout.backup(path)


class CommandContractTest(unittest.TestCase):
    def test_cli_requires_explicit_snapshot_directory(self):
        result = subprocess.run(['python3', str(SCRIPT), 'pause'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('--snapshot-dir', result.stderr)

    def test_toggle_http_contract_does_not_follow_redirect_or_retry(self):
        response = Mock(status=302)
        connection = Mock()
        connection.getresponse.return_value = response
        with patch.object(rollout, 'HTTPSConnection', return_value=connection):
            with self.assertRaisesRegex(SystemExit, 'HTTP 302'):
                rollout.request(rollout.OWUI_HOST, f'{rollout.TOOL}/toggle', 'synthetic',
                                method='POST')
        connection.request.assert_called_once_with(
            'POST', '/api/v1/tools/id/lathe/toggle', None,
            {'Authorization': 'Bearer synthetic', 'Accept': 'application/json'})
        response.read.assert_not_called()
        connection.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
