"""uv run --with aiohttp --with pydantic --with 'PyJWT[crypto]' --with pillow python -m unittest discover -s chat/tools/brace3_drive_toolkit"""

import base64
import io
import inspect
import json
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import tool
from PIL import Image

KEY = {"type": "service_account", "client_email": "brace@example.iam.gserviceaccount.com", "private_key": "private-secret"}
CONFIG = json.dumps(KEY)
MODEL = SimpleNamespace(id="brace3-94741", is_active=True, base_model_id="base", user_id="teacher",
                        meta={"bayleaf_course_id": "94741", "toolIds": [tool.TOOL_ID]})


class Response:
    def __init__(self, data=None, status=200, raw=None):
        self.body = raw if raw is not None else json.dumps(data).encode()
        self.status, self.content = status, self

    async def iter_chunked(self, size):
        for offset in range(0, len(self.body), size):
            yield self.body[offset:offset + size]

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


class Session:
    def __init__(self, *responses):
        self.responses, self.calls = iter(responses), []

    def get(self, url, **kwargs):
        assert kwargs["allow_redirects"] is False
        self.calls.append((url, kwargs))
        return next(self.responses)

    post = get


def paragraph(text, **kwargs):
    return {"paragraph": {"elements": [{"textRun": {"content": text}}], **kwargs}}


class AuthorizationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.models = SimpleNamespace(get_model_by_id=AsyncMock(return_value=MODEL))
        self.groups = SimpleNamespace(get_groups_by_member_id=AsyncMock(return_value=[SimpleNamespace(id="group", name="course:94741")]))
        self.grants = SimpleNamespace(has_access=AsyncMock(return_value=True))
        modules = {"open_webui.models.models": SimpleNamespace(Models=self.models),
                   "open_webui.models.groups": SimpleNamespace(Groups=self.groups),
                   "open_webui.models.access_grants": SimpleNamespace(AccessGrants=self.grants)}
        self.patcher = patch.dict(sys.modules, modules)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    async def authorize(self, config=CONFIG, user=None, metadata=None):
        return await tool._authorize(config, user or {"id": "student", "role": "user"},
                                     {"id": "task-model"}, metadata or {"model": {"id": MODEL.id}})

    async def test_actual_selection_and_stored_binding(self):
        self.assertEqual(await self.authorize(), KEY)
        self.models.get_model_by_id.assert_awaited_once_with(MODEL.id)
        self.grants.has_access.assert_awaited_once()

    async def test_membership_required_even_for_admin_owner(self):
        self.groups.get_groups_by_member_id.return_value = []
        for user in [{"id": "student"}, {"id": "teacher", "role": "admin"}]:
            with self.assertRaises(tool.ReadFailure):
                await self.authorize(user=user)

    async def test_model_grant_independent(self):
        self.grants.has_access.return_value = False
        with self.assertRaises(tool.ReadFailure):
            await self.authorize()

    async def test_binding_course_and_active_state_fail_closed(self):
        for changes in [dict(meta={}), dict(meta={"bayleaf_course_id": "94741", "toolIds": []}),
                        dict(is_active=False), dict(base_model_id=None)]:
            self.models.get_model_by_id.return_value = SimpleNamespace(**(vars(MODEL) | changes))
            with self.assertRaises(tool.ReadFailure):
                await self.authorize()

    async def test_old_course_map_and_bad_keys_do_not_leak(self):
        for config in [json.dumps({"123": {"service_account_key": KEY}}), "private-secret",
                       "[]", '{"94741":{"service_account_key":null}}']:
            with self.assertRaises(tool.ReadFailure) as exc:
                await self.authorize(config=config)
            self.assertNotIn("private-secret", json.dumps(exc.exception.result))

    async def test_authorized_courses_use_same_global_identity(self):
        self.assertEqual(await self.authorize(), KEY)
        self.models.get_model_by_id.return_value = SimpleNamespace(**(vars(MODEL) | {
            "meta": {"bayleaf_course_id": "123", "toolIds": [tool.TOOL_ID]}}))
        with self.assertRaises(tool.ReadFailure):
            await self.authorize()
        self.groups.get_groups_by_member_id.return_value = [SimpleNamespace(id="other-group", name="course:123")]
        self.assertEqual(await self.authorize(), KEY)

    async def test_selected_unrelated_model_does_not_fallback(self):
        self.models.get_model_by_id.return_value = None
        with self.assertRaises(tool.ReadFailure):
            await self.authorize(metadata={"model": "basic"})
        self.models.get_model_by_id.assert_awaited_once_with("basic")

    async def test_all_tools_authorize_including_vision_and_identity(self):
        instance = tool.Tools()
        with patch.object(tool, "_authorize", AsyncMock(side_effect=tool.ReadFailure("denied"))) as auth:
            for name, method in inspect.getmembers(instance, inspect.ismethod):
                if not name.startswith("gdrive_"):
                    continue
                args = {p.name: "x" for p in inspect.signature(method).parameters.values()
                        if p.default is inspect.Parameter.empty}
                self.assertEqual(await method(**args), {"failure": "denied"})
            self.assertEqual(auth.await_count, 7)


