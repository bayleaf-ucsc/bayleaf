#!/usr/bin/env python3
"""Compare quiesced Daytona homes using the same source in both guests.

Run as the configured daytona user with `python3 -I -S -c <this source>`.
Success is one JSON line with `version` (2), `sha256`, and `entries`
(including the scan root). By default the scope is all of /home/daytona.
Pass /home/daytona/workspace as the sole positional argument to compare only
that tree. Both scopes include dotfiles and have no path exclusions.
Compare relative path bytes, entry type, permission bits, numeric ownership,
regular file bytes, and literal symlink targets. Inodes, hard-link
relationships, timestamps, ACLs, and xattrs are outside the comparison.
Unix sockets are runtime endpoints and have no filesystem payload to restore.
The verified legacy Daytona entrypoint runtime directory is omitted only
when it contains the expected provider artifacts and entry types.

Reads are descriptor-relative and symlinks are never followed inside the
tree. Recheck metadata during the read and in a second traversal to catch
changes to earlier entries. This is a race check, not an atomic snapshot:
keep writers quiesced for the entire comparison.

Unreadable paths, special files, nested filesystems and exceeded limits
produce no digest and a nonzero exit. Use an external command timeout too,
in case the guest filesystem blocks in the kernel.
"""

import hashlib
import json
import os
import re
import signal
import stat
import struct
import sys
import time


ROOT = b"/home/daytona"
WORKSPACE_ROOT = b"/home/daytona/workspace"
MOUNTINFO = "/proc/self/mountinfo"
ENTRYPOINT = b".daytona/sessions/entrypoint"
ENTRYPOINT_RUNTIME = {
    b"entrypoint_command": {
        b"cmd.sh": stat.S_ISREG,
        b"output.log": stat.S_ISREG,
        b"input.pipe": stat.S_ISFIFO,
        b"stdout.pipe": stat.S_ISFIFO,
        b"stderr.pipe": stat.S_ISFIFO,
    },
}
MAX_ENTRIES = 500_000
MAX_DEPTH = 128
MAX_BYTES = 16 * 1024**3  # Logical regular-file bytes, including sparse holes.
MAX_SECONDS = 100
READ_CHUNK = 1024**2


class ScanFailure(Exception):
    """Carries only a fixed, workspace-independent error message."""


def frame(digest, value):
    digest.update(struct.pack(">Q", len(value)))
    digest.update(value)


def signature(info):
    # Used only to detect local changes. Reads themselves may advance atime.
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_size, info.st_nlink,
            info.st_mtime_ns, info.st_ctime_ns)


def check_same(before, after):
    if signature(before) != signature(after):
        raise ScanFailure("tree changed")


def file_digest(parent_fd, name, before):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(name, flags, dir_fd=parent_fd)
    try:
        check_same(before, os.fstat(fd))
        digest = hashlib.sha256()
        remaining = before.st_size
        while remaining:
            chunk = os.read(fd, min(remaining, READ_CHUNK))
            if not chunk:
                raise ScanFailure("tree changed")
            digest.update(chunk)
            remaining -= len(chunk)
        if os.read(fd, 1):
            raise ScanFailure("tree changed")
        check_same(before, os.fstat(fd))
        return digest.digest()
    finally:
        os.close(fd)


def mount_snapshot(root):
    if sys.platform != "linux":
        return ()
    prefix = root.rstrip(b"/") + b"/"
    relevant = []
    with open(MOUNTINFO, "rb") as mounts:
        for line in mounts:
            fields = line.split()
            if len(fields) < 10 or b"-" not in fields[6:]:
                raise ScanFailure("invalid mount information")
            target = re.sub(rb"\\([0-7]{3})", lambda match: bytes([int(match[1], 8)]), fields[4])
            if target.startswith(prefix):
                raise ScanFailure("nested filesystem")
            if target == root or root.startswith(target.rstrip(b"/") + b"/"):
                relevant.append(line)
    if not relevant:
        raise ScanFailure("invalid mount information")
    return tuple(relevant)


def validate_runtime_directory(parent_fd, name, before, expected):
    if not stat.S_ISDIR(before.st_mode):
        raise ScanFailure("unexpected entrypoint runtime entry")
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        check_same(before, os.fstat(fd))
        with os.scandir(fd) as entries:
            for entry in entries:
                child = os.fsencode(entry.name)
                allowed = expected.get(child)
                info = os.stat(child, dir_fd=fd, follow_symlinks=False)
                if isinstance(allowed, dict):
                    validate_runtime_directory(fd, child, info, allowed)
                elif allowed is None or not allowed(info.st_mode):
                    raise ScanFailure("unexpected entrypoint runtime entry")
        check_same(before, os.fstat(fd))
    finally:
        os.close(fd)


