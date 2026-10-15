import importlib.util
import sys
import unittest
from email.parser import BytesParser
from html.parser import HTMLParser
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.parse import urlsplit

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
        self.assertIn("private &lt;answer&gt;", document)
        self.assertNotIn("exact tool time not recorded", document)
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
        self.assertIn("open", calls[0])
        self.assertIn("open", results[0])
        reasoning = [attrs for tag, attrs in parsed.elements
                     if tag == "details" and attrs.get("data-event-type") == "reasoning"]
        self.assertEqual(len(reasoning), 1)
        self.assertNotIn("open", reasoning[0])
        self.assertIn(("time", {"datetime": "1970-01-01T00:01:42+00:00", "data-timestamp": "102"}), parsed.elements)
        self.assertNotIn("data-timestamp", calls[0])
        self.assertEqual(parsed.yaml_payloads, [{"prompt": "a <question>"}, "private <answer>"])

    def test_missing_branch_fails_closed(self):
        with self.assertRaises(ValueError):
            action.branch_to_message({"history": {"messages": {}}}, "missing")

    def test_only_recorded_event_timestamps_are_shown(self):
        self.assertEqual(action.exact_event_time({}), "")
        self.assertEqual(action.exact_event_time({"started_at": 123}), " · 1970-01-01 00:02:03 UTC")
        self.assertEqual(yaml.safe_load(action.yaml_arguments('{"question":"One?","choices":["yes","no"]}')),
                         {"question": "One?", "choices": ["yes", "no"]})

    def test_json_tool_result_becomes_yaml(self):
        self.assertEqual(yaml.safe_load(action.yaml_result([{"type": "text", "text": '{"ok":true,"items":[1,2]}'}])),
                         {"ok": True, "items": [1, 2]})

    def test_tool_result_openness_uses_rendered_yaml_utf8_bytes(self):
        def result(size):
            return [{"type": "text", "text": "x" * size}]

        # Find the boundary in rendered YAML, without pinning a scalar spelling.
        boundary = max(size for size in range(1, 257)
                       if len(action.yaml_result(result(size)).encode("utf-8")) <= 256)
        unicode_result = [{"type": "text", "text": "é" * 200}]
        self.assertLess(len(action.yaml_result(unicode_result)), 256)
        self.assertGreater(len(action.yaml_result(unicode_result).encode("utf-8")), 256)

        events = [
            {"type": "function_call_output", "output": result(boundary)},
            {"type": "function_call_output", "output": result(boundary + 1)},
            {"type": "function_call_output", "output": unicode_result},
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


class ActionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.user = {"id": "owner", "email": "student@example.test", "role": "user"}
        self.body = {"model": "brace3-94741", "chat_id": "saved-chat", "id": "selected",
                     "student_id": 999, "email": "intruder@example.test", "messages": [
                         {"role": "user", "content": "https://canvas.ucsc.edu/courses/94741/assignments/999"},
                         {"role": "assistant", "content": "FLATTENED PAYLOAD"}]}
        self.stored = {"history": {"messages": {
            "prompt": {"id": "prompt", "role": "user", "parentId": None,
                       "content": "https://canvas.ucsc.edu/courses/94741/assignments/12345"},
            "selected": {"id": "selected", "role": "assistant", "parentId": "prompt",
                         "content": "stored answer", "output": [
                             {"type": "reasoning", "content": [{"type": "text", "text": "STORED REASONING"}]},
                             {"type": "function_call_output", "call_id": "call-1",
                              "output": [{"type": "text", "text": "STORED TOOL RESULT"}]}]},
            "sibling": {"id": "sibling", "role": "assistant", "parentId": "prompt", "content": "OTHER BRANCH"},
        }, "currentId": "sibling"}}
        self.roster = [{"user": {"id": 42, "name": "Synthetic Student", "login_id": "STUDENT@example.test"}}]
        self.lookups, self.gets = [], []

        async def owned_chat(chat_id, user_id):
            self.lookups.append((chat_id, user_id))
            return SimpleNamespace(chat=self.stored) if (chat_id, user_id) == ("saved-chat", "owner") else None

        self.chats = SimpleNamespace(get_chat_by_id_and_user_id=owned_chat)
        self.instance = action.Action()
        self.instance.valves.CANVAS_ACCESS_TOKEN = "synthetic-token"

    async def invoke(self, confirmation=True):
        test = self
        self.writes, self.documents = [], []

        class UploadBody:
            def __init__(self):
                self.chunks = []

            async def write(self, chunk):
                self.chunks.append(chunk)

        class Response:
            def __init__(self, payload, status=200, location=None, form=None):
                self.payload, self.status, self.form = payload, status, form
                self.headers = {"Location": location} if location else {}

            async def __aenter__(self):
                if self.form is not None:
                    # Inspect the public multipart wire representation, not
                    # FormData's private fields or the upload helper's arguments.
                    multipart = self.form()
                    body = UploadBody()
                    await multipart.write(body)
                    message = BytesParser().parsebytes(
                        f"Content-Type: {multipart.content_type}\r\n\r\n".encode() + b"".join(body.chunks))
                    test.documents.extend(part.get_payload(decode=True).decode("utf-8")
                                          for part in message.walk() if part.get_filename())
                return self

            async def __aexit__(self, *args):
                pass

            def raise_for_status(self):
                pass

            async def json(self):
                return self.payload

        class Session:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            def get(self, url):
                test.gets.append(url)
                parsed = urlsplit(url)
                if parsed.netloc != "canvas.ucsc.edu":
                    raise AssertionError(f"Unexpected Canvas origin: {url}")
                if parsed.path == "/api/v1/courses/94741/enrollments":
                    return Response(test.roster)
                if parsed.path == "/api/v1/courses/94741/assignments/12345":
                    return Response({"course_id": 94741, "name": "Synthetic Assignment",
                                     "submission_types": ["online_upload"], "allowed_extensions": ["html"]})
                raise AssertionError(f"Unexpected Canvas read: {url}")

            def post(self, url, data, **kwargs):
                test.writes.append((url, data))
                root = "https://canvas.ucsc.edu/api/v1/courses/94741/assignments/12345/submissions"
                if url.startswith(root + "/") and url.endswith("/files"):
                    return Response({"upload_url": "https://uploads.example/upload", "upload_params": {"key": "abc"}})
                if url == "https://uploads.example/upload":
                    return Response({}, status=201, location="https://canvas.ucsc.edu/api/v1/files/13196850", form=data)
                if url == root:
                    return Response({"user_id": int(data["submission[user_id]"])})
                raise AssertionError(f"Unexpected Canvas write: {url}")

        async def event_call(event):
            self.assertEqual(event["type"], "confirmation", "Stored branch should select the assignment without input")
            return confirmation

        self.events = AsyncMock()
        with patch.dict(sys.modules, {"open_webui.models.chats": SimpleNamespace(Chats=self.chats)}), \
                patch.object(action.aiohttp, "ClientSession", return_value=Session()):
            await self.instance.action(self.body, self.user, self.events, event_call)

    async def test_rejected_confirmation_never_uploads(self):
        for rejected in (False, None, "true", 1, {}):
            with self.subTest(confirmation=rejected):
                await self.invoke(rejected)
                self.assertEqual(self.writes, [])
                self.assertIn("assignments/12345", self.gets[-1])
                event = self.events.await_args.args[0]
                self.assertEqual(event["type"], "status")
                self.assertTrue(event["data"]["done"])
                self.assertFalse(any(call.args[0]["type"] == "notification" for call in self.events.await_args_list))

    async def test_unmatched_enrollment_never_uploads(self):
        self.roster = [{"user": {"id": 999, "name": "Payload Impostor", "login_id": "intruder@example.test"}}]
        with self.assertRaisesRegex(ValueError, "does not match a student enrollment"):
            await self.invoke()
        self.assertEqual(self.writes, [])

    async def test_upload_uses_owners_selected_stored_branch(self):
        await self.invoke()
        self.assertEqual(self.lookups, [("saved-chat", "owner")])
        root = "https://canvas.ucsc.edu/api/v1/courses/94741/assignments/12345/submissions"
        self.assertIn(root + "/42/files", [url for url, _ in self.writes])
        submitted = next(data for url, data in self.writes if url == root)
        self.assertEqual(submitted["submission[user_id]"], "42")
        self.assertEqual(submitted["submission[file_ids][]"], "13196850")
        self.assertEqual(submitted["submission[submission_type]"], "online_upload")
        self.assertEqual(len(self.documents), 1)
        document = self.documents[0]
        for text in ("stored answer", "STORED REASONING", "STORED TOOL RESULT"):
            self.assertIn(text, document)
        for text in ("FLATTENED PAYLOAD", "OTHER BRANCH"):
            self.assertNotIn(text, document)


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
