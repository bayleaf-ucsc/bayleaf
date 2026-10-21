"""One read-only exact-recipient activity query after a staged run. Never sends mail."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--private-dir', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
os.umask(0o077)
manifest = json.loads((args.private_dir / 'resource-manifest.json').read_text())
if manifest['account'] != os.environ.get('CLOUDFLARE_ACCOUNT_ID'):
    raise SystemExit('Explicit account must match the private manifest')
if not manifest['name'].startswith('bayleaf-inboxes-temp-smtp-'):
    raise SystemExit('Not a qualification manifest')
profile = os.environ.get('CLOUDFLARE_PROFILE', 'ucsc')
if not re.fullmatch(r'[a-zA-Z0-9_-]+', profile):
    raise SystemExit('Invalid profile')
subprocess.run(['cf', 'workers', 'list', '--profile', profile],
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
token = json.loads((Path.home() / 'Library/Preferences/cloudflare/config' /
                    (profile + '.json')).read_text())['oauth_token']
query = '''query($z:string!,$r:string!,$s:Time!,$e:Time!){viewer{zones(filter:{zoneTag:$z}){
emailRoutingAdaptive(filter:{to:$r,datetime_geq:$s,datetime_leq:$e},limit:20,orderBy:[datetime_ASC]){
datetime status action errorDetail ruleMatched sampleInterval dkim dmarc spf}}}}'''
start = datetime.datetime.fromisoformat(manifest['started'].replace('Z', '+00:00'))
end = min(datetime.datetime.now(datetime.timezone.utc), start + datetime.timedelta(hours=1))
request = urllib.request.Request('https://api.cloudflare.com/client/v4/graphql',
    data=json.dumps({'query': query, 'variables': {'z': manifest['zone'],
        'r': manifest['recipient'], 's': manifest['started'], 'e': end.isoformat()}}).encode(),
    headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
with urllib.request.urlopen(request, timeout=30) as response:
    data = json.load(response)
(args.private_dir / 'private-activity-followup.json').write_text(json.dumps(data))
result = {'activity': [], 'activity_unavailable': bool(data.get('errors')),
          'queried_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
if data.get('errors'):
    result['rate_limited'] = any('Rate limiter budget depleted' in e.get('message', '')
                                 for e in data['errors'])
else:
    normalize = lambda value: (value or '').replace('-', '').lower()
    known = ['5.1.1 Address not found', '5.7.1 DKIM domain authorization required',
             '5.3.4 Restricted inbox supports DKIM mail up to 1 MiB',
             '4.7.0 Rate limited, try later']
    for row in data['data']['viewer']['zones'][0]['emailRoutingAdaptive']:
        result['activity'].append({k: row[k] for k in
            ['datetime', 'status', 'action', 'sampleInterval', 'dkim', 'dmarc', 'spf']} | {
            'matched_fixture': normalize(row['ruleMatched']) == normalize(
                manifest['rule'].get('tag') or manifest['rule'].get('id')),
            'matched_catchall': normalize(row['ruleMatched']) == normalize(
                manifest['beforeCatch'].get('tag') or manifest['beforeCatch'].get('id')),
            'reason': next((reason for reason in known if row['errorDetail'] ==
                'Worker rejected email with reason: ' + reason),
                'other' if row['errorDetail'] else 'none')})
args.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
