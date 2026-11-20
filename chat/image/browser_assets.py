"""Independent, off-default Chat arrival assets. No backend/frontend source edits."""
import hashlib
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
HASHES = {
    'build/index.html': 'c2fe02890b312042147858a8156aaff690c0a2208595602bcd98ef2214d6d806',
    'backend/open_webui/config.py': '2fbbf686652656b1bc1e425fa9c4b219a4730b84e19d63858bbc05d1ba688bb8',
    'backend/start.sh': '29ef1237701355ea895c85b06992a3e0ef60dd5a8c218cfbf6d403df540bf5dd',
    'build/_app/immutable/nodes/0.CAO82wNH.js': '66ed6b3bc428fdf3c9ef116637fa9ff1dec563b26a701e3d660210858c84e931',
    'build/_app/immutable/nodes/53.Dg9TGR5C.js': 'c59af62dfe6785164d677911b21a3732e92c497064dae4cb665ae861ea1dfd5c',
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
