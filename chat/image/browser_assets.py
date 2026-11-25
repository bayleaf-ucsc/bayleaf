"""Independent, off-default Chat arrival assets. No backend/frontend source edits."""
import hashlib
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
HASHES = {
    'build/index.html': '230d4fc80b3516caf3e67c0cbd6e4f93f2f931f22151cda6a9aa22ea265b8df2',
    'backend/open_webui/config.py': '29bd6c5edc5bacd447833a0e853053e5abc103b3bc6f6cc1eeecdc9c78a5e96e',
    'backend/start.sh': '29ef1237701355ea895c85b06992a3e0ef60dd5a8c218cfbf6d403df540bf5dd',
    'build/_app/immutable/nodes/0.CFbyTGWJ.js': 'c2c2ae360b3debbed0e0800f87b519bbb9f8847ee33d2b858db469098a80ffdf',
    'build/_app/immutable/nodes/53.Cfm1ciYE.js': 'ce19f5fe78aaad201c9fc9885a909b5038bacb75359bb832aab3a479fd7980f1',
}
STOCK_LOADER = b''  # Exact pinned image has an empty loader, not an owned plugin registry.


def install(app=Path('/app'), enabled=None):
    switch = os.environ.get('BAYLEAF_CHAT_ARRIVALS_ENABLED', 'false') if enabled is None else enabled
    if switch not in ('true', 'false'):
        raise ValueError('invalid_chat_arrival_switch')
    if any(k in os.environ for k in ('FRONTEND_BUILD_DIR', 'STATIC_DIR')):
        raise ValueError('unsupported_chat_asset_directory')
    for name, digest in HASHES.items():
        if hashlib.sha256((app / name).read_bytes()).hexdigest() != digest:
            raise ValueError('chat_asset_source_mismatch')
    source = app / 'build/static'
    client = (HERE / 'browser/chat-client.mjs').read_bytes()
    filename = 'bayleaf-chat-' + hashlib.sha256(client).hexdigest()[:16] + '.mjs'
    gate = (HERE / 'browser/chat-gate.js').read_text().replace('__BAYLEAF_CHAT_CLIENT__', '/static/' + filename).encode()
    active_loader = STOCK_LOADER + b'\n' + gate
    loader = source / 'loader.js'
    # Never overwrite another customization, even when disabled. Native guards
    # remain independent and mandatory. Repeated startup is idempotent.
    if loader.read_bytes() not in (STOCK_LOADER, active_loader):
        raise ValueError('unrecognized_chat_loader')
    asset = source / filename
    if asset.exists() and asset.read_bytes() != client:
        raise ValueError('chat_client_mismatch')
    if switch == 'true':
        asset.write_bytes(client)
    elif asset.exists():
        asset.unlink()
    temporary = loader.with_suffix('.bayleaf-tmp')
    temporary.write_bytes(active_loader if switch == 'true' else STOCK_LOADER)
    temporary.replace(loader)