class ProjectionTests(unittest.TestCase):
    def test_document_tabs_tables_images_and_footnotes(self):
        tab = {"body": {"content": [paragraph("Heading\n", paragraphStyle={"namedStyleType": "HEADING_1"}),
                                    {"paragraph": {"elements": [{"inlineObjectElement": {"inlineObjectId": "img1"}},
                                                               {"footnoteReference": {"footnoteId": "fn"}}],
                                                   "positionedObjectIds": ["img2"]}},
                                    {"table": {"tableRows": [{"tableCells": [{"content": [paragraph("cell")]}]}]}}]},
               "inlineObjects": {"img1": {"inlineObjectProperties": {"embeddedObject": {
                   "title": "Diagram", "description": "A → B", "imageProperties": {"contentUri": "https://secret/signed", "sourceUri": "data:image/png;base64,AAAA"}}}}},
               "footnotes": {"fn": {"content": [paragraph("Footnote text")]}}}
        data = {"tabs": [{"tabProperties": {"tabId": "t1", "title": "Main"}, "documentTab": tab,
                          "childTabs": [{"tabProperties": {"tabId": "t2", "title": "Child"},
                                         "documentTab": {"body": {"content": [paragraph("Nested content")]}}}]}]}
        text = tool._document(data)
        for expected in ["# Heading", "Image img1: Diagram / A → B", "Image img2", "Footnote text", "| cell |", "Nested content"]:
            self.assertIn(expected, text)
        self.assertNotIn("signed", text)
        self.assertNotIn("base64", text)

    def test_links_and_numbered_lists(self):
        blocks = [paragraph("first", bullet={"listId": "l"}), paragraph("second", bullet={"listId": "l"}),
                  {"paragraph": {"elements": [{"richLink": {"richLinkProperties": {"title": "Course", "uri": "https://example.com"}}},
                                              {"textRun": {"content": "safe", "textStyle": {"link": {"url": "data:image/png;base64,AAAA"}}}}]}}]
        text = tool._doc_blocks(blocks, {"lists": {"l": {"listProperties": {"nestingLevels": [{"glyphType": "DECIMAL", "startNumber": 3}]}}}})
        self.assertIn("3. first", text)
        self.assertIn("4. second", text)
        self.assertIn("[Course](<https://example.com>)", text)
        self.assertNotIn("base64", text)

    def test_character_continuation_lossless_even_long_lines(self):
        text, parts, offset = "abcdef" * 2000, [], 0
        while True:
            result = tool._window(text, offset, 999)
            parts.append(result["content"])
            if result["next_offset"] is None:
                break
            offset = result["next_offset"]
        self.assertEqual("".join(parts), text)
        for offset, limit in [(-1, 100), (0, 16001), (True, 100)]:
            with self.assertRaises(tool.ReadFailure):
                tool._window(text, offset, limit)

    def test_links_resource_keys_and_rejected_urls(self):
        for url in ["https://docs.google.com/document/d/abc/edit?resourcekey=key_1",
                    "https://drive.google.com/drive/folders/abc?resourcekey=key_1",
                    "https://drive.google.com/open?id=abc&resourcekey=key_1"]:
            self.assertEqual(tool._reference(url), ("abc", "key_1"))
        for url in ["https://evil.example/d/abc", "../abc", "https://docs.google.com@evil.example/d/abc"]:
            with self.assertRaises(tool.ReadFailure):
                tool._reference(url)
        with self.assertRaises(tool.ReadFailure):
            tool._reference("abc", "key\r\nInjected: yes")

    def test_cell_bounds(self):
        for value in ["'Sheet 1'!A1:Z50", "Sheet2!A1:A2000", "'Bob''s Sheet'!A1:B2"]:
            tool._cell_range(value)
        for value in ["A1:Z50", "Sheet!A:Z", "Sheet!A0:A10", "Sheet!Z10:A1", "Sheet!A1:ZZ1000"]:
            with self.assertRaises(tool.ReadFailure):
                tool._cell_range(value)


