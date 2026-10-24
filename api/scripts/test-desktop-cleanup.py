#!/usr/bin/env python3
"""Synthetic selection checks for desktop-cleanup.py. Never inspects real processes."""
import importlib.util
import pathlib

spec = importlib.util.spec_from_file_location('cleanup', pathlib.Path(__file__).with_name('desktop-cleanup.py'))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)

UID, D = 1001, ['HOME=/home/daytona', 'DISPLAY=:0']
proc = lambda pid, argv0, environ=D, uid=UID: {'pid': pid, 'uid': uid, 'argv0': argv0, 'environ': environ}
table = [
    proc(1, '/usr/local/bin/daytona'),                     # daemon
    proc(121, '/usr/local/lib/daytona-computer-use'),      # supervisor plugin
    proc(500, '/usr/libexec/xfconfd'), proc(501, 'ssh-agent'), proc(502, '/usr/bin/gpg-agent'),
    proc(503, '/usr/libexec/gvfs-udisks2-volume-monitor'), proc(504, '/usr/libexec/dconf-service'),
    proc(600, 'ssh-agent', ['HOME=/home/daytona']),         # ordinary shell's agent
    proc(601, 'ssh-agent', ['DISPLAY=:01']),                # a different display
    proc(602, 'ssh-agent', uid=0),                          # another user
    proc(603, '/usr/bin/python3'),                          # owner exported DISPLAY=:0
    proc(604, 'node'), proc(605, 'opencode'),
    proc(700, 'ssh-agent'),                                 # protected ancestor
    proc(701, '/usr/local/lib/daytona-ssh-agent'),          # Daytona binary
]
assert cleanup.select(table, UID, {700}) == [500, 501, 502, 503, 504], cleanup.select(table, UID, {700})
parents = {9: 8, 8: 3, 3: 1, 1: 0}
assert cleanup.ancestors(9, lambda p: parents.get(p, 0)) == {9, 8, 3, 1}
assert cleanup.ancestors(5, lambda p: 5) == {5}, 'cycle bounded'
print('PASS desktop cleanup selects only allowlisted DISPLAY=:0 session daemons (2 checks)')
