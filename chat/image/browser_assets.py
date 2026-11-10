"""Independent, off-default Chat arrival assets. No backend/frontend source edits."""
import hashlib
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
HASHES = {
    'build/index.html': 'ef15e5999dc3f8ae80d1cdf8013cbd788dac24cfc2f5d2a6dba42b391e10a65d',
    'backend/open_webui/config.py': 'e1ccda60fa000c8008bd2da169b8b38b5e56ccb092d89218606a186cfdcb025c',
    'backend/start.sh': '29ef1237701355ea895c85b06992a3e0ef60dd5a8c218cfbf6d403df540bf5dd',
    'build/_app/immutable/nodes/0.D2dVsOLW.js': '0202ef342d12b784a88a9d6a89e1960196d96e88c0327e97c99fcb1432e15ae2',
    'build/_app/immutable/nodes/53.D_OC8Apn.js': '75b90502ebeda577c7171c9ac54d601f12609f32dfd8c5430f30c7a0329f4a34',
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
