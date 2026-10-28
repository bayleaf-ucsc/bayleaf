"""Independent, off-default Chat arrival assets. No backend/frontend source edits."""
import hashlib
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
HASHES = {
    'build/index.html': 'c8a05579f99aa69239b71b54457a23e946d9135a2a1cee1daf9afc58d72dded0',
    'backend/open_webui/config.py': 'e8b8baab2ecb992e23b5e07d9abeaee2e7db48590b1f04e0fb4cf5087c040e25',
    'backend/start.sh': '40fef6f5b49405e27e3367b1a119469c10aba35c1f342632e59726198c195f2a',
    'build/_app/immutable/nodes/0.zfrqCKbs.js': '8d6ac06cfc96f735f0cd174311af86ecc7273ba289c609831c241208ced6f815',
    'build/_app/immutable/nodes/53.1SYwzS3k.js': 'd2daa4ab8979e61b2b732ae6cb453bb742e876f9c63b5235ebbde0f545f6a979',
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
