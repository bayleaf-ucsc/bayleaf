#!/usr/bin/env python3
"""Offline exercise of provisional archive comparison, recovery and cleanup."""

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import daytona_workspace_compare as comparison

OWNER = "fixture@example.test"
V0_ID, V2_ID = "source", "destination"
PINNED = {"v0_id": V0_ID, "source_activity": "old", "last_backup_at": "backup"}


class Fleet:
    """One owner's v0 source and v2 destination, with a fake clock."""

    def __init__(self, test, *, v0="archived", v2="paused", restore_s=0):
        self.test = test
        self.states = {"v0": v0, "v2": v2}
        self.activity = {"v0": "old" if v0 == "archived" else "new", "v2": "v2-0"}
        self.actions = []
        self.restore_s = restore_s
        self.clock = 0.0
        self.restoring_until = None
        self.failures = []  # (url predicate, exception) consumed once each.
        self.on_action = None

    def provider(self, url, method="GET", body=None, **_):
        for index, (match, error) in enumerate(self.failures):
            if match(url, method):
                del self.failures[index]
                raise error
        self.test.assertIsNone(body)
        if url.startswith(comparison.IMPORT + "?"):
            return {"sandboxes": [{"v0_id": V0_ID, "imported_sandbox_id": V2_ID,
                "labels": {comparison.OWNER_LABEL: OWNER}, "last_backup_at": "backup",
                "importable": self.states["v0"] == "archived"}], "next_cursor": None}
        legacy = url.startswith(comparison.V0 + "/")
        api, ident, tier = (comparison.V0, V0_ID, "v0") if legacy else (comparison.V2, V2_ID, "v2")
        suffix = url.removeprefix(f"{api}/{ident}")
        if method == "POST":
            self.actions.append((tier, suffix))
            if suffix == "/start" and legacy and self.restore_s:
                self.states["v0"], self.restoring_until = "restoring", self.clock + self.restore_s
            else:
                self.states[tier] = {"/start": "started", "/stop": "stopped",
                                     "/resume": "running", "/pause": "paused"}[suffix]
            if suffix in {"/start", "/resume"}:
                self.activity[tier] = "new" if legacy else f"v2-{len(self.actions)}"
            if self.on_action:
                self.on_action(tier, suffix)
            return {}
        self.test.assertEqual(suffix, "")
        if self.restoring_until is not None and self.clock >= self.restoring_until:
            self.states["v0"], self.restoring_until = "started", None
        labels = {comparison.OWNER_LABEL: OWNER}
        if legacy:
            labels[comparison.MIGRATION_LABEL] = V2_ID
            return {"id": ident, "state": self.states["v0"], "labels": labels,
                    "lastActivityAt": self.activity["v0"]}
        return {"id": ident, "status": self.states["v2"], "labels": labels, "persistent": True,
                "region_id": "test", "toolbox_proxy_url": "https://proxy.test.daytona.app/toolbox",
                "lifecycle_policy": {"last_activity_at": self.activity["v2"]}}

    def sleep(self, seconds):
        self.clock += seconds


