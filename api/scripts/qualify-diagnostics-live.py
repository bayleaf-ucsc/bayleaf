#!/usr/bin/env python3
"""Content-free, read-only public checks for #113. Never visits a receipt/app URL.

Pass --live to contact production; --arrivals-on checks the explicitly enabled
revision. Owner login and actual browser arrival readback are separate evidence.
"""
import argparse
import json
import secrets
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true')
    parser.add_argument('--arrivals-on', action='store_true')
    args = parser.parse_args()
    if not args.live:
        parser.error('--live is required before making any request')
    client = urllib.request.build_opener(NoRedirect())
    checks = 0

    def get(url, method='GET', headers=None):
        request = urllib.request.Request(url, method=method,
            headers={'User-Agent': 'BayLeaf-Diagnostics-Qualification/1.0', **(headers or {})})
        try:
            response = client.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read().decode()

    def check(condition, label):
        nonlocal checks
        if not condition:
            raise RuntimeError('Failed: ' + label)
        checks += 1

    for kind in ['proxies', 'inboxes']:
        home = f'https://bayleaf-{kind}.dev'
        paths = ['/', '/unavailable'] if kind == 'proxies' else ['/']
        for path in paths:
            status, headers, body = get(home + path)
            check(status == (404 if path == '/unavailable' else 200), f'{kind} HTML status')
            check('text/html' in headers.get('Content-Type', ''), f'{kind} HTML type')
            check('no-store' in headers.get('Cache-Control', ''), f'{kind} no-store')
            check(headers.get('Referrer-Policy') == 'no-referrer', f'{kind} no-referrer')
            check((f'BayLeafArrival.publicArrival("{kind}",true)' in body) == args.arrivals_on,
                  f'{kind} explicit arrival inclusion')
            policy = headers.get('Content-Security-Policy', '')
            check("frame-ancestors 'none'" in policy and 'static.cloudflareinsights.com' not in policy,
                  f'{kind} framing and third-party beacon blocked')
            check(('connect-src https://telemetry.bayleaf.dev' if args.arrivals_on else "connect-src 'none'") in policy,
                  f'{kind} collection CSP')
            head, head_headers, head_body = get(home + path, 'HEAD')
            check(head == status and not head_body and head_headers.get('Content-Security-Policy') == policy,
                  f'{kind} HEAD parity')
        status, headers, text = get(home + '/llms.txt')
        check(status == 200 and 'text/plain' in headers.get('Content-Type', '') and
              'https://api.bayleaf.dev/llms.txt' in text and '<script' not in text,
              f'{kind} plaintext discovery')
        check(get(home + '/does-not-exist')[0] == 404, f'{kind} unknown apex route')
        status, headers, body = get(f'https://api.bayleaf.dev/diagnostics/{kind}')
        check(status == 200 and 'Sign in to inspect' in body, f'{kind} anonymous sign-in interstitial')
        check('BayLeafArrival' not in body and "script-src 'none'" in headers.get('Content-Security-Policy', '') and
              "connect-src 'none'" in headers.get('Content-Security-Policy', ''), f'{kind} private arrival exclusion')
        status, headers, _ = get(f'https://api.bayleaf.dev/login?diagnostic={kind}')
        cookies = headers.get_all('Set-Cookie') or []
        check(status == 302 and any(f'__Host-bl-diagnostic-return={kind};' in value and
              'Max-Age=600' in value and 'HttpOnly' in value and 'Domain=' not in value for value in cookies),
              f'{kind} fresh allowlisted host-only OAuth return marker')

    unknown = 'https://diagnostic-' + secrets.token_hex(12) + '.bayleaf-proxies.dev/private-path?credential=synthetic'
    status, headers, body = get(unknown, headers={'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document'})
    check(status == 302 and headers.get('Location') == 'https://bayleaf-proxies.dev/unavailable' and
          headers.get('Referrer-Policy') == 'no-referrer' and not body, 'generic recovery sheds tenant data')
    check(get(unknown)[0] == 404 and get(unknown, 'HEAD')[0] == 404, 'machine reads stay 404')
    check(get('https://api.bayleaf.dev/health')[0] == 200, 'API health')
    status, _, text = get('https://api.bayleaf.dev/docs/openapi.json')
    spec = json.loads(text)
    check(status == 200 and '/inboxes' in spec['paths'] and
          not any(path.startswith('/diagnostics') for path in spec['paths']), 'API contracts preserved')
    print(f'{checks} read-only production checks passed; new arrivals {"on" if args.arrivals_on else "off"}.')


if __name__ == '__main__':
    main()
