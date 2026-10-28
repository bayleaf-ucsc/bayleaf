# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx==0.28.1"]
# ///
"""Content-free, read-only retained-chat rate analysis. See ops playbook.

Run with OWUI_URL/OWUI_TOKEN set. Aggregate JSON goes to stdout; progress to
stderr. Raw identities, message rows, titles and annotations are never saved.
"""
import argparse
import asyncio
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
import math
import os
import sys
import time

import httpx


def quantiles(values):
    values = sorted(values)
    return {str(p): values[max(0, math.ceil(p / 100 * len(values)) - 1)] if values else None
            for p in (50, 75, 90, 95, 99, 100)}


def summarize(events, start, end, windows):
    series = [sorted(t for t in rows.values() if start <= t <= end) for rows in events.values()]
    series = [ts for ts in series if ts]
    result = {'users': len(series), 'events': sum(map(len, series)), 'windows': {}}
    for label, seconds, limit in windows:
        peaks, rolling = [], []
        for ts in series:
            left, counts = 0, []
            for i, t in enumerate(ts):
                while ts[left] <= t - seconds:
                    left += 1
                n = i - left + 1
                counts.append(n)
                # Exclude left-boundary partial windows from event-weighted quantiles.
                if t >= start + seconds:
                    rolling.append(n)
            peaks.append(max(counts))
        result['windows'][label] = {
            'seconds': seconds, 'comparison_limit': limit,
            'per_user_peak_quantiles': quantiles(peaks),
            'event_rolling_quantiles': quantiles(rolling),
            'event_rolling_samples': len(rolling),
            'users_ge_80pct_limit': sum(n >= .8 * limit for n in peaks),
            'users_ge_limit': sum(n >= limit for n in peaks),
        }
    return result


def self_test():
    x = summarize({'a': {'1': 1, '2': 20, '3': 60, '4': 61}, 'b': {'1': 300}},
                  0, 100000, [('minute', 60, 10), ('hour', 3600, 100)])
    assert x['users'] == 2 and x['events'] == 5
    assert x['windows']['minute']['per_user_peak_quantiles']['100'] == 3
    assert x['windows']['hour']['per_user_peak_quantiles']['100'] == 4
    assert summarize({}, 0, 100, [('m', 60, 10)])['windows']['m']['per_user_peak_quantiles']['50'] is None
    boundary = summarize({'a': {'1': 0, '2': 60}}, 0, 120, [('m', 60, 1)])
    assert boundary['windows']['m']['per_user_peak_quantiles']['100'] == 1
    assert boundary['windows']['m']['users_ge_limit'] == 1
    print('Synthetic rolling-window, boundary, quantile and empty-cohort checks passed.')