def scan(root_parent, root_name, root_info, *, with_contents, legacy_runtime):
    content = hashlib.sha256(b"bayleaf-daytona-workspace-v2\0")
    observed = hashlib.sha256()
    count = 1
    visited = 1
    total_bytes = 0

    def walk(parent_fd, name, relative, before, depth):
        nonlocal count, total_bytes, visited
        mode = before.st_mode
        if stat.S_ISDIR(mode) and before.st_dev != root_info.st_dev:
            raise ScanFailure("nested filesystem")
        frame(observed, relative)
        frame(observed, repr(signature(before)).encode("ascii"))
        if with_contents:
            content.update(struct.pack(">III", mode, before.st_uid, before.st_gid))
            frame(content, relative)

        if stat.S_ISDIR(mode):
            if depth > MAX_DEPTH:
                raise ScanFailure("depth limit")
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                         dir_fd=parent_fd)
            try:
                check_same(before, os.fstat(fd))
                names = []
                with os.scandir(fd) as entries:
                    for entry in entries:
                        visited += 1
                        if visited > MAX_ENTRIES:
                            raise ScanFailure("entry limit")
                        names.append(os.fsencode(entry.name))
                for child in sorted(names):
                    child_info = os.stat(child, dir_fd=fd, follow_symlinks=False)
                    child_path = relative + b"/" + child if relative else child
                    if legacy_runtime and child_path == ENTRYPOINT:
                        validate_runtime_directory(fd, child, child_info, ENTRYPOINT_RUNTIME)
                        continue
                    if stat.S_ISSOCK(child_info.st_mode):
                        continue
                    count += 1
                    walk(fd, child, child_path, child_info, depth + 1)
                check_same(before, os.fstat(fd))
            finally:
                os.close(fd)
        elif stat.S_ISREG(mode):
            total_bytes += before.st_size
            if total_bytes > MAX_BYTES:
                raise ScanFailure("byte limit")
            if with_contents:
                content.update(file_digest(parent_fd, name, before))
        elif stat.S_ISLNK(mode):
            if with_contents:
                frame(content, os.readlink(name, dir_fd=parent_fd))
        else:
            raise ScanFailure("unsupported entry type")

        check_same(before, os.stat(name, dir_fd=parent_fd, follow_symlinks=False))

    walk(root_parent, root_name, b"", root_info, 0)
    return content.hexdigest(), count, observed.digest()


def workspace_digest(root, *, legacy_runtime=False):
    parent_path, name = os.path.split(root)
    parent = os.open(parent_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parent_info = os.fstat(parent)
        root_info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISDIR(root_info.st_mode):
            raise ScanFailure("scan root is not a directory")
        mounts = mount_snapshot(root)
        digest, count, observed = scan(parent, name, root_info, with_contents=True, legacy_runtime=legacy_runtime)
        _, rechecked_count, rechecked = scan(parent, name, root_info, with_contents=False, legacy_runtime=legacy_runtime)
        if (count, observed) != (rechecked_count, rechecked) or mounts != mount_snapshot(root):
            raise ScanFailure("tree changed")
        # Keep sibling changes outside a selected scope out of the comparison.
        current_parent = os.stat(parent_path, follow_symlinks=False)
        if not os.path.samestat(parent_info, current_parent):
            raise ScanFailure("tree changed")
    finally:
        os.close(parent)
    return {"version": 2, "sha256": digest, "entries": count}


def timed_out(_signum, _frame):
    raise ScanFailure("time limit")


def main(args):
    try:
        root = ROOT
        if args:
            if len(args) != 1 or os.fsencode(args[0]) not in (ROOT, WORKSPACE_ROOT):
                raise ScanFailure("invalid scope")
            root = os.fsencode(args[0])
        deadline = time.monotonic() + MAX_SECONDS
        signal.signal(signal.SIGALRM, timed_out)
        signal.setitimer(signal.ITIMER_REAL, MAX_SECONDS)
        try:
            result = workspace_digest(root, legacy_runtime=root == ROOT)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
        if time.monotonic() >= deadline:
            raise ScanFailure("time limit")
    except ScanFailure as error:
        print(f"workspace digest failed: {error}", file=sys.stderr)
        return 1
    except (Exception, KeyboardInterrupt):
        # OS and interpreter errors can contain workspace paths.
        print("workspace digest failed: scan error", file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
