#!/usr/bin/env python3
"""Reap desktop-session daemons that Daytona's /computeruse/stop leaves behind.

Run by the SandboxBrowser controller through Toolbox only after a successful
POST /computeruse/stop. Observed leaks (2026-10-24 spike): xfconfd, one
ssh-agent per xfce4-session generation, gpg-agent, gvfs* and dconf-service, all
reparented to pid 1. X clients die with Xvfb, so these non-X daemons are all
that survive.

A process is reaped only if ALL hold:
  - its argv[0] basename is in LEAKED (a fixed allowlist of session daemons);
  - it belongs to this script's uid;
  - its /proc/<pid>/environ contains exactly DISPLAY=:0, so it was started
    inside the desktop session rather than by an ordinary shell;
  - it is not pid 1 (the Daytona daemon), a Daytona binary, this script, or
    one of this script's ancestors (the Toolbox shell running it).
Requiring the allowlist keeps an owner who exports DISPLAY=:0 in a shell
profile from losing agents or apps. Prints {"stopped":true,"reaped":N} only.
No pids, names or paths are printed.
"""
import json
import os
import signal
import sys
import time

LEAKED = frozenset({
    'xfconfd', 'ssh-agent', 'gpg-agent', 'dconf-service', 'gvfsd', 'gvfsd-trash',
    'gvfsd-metadata', 'gvfsd-fuse', 'gvfs-udisks2-volume-monitor',
    'gvfs-afc-volume-monitor', 'gvfs-mtp-volume-monitor',
    'gvfs-gphoto2-volume-monitor', 'gvfs-goa-volume-monitor',
})


def ancestors(pid, parent_of):
    """Pids from pid up to (not including) 0, bounded against cycles."""
    seen = []
    while pid > 0 and pid not in seen and len(seen) < 512:
        seen.append(pid)
        pid = parent_of(pid)
    return set(seen)


def select(processes, uid, protected):
    """Pure selection. processes: iterable of dicts {pid, uid, argv0, environ}."""
    chosen = []
    for p in processes:
        name = os.path.basename(p['argv0'] or '')
        if (p['pid'] == 1 or p['pid'] in protected or p['uid'] != uid or
                'daytona' in (p['argv0'] or '') or name not in LEAKED or
                'DISPLAY=:0' not in p['environ']):
            continue
        chosen.append(p['pid'])
    return chosen


def read_proc(pid):
    base = f'/proc/{pid}'
    try:
        uid = os.stat(base).st_uid
        with open(f'{base}/cmdline', 'rb') as f:
            argv0 = f.read().split(b'\0')[0].decode(errors='replace')
        with open(f'{base}/environ', 'rb') as f:
            environ = [e.decode(errors='replace') for e in f.read().split(b'\0')]
    except OSError:
        return None
    return {'pid': pid, 'uid': uid, 'argv0': argv0, 'environ': environ}


def parent(pid):
    try:
        with open(f'/proc/{pid}/stat') as f:
            return int(f.read().rsplit(')', 1)[1].split()[1])
    except (OSError, ValueError, IndexError):
        return 0


def main():
    protected = ancestors(os.getpid(), parent)
    table = [p for p in (read_proc(int(n)) for n in os.listdir('/proc') if n.isdigit()) if p]
    targets = select(table, os.getuid(), protected)
    for pid in targets:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline and any(os.path.exists(f'/proc/{pid}') for pid in targets):
        time.sleep(0.1)
    # Re-check identity before escalating, so a reused pid is never killed.
    current = [p for p in (read_proc(pid) for pid in targets) if p]
    for pid in select(current, os.getuid(), protected):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    print(json.dumps({'stopped': True, 'reaped': len(targets)}))


if __name__ == '__main__':
    sys.exit(main())
