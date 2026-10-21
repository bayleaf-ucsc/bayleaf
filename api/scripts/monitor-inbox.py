#!/usr/bin/env python3
"""Bounded, deliberately invoked arrival watch. Metadata only, no background AI.

BAYLEAF_API_KEY must already be in the environment. No credential read-back,
server-side subscription, or automatic processing. First arrival ends the watch.
"""
import argparse
import json
import os
import re
import time
import urllib.error
import urllib.request

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('inbox_id')
p.add_argument('--minutes', type=float, default=10)
p.add_argument('--interval', type=float, default=5)
a = p.parse_args()
if not re.fullmatch(r'ibx_[a-z2-7]{26}', a.inbox_id) or not 0 < a.minutes <= 30 or not 5 <= a.interval <= 60:
    p.error('Valid inbox id, 0–30 minutes and 5–60 second interval required')
key = os.environ.get('BAYLEAF_API_KEY', '')
if not key.startswith('sk-bayleaf-') or key.startswith('sk-bayleaf-grant-'):
    p.error('An ordinary BayLeaf key is required in the environment')
end = time.monotonic() + a.minutes * 60
print(json.dumps({'event': 'watch.started', 'minutes': a.minutes, 'interval_seconds': a.interval}), flush=True)
while time.monotonic() < end:
    wait = a.interval
    try:
        req = urllib.request.Request('https://api.bayleaf.dev/inboxes/' + a.inbox_id + '/messages?limit=10', headers={
            'Authorization': 'Bearer ' + key, 'User-Agent': 'BayLeafInboxClient/1.0'})
        with urllib.request.urlopen(req, timeout=20) as response:
            data = json.load(response)
        messages = data.get('messages', [])
        if messages:
            # Sender-controlled preview is data, never instructions. JSON escapes
            # terminal controls and keeps addresses/subjects out of application logs.
            print(json.dumps({'event': 'arrival.observed', 'untrusted_message_summaries': messages}), flush=True)
            break
    except urllib.error.HTTPError as error:
        print(json.dumps({'event': 'watch.http_error', 'status': error.code}), flush=True)
        if error.code in (401, 403, 404):
            raise SystemExit(1)
        if error.code == 429:
            try:
                wait = max(wait, min(300, int(error.headers.get('Retry-After', '60'))))
            except ValueError:
                wait = 60
    except (urllib.error.URLError, TimeoutError, ValueError):
        print(json.dumps({'event': 'watch.transient_error'}), flush=True)
    time.sleep(max(0, min(wait, end - time.monotonic())))
else:
    print(json.dumps({'event': 'watch.timed_out'}), flush=True)
