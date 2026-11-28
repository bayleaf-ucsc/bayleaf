#!/usr/bin/env python3
"""Offline cutover checks using fake Daytona, fake inventory, and SQLite."""

import contextlib
import io
import json
from pathlib import Path
import runpy
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("prepare-daytona-v2-cutover.py")
cutover = SimpleNamespace(**runpy.run_path(str(SCRIPT)))
OWNER = "o'neil@ucsc.edu"
SOURCE = "00000000-0000-0000-0000-000000000001"
DEST = "sbx_first"
ACTIVITY = "2026-11-25T12:00:00.123456789Z"
BACKUP = "2026-11-25T12:00:01Z"
IMPORTED = "2026-11-27T09:00:00.001Z"
INSPECTED = "2026-11-27T09:45:00.789123456Z"


class DaytonaFixture:
    def __init__(self):
        self.source = {"id": SOURCE, "state": "archived", "lastActivityAt": ACTIVITY,
                       "cpu": 2, "memory": 4, "disk": 8,
                       "labels": {cutover.LABEL: OWNER}}
        self.entry = {"v0_id": SOURCE, "labels": {cutover.LABEL: OWNER},
                      "importable": True, "last_backup_at": BACKUP}
        self.target = {"id": DEST, "status": "queued", "region_id": cutover.DEFAULT_QUALIFIED_REGION,
                       "persistent": True, "labels": {cutover.LABEL: OWNER},
                       "cpu": 0.5, "cores_max": 1, "memory_mib": 4096, "memory_max_mib": 8192,
                       "disk_max_mib": 10240,
                       "lifecycle_policy": {"last_activity_at": IMPORTED}}
        self.mutations = []
        self.label_ok = True
        self.label_visible = True

    def __call__(self, url, method="GET", body=None):
        url = url.split("?")[0]
        if method != "GET":
            self.mutations.append((method, url, body))
        if url == cutover.V0:
            return {"items": [{**self.source, "cpu": 999}], "nextCursor": None}
        if url == cutover.IMPORT:
            return {"sandboxes": [self.entry], "next_cursor": None}
        if url == f"{cutover.V2}/search":
            return {"sandboxes": [{**self.target, "cpu": 999}] if "imported_sandbox_id" in self.entry else [],
                    "next_cursor": None}
        if url == f"{cutover.V0}/{SOURCE}":
            return self.source
        if url == f"{cutover.V2}/{DEST}":
            return self.target
        if method == "POST" and url == f"{cutover.IMPORT}/{SOURCE}/import":
            existing = "imported_sandbox_id" in self.entry
            self.entry["imported_sandbox_id"] = DEST
            if self.label_ok and self.label_visible:
                self.source["labels"][cutover.MIGRATED_TO] = DEST
            return {"sandbox_id": DEST, "existing": existing, "v0_labeled": self.label_ok,
                    "warnings": ["test warning"], "secret_env_vars": ["BAYLEAF_API_KEY"]}
        if method == "PATCH" and url == f"{cutover.V2}/{DEST}/lifecycle-policy":
            self.target["lifecycle_policy"].update(body)
            return {"lifecycle_policy": self.target["lifecycle_policy"]}
        raise AssertionError((method, url))


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = DaytonaFixture()
        temporary = self.enterContext(tempfile.TemporaryDirectory())
        self.directory = Path(temporary) / "private-state"
        self.enterContext(patch.dict(cutover.run.__globals__, {
            "d1_bindings": lambda: [{"email": OWNER, "daytona_sandbox_id": SOURCE, "managed": 1}],
        }))
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))

    def run_stage(self, stage):
        cutover.run(SimpleNamespace(prepare=stage == "prepare", finalize=stage == "finalize",
                                    state_dir=self.directory,
                                    qualified_region=[cutover.DEFAULT_QUALIFIED_REGION]), self.fixture)

    def test_pagination_requires_terminal_cursor(self):
        pages = iter([{"sandboxes": [], "next_cursor": "part 2"},
                      {"sandboxes": [42], "next_cursor": None}])

        def fetch(url):
            self.assertIn("limit=100", url)
            page = next(pages)
            if page["next_cursor"] is None:
                self.assertIn("cursor=part+2", url)
            return page

        self.assertEqual(list(cutover.inventory(fetch, cutover.V2, "sandboxes", "next_cursor")), [42])
        for page in ({"sandboxes": []}, {"sandboxes": [], "next_cursor": ""},
                     {"sandboxes": [], "next_cursor": "repeated"}):
            with self.subTest(page=page), self.assertRaises(RuntimeError):
                list(cutover.inventory(lambda _: page, cutover.V2, "sandboxes", "next_cursor"))

    def test_stale_backup_at_sub_millisecond_precision(self):
        self.fixture.entry["last_backup_at"] = "2026-11-25T12:00:00.123456788Z"
        with self.assertRaisesRegex(RuntimeError, "backup predates"):
            self.run_stage("prepare")
        self.assertEqual(self.fixture.mutations, [])

    def test_unproven_import_refused_without_mutation(self):
        self.fixture.entry["imported_sandbox_id"] = DEST
        self.fixture.source["labels"][cutover.MIGRATED_TO] = DEST
        with self.assertRaisesRegex(RuntimeError, "No preparation ledger"):
            self.run_stage("prepare")
        self.assertEqual(self.fixture.mutations, [])

    def test_backup_change_rejects_reuse_even_if_source_activity_did_not_change(self):
        self.run_stage("prepare")
        self.fixture.entry["last_backup_at"] = "2026-11-26T02:00:00Z"
        with self.assertRaisesRegex(RuntimeError, "differs from preparation"):
            self.run_stage("prepare")
        self.assertEqual([m[0] for m in self.fixture.mutations], ["POST"])

    def test_changed_source_size_rejects_reuse(self):
        self.run_stage("prepare")
        self.fixture.source["disk"] = 10
        with self.assertRaisesRegex(RuntimeError, "differs from preparation"):
            self.run_stage("prepare")
        self.assertEqual([m[0] for m in self.fixture.mutations], ["POST"])

    def test_finalize_rejects_a_baseline_that_changes_during_capture(self):
        self.fixture.target["status"] = "paused"
        self.run_stage("prepare")
        count = 0
        daytona = self.fixture

        def change_baseline(url, method="GET", body=None):
            nonlocal count
            if url == f"{cutover.V2}/{DEST}":
                count += 1
                if count == 2:
                    daytona.target["lifecycle_policy"]["last_activity_at"] = INSPECTED
            return daytona(url, method, body)

        self.fixture = change_baseline
        with self.assertRaisesRegex(RuntimeError, "changed while capturing"):
            self.run_stage("finalize")
        self.assertFalse((self.directory / "handoff").exists())

    def test_label_confirmation_retry_and_post_inspection_baseline(self):
        self.fixture.label_ok = False
        with self.assertRaisesRegex(RuntimeError, "migration label"):
            self.run_stage("prepare")
        self.fixture.label_ok = True
        self.fixture.label_visible = False
        with self.assertRaisesRegex(RuntimeError, "migration label"):
            self.run_stage("prepare")
        self.fixture.label_visible = True
        self.run_stage("prepare")  # Repair the label, then wait for conversion.
        self.fixture.target["status"] = "running"
        self.run_stage("prepare")  # Reuse the proven import without doing another POST.
        self.assertEqual([m[0] for m in self.fixture.mutations], ["POST", "POST", "POST", "PATCH"])
        self.assertFalse((self.directory / "handoff").exists())
        with self.assertRaisesRegex(RuntimeError, "state"):
            self.run_stage("finalize")

        self.fixture.target["status"] = "paused"
        self.fixture.target["lifecycle_policy"]["last_activity_at"] = INSPECTED
        self.run_stage("finalize")
        handoff = self.directory / "handoff"
        mapping = json.loads((handoff / "mapping.json").read_text())[0]
        self.assertEqual(mapping["last_backup_at"], BACKUP)
        self.assertEqual(mapping["baseline_activity"], INSPECTED)
        self.assertEqual(mapping["baseline_activity_ms"], cutover.nanoseconds(INSPECTED) // 10**6)
        self.assertEqual(mapping["v0_resources"], {"cpu": 2, "memory": 4, "disk": 8})
        self.assertEqual(mapping["v2_resources"], {"cpu": 0.5, "cores_max": 1, "memory_mib": 4096,
                                                   "memory_max_mib": 8192, "disk_max_mib": 10240})
        self.assertEqual(mapping["import_warnings"], ["test warning"])
        self.assertEqual((handoff / "mapping.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual([m[0] for m in self.fixture.mutations], ["POST", "POST", "POST", "PATCH"])


class BindingTests(unittest.TestCase):
    def setUp(self):
        migration = SCRIPT.parents[1] / "migrations/0024_daytona_v2_import_activity.sql"
        self.db = self.enterContext(contextlib.closing(sqlite3.connect(":memory:")))
        self.db.executescript("CREATE TABLE user_keys (email TEXT PRIMARY KEY, daytona_sandbox_id TEXT);"
                              + migration.read_text())
        self.original = [(OWNER, SOURCE), ("second@ucsc.edu", "source-two")]
        self.destinations = [(OWNER, DEST), ("second@ucsc.edu", "sbx_second")]
        self.db.executemany("INSERT INTO user_keys VALUES (?,?)", self.original)
        self.manifest = [{"email": owner, "v0_id": old, "v2_id": new,
                          "source_activity_ms": 100, "baseline_activity_ms": 200 + i}
                         for i, ((owner, old), (_, new)) in enumerate(zip(self.original, self.destinations))]
        self.sql = cutover.handoff_sql(self.manifest)
        self.db.executescript(self.sql["install-guard.sql"])

    def bindings(self):
        return self.db.execute("SELECT * FROM user_keys ORDER BY email").fetchall()

    def activity(self):
        return self.db.execute("SELECT * FROM sandbox_import_activity ORDER BY sandbox_id").fetchall()

    def test_cutover_verify_retry_and_rollback(self):
        self.db.execute("INSERT INTO sandbox_import_activity VALUES ('unrelated','elsewhere',200,300)")
        for _ in range(2):
            self.db.execute(self.sql["cutover.sql"])
        # execute(), rather than executescript(), enforces the single-statement boundary.
        self.assertEqual(self.bindings(), self.destinations)
        self.assertEqual(self.db.execute(self.sql["verify.sql"]).fetchone(), (2, 2, 2, 2, 1))
        self.db.execute("UPDATE sandbox_import_activity SET baseline_activity_ms=999 WHERE sandbox_id=?", (DEST,))
        self.assertEqual(self.db.execute(self.sql["verify.sql"]).fetchone(), (2, 2, 2, 1, 0))
        with self.assertRaisesRegex(sqlite3.IntegrityError, "Unexpected fleet state"):
            self.db.execute(self.sql["rollback.sql"])
        self.db.execute("UPDATE sandbox_import_activity SET baseline_activity_ms=200 WHERE sandbox_id=?", (DEST,))
        for _ in range(2):
            self.db.execute(self.sql["rollback.sql"])
        self.assertEqual(self.bindings(), self.original)
        self.assertEqual(self.activity(), [("unrelated", "elsewhere", 200, 300)])
        self.assertEqual(self.db.execute(self.sql["verify-rollback.sql"]).fetchone(), (2, 2, 0, 0, 1))

    def test_preconditions_reject_binding_drift_or_stale_activity(self):
        self.db.execute("UPDATE user_keys SET daytona_sandbox_id='changed' WHERE email='second@ucsc.edu'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "Unexpected fleet state"):
            self.db.execute(self.sql["cutover.sql"])
        self.assertEqual(self.bindings(), [self.original[0], ("second@ucsc.edu", "changed")])
        self.assertEqual(self.activity(), [])
        self.db.execute("UPDATE user_keys SET daytona_sandbox_id='source-two' WHERE email='second@ucsc.edu'")
        self.db.execute("INSERT INTO sandbox_import_activity VALUES (?,?,1,2)", (DEST, SOURCE))
        with self.assertRaisesRegex(sqlite3.IntegrityError, "Unexpected fleet state"):
            self.db.execute(self.sql["cutover.sql"])
        self.assertEqual(self.bindings(), self.original)
        self.assertEqual(self.activity(), [(DEST, SOURCE, 1, 2)])

    def test_postcondition_failure_aborts_all_writes_in_both_directions(self):
        self.db.executescript("""CREATE TRIGGER skip_second BEFORE UPDATE ON user_keys
          WHEN OLD.email='second@ucsc.edu' BEGIN SELECT RAISE(IGNORE); END;""")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "all binding changes rolled back"):
            self.db.execute(self.sql["cutover.sql"])
        self.assertEqual(self.bindings(), self.original)
        self.assertEqual(self.activity(), [])
        self.db.execute("DROP TRIGGER skip_second")
        self.db.execute(self.sql["cutover.sql"])
        before = self.activity()
        self.db.executescript("""CREATE TRIGGER skip_second BEFORE UPDATE ON user_keys
          WHEN OLD.email='second@ucsc.edu' BEGIN SELECT RAISE(IGNORE); END;""")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "all binding changes rolled back"):
            self.db.execute(self.sql["rollback.sql"])
        self.assertEqual(self.bindings(), self.destinations)
        self.assertEqual(self.activity(), before)

    def test_partial_guard_install_cannot_accept_a_binding_command(self):
        self.db.executescript(self.sql["remove-guard.sql"])
        for statement in self.sql["install-guard.sql"].splitlines():
            if statement.startswith("CREATE VIEW"):
                self.db.execute(statement)
        with self.assertRaisesRegex(sqlite3.OperationalError, "cannot modify"):
            self.db.execute(self.sql["cutover.sql"])
        self.assertEqual(self.bindings(), self.original)
        self.assertEqual(self.activity(), [])


if __name__ == "__main__":
    unittest.main()