class DriveTests(unittest.IsolatedAsyncioTestCase):
    def client(self, *responses):
        session = Session(*responses)
        drive = tool._Drive(session, KEY)
        drive.token = "access-secret"
        return drive, session

    def metadata(self, kind="document"):
        return Response({"id": "abc", "name": "Title", "version": "7", "modifiedTime": "today", "mimeType": tool.MIME + kind})

    async def test_document_api_requests_and_version_mismatch(self):
        drive, session = self.client(self.metadata(), Response({"body": {"content": [paragraph("abcdef")]}}))
        args = dict(file="abc", resource_key="rk", offset=0, limit=3, version="7")
        result = await drive.execute("document", args)
        self.assertEqual(result["content"], "abc")
        self.assertEqual(result["next_offset"], 3)
        self.assertEqual(result["version"], "7")
        self.assertEqual(session.calls[1][1]["params"]["includeTabsContent"], "true")
        for _, call in session.calls:
            self.assertEqual(call["headers"]["X-Goog-Drive-Resource-Keys"], "abc/rk")
        drive, session = self.client(self.metadata())
        with self.assertRaises(tool.ReadFailure):
            await drive.execute("document", dict(args, version="6"))
        self.assertEqual(len(session.calls), 1)

    async def test_pagination_preserves_empty_pages_with_next_token(self):
        drive, session = self.client(Response({"files": [], "nextPageToken": "next", "incompleteSearch": True}),
                                     Response({"files": [{"id": "child", "resourceKey": "child-key"}]}))
        args = dict(folder="folder", resource_key="key", page_token="", page_size=30)
        first = await drive.execute("list", args)
        self.assertEqual(first["next_page_token"], "next")
        self.assertTrue(first["incomplete_search"])
        second = await drive.execute("list", dict(args, page_token=first["next_page_token"]))
        self.assertEqual(second["files"][0]["resourceKey"], "child-key")
        self.assertIsNone(second["next_page_token"])
        self.assertEqual(session.calls[1][1]["params"]["pageToken"], "next")
        self.assertEqual(session.calls[1][1]["params"]["orderBy"], "folder,name")

    async def test_search_escapes_query_and_scopes_to_direct_children(self):
        drive, session = self.client(Response({"files": []}))
        await drive.execute("search", dict(folder="folder", resource_key="", page_token="", page_size=30, query="Bob's \\ notes"))
        query = session.calls[0][1]["params"]["q"]
        self.assertEqual(query, "trashed = false and 'folder' in parents and fullText contains 'Bob\\'s \\\\ notes'")
        self.assertNotIn("orderBy", session.calls[0][1]["params"])

    async def test_query_and_api_403_are_not_reported_as_sharing_failures(self):
        for error, expected in [
            ({"errors": [{"reason": "forbidden", "location": "orderBy"}]}, "toolkit query error"),
            ({"details": [{"reason": "SERVICE_DISABLED"}]}, "API is disabled"),
            ({"message": "access-secret"}, "does not establish which"),
        ]:
            drive, _ = self.client(Response({"error": error}, status=403))
            with self.assertRaises(tool.ReadFailure) as caught:
                await drive.get(tool.DRIVE + "/files")
            self.assertIn(expected, caught.exception.result["failure"])
            self.assertNotIn("access-secret", json.dumps(caught.exception.result))

    async def test_search_requires_nonempty_folder_before_network(self):
        parameter = inspect.signature(tool.Tools.gdrive_search).parameters["folder"]
        self.assertIs(parameter.default, inspect.Parameter.empty)
        for folder in ("", " ", "\n"):
            drive, session = self.client()
            with self.assertRaises(tool.ReadFailure):
                await drive.execute("search", dict(query="notes", folder=folder, resource_key="", page_token="", page_size=30))
            self.assertEqual(session.calls, [])

    async def test_sheets_overview_and_nonfirst_tab_range(self):
        drive, _ = self.client(self.metadata("spreadsheet"), Response({"sheets": [{"properties": {"title": "Second", "sheetId": 2}}]}))
        args = dict(file="abc", resource_key="", cell_range="")
        self.assertEqual((await drive.execute("sheet", args))["sheets"][0]["title"], "Second")
        drive, session = self.client(self.metadata("spreadsheet"), Response({"range": "Second!A1:B2", "values": [["a", "b"], ["c"]]}))
        result = await drive.execute("sheet", dict(args, cell_range="'Second'!A1:B2"))
        self.assertEqual(result["rows"], [["a", "b"], ["c"]])
        self.assertIn("%27Second%27%21A1%3AB2", session.calls[1][0])
        self.assertEqual(session.calls[1][1]["params"]["valueRenderOption"], "FORMATTED_VALUE")

    async def test_large_sheet_cells_fail_without_silent_truncation(self):
        drive, _ = self.client(self.metadata("spreadsheet"), Response({"values": [["x" * 16001]]}))
        with self.assertRaises(tool.ReadFailure):
            await drive.execute("sheet", dict(file="abc", resource_key="", cell_range="Sheet!A1:A1"))

    async def test_slides_groups_notes_and_visual_markers(self):
        shape = lambda text: {"shape": {"text": {"textElements": [{"textRun": {"content": text}}]}}}
        slide = {"objectId": "s1", "pageElements": [{"elementGroup": {"children": [shape("Grouped text")]}},
                                                    {"objectId": "img", "image": {"contentUrl": "https://signed"}, "description": "Chart alt"}],
                 "slideProperties": {"notesPage": {"notesProperties": {"speakerNotesObjectId": "n"},
                                                    "pageElements": [dict(shape("Speaker words"), objectId="n"), shape("ignored placeholder")]}}}
        drive, _ = self.client(self.metadata("presentation"), Response({"slides": [slide, slide]}))
        result = await drive.execute("slides", dict(file="abc", resource_key="", start_slide=1, slide_count=1, offset=0, limit=8000, version=""))
        for text in ["Grouped text", "Chart alt", "Speaker words"]:
            self.assertIn(text, result["content"])
        for text in ["signed", "ignored placeholder"]:
            self.assertNotIn(text, result["content"])
        self.assertEqual(result["next_slide"], 2)

    async def test_wrong_file_type_and_inaccessible_responses(self):
        drive, _ = self.client(self.metadata("spreadsheet"))
        with self.assertRaises(tool.ReadFailure):
            await drive.file("abc", "", "document")
        for status in [302, 401, 403, 404, 429, 500]:
            drive, session = self.client(Response({"error": "access-secret"}, status=status))
            with self.assertRaises(tool.ReadFailure) as caught:
                await drive.file("abc", "", "document")
            self.assertNotIn("access-secret", json.dumps(caught.exception.result))
            self.assertEqual(len(session.calls), 1)
            if status == 404:
                self.assertIn("may still exist", caught.exception.result["failure"])

    async def test_response_and_listing_bounds(self):
        drive, _ = self.client(Response(raw=b"x" * (tool.MAX_BYTES + 1)))
        with self.assertRaises(tool.ReadFailure):
            await drive.file("abc", "", "document")
        drive, _ = self.client(Response({"files": [{"name": "x" * 16001}]}))
        with self.assertRaises(tool.ReadFailure):
            await drive.execute("list", dict(folder="abc", resource_key="", page_token="", page_size=30))

    async def test_identity_needs_no_network(self):
        drive, session = self.client()
        self.assertEqual((await drive.execute("identity", {}))["sharing_identity"], KEY["client_email"])
        self.assertEqual(session.calls, [])

    async def test_jwt_readonly_fixed_audience_and_no_delegation(self):
        drive, session = self.client(Response({"access_token": "new-secret"}))
        with patch.object(tool.jwt, "encode", return_value="signed-assertion") as encode:
            await drive.authenticate()
        claims = encode.call_args.args[0]
        self.assertEqual(claims["scope"], tool.SCOPE)
        self.assertEqual(claims["aud"], tool.TOKEN_URL)
        self.assertNotIn("sub", claims)
        self.assertEqual(claims["exp"] - claims["iat"], 3600)
        self.assertEqual(session.calls[0][0], tool.TOKEN_URL)
        self.assertEqual(drive.token, "new-secret")


