#!/usr/bin/env python3
"""Offline filesystem and failure checks for the in-guest digest."""

import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import signal
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("daytona-workspace-digest.py")


class WorkspaceDigestTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / "home"
        self.root.mkdir(mode=0o755)
        self.module = runpy.run_path(str(SCRIPT))["main"].__globals__

    def digest(self, root=None):
        return self.module["workspace_digest"](os.fsencode(root or self.root))

    def test_results_match_across_order_inode_and_mtime(self):
        def create(root, backwards):
            root.mkdir(mode=0o755, exist_ok=True)
            entries = [
                lambda: (root / ".hidden").write_bytes(b"\x00\xff"),
                lambda: (root / "empty").mkdir(mode=0o755),
                lambda: (root / "pointer").symlink_to("missing\npath"),
                lambda: (root / "workspace\nproject").write_bytes(b"test"),
            ]
            for entry in reversed(entries) if backwards else entries:
                entry()

        create(self.root, False)
        other = self.root.with_name("restored")
        create(other, True)
        os.utime(other / ".hidden", (1, 1))
        first = self.digest()
        self.assertEqual(first, self.digest(other))
        self.assertEqual(first["version"], 2)
        self.assertEqual(first["entries"], 5)
        self.assertRegex(first["sha256"], r"^[0-9a-f]{64}$")

    def test_changes_in_each_compared_property(self):
        file = self.root / "file"
        file.write_bytes(b"old")
        directory = self.root / "dir"
        directory.mkdir(mode=0o755)
        link = self.root / "link"
        link.symlink_to("missing")

        def change(mutate):
            before = self.digest()
            mutate()
            self.assertNotEqual(before["sha256"], self.digest()["sha256"])

        change(lambda: file.write_bytes(b"new"))
        change(lambda: file.chmod(0o700))
        change(lambda: file.rename(self.root / "new-name"))
        change(lambda: directory.chmod(0o700))
        change(directory.rmdir)
        def retarget():
            link.unlink()
            link.symlink_to("also-missing")

        change(retarget)

    def test_symlink_targets_are_never_traversed(self):
        outside = self.root.with_name("outside")
        outside.mkdir()
        (self.root / "loop").symlink_to(".")
        (self.root / "external").symlink_to(outside)
        first = self.digest()
        (outside / "file").write_bytes(b"outside scope")
        self.assertEqual(first, self.digest())
        with self.assertRaisesRegex(self.module["ScanFailure"], "not a directory"):
            self.digest(self.root / "external")

    def test_scope_is_explicit(self):
        workspace = self.root / "workspace"
        workspace.mkdir()
        (workspace / "project").write_bytes(b"project")
        home_before, workspace_before = self.digest(), self.digest(workspace)
        (self.root / ".outside-workspace").write_bytes(b"provider lifecycle state")
        self.assertNotEqual(home_before, self.digest())
        self.assertEqual(workspace_before, self.digest(workspace))
        self.assert_failure("invalid scope", ["private-path"])

    def test_detects_mutation_after_file_was_hashed(self):
        early = self.root / "a"
        early.write_bytes(b"old")
        os.utime(early, (1, 1))
        (self.root / "z").write_bytes(b"last file")
        original = self.module["file_digest"]

        def mutate_earlier_file(parent_fd, name, before):
            if name == b"z":
                early.write_bytes(b"new")
            return original(parent_fd, name, before)

        with patch.dict(self.module, file_digest=mutate_earlier_file):
            with self.assertRaisesRegex(self.module["ScanFailure"], "tree changed"):
                self.digest()

    def test_detects_in_place_mutation_during_read(self):
        file = self.root / "file"
        file.write_bytes(b"old")
        os.utime(file, (1, 1))
        original = os.read

        def mutate_after_chunk(fd, size):
            chunk = original(fd, size)
            if chunk:
                file.write_bytes(b"new")
            return chunk

        with patch.object(os, "read", side_effect=mutate_after_chunk):
            with self.assertRaisesRegex(self.module["ScanFailure"], "tree changed"):
                self.digest()

    def test_bounds_and_special_files_fail(self):
        (self.root / "large").write_bytes(b"too big")
        (self.root / "nested").mkdir()
        for bound, limit, message in (("MAX_BYTES", 1, "byte"), ("MAX_ENTRIES", 1, "entry"),
                                      ("MAX_DEPTH", 0, "depth")):
            with self.subTest(bound=bound), patch.dict(self.module, {bound: limit}):
                with self.assertRaisesRegex(self.module["ScanFailure"], f"{message} limit"):
                    self.digest()
        os.mkfifo(self.root / "fifo")
        with self.assertRaisesRegex(self.module["ScanFailure"], "unsupported entry type"):
            self.digest()

    def test_unix_socket_is_not_persisted_content(self):
        before = self.digest()
        with socket.socket(socket.AF_UNIX) as endpoint:
            endpoint.bind(str(self.root / "socket"))
            self.assertEqual(self.digest(), before)

    def test_legacy_entrypoint_exceptions_are_exact_paths_and_types(self):
        pipe = self.root / ".daytona/sessions/entrypoint/entrypoint_command/stdout.pipe"
        digest = lambda: self.module["workspace_digest"](os.fsencode(self.root), legacy_runtime=True)
        pipe.parent.parent.parent.mkdir(parents=True)
        before = digest()
        pipe.parent.mkdir(parents=True)
        os.mkfifo(pipe)
        pipe.with_name("cmd.sh").write_bytes(b"provider runtime")
        self.assertEqual(digest(), before)
        pipe.unlink()
        pipe.write_bytes(b"regular file must be compared")
        with self.assertRaisesRegex(self.module["ScanFailure"], "unexpected entrypoint runtime entry"):
            digest()
        pipe.unlink()
        pipe.with_name("unrecognized.log").write_bytes(b"must not be omitted")
        with self.assertRaisesRegex(self.module["ScanFailure"], "unexpected entrypoint runtime entry"):
            digest()

    def test_kernel_mount_table_rejects_nested_same_device_file_mount(self):
        path = self.root.with_name("mountinfo")
        root = b"1 0 8:1 / / rw - ext4 /dev/example rw\n"
        bind_target = os.fsencode(self.root / "a b").replace(b" ", rb"\040")
        with patch.dict(self.module, MOUNTINFO=path), patch.object(sys, "platform", "linux"):
            path.write_bytes(root)
            self.digest()
            path.write_bytes(root + b"2 1 8:1 /file " + bind_target + b" rw - ext4 /dev/example rw\n")
            with self.assertRaisesRegex(self.module["ScanFailure"], "nested filesystem"):
                self.digest()

    def test_cli_redacts_permission_errors(self):
        file = self.root / "private-filename"
        file.write_bytes(b"private-contents")
        original = os.open

        def deny_file(name, flags, **kwargs):
            if name == b"private-filename":
                raise PermissionError(13, "permission denied", name)
            return original(name, flags, **kwargs)

        with patch.object(os, "open", side_effect=deny_file):
            self.assert_failure("scan error")

    def test_refuses_file_replaced_with_symlink_before_open(self):
        file = self.root / "private-filename"
        file.write_bytes(b"original contents")
        outside = self.root.with_name("outside")
        outside.write_bytes(b"outside scope")
        original = os.open

        def replace_before_open(name, flags, **kwargs):
            if name == b"private-filename":
                file.unlink()
                file.symlink_to(outside)
            return original(name, flags, **kwargs)

        with patch.object(os, "open", side_effect=replace_before_open):
            self.assert_failure("scan error")

    def test_cli_times_out_while_blocked(self):
        with patch.dict(self.module, MAX_SECONDS=0.02, workspace_digest=lambda _root, **_: signal.pause()):
            self.assert_failure("time limit")

    def assert_failure(self, message, args=()):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.dict(self.module, ROOT=os.fsencode(self.root)):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                self.assertEqual(self.module["main"](args), 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), f"workspace digest failed: {message}\n")

    def test_one_json_line_from_python_dash_c(self):
        workspace = self.root / "workspace"
        workspace.mkdir()
        (self.root / "private-filename").write_bytes(b"private-contents")
        # Submit the source verbatim, overriding only the allowed roots in memory.
        bootstrap = "\n".join([
            "import os, sys",
            "namespace = {'__name__': 'offline_test'}",
            "exec(sys.argv[1], namespace)",
            "namespace['ROOT'], namespace['WORKSPACE_ROOT'] = map(os.fsencode, sys.argv[2:4])",
            "sys.exit(namespace['main'](sys.argv[4:]))",
        ])
        argv = [sys.executable, "-I", "-S", "-c", bootstrap, SCRIPT.read_text(),
                str(self.root), str(workspace)]
        for root, args in ((self.root, []), (workspace, [str(workspace)])):
            with self.subTest(args=args):
                result = subprocess.run(
                    argv + args, capture_output=True, text=True, check=True, timeout=5,
                )
                self.assertEqual(result.stderr, "")
                self.assertEqual(len(result.stdout.splitlines()), 1)
                self.assertEqual(json.loads(result.stdout), self.digest(root))


if __name__ == "__main__":
    unittest.main()
