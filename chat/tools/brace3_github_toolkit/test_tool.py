"""uv run --with aiohttp --with pydantic python -m unittest discover -s chat/tools/brace3_github_toolkit"""

import base64
import inspect
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import tool

SHA = "a" * 40
PUBLIC = {"private": False, "visibility": "public", "full_name": "owner/repo", "default_branch": "main"}
MODEL = SimpleNamespace(id="brace3-94741", is_active=True, base_model_id="base", user_id="teacher",
                        meta={"bayleaf_course_id": "94741", "toolIds": [tool.TOOL_ID]})


class Response:
    def __init__(self, data=None, status=200, headers=None, next_url=None, raw=None):
        self.body = raw if raw is not None else json.dumps(data).encode()
        self.status, self.headers = status, headers or {}
        self.links = {"next": {"url": next_url}} if next_url else {}
        self.content = self

    async def iter_chunked(self, size):
        for offset in range(0, len(self.body), size):
            yield self.body[offset:offset + size]

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


class Session:
    def __init__(self, *responses):
        self.responses = iter(responses)
        self.calls = []

    def get(self, url, **kwargs):
        assert kwargs["allow_redirects"] is False
        self.calls.append((url, kwargs))
        return next(self.responses)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


class AuthorizationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.models = SimpleNamespace(get_model_by_id=AsyncMock(return_value=MODEL))
        self.groups = SimpleNamespace(get_groups_by_member_id=AsyncMock(return_value=[SimpleNamespace(id="group", name="course:94741")]))
        self.grants = SimpleNamespace(has_access=AsyncMock(return_value=True))
        modules = {"open_webui.models.models": SimpleNamespace(Models=self.models),
                   "open_webui.models.groups": SimpleNamespace(Groups=self.groups),
                   "open_webui.models.access_grants": SimpleNamespace(AccessGrants=self.grants)}
        self.module_patch = patch.dict(sys.modules, modules)
        self.module_patch.start()
        self.addCleanup(self.module_patch.stop)

    async def authorize(self, config='{"94741": {"token": "secret"}}', user=None, model=None, metadata=None):
        return await tool._authorize(config, user or {"id": "student", "role": "user"},
                                     model or {"id": "task-model"}, metadata or {"model": {"id": MODEL.id}})

    async def test_stored_metadata_and_actual_selection_not_task_model(self):
        self.assertEqual(await self.authorize(), "secret")
        self.models.get_model_by_id.assert_awaited_once_with(MODEL.id)
        self.grants.has_access.assert_awaited_once()

    async def test_course_membership_required_even_for_admin_and_owner(self):
        self.groups.get_groups_by_member_id.return_value = []
        for user in [{"id": "teacher", "role": "admin"}, {"id": "student", "role": "user"}]:
            with self.assertRaises(tool.ReadFailure):
                await self.authorize(user=user)

    async def test_model_access_separate_from_course_membership(self):
        self.grants.has_access.return_value = False
        with self.assertRaises(tool.ReadFailure):
            await self.authorize()

    async def test_no_course_or_binding_or_inactive_model_fails_closed(self):
        for changes in [dict(meta={}), dict(meta={"bayleaf_course_id": "94741", "toolIds": []}),
                        dict(is_active=False), dict(base_model_id=None),
                        dict(meta={"bayleaf_course_id": 94741, "toolIds": [tool.TOOL_ID]})]:
            self.models.get_model_by_id.return_value = SimpleNamespace(**(vars(MODEL) | changes))
            with self.assertRaises(tool.ReadFailure):
                await self.authorize()
        self.models.get_model_by_id.return_value = None
        with self.assertRaises(tool.ReadFailure):
            await self.authorize()

    async def test_credential_map_is_course_scoped_and_errors_do_not_echo_it(self):
        for config in ['{"123": {"token": "other-secret"}}', 'bad-secret-json', '[]',
                       '{"94741": {"token": ""}}', '{"94741": {"token": 123}}']:
            with self.assertRaises(tool.ReadFailure) as caught:
                await self.authorize(config=config)
            self.assertNotIn("secret", json.dumps(caught.exception.result))

    async def test_unrelated_selected_model_cannot_use_bound_model_fallback(self):
        self.models.get_model_by_id.return_value = None
        with self.assertRaises(tool.ReadFailure):
            await self.authorize(model={"id": MODEL.id}, metadata={"model": {"id": "basic"}})
        self.models.get_model_by_id.assert_awaited_once_with("basic")


