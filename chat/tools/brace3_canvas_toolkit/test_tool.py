"""Run with: uv run --with aiohttp --with pydantic python -m unittest discover -s chat/tools/brace3_canvas_toolkit"""

import ast
import json
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

import tool


class CanvasUrlTest(unittest.TestCase):
    def test_course_content_and_pagination(self):
        for url in (
            "https://canvas.ucsc.edu/api/v1/courses/94741?include[]=syllabus_body",
            "https://canvas.ucsc.edu/api/v1/courses/94741/assignments?page=2&per_page=50",
            "https://canvas.ucsc.edu/api/v1/courses/94741/assignments/897740",
            "https://canvas.ucsc.edu/api/v1/courses/94741/quizzes/1234",
            "https://canvas.ucsc.edu/api/v1/courses/94741/pages/brace3-system-prompt",
        ):
            with self.subTest(url=url):
                self.assertTrue(tool._is_allowed_canvas_url(url))

    def test_other_courses_and_sensitive_routes(self):
        for url in (
            "https://canvas.ucsc.edu/api/v1/courses/92591/assignments",
            "https://canvas.ucsc.edu/api/v1/courses/94741/assignments/897740/submissions",
            "https://canvas.ucsc.edu/api/v1/courses/94741/assignments?include[]=submission",
            "https://canvas.ucsc.edu/api/v1/courses/94741/pages/%2e%2e%2fassignments",
            "https://canvas.ucsc.edu/api/v1/courses/94741/pages/../users",
            "https://canvas.ucsc.edu/api/v1/courses/94741?page=-1",
            "https://canvas.ucsc.edu/api/v1/courses/94741#fragment",
            "https://canvas.ucsc.edu.evil.example/api/v1/courses/94741",
            "http://canvas.ucsc.edu/api/v1/courses/94741",
        ):
            with self.subTest(url=url):
                self.assertFalse(tool._is_allowed_canvas_url(url))