def png(width=16, height=8):
    output = io.BytesIO()
    Image.new("RGB", (width, height), (12, 34, 56)).save(output, format="PNG")
    return output.getvalue()


class VisionTests(unittest.IsolatedAsyncioTestCase):
    def client(self, kind, *responses):
        session = Session(Response({"name": "Fixture", "mimeType": kind, "version": "7"}), *responses)
        drive = tool._Drive(session, KEY)
        drive.token = "access-secret"
        return drive, session

    def args(self, image_ref="img.1", **kwargs):
        return dict(file="abc", image_ref=image_ref, version="7", resource_key="rk", **kwargs)

    async def test_doc_image_resolves_child_tab_and_never_fetches_source_uri(self):
        obj = {"inlineObjectProperties": {"embeddedObject": {"imageProperties": {
            "contentUri": "https://lh7-rt.googleusercontent.com/private-image",
            "sourceUri": "https://evil.example/source"}}}}
        doc = {"tabs": [{"childTabs": [{"documentTab": {"inlineObjects": {"img.1": obj}}}]}]}
        drive, session = self.client(tool.MIME + "document", Response(doc), Response(raw=png()))
        result = await drive.view_image(self.args())
        self.assertTrue(result.startswith("data:image/png;base64,"))
        self.assertNotIn("private-image", result)
        self.assertEqual(session.calls[-1][1]["headers"], {})
        self.assertNotIn("evil", repr(session.calls))
        self.assertEqual(session.calls[1][1]["headers"]["X-Goog-Drive-Resource-Keys"], "abc/rk")

    async def test_slide_thumbnail_is_resolved_from_current_slide_ids(self):
        drive, session = self.client(tool.MIME + "presentation", Response({"slides": [{"objectId": "p"}]}),
                                     Response({"contentUrl": "https://lh7-us.googleusercontent.com/thumbnail"}), Response(raw=png()))
        result = await drive.view_image(self.args("p"))
        self.assertTrue(result.startswith("data:image/"))
        self.assertTrue(session.calls[2][0].endswith("/pages/p/thumbnail"))
        self.assertEqual(session.calls[2][1]["params"]["thumbnailProperties.thumbnailSize"], "LARGE")
        self.assertEqual(session.calls[-1][1]["headers"], {})

    async def test_grouped_slide_image_and_positioned_doc_image(self):
        url = "https://lh3.googleusercontent.com/image"
        slide = {"slides": [{"objectId": "p", "pageElements": [{"elementGroup": {"children": [
            {"objectId": "img.1", "image": {"contentUrl": url}}]}}]}]}
        doc = {"positionedObjects": {"img.1": {"positionedObjectProperties": {
            "embeddedObject": {"imageProperties": {"contentUri": url}}}}}}
        for kind, data in [("presentation", slide), ("document", doc)]:
            drive, _ = self.client(tool.MIME + kind, Response(data), Response(raw=png()))
            self.assertTrue((await drive.view_image(self.args())).startswith("data:image/"))

    async def test_standalone_media_has_auth_and_resource_key(self):
        drive, session = self.client("image/png", Response(raw=png()))
        result = await drive.view_image(self.args(""))
        self.assertTrue(result.startswith("data:image/"))
        request = session.calls[-1][1]
        self.assertEqual(request["params"]["alt"], "media")
        self.assertEqual(request["headers"]["Authorization"], "Bearer access-secret")
        self.assertEqual(request["headers"]["X-Goog-Drive-Resource-Keys"], "abc/rk")

    async def test_unknown_ref_wrong_type_and_revision_fail_before_image_fetch(self):
        for kind, args, responses in [
            (tool.MIME + "document", self.args(), [Response({"tabs": []})]),
            (tool.MIME + "presentation", self.args("missing"), [Response({"slides": [{"objectId": "p"}]})]),
            (tool.MIME + "spreadsheet", self.args(""), []),
            ("image/svg+xml", self.args(""), []),
            ("image/png", self.args(), []),
            ("image/png", dict(self.args(""), version="6"), []),
        ]:
            drive, session = self.client(kind, *responses)
            with self.assertRaises(tool.ReadFailure):
                await drive.view_image(args)
            self.assertEqual(len(session.calls), 1 + len(responses))

    async def test_unsafe_image_hosts_and_redirects_are_not_followed(self):
        session = Session()
        drive = tool._Drive(session, KEY)
        for url in ["http://lh3.googleusercontent.com/x", "https://evilgoogleusercontent.com/x",
                    "https://lh3.googleusercontent.com.evil.example/x", "https://127.0.0.1/x",
                    "https://user@lh3.googleusercontent.com/x", "https://lh3.googleusercontent.com:8443/x"]:
            with self.assertRaises(tool.ReadFailure):
                await drive.image_bytes(url)
        self.assertEqual(session.calls, [])
        drive.session = Session(Response({}, status=302))
        with self.assertRaises(tool.ReadFailure):
            await drive.image_bytes("https://lh3.googleusercontent.com/x")
        self.assertEqual(len(drive.session.calls), 1)

    async def test_streamed_image_download_bound(self):
        drive = tool._Drive(Session(Response(raw=b"x" * (tool.MAX_IMAGE_BYTES + 1))), KEY)
        with self.assertRaises(tool.ReadFailure):
            await drive.image_bytes("https://lh3.googleusercontent.com/x")

    async def test_vision_refusal_before_network_and_no_task_model_fallback(self):
        instance = tool.Tools()
        capable = {"id": "vision", "info": {"meta": {"capabilities": {"vision": True}}}}
        for selected in [{}, {"id": "text", "architecture": {"input_modalities": ["text"]}}, "unknown"]:
            with patch.object(tool, "_authorize", AsyncMock(return_value=KEY)), patch.object(tool.aiohttp, "ClientSession") as session:
                result = await instance.gdrive_view_image("abc", __model__=capable,
                                                          __metadata__={"model": selected or {"id": "unknown"}})
                self.assertIn("lacks confirmed", result["failure"])
                session.assert_not_called()
        self.assertTrue(tool._vision_supported(capable, None))
        self.assertTrue(tool._vision_supported({"architecture": {"modality": "text+image->text"}}, None))
        self.assertFalse(tool._vision_supported({"architecture": {"input_modalities": ["text"]}, **capable}, None))

    async def test_public_tool_returns_unwrapped_image_for_owui(self):
        instance = tool.Tools()
        uri = tool._image_data_uri(png())
        capable = {"info": {"meta": {"capabilities": {"vision": True}}}}
        with patch.object(tool, "_authorize", AsyncMock(return_value=KEY)), patch.object(tool._Drive, "execute", AsyncMock(return_value=uri)):
            result = await instance.gdrive_view_image("abc", __model__=capable)
        self.assertEqual(result, uri)

    def test_decoding_resize_and_rejection(self):
        result = tool._image_data_uri(png(2000, 1000))
        raw = base64.b64decode(result.split(",", 1)[1])
        with Image.open(io.BytesIO(raw)) as image:
            self.assertEqual(image.size, (1600, 800))
            self.assertEqual(image.format, "PNG")
        for raw in [b"<svg></svg>", b"\x89PNG\r\n\x1a\ncorrupt", b"x" * (tool.MAX_IMAGE_BYTES + 1), png(4001, 4000)]:
            with self.assertRaises(tool.ReadFailure):
                tool._image_data_uri(raw)

    def test_animation_first_frame_only(self):
        output = io.BytesIO()
        frames = [Image.new("RGB", (4, 4), color) for color in ("red", "blue")]
        frames[0].save(output, format="GIF", save_all=True, append_images=frames[1:])
        raw = base64.b64decode(tool._image_data_uri(output.getvalue()).split(",", 1)[1])
        with Image.open(io.BytesIO(raw)) as image:
            self.assertEqual(image.n_frames, 1)
            self.assertEqual(image.getpixel((0, 0))[:3], (255, 0, 0))


if __name__ == "__main__":
    unittest.main()
