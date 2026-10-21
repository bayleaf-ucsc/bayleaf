"""One authorized synthetic self-mail. Native Gmail confirmation is retained.

Run only with --send-one after explicit send authorization. No SMTP semantics are
inferred from Gmail API submission. Private evidence stays outside the repository.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid


def command(args, timeout=30):
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         start_new_session=True)
    try:
        out, _ = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGTERM)
        p.communicate()
        raise RuntimeError("command_timeout") from None
    if p.returncode:
        raise RuntimeError("command_failed")
    return json.loads(out)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--send-one', action='store_true', required=True)
    parser.add_argument('--account', choices=['ucsc', 'as'], default='ucsc')
    parser.add_argument('--guard-ticket', help='Explicit approved Gmail ticket for this run')
    args = parser.parse_args()
    gws = ['gws-' + args.account] + (['--guard-ticket', args.guard_ticket] if args.guard_ticket else [])
    os.umask(0o077)
    sender = os.environ['BAYLEAF_QUALIFICATION_SENDER']
    domain = {'ucsc': 'ucsc.edu', 'as': 'adamsmith.as'}[args.account]
    if not sender.endswith('@' + domain) or any(c in sender for c in '\r\n'):
        raise RuntimeError('unexpected_sender')
    token = os.environ['BAYLEAF_QUALIFICATION_TOKEN']
    if not token.startswith('sk-bayleaf-'):
        raise RuntimeError('unexpected_token')
    identity = command(gws + ['gmail', 'users', 'settings', 'sendAs', 'list',
                        '--params', '{"userId":"me"}'])
    assert any(x.get('sendAsEmail') == sender and x.get('isPrimary')
               for x in identity.get('sendAs', [])), 'unexpected_sender'

    def api(path, method='GET', body=None):
        req = urllib.request.Request('https://api.bayleaf.dev' + path,
            data=None if body is None else json.dumps(body).encode(), method=method,
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                     'User-Agent': 'BayLeafQualification/1.0 (synthetic self-mail)'})
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read()
            return raw if path.endswith('/body') else json.loads(raw)

    root = Path(tempfile.mkdtemp(prefix='inbox-smtp-selfmail-', dir=
        '/private/var/folders/qj/gyqbn5y57956rrqd_g6yfqwr0000gn/T/opencode'))
    evidence = {'confirmed_gmail_submissions': 0, 'smtp_boundary_observed': False}
    box = None
    try:
        box = api('/inboxes', 'POST', {'type': 'email', 'label': 'smtp-selfmail-synthetic',
                                     'ttl_seconds': 900})
        assert box['type'] == 'email' and box.get('email_auth') is None
        evidence['inbox'] = box
        (root / 'manifest.json').write_text(json.dumps(evidence))
        assert box['address'].endswith('@bayleaf-inboxes.dev')
        messages = api('/inboxes/' + box['id'] + '/messages')
        assert messages['messages'] == []
        run = uuid.uuid4().hex
        raw = ('From: ' + sender + '\r\nTo: ' + box['address'] + '\r\n'
               'Subject: BayLeaf synthetic DKIM qualification ' + run + '\r\n'
               'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=us-ascii\r\n\r\n'
               'Synthetic self-mail for issue 97. No personal or third-party content.\r\n')
        evidence['guarded_send_invoked'] = True
        (root / 'manifest.json').write_text(json.dumps(evidence))
        sent = command(gws + ['gmail', 'users', 'messages', 'send',
                        '--params', '{"userId":"me"}', '--json',
                        json.dumps({'raw': base64.urlsafe_b64encode(raw.encode()).decode()})], 90)
        evidence['gmail_message_id'] = sent.get('id')
        evidence['confirmed_gmail_submissions'] = 1
        time.sleep(10)  # One bounded readback, no polling or automatic resend.
        messages = api('/inboxes/' + box['id'] + '/messages')['messages']
        evidence['receipt_count'] = len(messages)
        if len(messages) == 1:
            payload = api('/inboxes/' + box['id'] + '/messages/' + messages[0]['id'] + '/body')
            assert run.encode() in payload
            (root / 'synthetic.eml').write_bytes(payload)
            evidence['raw_bytes'] = len(payload)
    except Exception as exc:
        evidence['failure_type'] = type(exc).__name__
        if isinstance(exc, RuntimeError) and str(exc) in {'command_timeout', 'command_failed'}:
            evidence['failure_reason'] = str(exc)
        if isinstance(exc, urllib.error.HTTPError):
            evidence['http_status'] = exc.code
            try:
                error = json.loads(exc.read()).get('error')
                if isinstance(error, str) and error in {'limit', 'disabled', 'not_found', 'unauthorized', 'invalid', 'unavailable'}:
                    evidence['api_error'] = error
            except Exception:
                pass
    finally:
        if box and box.get('id'):
            try:
                evidence['cleanup'] = api('/inboxes/' + box['id'], 'DELETE')
            except Exception:
                evidence['cleanup_pending'] = True
        (root / 'manifest.json').write_text(json.dumps(evidence))
        print(json.dumps({k: v for k, v in evidence.items()
                          if k not in {'inbox', 'gmail_message_id', 'cleanup'}} |
                         {'private_evidence': str(root),
                          'destruction_requested': 'cleanup' in evidence}))


if __name__ == '__main__':
    main()