class Response:
    def __init__(self, data, status=200, next_url=None):
        self.data = data
        self.status = status
        self.links = {"next": {"url": next_url}} if next_url else {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def json(self):
        return self.data


class Session:
    def __init__(self, *responses):
        self.responses = iter(responses)
        self.urls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    def get(self, url, **kwargs):
        assert kwargs["allow_redirects"] is False
        self.urls.append(url)
        return next(self.responses)


class CanvasToolsTests(unittest.IsolatedAsyncioTestCase):
    async def test_unpublished_direct_reads_indistinguishable_from_missing(self):
        tools = tool.Tools()
        for method, arg in [(tools.canvas_read_assignment, 1),
                            (tools.canvas_read_quiz, 2),
                            (tools.canvas_read_page, "staff-guide")]:
            for resource in [{"published": False, "body": "private"},
                             {"published": True, "hide_from_students": True},
                             {"published": True, "only_visible_to_overrides": True},
                             {"published": True, "visible_to_everyone": False},
                             {}]:
                with patch.object(tool, "_fetch", AsyncMock(return_value=resource)):
                    self.assertEqual(await method(arg), {"failure": tool.UNAVAILABLE})
        for status in [403, 404]:
            with patch.object(tool.aiohttp, "ClientSession", return_value=Session(Response({}, status))):
                self.assertEqual(await tool._fetch("token", tool.COURSE_API_URL + "/pages/missing", False),
                                 {"failure": tool.UNAVAILABLE})

    async def test_lists_hide_drafts_and_do_not_expose_omitted_titles(self):
        rows = [{"id": 1, "published": True, "name": "Student activity"},
                {"id": 2, "published": False, "name": "Staff-only material"}]
        with patch.object(tool, "_fetch", AsyncMock(return_value=rows)):
            result = await tool.Tools().canvas_list_assignments()
        self.assertEqual([row["id"] for row in result["assignments"]], [1])
        self.assertNotIn("Staff-only", json.dumps(result))

    async def test_assignment_content_and_requirements_survive_projection(self):
        resource = {"id": 1, "published": True, "description": "<p>Full instructions</p>",
                    "submission_types": ["online_upload"], "allowed_extensions": ["html", "pdf"],
                    "rubric": [{"description": "Demonstrate understanding"}],
                    "due_at": "2026-09-28T21:40:00Z", "lock_at": None,
                    "secure_params": "secret", "submission": {"user_id": 123}}
        with patch.object(tool, "_fetch", AsyncMock(return_value=resource)):
            result = await tool.Tools().canvas_read_assignment(1)
        for field in ["description", "submission_types", "allowed_extensions", "rubric"]:
            self.assertEqual(result[field], resource[field])
        self.assertEqual(result["due_at_local"], "2026-09-28T14:40:00-07:00")
        self.assertIsNone(result["lock_at_local"])
        self.assertNotIn("secure_params", result)
        self.assertNotIn("submission", result)
        self.assertNotIn("result", result)  # Individual resources are objects, not nested arrays.

    async def test_quiz_and_page_exclude_instructor_and_personal_fields(self):
        tools = tool.Tools()
        quiz = {"id": 1, "published": True, "description": "Instructions",
                "access_code": "secret", "all_dates": [{"student_ids": [123]}],
                "permissions": {"manage": True}, "question_count": 5}
        with patch.object(tool, "_fetch", AsyncMock(return_value=quiz)):
            result = await tools.canvas_read_quiz(1)
        self.assertEqual(result, {"id": 1, "published": True, "description": "Instructions", "question_count": 5})
        page = {"published": True, "body": "<p>Full body</p>", "last_edited_by": {"id": 123}}
        with patch.object(tool, "_fetch", AsyncMock(return_value=page)):
            self.assertEqual(await tools.canvas_read_page("notes"),
                             {"published": True, "body": "<p>Full body</p>"})

    async def test_syllabus_excludes_enrollments_and_retains_empty_body(self):
        with patch.object(tool, "_fetch", AsyncMock(return_value={
            "id": 94741, "workflow_state": "available", "syllabus_body": "", "enrollments": [{"user_id": 123}]
        })):
            result = await tool.Tools().canvas_read_syllabus()
        self.assertEqual(result["syllabus_body"], "")
        self.assertNotIn("enrollments", result)

    async def test_pagination_and_partial_failure(self):
        url = tool.COURSE_API_URL + "/assignments?per_page=100"
        next_url = tool.COURSE_API_URL + "/assignments?page=2&per_page=100"
        session = Session(Response([{"id": 1}], next_url=next_url), Response([{"id": 2}]))
        with patch.object(tool.aiohttp, "ClientSession", return_value=session):
            self.assertEqual(await tool._fetch("token", url, True), [{"id": 1}, {"id": 2}])
        self.assertEqual(session.urls, [url, next_url])
        session = Session(Response([{"id": 1}], next_url=next_url), Response({}, 500))
        with patch.object(tool.aiohttp, "ClientSession", return_value=session):
            self.assertIn("failure", await tool._fetch("token", url, True))

    async def test_pagination_boundary_and_cycles_before_credentials_sent(self):
        url = tool.COURSE_API_URL + "/pages?per_page=100"
        for next_url in ["https://evil.example/pages", url,
                         "https://canvas.ucsc.edu/api/v1/courses/123/pages",
                         tool.COURSE_API_URL + "/students"]:
            session = Session(Response([], next_url=next_url))
            with patch.object(tool.aiohttp, "ClientSession", return_value=session):
                self.assertIn("failure", await tool._fetch("token", url, True))
            self.assertEqual(session.urls, [url])

    async def test_invalid_slug_never_fetches(self):
        with patch.object(tool, "_fetch", AsyncMock()) as fetch:
            for slug in ["../students", "notes?include[]=all", "https://canvas.ucsc.edu/courses/1/pages/notes"]:
                self.assertIn("failure", await tool.Tools().canvas_read_page(slug))
            fetch.assert_not_called()

    def test_dst_localization(self):
        localize = tool.Tools().canvas_localize_date
        self.assertEqual(localize("2026-09-28T21:40:00Z"), "2026-09-28 14:40:00 PDT")
        self.assertEqual(localize("2026-12-01T21:40:00Z"), "2026-12-01 13:40:00 PST")

    def test_metadata_matches_public_tools(self):
        root = Path(__file__).parent
        meta = json.loads((root / "meta.json").read_text())
        tools = next(node for node in ast.parse((root / "tool.py").read_text()).body
                     if isinstance(node, ast.ClassDef) and node.name == "Tools")
        public = {node.name: node for node in tools.body
                  if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith("_")}
        self.assertEqual(set(public), {spec["name"] for spec in meta["specs"]})
        self.assertEqual(len(public), 8)
        for spec in meta["specs"]:
            node = public[spec["name"]]
            self.assertEqual(spec["description"], ast.get_docstring(node))
            self.assertEqual(set(spec["parameters"]["properties"]), {a.arg for a in node.args.args[1:]})


if __name__ == "__main__":
    unittest.main()