async def analyze(days):
    now = time.time()
    tally = Counter()
    events = {role: defaultdict(dict) for role in ('user', 'assistant')}
    roles = {}
    seen_chats = set()
    sem = asyncio.Semaphore(2)
    async with httpx.AsyncClient(base_url=os.environ['OWUI_URL'].rstrip('/'),
            headers={'Authorization': 'Bearer ' + os.environ['OWUI_TOKEN']},
            timeout=90, follow_redirects=False) as client:
        async def get(path, params=None):
            for attempt in range(3):
                if tally['http_reads'] >= 10000:
                    raise RuntimeError('10,000-read safety budget exhausted; no final summary emitted')
                tally['http_reads'] += 1
                async with sem:
                    try:
                        r = await client.get(path, params=params)
                    except httpx.RequestError:
                        raise RuntimeError('Metadata transport failed; no final summary emitted') from None
                if r.status_code in (429, 502, 503, 504) and attempt < 2:
                    await asyncio.sleep(2 ** attempt)
                    continue
                if r.status_code != 200:
                    raise RuntimeError(f'Metadata read failed: HTTP {r.status_code}')
                return r.json()

        function = await get('/api/v1/functions/id/rate_limit_filter')
        valves = await get('/api/v1/functions/id/rate_limit_filter/valves')
        # Fail rather than silently interpreting a different limiter's schema.
        thresholds = {k: valves[k] for k in ('requests_per_minute', 'requests_per_hour',
                      'sliding_window_limit', 'sliding_window_minutes')}
        if not all(isinstance(v, int) and not isinstance(v, bool) and v > 0 for v in thresholds.values()):
            raise RuntimeError('Unsupported rate-limit valves; review before analysis')
        windows = [('minute', 60, thresholds['requests_per_minute']),
                   ('hour', 3600, thresholds['requests_per_hour']),
                   ('day_comparison', 86400, thresholds['sliding_window_limit']),
                   ('configured_long_window', thresholds['sliding_window_minutes'] * 60,
                    thresholds['sliding_window_limit'])]
        users, page = [], 1
        while True:
            d = await get('/api/v1/users/', {'page': page, 'order_by': 'email', 'direction': 'asc'})
            batch = d if isinstance(d, list) else d['users']
            users.extend({'id': u['id'], 'role': u['role'],
                          'synthetic': u.get('email', '').lower() == 'probe@bayleaf.dev'} for u in batch)
            if len(batch) < 30 or (isinstance(d, dict) and len(users) >= d['total']):
                break
            page += 1
        if not users or len({u['id'] for u in users}) != len(users):
            raise RuntimeError('Empty or duplicate account inventory')
        tally['accounts'] = len(users)

        async def scan_user(u):
            if u['synthetic']:
                tally['synthetic_accounts_excluded'] += 1
                return
            uid, page = u['id'], 1
            roles[uid] = u['role']
            while True:
                batch = await get('/api/v1/chats/list/user/' + uid,
                                  {'page': page, 'order_by': 'created_at', 'direction': 'asc'})
                if not isinstance(batch, list):
                    raise RuntimeError('Unexpected chat-list envelope')
                for item in batch:
                    cid = item['id']
                    if cid in seen_chats:
                        raise RuntimeError('Duplicate chat in pagination; rerun after reviewing drift')
                    seen_chats.add(cid)
                    d = await get('/api/v1/chats/stats/export/' + cid)
                    if d['user_id'] != uid:
                        raise RuntimeError('Chat owner mismatch')
                    tally['chats'] += 1
                    for key, m in d['chat']['history']['messages'].items():
                        role, t = m.get('role'), m.get('timestamp')
                        if role not in events:
                            continue
                        if not isinstance(t, (int, float)) or not math.isfinite(t) or t <= 0 or t > now:
                            tally['invalid_or_out_of_snapshot_timestamps'] += 1
                            continue
                        mid = m.get('id') or key
                        old = events[role][uid].get(mid)
                        if old is not None:
                            tally['duplicate_message_ids'] += 1
                            if old != t:
                                tally['conflicting_duplicate_timestamps'] += 1
                                # Deterministic heuristic, not recovery of an original admission time.
                                events[role][uid][mid] = min(old, t)
                            continue
                        events[role][uid][mid] = t
                if len(batch) < 60:
                    break
                page += 1
            tally['accounts_scanned'] += 1
            if tally['accounts_scanned'] % 50 == 0:
                print(f"Scanned {tally['accounts_scanned']} accounts, {tally['chats']} chats", file=sys.stderr)

        for offset in range(0, len(users), 2):
            await asyncio.gather(*(scan_user(u) for u in users[offset:offset + 2]))

    result = {
        'as_of_utc': datetime.fromtimestamp(now, timezone.utc).isoformat(),
        'scan_finished_utc': datetime.now(timezone.utc).isoformat(),
        'inventory': dict(tally),
        'limiter': {'is_active': function['is_active'], 'is_global': function['is_global'],
                    **thresholds, **{k: valves[k] for k in ('global_limit', 'enabled_for_admins', 'priority')}},
        'method': 'Retained message timestamps, all branches, IDs deduplicated per owner; probe excluded. Not admission logs.',
        'periods': {},
    }
    for n in days:
        result['periods'][str(n)] = {}
        for role, data in events.items():
            result['periods'][str(n)][role] = {}
            for cohort in ('non_admin', 'admin', 'all'):
                subset = {u: ts for u, ts in data.items()
                          if cohort == 'all' or (roles[u] == 'admin') == (cohort == 'admin')}
                result['periods'][str(n)][role][cohort] = summarize(subset, now - n * 86400, now, windows)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--days', type=int, nargs='+', default=[30, 90])
    parser.add_argument('--self-test', action='store_true', help='Synthetic tests only; no credentials or network')
    args = parser.parse_args()
    if args.self_test:
        self_test()
    else:
        if any(n <= 0 or n > 90 for n in args.days):
            parser.error('Use periods between 1 and 90 days')
        try:
            print(json.dumps(asyncio.run(analyze(args.days)), indent=2))
        except Exception as exc:
            # Never expose transport URLs, response bodies or identities in diagnostics.
            print(f'Analysis failed ({type(exc).__name__}); no complete summary emitted. Review API/schema/auth privately.', file=sys.stderr)
            sys.exit(1)
