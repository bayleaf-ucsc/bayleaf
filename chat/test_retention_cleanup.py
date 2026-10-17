"""Offline transaction tests: real runner, synthetic HTTP responses only.

Run: uv run --offline --with httpx python -m unittest discover -s chat -p 'test_retention_cleanup.py' -v
"""

import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import httpx
import retention_cleanup as retention


SCRIPT = Path(__file__).with_name("retention_cleanup.py")
NOW = 1_800_000_000
USER = {"id": "synthetic-user", "group_ids": []}
CHAT = {"id": "synthetic-chat", "updated_at": NOW}
CHAT_LIST = "/api/v1/chats/list/user/synthetic-user"
ORPHAN = "11111111-1111-4111-8111-111111111111"
REFERENCED = "22222222-2222-4222-8222-222222222222"
RECENT = "33333333-3333-4333-8333-333333333333"
KB = "/api/v1/knowledge/synthetic-kb/files"


class RetentionTransactionTests(unittest.TestCase):
    def run_cleanup(self, overrides=None, settings=None):
        """Supply external HTTP, policy settings and wall clock directly.

        Route keys may include page and visit to model Phase B re-enumeration.
        Unexpected requests fail the test rather than falling through to network.
        """
        responses = {
            "/health": {"status": True},
            "/api/v1/users/": [USER],
            "/api/v1/groups/": [],
            CHAT_LIST: [],
            "/api/v1/files/": {
                "items": [{"id": ORPHAN, "created_at": NOW - 172800}], "total": 1,
            },
            "/api/v1/knowledge/": [],
        }
        responses.update(overrides or {})
        requests = []
        visits = {}

        def respond(request):
            requests.append(request)
            path = request.url.path
            if request.method == "DELETE":
                payload = responses.get(("DELETE", path), httpx.Response(200, json=True))
                if isinstance(payload, Exception):
                    raise payload
                return payload
            self.assertEqual(request.method, "GET")
            page = int(request.url.params.get("page", "1"))
            key = (path, page)
            visits[key] = visits.get(key, 0) + 1
            payload = responses.get((*key, visits[key]), responses.get(key, responses.get(path)))
            if payload is None and path not in responses and key not in responses:
                self.fail(f"Unexpected request: {request.method} {request.url}")
            if isinstance(payload, Exception):
                raise payload
            if isinstance(payload, httpx.Response):
                return payload
            return httpx.Response(200, content=json.dumps(payload), headers={"Content-Type": "application/json"})

        stdout, stderr = io.StringIO(), io.StringIO()
        with httpx.Client(transport=httpx.MockTransport(respond), base_url="https://retention.invalid") as client:
            with (
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr),
                patch.object(retention.time, "sleep"),
            ):
                try:
                    retention.run_cleanup(client, settings or retention.Settings(dry_run=False), clock=lambda: NOW)
                    code = 0
                except SystemExit as exc:
                    code = exc.code
        return code, stdout.getvalue(), stderr.getvalue(), requests

    def assert_aborts_without_file_deletes(self, overrides):
        code, stdout, stderr, requests = self.run_cleanup(overrides)
        self.assertEqual(
            [r.url.path for r in requests if r.method == "DELETE" and r.url.path.startswith("/api/v1/files/")],
            [],
        )
        self.assertEqual(code, 1, (stdout, stderr))
        self.assertIn("FATAL:", stderr)
        self.assertNotIn("status=ok", stdout)
        return stdout, stderr, requests

    def test_unknown_chat_envelope_cannot_authorize_orphan_deletion(self):
        # Phase A can succeed; the second list is the surviving-reference scan.
        self.assert_aborts_without_file_deletes({(CHAT_LIST, 1, 2): {"results": [CHAT]}})

    def test_unknown_chat_envelope_in_phase_a_also_aborts(self):
        self.assert_aborts_without_file_deletes({CHAT_LIST: {"results": []}})

    def test_supported_empty_chat_lists_allow_real_orphan_deletion(self):
        for payload in ([], {"chats": []}, {"items": [], "total": 0}):
            with self.subTest(payload=payload):
                code, stdout, stderr, requests = self.run_cleanup({CHAT_LIST: payload})
                self.assertEqual(code, 0, stderr)
                self.assertIn("files_deleted=1", stdout)
                self.assertIn("status=ok", stdout)
                self.assertEqual([r.url.path for r in requests if r.method == "DELETE"],
                                 [f"/api/v1/files/{ORPHAN}"])

    def test_supported_nonempty_chat_lists_preserve_reference_and_grace(self):
        for payload in ([CHAT], {"chats": [CHAT]}, {"items": [CHAT], "total": 1}):
            with self.subTest(payload=payload):
                code, stdout, stderr, requests = self.run_cleanup({
                    CHAT_LIST: payload,
                    "/api/v1/chats/synthetic-chat": {
                        "id": "synthetic-chat", "chat": {"messages": [
                            {"files": [{"type": "file", "file": {"id": REFERENCED}}]},
                        ]},
                    },
                    "/api/v1/files/": {"items": [
                        {"id": ORPHAN, "created_at": NOW - 172800},
                        {"id": REFERENCED, "created_at": NOW - 172800},
                        {"id": RECENT, "created_at": NOW - 86400},
                    ], "total": 3},
                })
                self.assertEqual(code, 0, stderr)
                self.assertIn("files_referenced=1", stdout)
                self.assertIn("files_in_grace=1", stdout)
                self.assertEqual([r.url.path for r in requests if r.method == "DELETE"],
                                 [f"/api/v1/files/{ORPHAN}"])

    def test_invalid_chat_lists_and_entries_abort_even_in_reference_phase(self):
        for payload in (
            None, "unexpected", 42, {"chats": None}, {"items": {}},
            {"chats": [], "items": []}, [None], [{}], [{"id": ""}],
            [{"id": 123, "updated_at": NOW}],
            [{"id": "synthetic-chat"}],
            [{"id": "synthetic-chat", "updated_at": "recent"}],
            [{"id": "synthetic-chat", "updated_at": True}],
        ):
            with self.subTest(payload=payload):
                self.assert_aborts_without_file_deletes({(CHAT_LIST, 1, 2): payload})

    def test_chat_total_requires_remaining_pages_even_after_short_batch(self):
        self.assert_aborts_without_file_deletes({
            (CHAT_LIST, 1, 2): {"chats": [CHAT], "total": 2},
            (CHAT_LIST, 2): {"chats": [], "total": 2},
        })

    def test_bad_chat_pagination_totals_abort(self):
        for total in (None, "1", True, -1, 0):
            with self.subTest(total=total):
                self.assert_aborts_without_file_deletes({
                    (CHAT_LIST, 1, 2): {"chats": [CHAT], "total": total},
                })

    def test_repeated_chat_page_aborts(self):
        self.assert_aborts_without_file_deletes({
            (CHAT_LIST, 1, 2): {"chats": [CHAT], "total": 2},
            (CHAT_LIST, 2): {"chats": [CHAT], "total": 2},
        })

    def test_pagination_cannot_discard_or_reduce_a_declared_total(self):
        for payload in ([], {"chats": []}, {"chats": [], "total": 1}):
            with self.subTest(payload=payload):
                self.assert_aborts_without_file_deletes({
                    (CHAT_LIST, 1, 2): {"chats": [CHAT], "total": 2},
                    (CHAT_LIST, 2): payload,
                })
        self.assert_aborts_without_file_deletes({
            "/api/v1/knowledge/": {"items": [{"id": "synthetic-kb"}], "total": 2},
            ("/api/v1/knowledge/", 2): [],
        })

    def test_unknown_second_chat_page_aborts(self):
        chats = [{"id": f"synthetic-chat-{i}", "updated_at": NOW} for i in range(30)]
        self.assert_aborts_without_file_deletes({
            (CHAT_LIST, 1, 2): chats, (CHAT_LIST, 2): {"results": []},
        })

    def test_complete_multipage_chats_are_scanned(self):
        other_chat = {"id": "other-chat", "updated_at": NOW}
        code, stdout, stderr, requests = self.run_cleanup({
            CHAT_LIST: {"chats": [CHAT], "total": 2},
            (CHAT_LIST, 2): {"chats": [other_chat], "total": 2},
            "/api/v1/chats/synthetic-chat": {"id": "synthetic-chat", "chat": {}},
            "/api/v1/chats/other-chat": {"id": "other-chat", "chat": {"file": ORPHAN}},
        })
        self.assertEqual(code, 0, stderr)
        self.assertIn("chats_scanned_for_refs=2", stdout)
        self.assertFalse(any(r.method == "DELETE" for r in requests))

    def test_incomplete_user_enumeration_aborts(self):
        for payload in ({"results": []}, {"users": None}, {"users": [{}]}):
            with self.subTest(payload=payload):
                self.assert_aborts_without_file_deletes({"/api/v1/users/": payload})
        self.assert_aborts_without_file_deletes({
            "/api/v1/users/": {"users": [USER], "total": 2},
            ("/api/v1/users/", 2): {"users": [], "total": 2},
        })

    def test_unknown_later_user_page_does_not_hide_reference_owners(self):
        users = [{"id": f"synthetic-user-{i}", "group_ids": []} for i in range(30)]
        self.assert_aborts_without_file_deletes({
            "/api/v1/users/": users, ("/api/v1/users/", 2): {"results": []},
        })

    def test_incomplete_knowledge_discovery_aborts(self):
        for payload in (
            {"results": []}, {"items": None, "total": 0}, [{}],
            {"items": [{"id": "synthetic-kb"}]},
            {"items": [], "total": 1},
        ):
            with self.subTest(payload=payload):
                self.assert_aborts_without_file_deletes({"/api/v1/knowledge/": payload})
        self.assert_aborts_without_file_deletes({
            "/api/v1/knowledge/": {"items": [{"id": "synthetic-kb"}], "total": 2},
            ("/api/v1/knowledge/", 2): {"items": [], "total": 2},
        })

    def test_incomplete_kb_file_discovery_aborts(self):
        for payload in (
            None, {"results": []}, {"items": None}, [None], [{}],
            [{"id": ""}], {"items": [], "total": 1},
            {"items": [{"id": ORPHAN}], "total": 2},
        ):
            with self.subTest(payload=payload):
                self.assert_aborts_without_file_deletes({
                    "/api/v1/knowledge/": [{"id": "synthetic-kb"}], KB: payload,
                })

    def test_supported_kb_file_lists_preserve_references(self):
        for payload in ([{"id": ORPHAN}], {"items": [{"id": ORPHAN}]},
                        {"items": [{"id": ORPHAN}], "total": 1}):
            with self.subTest(payload=payload):
                code, stdout, stderr, requests = self.run_cleanup({
                    "/api/v1/knowledge/": {"items": [{"id": "synthetic-kb"}], "total": 1},
                    KB: payload,
                })
                self.assertEqual(code, 0, stderr)
                self.assertIn("files_referenced=1", stdout)
                self.assertFalse(any(r.method == "DELETE" for r in requests))

    def test_empty_kb_file_lists_allow_orphan_deletion(self):
        for payload in ([], {"items": []}, {"items": [], "total": 0}):
            with self.subTest(payload=payload):
                code, stdout, stderr, requests = self.run_cleanup({
                    "/api/v1/knowledge/": [{"id": "synthetic-kb"}], KB: payload,
                })
                self.assertEqual(code, 0, stderr)
                self.assertEqual([r.url.path for r in requests if r.method == "DELETE"],
                                 [f"/api/v1/files/{ORPHAN}"])

    def test_incomplete_chat_detail_aborts(self):
        for payload in ({}, {"id": "synthetic-chat"}, {"chat": {}},
                        {"id": "synthetic-chat", "chat": None},
                        {"id": "wrong-chat", "chat": {}}, []):
            with self.subTest(payload=payload):
                self.assert_aborts_without_file_deletes({
                    CHAT_LIST: [CHAT], "/api/v1/chats/synthetic-chat": payload,
                })

    def test_reference_http_or_network_failure_aborts_before_file_delete(self):
        for path, overrides in (
            (CHAT_LIST, {}),
            (KB, {"/api/v1/knowledge/": [{"id": "synthetic-kb"}]}),
            ("/api/v1/chats/synthetic-chat", {CHAT_LIST: [CHAT]}),
        ):
            for error in (httpx.Response(404), httpx.Response(503),
                          httpx.ConnectError(f"synthetic failure {ORPHAN}")):
                with self.subTest(path=path, error=error):
                    stdout, stderr, _ = self.assert_aborts_without_file_deletes({**overrides, path: error})
                    self.assertNotIn(ORPHAN, stdout + stderr)

    def test_complete_multipage_users_and_knowledge_preserve_last_reference(self):
        code, stdout, stderr, requests = self.run_cleanup({
            "/api/v1/users/": {"users": [USER], "total": 2},
            ("/api/v1/users/", 2): {"users": [{"id": "second-user", "group_ids": []}], "total": 2},
            "/api/v1/chats/list/user/second-user": [],
            "/api/v1/knowledge/": {"items": [{"id": "synthetic-kb"}], "total": 2},
            ("/api/v1/knowledge/", 2): {"items": [{"id": "second-kb"}], "total": 2},
            KB: [], "/api/v1/knowledge/second-kb/files": [{"id": ORPHAN}],
        })
        self.assertEqual(code, 0, stderr)
        self.assertIn("users_total=2", stdout)
        self.assertIn("knowledge_bases=2", stdout)
        self.assertFalse(any(r.method == "DELETE" for r in requests))

    def test_complete_multipage_file_inventory_preserves_later_reference_and_grace(self):
        later_orphan = "44444444-4444-4444-8444-444444444444"
        code, stdout, stderr, requests = self.run_cleanup({
            CHAT_LIST: [CHAT],
            "/api/v1/chats/synthetic-chat": {
                "id": "synthetic-chat", "chat": {"file": REFERENCED},
            },
            "/api/v1/files/": {
                "items": [{"id": ORPHAN, "created_at": NOW - 172800}], "total": 4,
            },
            ("/api/v1/files/", 2): {"items": [
                {"id": REFERENCED, "created_at": NOW - 172800},
                {"id": RECENT, "created_at": NOW - 86400},
                {"id": later_orphan, "created_at": NOW - 172800},
            ], "total": 4},
        })
        self.assertEqual(code, 0, stderr)
        self.assertIn("status=ok", stdout)
        self.assertIn("files_total=4", stdout)
        self.assertIn("files_referenced=1", stdout)
        self.assertIn("files_in_grace=1", stdout)
        self.assertIn("files_deleted=2", stdout)
        self.assertEqual([r.url.path for r in requests if r.method == "DELETE"],
                         [f"/api/v1/files/{ORPHAN}", f"/api/v1/files/{later_orphan}"])
        file_reads = [r for r in requests if r.method == "GET" and r.url.path == "/api/v1/files/"]
        self.assertEqual([r.url.params["page"] for r in file_reads], ["1", "2"])
        self.assertTrue(all(r.url.params["content"] == "false" for r in file_reads))

    def test_full_bare_user_and_chat_pages_transition_to_supported_envelopes(self):
        # The reference owner is absent from the first user page, and its file
        # reference is absent from the first chat page. Neither may be skipped.
        first_users = [{"id": f"first-user-{i}", "group_ids": []} for i in range(30)]
        first_chats = [{"id": f"first-chat-{i}", "updated_at": NOW} for i in range(30)]
        for chat_key in ("chats", "items"):
            with self.subTest(chat_envelope=chat_key):
                code, stdout, stderr, requests = self.run_cleanup({
                    "/api/v1/users/": first_users,
                    ("/api/v1/users/", 2): {"users": [USER], "total": 31},
                    **{f"/api/v1/chats/list/user/{user['id']}": [] for user in first_users},
                    CHAT_LIST: first_chats,
                    (CHAT_LIST, 2): {chat_key: [CHAT], "total": 31},
                    **{f"/api/v1/chats/{chat['id']}": {"id": chat["id"], "chat": {}}
                       for chat in first_chats},
                    "/api/v1/chats/synthetic-chat": {
                        "id": "synthetic-chat", "chat": {"file": REFERENCED},
                    },
                    "/api/v1/files/": {"items": [
                        {"id": ORPHAN, "created_at": NOW - 172800},
                        {"id": REFERENCED, "created_at": NOW - 172800},
                        {"id": RECENT, "created_at": NOW - 86400},
                    ], "total": 3},
                })
                self.assertEqual(code, 0, stderr)
                self.assertIn("status=ok", stdout)
                self.assertIn("users_total=31", stdout)
                self.assertIn("chats_scanned=31", stdout)
                self.assertIn("chats_scanned_for_refs=31", stdout)
                self.assertIn("files_referenced=1", stdout)
                self.assertIn("files_in_grace=1", stdout)
                self.assertEqual([r.url.path for r in requests if r.method == "DELETE"],
                                 [f"/api/v1/files/{ORPHAN}"])
                self.assertEqual([r.url.params["page"] for r in requests
                                  if r.url.path == "/api/v1/users/"], ["1", "2"])
                self.assertEqual([r.url.params["page"] for r in requests
                                  if r.url.path == CHAT_LIST], ["1", "2", "1", "2"])

    def test_invalid_file_inventory_cannot_bypass_grace(self):
        for payload in (
            {"items": [{"id": ORPHAN}], "total": 1},
            {"items": [{"id": ORPHAN, "created_at": None}], "total": 1},
            {"items": [], "total": 1}, {"items": []},
        ):
            with self.subTest(payload=payload):
                self.assert_aborts_without_file_deletes({"/api/v1/files/": payload})

    def test_held_user_chats_are_not_deleted_but_are_scanned_for_references(self):
        code, stdout, stderr, requests = self.run_cleanup({
            "/api/v1/users/": [{**USER, "group_ids": ["synthetic-hold"]}],
            "/api/v1/groups/": [{"id": "synthetic-hold", "name": "hold:synthetic"}],
            CHAT_LIST: [{**CHAT, "updated_at": 1}],
            "/api/v1/chats/synthetic-chat": {"id": "synthetic-chat", "chat": {"file": ORPHAN}},
        })
        self.assertEqual(code, 0, stderr)
        self.assertIn("users_held=1", stdout)
        self.assertIn("chats_scanned=0", stdout)
        self.assertIn("chats_scanned_for_refs=1", stdout)
        self.assertFalse(any(r.method == "DELETE" for r in requests))

    def test_dry_run_never_deletes(self):
        code, stdout, stderr, requests = self.run_cleanup({
            CHAT_LIST: [{**CHAT, "updated_at": 1}],
            "/api/v1/chats/synthetic-chat": {"id": "synthetic-chat", "chat": {}},
        }, settings=retention.Settings())
        self.assertEqual(code, 0, stderr)
        self.assertIn("chats_would_delete=1", stdout)
        self.assertIn("files_would_delete=1", stdout)
        self.assertFalse(any(r.method == "DELETE" for r in requests))

    def test_invalid_hold_discovery_aborts_before_any_delete(self):
        cases = [
            {"/api/v1/users/": [{"id": USER["id"]}]},
            {"/api/v1/users/": [{**USER, "group_ids": None}]},
            {"/api/v1/users/": [{**USER, "group_ids": "hold"}]},
            {"/api/v1/users/": [{**USER, "group_ids": [None]}]},
            {"/api/v1/users/": [{**USER, "group_ids": ["unknown"]}]},
            {"/api/v1/groups/": [{"id": "group"}]},
            {"/api/v1/groups/": [{"id": "group", "name": ""}]},
            {"/api/v1/groups/": [{"id": "group", "name": "hold:test"}] * 2},
        ]
        for overrides in cases:
            with self.subTest(overrides=overrides):
                _, _, requests = self.assert_aborts_without_file_deletes({
                    CHAT_LIST: [{**CHAT, "updated_at": 1}], **overrides,
                })
                self.assertFalse(any(r.method == "DELETE" for r in requests))

    def test_no_eligible_files_skips_all_reference_discovery(self):
        for files in ([], [{"id": RECENT, "created_at": NOW - 86400}]):
            with self.subTest(files=files):
                code, stdout, stderr, requests = self.run_cleanup({
                    "/api/v1/files/": {"items": files, "total": len(files)},
                })
                self.assertEqual(code, 0, stderr)
                self.assertIn("file_sweep=skipped_no_eligible_files", stdout)
                self.assertEqual(sum(r.url.path == CHAT_LIST for r in requests), 1)
                self.assertFalse(any("knowledge" in r.url.path for r in requests))

    def test_transient_read_retries_then_recovers(self):
        for error in (httpx.ReadTimeout(f"secret {ORPHAN}"), httpx.Response(503), httpx.Response(429)):
            with self.subTest(error=error):
                code, stdout, stderr, requests = self.run_cleanup({
                    ("/health", 1, 1): error,
                })
                self.assertEqual(code, 0, stderr)
                self.assertEqual(sum(r.url.path == "/health" for r in requests), 2)
                self.assertIn("retry operation=health", stdout)
                self.assertNotIn(ORPHAN, stdout + stderr)

    def test_persistent_read_failure_has_bounded_safe_diagnostics(self):
        code, stdout, stderr, requests = self.run_cleanup({
            "/health": httpx.ReadTimeout(f"secret {ORPHAN}"),
        })
        self.assertEqual(code, 1)
        self.assertEqual(len(requests), 3)
        self.assertIn("health: ReadTimeout; attempt=3/3", stderr)
        self.assertNotIn(ORPHAN, stdout + stderr)

    def test_invalid_json_and_permanent_http_errors_fail_without_retry(self):
        for response in (httpx.Response(200, text=f"secret {ORPHAN}"), httpx.Response(401)):
            with self.subTest(response=response):
                code, stdout, stderr, requests = self.run_cleanup({"/health": response})
                self.assertEqual(code, 1)
                self.assertEqual(len(requests), 1)
                self.assertNotIn(ORPHAN, stdout + stderr)

    def test_deletes_are_never_retried(self):
        for error in (httpx.ReadTimeout(f"secret {ORPHAN}"), httpx.Response(503)):
            for path, delete in (("/api/v1/chats/synthetic-chat", retention.delete_chat),
                                 (f"/api/v1/files/{ORPHAN}", retention.delete_file)):
                with self.subTest(error=error, path=path):
                    requests = []
                    def respond(request):
                        requests.append(request)
                        if isinstance(error, Exception):
                            raise error
                        return error
                    stderr = io.StringIO()
                    with httpx.Client(transport=httpx.MockTransport(respond), base_url="https://retention.invalid") as client:
                        with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit):
                            delete(client, path.rsplit("/", 1)[1])
                    self.assertEqual(len(requests), 1)
                    self.assertNotIn(ORPHAN, stderr.getvalue())

    def test_chat_delete_failure_stops_run_and_reports_partial_progress(self):
        code, stdout, stderr, requests = self.run_cleanup({
            CHAT_LIST: [{**CHAT, "updated_at": 1}, {"id": "second-chat", "updated_at": 1}],
            ("DELETE", "/api/v1/chats/second-chat"): httpx.Response(503),
        })
        self.assertEqual(code, 1)
        self.assertIn("chats_deleted=1", stdout)
        self.assertNotIn("status=ok", stdout)
        self.assertFalse(any(r.url.path == "/api/v1/files/" for r in requests))
        self.assertIn("chat_delete: HTTP 503; attempt=1/1", stderr)

    def test_file_delete_failure_stops_run_and_reports_partial_progress(self):
        code, stdout, stderr, requests = self.run_cleanup({
            "/api/v1/files/": {"items": [
                {"id": ORPHAN, "created_at": 1},
                {"id": REFERENCED, "created_at": 1},
                {"id": RECENT, "created_at": 1},
            ], "total": 3},
            ("DELETE", f"/api/v1/files/{REFERENCED}"): httpx.ReadTimeout(f"secret {REFERENCED}"),
        })
        self.assertEqual(code, 1)
        self.assertIn("files_deleted=1", stdout)
        self.assertNotIn("status=ok", stdout)
        self.assertNotIn(REFERENCED, stdout + stderr)
        self.assertEqual(sum(r.method == "DELETE" for r in requests), 2)

    def test_phase_b_reenumerates_after_expired_chat_deletion(self):
        code, stdout, stderr, requests = self.run_cleanup({
            CHAT_LIST: [{**CHAT, "updated_at": 1}], (CHAT_LIST, 1, 2): [],
        })
        self.assertEqual(code, 0, stderr)
        self.assertEqual([r.url.path for r in requests if r.method == "DELETE"],
                         ["/api/v1/chats/synthetic-chat", f"/api/v1/files/{ORPHAN}"])
        self.assertIn("chats_deleted=1", stdout)
        self.assertIn("files_deleted=1", stdout)
        for sentinel in (USER["id"], CHAT["id"], ORPHAN, "synthetic-token"):
            self.assertNotIn(sentinel, stdout + stderr)


