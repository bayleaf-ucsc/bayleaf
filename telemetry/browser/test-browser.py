# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright>=1.62,<2"]
# ///
"""Real Chromium, all HTTP intercepted: no production reads/writes or collection."""
import json
from pathlib import Path
import subprocess
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
fixtures = json.loads(subprocess.check_output(["node", "telemetry/browser/fixtures.mjs"], cwd=ROOT))
landing = (ROOT / "landing/index.html").read_text()
styles = (ROOT / "landing/style.css").read_text()
disabled_js = fixtures["landingDisabled"]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    context = browser.new_context(service_workers="block")
    context.add_cookies([{"name": "synthetic-cookie", "value": "must-not-travel", "domain": "telemetry.bayleaf.dev", "path": "/", "secure": True}])
    for viewport in [(1280, 900), (360, 800)]:
        page = context.new_page()
        page.set_viewport_size({"width": viewport[0], "height": viewport[1]})
        for destination, host in [("landing", "bayleaf.dev"), ("api", "api.bayleaf.dev"), ("sandbox", "sandbox.bayleaf.dev")]:
            shapes = []
            for enabled in [False, True]:
                arrivals, asset_requests = [], []
                html = landing if destination == "landing" else fixtures[destination if enabled else destination + "Disabled"]
                headers = {"content-type": "text/html"}
                if destination == "sandbox":
                    headers.update(html["headers"])
                    html = html["html"]

                def intercept(route):
                    request = route.request
                    url = urlsplit(request.url)
                    if url.netloc == "telemetry.bayleaf.dev":
                        if request.method == "POST":
                            arrivals.append({"headers": request.all_headers(), "body": json.loads(request.post_data)})
                        route.fulfill(status=204, headers={"Access-Control-Allow-Origin": f"https://{host}",
                            "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST"})
                    elif url.netloc == host and url.path == "/arrival.js":
                        asset_requests.append(request.all_headers())
                        route.fulfill(content_type="application/javascript", body=fixtures["landingActive"] if enabled else disabled_js)
                    elif url.netloc == host and url.path == "/style.css":
                        route.fulfill(content_type="text/css", body=styles)
                    elif url.netloc == host:
                        route.fulfill(headers=headers, body=html)
                    else:
                        route.fulfill(content_type="text/html", body="<!doctype html><title>Synthetic</title>")

                page.route("**/*", intercept)
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(f"https://{host}/?private-query=not-collected", referer="https://example.org/private/file?secret=not-collected#fragment")
                page.wait_for_timeout(150)
                assert len(arrivals) == int(enabled), (destination, enabled, arrivals)
                if enabled:
                    event = arrivals[0]
                    assert event["body"] == {"schema_version": 1, "destination": destination, "referring_hostname": "example.org"}, event
                    assert "cookie" not in event["headers"] and "referer" not in event["headers"] and "authorization" not in event["headers"], event
                assert all("referer" not in request for request in asset_requests)
                assert not errors, errors
                shapes.append(page.locator("main").evaluate("el => ({text:el.innerText, box:el.getBoundingClientRect().toJSON()})") if destination != "api" else page.locator("body").evaluate("el => ({text:el.innerText, box:el.getBoundingClientRect().toJSON()})"))
                # No SPA-navigation observation or new arrival after a history update.
                page.evaluate("history.pushState({}, '', '/dashboard?private=not-collected')")
                page.wait_for_timeout(30)
                assert len(arrivals) == int(enabled)
                # Exact-root backstop: replaying even an enabled fixture on private paths emits nothing.
                arrivals.clear()
                page.goto(f"https://{host}/dashboard")
                page.wait_for_timeout(50)
                assert not arrivals
                page.unroute("**/*", intercept)
            assert shapes[0] == shapes[1], (destination, viewport, "visible content/layout changed")
        page.close()
    # Authenticated Sandboxes root has no telemetry code or relaxed connect policy.
    assert "BayLeafArrival" not in fixtures["sandboxPrivate"]["html"]
    assert "telemetry.bayleaf.dev" not in fixtures["sandboxPrivate"]["headers"]["content-security-policy"]
    context.close()
    browser.close()
print("PASS intercepted Chromium: 3 public sources, credential/referrer omission, query exclusion, private-path suppression, no SPA events, identical desktop/mobile text and geometry")
