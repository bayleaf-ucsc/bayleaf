import importlib.util
import unittest
from html.parser import HTMLParser
from pathlib import Path
from unittest.mock import patch

import yaml


spec = importlib.util.spec_from_file_location("brace3_submit_action", Path(__file__).with_name("function.py"))
action = importlib.util.module_from_spec(spec)
spec.loader.exec_module(action)


class SubmitActionTests(unittest.TestCase):
    def test_assignment_url_is_confined_to_this_course(self):
        self.assertEqual(action.assignment_id_from_url(
            "https://canvas.ucsc.edu/courses/94741/assignments/12345"), 12345)
        for url in (
            "https://canvas.ucsc.edu/courses/85291/assignments/12345",
            "https://canvas.ucsc.edu.evil.test/courses/94741/assignments/12345",
            "https://canvas.ucsc.edu@evil.test/courses/94741/assignments/12345",
            "http://canvas.ucsc.edu/courses/94741/assignments/12345",
            "https://canvas.ucsc.edu/courses/94741/assignments/12345/other",
            "https://canvas.ucsc.edu/courses/94741/assignments/12345?foo=bar",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                action.assignment_id_from_url(url)

    def test_assignment_auto_detected_anywhere_in_user_branch(self):
        branch = [
            {"role": "user", "content": "Let's talk before I link anything."},
            {"role": "assistant", "content": "https://canvas.ucsc.edu/courses/94741/assignments/111"},
            {"role": "user", "content": "Here it is:\nhttps://canvas.ucsc.edu/courses/94741/assignments/897740."},
        ]
        self.assertEqual(action.assignment_id_from_user_messages(branch), 897740)

    def test_ambiguous_or_absent_url_requires_input(self):
        url = "https://canvas.ucsc.edu/courses/94741/assignments/897740"
        for branch in (
            [{"role": "user", "content": "No link yet"}],
            [{"role": "assistant", "content": url}],
            [{"role": "user", "content": url}, {"role": "user", "content": url}],
            [{"role": "user", "content": url}, {"role": "user", "content": url.replace("897740", "12345")}],
            [{"role": "user", "content": url + "/other"}],
            [{"role": "user", "content": "https://canvas.ucsc.edu.evil.test/courses/94741/assignments/897740"}],
            [{"role": "user", "content": "https://canvas.ucsc.edu@evil.test/courses/94741/assignments/897740"}],
        ):
            with self.subTest(branch=branch):
                self.assertIsNone(action.assignment_id_from_user_messages(branch))

    def test_transcript_escapes_content_and_excludes_system_messages(self):
        document = action.conversation_html([
            {"role": "system", "content": "private system prompt"},
            {"role": "user", "content": '<script>alert("oops")</script>'},
            {"role": "assistant", "content": "Hello"},
        ])
        self.assertNotIn("private system prompt", document)
        self.assertNotIn("<script>", document)
        self.assertIn("&lt;script&gt;", document)
        self.assertIn("Hello", document)

    def test_structured_output_has_tools_reasoning_and_replies(self):
        history = {"history": {"messages": {
            "u": {"id": "u", "role": "user", "content": "hello", "timestamp": 100, "parentId": None},
            "a": {"id": "a", "role": "assistant", "content": "flattened answer", "timestamp": 101,
                  "parentId": "u", "output": [
                      {"type": "reasoning", "id": "r1", "started_at": 102, "content": [{"type": "output_text", "text": "think <carefully>"}]},
                      {"type": "function_call", "id": "c1", "call_id": "call_1", "name": "ask_user", "arguments": '{"prompt":"a <question>"}'},
                      {"type": "function_call_output", "id": "o1", "call_id": "call_1", "output": [{"type": "text", "text": "private <answer>"}]},
                      {"type": "reasoning", "started_at": 105, "content": []},
                      {"type": "message", "content": [{"type": "output_text", "text": "done"}]},
                  ]},
            "other": {"role": "assistant", "content": "other branch", "parentId": "u"},
        }}}
        document = action.conversation_html(action.branch_to_message(history, "a"), "chat-1", 897740)
        self.assertIn("class='event event--function-call tool' open", document)
        self.assertIn("prompt: a &lt;question&gt;", document)
        self.assertIn("class='event event--function-call-output tool-result' open", document)
        self.assertIn("|-", document)
        self.assertIn("private &lt;answer&gt;", document)
        self.assertNotIn("exact tool time not recorded", document)
        self.assertIn("<summary>Reasoning · <time datetime=", document)
        self.assertIn("think &lt;carefully&gt;", document)
        self.assertIn("done", document)
        self.assertNotIn("flattened answer", document)
        self.assertNotIn("other branch", document)

        class Structure(HTMLParser):
            def __init__(self):
                super().__init__()
                self.elements = []
                self.pre = None
                self.yaml_payloads = []

            def handle_starttag(self, tag, attrs):
                attrs = dict(attrs)
                self.elements.append((tag, attrs))
                if tag == "pre" and attrs.get("data-format") == "yaml":
                    self.pre = ""

            def handle_data(self, text):
                if self.pre is not None:
                    self.pre += text

            def handle_endtag(self, tag):
                if tag == "pre" and self.pre is not None:
                    self.yaml_payloads.append(yaml.safe_load(self.pre))
                    self.pre = None

        parsed = Structure()
        parsed.feed(document)
        article = next(attrs for tag, attrs in parsed.elements if tag == "article")
        self.assertEqual({key: article[key] for key in ("data-schema", "data-schema-version", "data-chat-id", "data-assignment-id")},
                         {"data-schema": "brace3-transcript", "data-schema-version": "1", "data-chat-id": "chat-1", "data-assignment-id": "897740"})
        turns = [attrs for tag, attrs in parsed.elements if tag == "section"]
        self.assertEqual([(t["data-role"], t["data-turn-index"], t["data-message-id"]) for t in turns],
                         [("user", "0", "u"), ("assistant", "1", "a")])
        calls = [attrs for tag, attrs in parsed.elements if tag == "details" and attrs.get("data-event-type") == "function_call"]
        results = [attrs for tag, attrs in parsed.elements if tag == "details" and attrs.get("data-event-type") == "function_call_output"]
        self.assertEqual((calls[0]["data-event-index"], calls[0]["data-call-id"], calls[0]["data-tool-name"]),
                         ("1", "call_1", "ask_user"))
        self.assertEqual(results[0]["data-call-id"], "call_1")
        self.assertNotIn("data-timestamp", calls[0])
        self.assertEqual(parsed.yaml_payloads, [{"prompt": "a <question>"}, "private <answer>"])

    def test_missing_branch_fails_closed(self):
        with self.assertRaises(ValueError):
            action.branch_to_message({"history": {"messages": {}}}, "missing")

    def test_only_recorded_event_timestamps_are_shown(self):
        self.assertEqual(action.exact_event_time({}), "")
        self.assertEqual(action.exact_event_time({"started_at": 123}), " · 1970-01-01 00:02:03 UTC")
        self.assertEqual(action.yaml_arguments('{"question":"One?","choices":["yes","no"]}'),
                         "question: One?\nchoices:\n- 'yes'\n- 'no'")

    def test_json_tool_result_becomes_yaml(self):
        self.assertEqual(action.yaml_result([{"type": "text", "text": '{"ok":true,"items":[1,2]}'}]),
                         "ok: true\nitems:\n- 1\n- 2")

    def test_tool_result_openness_uses_rendered_yaml_utf8_bytes(self):
        def result(size):
            return [{"type": "text", "text": "x" * size}]

        # The YAML block scalar adds five bytes (|- plus indentation).
        self.assertEqual(len(action.yaml_result(result(251)).encode("utf-8")), 256)
        self.assertEqual(len(action.yaml_result(result(252)).encode("utf-8")), 257)
        self.assertGreater(len(action.yaml_result([{"type": "text", "text": "é" * 127}]).encode("utf-8")), 256)

        events = [
            {"type": "function_call_output", "output": result(251)},
            {"type": "function_call_output", "output": result(252)},
            {"type": "function_call_output", "output": [{"type": "text", "text": "é" * 127}]},
        ]
        document = action.conversation_html([{"role": "assistant", "content": "", "output": events}])

        class ResultTags(HTMLParser):
            def __init__(self):
                super().__init__()
                self.tags = []

            def handle_starttag(self, tag, attrs):
                if tag == "details" and "tool-result" in dict(attrs).get("class", ""):
                    self.tags.append(dict(attrs))

        parsed = ResultTags()
        parsed.feed(document)
        self.assertEqual(["open" in attrs for attrs in parsed.tags], [True, False, False])
        self.assertEqual([attrs["data-event-index"] for attrs in parsed.tags], ["0", "1", "2"])

    def test_created_file_id_from_canvas_location(self):
        self.assertEqual(action.canvas_file_id_from_location(
            "https://canvas.ucsc.edu/api/v1/files/13196850?include%5B%5D=enhanced_preview_url"), 13196850)
        for url in ("https://other.example/api/v1/files/123", "https://canvas.ucsc.edu/api/v1/files/123/delete"):
            with self.subTest(url=url), self.assertRaises(RuntimeError):
                action.canvas_file_id_from_location(url)


class UploadTests(unittest.IsolatedAsyncioTestCase):
    async def test_201_location_submits_file_without_forbidden_get(self):
        class Response:
            def __init__(self, status, payload, location=None):
                self.status, self.payload = status, payload
                self.headers = {"Location": location} if location else {}

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            def raise_for_status(self):
                pass

            async def json(self):
                return self.payload

        class Session:
            def __init__(self):
                self.posts = []

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            def post(self, url, data, **kwargs):
                self.posts.append((url, data))
                if url.endswith("/files"):
                    return Response(200, {"upload_url": "https://uploads.example/upload", "upload_params": {"key": "abc"}})
                if url == "https://uploads.example/upload":
                    return Response(201, {}, "https://canvas.ucsc.edu/api/v1/files/13196850?include%5B%5D=enhanced_preview_url")
                self_test.assertEqual(data["submission[file_ids][]"], "13196850")
                return Response(200, {"user_id": 152664})

            def get(self, url):
                raise AssertionError(f"A 201 upload must not GET the private file: {url}")

        self_test = self
        canvas, external = Session(), Session()
        with patch.object(action.aiohttp, "ClientSession", return_value=external):
            await action.upload_submission(canvas, 12345, 152664, "<html>test</html>")
        self.assertEqual(len(canvas.posts), 2)
        self.assertEqual(len(external.posts), 1)


if __name__ == "__main__":
    unittest.main()