class GitHubTests(unittest.IsolatedAsyncioTestCase):
    def client(self, *responses):
        session = Session(*responses)
        github = tool._GitHub(session, "secret", "owner/repo")
        github.repo = PUBLIC
        return github, session

    async def test_visibility_is_checked_anonymously_with_powerful_token(self):
        for data in [dict(PUBLIC, private=True, visibility="private"), {"private": False}, None]:
            github, session = self.client(Response(data))
            with self.assertRaises(tool.ReadFailure):
                await github.public_repository()
            self.assertNotIn("Authorization", session.calls[0][1]["headers"])
            self.assertEqual(len(session.calls), 1)
        github, _ = self.client(Response(PUBLIC))
        self.assertEqual((await github.public_repository())[0]["visibility"], "public")

    async def test_template_provenance_survives_public_projection(self):
        template = {"id": 42, "full_name": "course/starter", "html_url": "https://github.com/course/starter",
                    "private": False, "visibility": "public", "temp_clone_token": "secret", "permissions": {"admin": True}}
        github, session = self.client(Response(dict(PUBLIC, fork=False, is_template=True, template_repository=template)))
        result, _ = await github.public_repository()
        self.assertFalse(result["fork"])
        self.assertTrue(result["is_template"])
        self.assertEqual(result["provenance"]["template_repository"], {
            "state": "recorded_public", "id": 42, "full_name": "course/starter", "html_url": "https://github.com/course/starter"})
        self.assertNotIn("secret", json.dumps(result))
        self.assertNotIn("Authorization", session.calls[0][1]["headers"])

    def test_fork_parent_and_root_remain_distinct_from_template(self):
        parent = {"id": 2, "full_name": "other/fork", "private": False, "visibility": "public"}
        source = {"id": 1, "full_name": "course/original", "private": False, "visibility": "public"}
        result = tool._provenance({"parent": parent, "source": source})
        self.assertEqual(result["parent"]["id"], 2)
        self.assertEqual(result["source"]["id"], 1)
        self.assertEqual(result["template_repository"]["state"], "unavailable")

    def test_missing_null_and_nonpublic_origins_are_inconclusive_and_hidden(self):
        for data in [{}, {"template_repository": None}, {"template_repository": {"private": True, "full_name": "hidden/template"}},
                     {"template_repository": {"private": False, "visibility": "internal", "full_name": "hidden/template"}}]:
            result = tool._provenance(data)
            self.assertEqual(result["template_repository"], {"state": "unavailable"})
            self.assertNotIn("hidden", json.dumps(result))
            self.assertIn("not proof", result["interpretation"])

    async def test_repository_rename_redirect_and_private_404_fail_closed(self):
        for response in [Response({}, 301, {"Location": "https://evil.example"}),
                         Response({}, 404), Response(dict(PUBLIC, full_name="other/repo"))]:
            github, session = self.client(response)
            with self.assertRaises(tool.ReadFailure):
                await github.public_repository()
            self.assertEqual(len(session.calls), 1)

    async def test_pagination_reports_but_never_follows_server_urls(self):
        github, session = self.client(Response({"sha": SHA}), Response([{"sha": SHA, "commit": {"message": "first"}}], next_url="https://evil.example?token=secret"))
        result = await github.execute("commits", dict(ref="main", path="src/main.py", page=2, per_page=1), {}, {})
        self.assertTrue(result["has_next_page"])
        self.assertEqual(result["resolved_ref"], SHA)
        self.assertIn("page=2", session.calls[1][0])
        self.assertIn("sha=" + SHA, session.calls[1][0])
        self.assertNotIn("evil", json.dumps(result))
        self.assertEqual(len(session.calls), 2)

    async def test_read_file_pins_sha_and_has_explicit_line_ranges(self):
        github, session = self.client(Response({"sha": SHA}), Response({"type": "file", "encoding": "base64", "size": 6,
                                            "sha": "blob-sha", "path": "readme.md", "content": base64.b64encode(b"a\nb\nc\n").decode()}))
        result = await github.execute("read_file", dict(path="readme.md", ref="main", start_line=2, line_count=1), {}, {})
        self.assertEqual(result["content"], "b\n")
        self.assertEqual(result["total_lines"], 3)
        self.assertTrue(result["has_more_lines"])
        self.assertIn(SHA, result["html_url"])
        self.assertIn("ref=" + SHA, session.calls[1][0])

    async def test_binary_large_and_non_file_reads_fail(self):
        for data in [{"type": "symlink"}, {"type": "file", "encoding": "none"},
                     {"type": "file", "encoding": "base64", "size": tool.MAX_FILE_BYTES + 1},
                     {"type": "file", "encoding": "base64", "size": 1, "content": "/w=="}]:
            github, _ = self.client(Response({"sha": SHA}), Response(data))
            with self.assertRaises(tool.ReadFailure):
                await github.execute("read_file", dict(path="x", ref="main", start_line=1, line_count=1), {}, {})

    async def test_log_redirect_download_has_no_credentials(self):
        destination = "https://productionresultssa0.blob.core.windows.net/actions/log.txt?sig=private-signature"
        github, session = self.client(Response({"id": 1}), Response({}, 302, {"Location": destination}),
                                      Response(raw=b"one\n\x1b[31mtwo\x1b[0m\nthree"))
        result = await github.execute("log", dict(job_id=1, start_line=2, line_count=1), {}, {})
        self.assertEqual(result["content"], "two")
        self.assertEqual(session.calls[2][1]["headers"], {})
        self.assertNotIn("private-signature", json.dumps(result))
        self.assertTrue(result["has_more_lines"])

    async def test_unsafe_log_redirects_never_download(self):
        for destination in ["http://productionresultssa0.blob.core.windows.net/a", "https://evil.example/a",
                            "https://productionresultssa0.blob.core.windows.net.evil.example/a",
                            "https://user@productionresultssa0.blob.core.windows.net/a",
                            "https://productionresultssa0.blob.core.windows.net:444/a"]:
            github, session = self.client(Response({}, 302, {"Location": destination}))
            with self.assertRaises(tool.ReadFailure):
                await github.request("/actions/jobs/1/logs", log=True)
            self.assertEqual(len(session.calls), 1)

    async def test_second_download_redirect_is_not_followed(self):
        github, session = self.client(Response({}, 302, {"Location": "https://productionresultssa0.blob.core.windows.net/a"}),
                                      Response({}, 302, {"Location": "http://localhost"}))
        with self.assertRaises(tool.ReadFailure):
            await github.request("/actions/jobs/1/logs", log=True)
        self.assertEqual(len(session.calls), 2)

    async def test_pages_returns_partial_evidence_and_permission_limits(self):
        github, _ = self.client(Response({}, 403), Response({}, 404),
                                Response([{"id": 1, "sha": SHA, "environment": "github-pages"}], next_url="evil"),
                                Response([{"state": "success", "environment_url": "https://owner.github.io/repo"}]))
        result = await github.execute("pages", {}, {}, {})
        self.assertEqual(result["configuration"]["status"], 403)
        self.assertEqual(result["latest_build"]["status"], 404)
        self.assertEqual(result["deployments"]["items"][0]["sha"], SHA)
        self.assertTrue(result["deployments"]["has_next_page"])
        self.assertIn("does not fetch", result["interpretation"])

    async def test_response_limit_and_rate_limits(self):
        github, _ = self.client(Response(raw=b"x" * (tool.MAX_RESPONSE_BYTES + 1)))
        with self.assertRaises(tool.ReadFailure):
            await github.request()
        github, _ = self.client(Response({}, 403, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "123"}))
        with self.assertRaises(tool.ReadFailure) as caught:
            await github.request()
        self.assertEqual(caught.exception.result["rate_limit_remaining"], "0")

    async def test_compare_and_commit_report_patch_and_file_limits(self):
        github, _ = self.client(Response({"sha": SHA}), Response({"sha": SHA}),
                                Response({"commits": [], "files": [{"filename": "x", "patch": "x" * 13000}]}))
        result = await github.execute("compare", dict(base="v1", head="main", page=1, per_page=30), {}, {})
        self.assertTrue(result["files"][0]["patch_truncated"])
        self.assertEqual(len(result["files"][0]["patch"]), tool.MAX_PATCH_CHARS)
        self.assertEqual(result["base_sha"], SHA)

    async def test_commit_files_paginate_and_missing_patch_is_explicit(self):
        github, _ = self.client(Response({"sha": SHA}),
                                Response({"sha": SHA, "commit": {"message": "change"},
                                          "files": [{"filename": "image.png"}]}, next_url="evil"))
        result = await github.execute("commit", dict(ref="main", page=2, per_page=1), {}, {})
        self.assertTrue(result["has_next_page"])
        self.assertFalse(result["files"][0]["patch_available"])
        self.assertEqual(result["sha"], SHA)

    async def test_workflow_jobs_steps_and_pagination_survive_projection(self):
        github, _ = self.client(Response({"id": 1, "head_sha": SHA, "conclusion": "failure"}),
                                Response({"total_count": 2, "jobs": [{"id": 2, "name": "build",
                                          "steps": [{"number": 1, "name": "test", "conclusion": "failure"}]}]}, next_url="evil"))
        result = await github.execute("run", dict(run_id=1, page=1, per_page=1), {}, {})
        self.assertEqual(result["jobs"][0]["steps"][0]["conclusion"], "failure")
        self.assertTrue(result["jobs_pagination"]["has_next_page"])
        self.assertEqual(result["head_sha"], SHA)

    async def test_directory_cap_is_not_presented_as_complete(self):
        github, _ = self.client(Response({"sha": SHA}), Response([{"name": "x", "type": "file"}] * 1000))
        result = await github.execute("list_files", dict(path="", ref="main"), {}, {})
        self.assertTrue(result["possibly_incomplete"])
        self.assertEqual(result["limit"], 1000)

    async def test_invalid_json_and_expired_logs_are_explicit_failures(self):
        for response, log in [(Response(raw=b"not JSON"), False), (Response({}, 410), True)]:
            github, _ = self.client(response)
            with self.assertRaises(tool.ReadFailure):
                await github.request("/actions/jobs/1/logs" if log else "", log=log)

    async def test_top_level_authorization_failure_never_opens_session(self):
        with patch.object(tool, "_authorize", AsyncMock(side_effect=tool.ReadFailure("denied"))), \
             patch.object(tool.aiohttp, "ClientSession") as session:
            result = await tool.Tools().github_get_repository("owner/repo")
        self.assertEqual(result, {"failure": "denied"})
        session.assert_not_called()

    def test_path_repository_and_range_validation(self):
        for path in ["../x", "/etc/passwd", "a/../b", "a//b", "a\\b", "https://evil.example", "x\n"]:
            with self.assertRaises(tool.ReadFailure):
                tool._path(path)
        for repo in ["https://github.com/owner/repo", "owner/..", "owner/repo?x=1", "owner/repo/extra"]:
            with self.assertRaises(tool.ReadFailure):
                tool._GitHub(None, "secret", repo)
        for page, count in [(0, 30), (1, 101), (True, 1), (1, -1)]:
            with self.assertRaises(tool.ReadFailure):
                tool._page(page, count)
        self.assertEqual(tool._segment("feature/a?b"), "feature%2Fa%3Fb")

    def test_metadata_matches_named_tools_and_excludes_reserved_context(self):
        meta = json.loads((Path(__file__).parent / "meta.json").read_text())
        methods = {name: method for name, method in inspect.getmembers(tool.Tools, inspect.isfunction) if not name.startswith("_")}
        self.assertEqual(len(methods), 11)
        self.assertEqual(set(methods), {spec["name"] for spec in meta["specs"]})
        for spec in meta["specs"]:
            method = methods[spec["name"]]
            self.assertEqual(spec["description"], inspect.getdoc(method))
            params = {name for name in inspect.signature(method).parameters if name != "self" and not name.startswith("__")}
            self.assertEqual(params, set(spec["parameters"]["properties"]))
        self.assertNotIn("COURSE_GITHUB_CONFIG_JSON", json.dumps(meta["specs"]))

    async def test_account_discovery_users_and_orgs_anonymous_and_paginated(self):
        row = {"id": 1, "name": "project-copy", "full_name": "owner/project-copy",
               "private": False, "visibility": "public", "owner": {"login": "owner"},
               "fork": True, "updated_at": "2026-09-30"}
        for kind, prefix in [("User", "users"), ("Organization", "orgs")]:
            session = Session(Response({"type": kind}), Response([row], next_url="https://evil.example"))
            with patch.object(tool, "_authorize", AsyncMock(return_value="secret")), \
                 patch.object(tool.aiohttp, "ClientSession", return_value=session):
                result = await tool.Tools().github_list_repositories("owner", page=2, per_page=1)
            self.assertEqual(result["repositories"][0]["fork"], True)
            self.assertEqual(result["account_type"], kind)
            self.assertTrue(result["has_next_page"])
            self.assertIn(f"/{prefix}/owner/repos?", session.calls[1][0])
            self.assertIn("page=2", session.calls[1][0])
            self.assertTrue(all("Authorization" not in call[1]["headers"] for call in session.calls))
            self.assertNotIn("evil", json.dumps(result))

    async def test_account_listing_rejects_private_internal_or_other_owners(self):
        for row in [{"private": True, "visibility": "private"},
                    {"private": False, "visibility": "internal"},
                    {"private": False, "visibility": "public", "owner": {"login": "other"}}]:
            session = Session(Response({"type": "Organization"}), Response([dict(row, name="hidden-title")]))
            with patch.object(tool, "_authorize", AsyncMock(return_value="secret")), \
                 patch.object(tool.aiohttp, "ClientSession", return_value=session):
                result = await tool.Tools().github_list_repositories("owner")
            self.assertIn("failure", result)
            self.assertNotIn("hidden-title", json.dumps(result))

    async def test_invalid_owner_and_unauthorized_discovery_never_request(self):
        with patch.object(tool, "_authorize", AsyncMock(return_value="secret")), \
             patch.object(tool.aiohttp, "ClientSession", return_value=Session()) as session:
            for owner in ["https://github.com/owner", "../orgs", "owner/repo", "owner?x=1", ""]:
                self.assertIn("failure", await tool.Tools().github_list_repositories(owner))
        with patch.object(tool, "_authorize", AsyncMock(side_effect=tool.ReadFailure("denied"))), \
             patch.object(tool.aiohttp, "ClientSession") as session:
            self.assertEqual(await tool.Tools().github_list_repositories("owner"), {"failure": "denied"})
            session.assert_not_called()


if __name__ == "__main__":
    unittest.main()
