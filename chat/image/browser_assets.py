"""Independent, off-default Chat arrival assets. No backend/frontend source edits."""
import hashlib
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
HASHES = {
    'build/index.html': '5a78675e4211e252a0bfce7120362c844d195aed2ba4371e95e47eb4141db86b',
    'backend/open_webui/config.py': 'bea79faa7e42dedec2ba4715466543fbfea3d09badab5a2b90d9f9104f372812',
    'backend/start.sh': '29ef1237701355ea895c85b06992a3e0ef60dd5a8c218cfbf6d403df540bf5dd',
    'build/_app/immutable/nodes/0.Cb3rY7DB.js': '97b8eed1f3e5fd48f4b44eb051bcc90c8c10972fac709fa2c91b8e09c8dbf096',
    'build/_app/immutable/nodes/53.B5o9OJRH.js': '5084107ba171f99121f1afc33cf5868aae41e0bb19854e93c0b9f9be29ff5e18',
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