class RetentionCLITests(unittest.TestCase):
    def cli(self, *args, env=None):
        # A fresh process exercises the actual __main__ entrypoint. No endpoint
        # is configured: every smoke case must stop before opening a client.
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args], env=env or {},
            capture_output=True, text=True, timeout=10,
        )

    def test_import_does_not_parse_args_read_environment_or_open_client(self):
        result = subprocess.run(
            [sys.executable, "-c", """
import argparse, os, socket, sys, httpx
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
with patch.object(argparse.ArgumentParser, 'parse_args', side_effect=AssertionError('argv')), \\
     patch.object(type(os.environ), '__getitem__', side_effect=AssertionError('secret read')), \\
     patch.object(type(os.environ), '__iter__', side_effect=AssertionError('environment')), \\
     patch.object(httpx, 'Client', side_effect=AssertionError('client')), \\
     patch.object(socket.socket, 'connect', side_effect=AssertionError('network')):
    import retention_cleanup
print('import-safe')
""", str(SCRIPT.parent)],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "import-safe\n")

    def test_help_needs_no_credentials(self):
        result = self.cli("--help", env={"RETENTION_DAYS": "invalid"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--live", result.stdout)
        self.assertNotIn("SUNRISE", result.stdout)

    def test_missing_credentials_fail_before_network(self):
        for env, message in (({}, "OWUI_URL is not set"),
                             ({"OWUI_URL": "https://retention.invalid"}, "OWUI_TOKEN is not set")):
            with self.subTest(env=env):
                result = self.cli(env=env)
                self.assertEqual(result.returncode, 1)
                self.assertIn(message, result.stderr)
                self.assertEqual(result.stdout, "")

    def test_entrypoint_live_conflict_cannot_be_bypassed(self):
        for value in ("true", "TRUE"):
            result = self.cli("--live", env={"DRY_RUN": value})
            self.assertEqual(result.returncode, 1)
            self.assertIn("--live conflicts with DRY_RUN=true", result.stderr)
            self.assertEqual(result.stdout, "")

    def test_zero_retention_override_is_rejected(self):
        result = self.cli("--retention-days", "0", env={
            "OWUI_URL": "https://retention.invalid", "OWUI_TOKEN": "synthetic-token",
            "RETENTION_DAYS": "90",
        })
        self.assertEqual(result.returncode, 1)
        self.assertIn("RETENTION_DAYS must be >= 1", result.stderr)


if __name__ == "__main__":
    unittest.main()
