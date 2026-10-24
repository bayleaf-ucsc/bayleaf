#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["nanobot-ai==0.3.5"]
# ///
"""Released Nanobot MCP registration/image path. Synthetic data, isolated HOME."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


async def qualify(root):
    from nanobot.agent.tools.mcp import connect_mcp_servers
    from nanobot.agent.tools.registry import ToolRegistry
    from nanobot.agent.tools.filesystem import ReadFileTool
    from nanobot.config.schema import MCPServerConfig
    from loguru import logger
    logger.remove()  # Keep protocol qualification output concise; no per-tool log spam.
    registry = ToolRegistry()
    names = json.loads(Path('.sandbox-cli-assets.json').read_text())['groups']
    enabled = [name for group in names.values() for name in group]
    cfg = MCPServerConfig(command=shutil.which('node'), args=[str(root/'stdio.mjs'),str(root/'computer-state')],
        env={'BAYLEAF_TEST_GROUPS':'computer,inboxes,previews'}, enabled_tools=enabled)
    connections = await connect_mcp_servers({'sandbox':cfg}, registry)
    try:
        assert 'sandbox' in connections
        assert len(registry.tool_names) == 28
        assert 'mcp_sandbox_click' in registry.tool_names
        assert not any(name.startswith('mcp_bayleaf_') for name in registry.tool_names)
        await registry.execute('mcp_sandbox_open_session', {})
        result = await registry.execute('mcp_sandbox_screenshot', {})
        data = json.loads(result)
        artifact = Path(data['artifacts'][0]['path'])
        assert artifact.is_relative_to(root), artifact
        assert artifact.read_bytes().startswith(b'\x89PNG')
        # Pinned Nanobot persists MCP images instead of inserting them in context.
        # Its native read_file is the supported vision bridge, not curl/base64.
        blocks = await ReadFileTool(workspace=root).execute(path=str(artifact))
        assert isinstance(blocks, list), blocks
        assert any(block.get('type') == 'image_url' for block in blocks), blocks
        assert 'iVBORw0KGgo' not in result
        print('PASS released Nanobot 0.3.5: exact 28-tool allowlist/prefixes, actual stdio calls, screenshot artifact and native read_file image blocks (no inference/browser render)')
    finally:
        for connection in connections.values():
            await connection.aclose()


with tempfile.TemporaryDirectory(prefix='nanobot-shared-mcp-', dir='/private/var/folders/qj/gyqbn5y57956rrqd_g6yfqwr0000gn/T/opencode') as directory:
    root = Path(directory)
    os.environ['HOME'] = str(root)
    # Do not inherit a real operator runtime home or credentials.
    for key in list(os.environ):
        if key.startswith(('NANOBOT_', 'BAYLEAF_')):
            os.environ.pop(key)
    subprocess.run(['node','--input-type=module','-e',
        'import {build} from "esbuild"; await build({entryPoints:["sandbox-cli/stdio-fixture.ts"],'
        'outfile:process.argv[1],bundle:true,platform:"node",format:"esm",target:"node22",'
        'banner:{js:\'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);\'}});',
        str(root/'stdio.mjs')], check=True)
    asyncio.run(qualify(root))