class ComparisonTest(unittest.TestCase):
    def setUp(self):
        self.directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.state = {"prepared": True, "archive_equivalence": True, "source": {OWNER: PINNED},
                      "imports": {OWNER: {"v2_id": V2_ID, "v0_labeled": True}}}
        self.ledger = self.directory / comparison.LEDGER
        self.marker = self.directory / comparison.PENDING

    def compare(self, fleet, *, matches=True):
        def digest(_provider, url, *, legacy):
            self.assertTrue(url.endswith("/" + (V0_ID if legacy else V2_ID)))
            self.assertEqual(fleet.states["v0" if legacy else "v2"], "started" if legacy else "running")
            if legacy:
                self.assertEqual(fleet.states["v2"], "paused", "v2 must sleep before the v0 restore")
                self.assertTrue(self.marker.exists(), "marker must be durable before the v0 start")
            return {"version": 2, "sha256": ("a" if legacy or matches else "b") * 64, "entries": 1}

        with (patch.object(comparison, "toolbox_digest", side_effect=digest),
              patch.object(comparison.time, "sleep", side_effect=fleet.sleep),
              patch.object(comparison.time, "monotonic", side_effect=lambda: fleet.clock)):
            comparison.compare_archives(fleet.provider, self.directory, self.state, ["test"])

    def private(self, path, text):
        path.write_text(text)
        path.chmod(0o600)

    def test_matching_pair_pauses_v2_before_restore_and_records_stopped_source(self):
        fleet = Fleet(self)
        self.compare(fleet)
        self.assertEqual(fleet.actions, [("v2", "/resume"), ("v2", "/pause"), ("v0", "/start"), ("v0", "/stop")])
        self.assertEqual(self.ledger.stat().st_mode & 0o777, 0o600)
        receipt = json.loads(self.ledger.read_text())[OWNER]
        self.assertEqual(receipt["source"], PINNED)
        self.assertEqual(receipt["manifest_version"], "sha256-tree-v2:/home/daytona")
        self.assertEqual(receipt["observed_v0"], {"state": "stopped", "source_activity": "new",
                                                  "last_backup_at": "backup"})
        self.assertFalse(self.marker.exists())

    def test_mismatch_sleeps_both_and_keeps_marker_without_receipt(self):
        fleet = Fleet(self)
        with self.assertRaisesRegex(RuntimeError, "digests differ"):
            self.compare(fleet, matches=False)
        self.assertEqual(fleet.actions, [("v2", "/resume"), ("v2", "/pause"), ("v0", "/start"), ("v0", "/stop")])
        self.assertFalse(self.ledger.exists())
        self.assertEqual(json.loads(self.marker.read_text()), {"owner": OWNER, "v0_id": V0_ID, "v2_id": V2_ID})
        self.assertEqual(self.marker.stat().st_mode & 0o777, 0o600)

    def test_restore_may_outlast_the_ordinary_settle_window(self):
        fleet = Fleet(self, restore_s=600)
        self.compare(fleet)
        self.assertIn(OWNER, json.loads(self.ledger.read_text()))

    def test_restore_beyond_limit_sleeps_v2_and_keeps_marker(self):
        fleet = Fleet(self, restore_s=10_000)
        with self.assertRaisesRegex(RuntimeError, "expected lifecycle state"):
            self.compare(fleet)
        self.assertEqual(fleet.actions[-1], ("v0", "/start"))
        self.assertEqual(fleet.states["v2"], "paused")
        self.assertTrue(self.marker.exists(), "a rerun must recover the in-flight restore")

    def test_marker_recovers_interrupted_restore_with_stop_first(self):
        fleet = Fleet(self, v0="started", v2="running")
        self.private(self.marker, json.dumps({"owner": OWNER, "v0_id": V0_ID, "v2_id": V2_ID}))
        self.compare(fleet)
        self.assertEqual(fleet.actions[:2], [("v0", "/stop"), ("v2", "/pause")])
        self.assertEqual(fleet.actions[2:], [("v2", "/resume"), ("v2", "/pause"), ("v0", "/start"), ("v0", "/stop")])
        self.assertIn(OWNER, json.loads(self.ledger.read_text()))
        self.assertFalse(self.marker.exists())

    def test_restored_source_without_marker_is_refused_before_any_action(self):
        fleet = Fleet(self, v0="stopped")
        with self.assertRaisesRegex(RuntimeError, "original archive changed"):
            self.compare(fleet)
        self.assertEqual(fleet.actions, [])

    def test_stale_marker_after_saved_receipt_is_removed(self):
        self.private(self.ledger, json.dumps({OWNER: {"v2_id": V2_ID}}))
        self.private(self.marker, json.dumps({"owner": OWNER, "v0_id": V0_ID, "v2_id": V2_ID}))
        fleet = Fleet(self)
        self.compare(fleet)
        self.assertFalse(self.marker.exists())
        self.assertEqual(fleet.actions, [])

    def test_foreign_marker_is_refused(self):
        self.private(self.marker, json.dumps({"owner": OWNER, "v0_id": V0_ID, "v2_id": "other"}))
        with self.assertRaisesRegex(RuntimeError, "marker disagrees"):
            self.compare(Fleet(self))

    def test_v2_activity_drift_during_restore_refuses_receipt(self):
        fleet = Fleet(self)

        def touch(tier, suffix):
            if (tier, suffix) == ("v0", "/start"):
                fleet.activity["v2"] = "touched"
        fleet.on_action = touch
        with self.assertRaisesRegex(RuntimeError, "activity changed"):
            self.compare(fleet)
        self.assertFalse(self.ledger.exists())

    def test_transient_reads_retry_but_definite_errors_do_not(self):
        fleet = Fleet(self)
        get = lambda url, method: method == "GET"
        fleet.failures = [(get, TimeoutError()), (get, RuntimeError("Daytona GET failed: HTTP 503"))]
        self.compare(fleet)
        self.assertIn(OWNER, json.loads(self.ledger.read_text()))

        self.ledger.unlink()
        fleet = Fleet(self)
        fleet.failures = [(get, RuntimeError("Daytona GET failed: HTTP 404"))]
        with self.assertRaisesRegex(RuntimeError, "HTTP 404"):
            self.compare(fleet)

    def test_reads_give_up_after_bounded_attempts(self):
        fleet = Fleet(self)
        fleet.failures = [(lambda url, method: method == "GET", ConnectionResetError())] * comparison.READ_ATTEMPTS
        with self.assertRaises(ConnectionResetError):
            self.compare(fleet)
        self.assertEqual(fleet.actions, [])

    def test_lifecycle_posts_are_not_retried(self):
        fleet = Fleet(self)
        fleet.failures = [(lambda url, method: method == "POST", TimeoutError())]
        with self.assertRaises(TimeoutError):
            self.compare(fleet)
        self.assertEqual(fleet.actions, [])

    def test_ledger_must_be_private_unique_and_not_a_link(self):
        cases = {
            "duplicate keys": ('{"%s": {}, "%s": {}}' % (OWNER, OWNER), 0o600),
            "Unsafe": ("{}", 0o644),
        }
        for message, (text, mode) in cases.items():
            with self.subTest(message):
                self.ledger.write_text(text)
                self.ledger.chmod(mode)
                with self.assertRaisesRegex(RuntimeError, message):
                    self.compare(Fleet(self))
                self.ledger.unlink()
        target = self.directory / "elsewhere.json"
        self.private(target, "{}")
        os.symlink(target, self.ledger)
        with self.assertRaisesRegex(RuntimeError, "Unsafe"):
            self.compare(Fleet(self))

    def test_v2_logs_must_be_one_complete_page(self):
        frames = [{"channel": "stdout", "data": "out"}, {"channel": "stderr", "data": "err"}]
        self.assertEqual(comparison.v2_logs({"logs": {"frames": frames, "eof": True}}), ("out", "err"))
        for result in ({}, {"logs": {"frames": frames}}, {"logs": {"frames": frames, "eof": False, "nextCursor": "x"}},
                       {"truncatedHead": True, "logs": {"frames": frames, "eof": True}},
                       {"logs": {"frames": frames, "eof": True, "truncatedHead": True}},
                       {"logs": {"frames": [{"channel": "stdout"}], "eof": True}}):
            with self.subTest(result=result), self.assertRaisesRegex(RuntimeError, "incomplete"):
                comparison.v2_logs(result)


if __name__ == "__main__":
    unittest.main()
