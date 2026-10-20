"""Synthetic tests only: never imports live cleanup code or opens its client."""
import dataclasses
import json
from pathlib import Path
import threading
import time
import unittest

from chat_retention import ChatRetentionCounts, RetentionPolicy, Run, chat_retention_summary, submit_summary

RUN = Run("d7360235-dd1a-4e94-a41e-e03b96046ff0", "2026-10-20T12:00:00.000Z",
          "2026-10-20T12:00:01.000Z", "ok")
POLICY = RetentionPolicy(90, 86400, 18)
TOKEN = "synthetic-only-chat-collector-write-token"
BUILD = lambda: chat_retention_summary(ChatRetentionCounts(chats_deleted=1), RUN, "delete", POLICY)


class AdapterTests(unittest.TestCase):
    def test_explicit_counts_unknown_phases_and_partial_progress(self):
        # Phase A failed after two confirmed DELETE replies. Files/account phase
        # never ran, so their counts are absent, not fabricated zeroes.
        counts = ChatRetentionCounts(users_total=9, users_held=2, chats_scanned=5,
                                     chats_expired=3, chats_deleted=2, users_impacted=1)
        result = chat_retention_summary(counts, dataclasses.replace(RUN, outcome="partial"), "delete", POLICY)
        self.assertEqual(result["deleted"], 2)
        self.assertEqual(result["outcome"], "partial")
        self.assertNotIn("files_deleted", result["extensions"]["counts"])
        self.assertEqual(result["extensions"]["user_retention_months"], 18)
        self.assertEqual(result["duration_ms"], 1000)

    def test_dry_run_does_not_claim_deletion_or_equate_candidates_and_eligible(self):
        counts = ChatRetentionCounts(chats_expired=4, chats_would_delete=4, users_expired=3,
                                     users_recheck_skipped=1, users_would_delete=2)
        result = chat_retention_summary(counts, RUN, "dry-run", POLICY)
        self.assertEqual(result["deleted"], 0)
        self.assertEqual(result["extensions"]["counts"]["users_would_delete"], 2)
        counts.users_deleted = 1
        self.assertIsNone(chat_retention_summary(counts, RUN, "dry-run", POLICY))

    def test_skipped_file_sweep_does_not_invent_orphan_inventory(self):
        result = chat_retention_summary(ChatRetentionCounts(files_total=2), RUN, "delete",
                                        dataclasses.replace(POLICY, file_sweep="skipped_no_eligible_files"))
        self.assertNotIn("files_orphan", result["extensions"]["counts"])
        self.assertEqual(result["extensions"]["file_sweep"], "skipped_no_eligible_files")

    def test_invalid_values_are_rejected_not_serialized(self):
        for value in (True, -1, 1.5, float("nan"), "private", 1000000000001):
            self.assertIsNone(chat_retention_summary(ChatRetentionCounts(chats_deleted=value), RUN, "delete", POLICY))
        for run in (dataclasses.replace(RUN, run_id="user@example.org"),
                    dataclasses.replace(RUN, started_at="2026-02-30T00:00:00.000Z"),
                    dataclasses.replace(RUN, ended_at="2026-10-20T11:59:59.000Z")):
            self.assertIsNone(chat_retention_summary(ChatRetentionCounts(), run, "delete", POLICY))
        self.assertIsNone(chat_retention_summary({"user_id": "private"}, RUN, "delete", POLICY))
        @dataclasses.dataclass(frozen=True)
        class UnknownPolicy(RetentionPolicy):
            identity: str = "must-not-escape"
        self.assertIsNone(chat_retention_summary(ChatRetentionCounts(), RUN, "delete", UnknownPolicy(90, 86400, 18)))

    def test_counter_names_exist_in_actual_source(self):
        source = (Path(__file__).parents[2] / "chat" / "retention_cleanup.py").read_text()
        for field in dataclasses.fields(ChatRetentionCounts):
            self.assertIn(field.name + "=", source)

    def test_transport_inert_by_default_and_credential_free_single_attempt(self):
        calls = []
        def sender(endpoint, body, headers, timeout):
            calls.append((endpoint, json.loads(body), headers, timeout))
            return 204
        build = lambda: chat_retention_summary(ChatRetentionCounts(chats_deleted=1), RUN, "delete", POLICY)
        config = dict(endpoint="https://collector.example/v1/deletions", sender=sender, service_token=TOKEN)
        self.assertFalse(submit_summary(lambda: self.fail("disabled builder ran"), **config))
        self.assertTrue(submit_summary(build, enabled=True, **config))
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][2], {"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"})
        self.assertNotIn(TOKEN, json.dumps(calls[0][1]))
        self.assertEqual(calls[0][3], 1)
        for endpoint in ("https://u:p@example.org/v1/deletions", "http://external.example/v1/deletions",
                         "https://example.org/v1/deletions?key=private", "https://example.org/wrong"):
            self.assertFalse(submit_summary(build, enabled=True, endpoint=endpoint, sender=sender, service_token=TOKEN))
        self.assertEqual(len(calls), 1)
        for token in (None, "", "too-short", TOKEN + "\n", TOKEN + " other"):
            self.assertFalse(submit_summary(build, enabled=True, endpoint=config["endpoint"], sender=sender, service_token=token))
        self.assertEqual(len(calls), 1)

    def test_transport_failure_and_oversize_swallowed(self):
        def broken(*args):
            raise RuntimeError("must not escape")
        config = dict(enabled=True, endpoint="http://127.0.0.1/v1/deletions", sender=broken, service_token=TOKEN)
        self.assertFalse(submit_summary(BUILD, **config))
        self.assertFalse(submit_summary(lambda: {"source": "chat-retention", "x": "x" * 16384}, **config))
        self.assertFalse(submit_summary(broken, **config))

    def test_delivery_deadline_bounds_caller_and_does_not_spawn_unbounded_threads(self):
        release, exited = threading.Event(), threading.Event()
        def stalled(*args):
            release.wait(1)
            exited.set()
            return 204
        config = dict(enabled=True, endpoint="http://localhost/v1/deletions", sender=stalled, deadline_ms=10, service_token=TOKEN)
        start = time.monotonic()
        self.assertFalse(submit_summary(BUILD, **config))
        self.assertLess(time.monotonic() - start, 0.5)
        self.assertFalse(submit_summary(BUILD, **config))  # Single occupied delivery slot.
        release.set()
        self.assertTrue(exited.wait(1))


if __name__ == "__main__":
    unittest.main()
