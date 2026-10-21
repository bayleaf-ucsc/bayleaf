"""Lab-only async state experiment, applied to an in-memory copy of GWS.

Not a release or a production patch. Reuses app.state.redis, never opens its
own connection. Guarded replacements fail if the vendored source changes.
"""

import ast
import hashlib
import importlib.util
import json
import time

PREFIX = "bayleaf-multiworker:gws:v1"
PENDING_TTL = 600


def _key(kind, *parts):
    # Tuple encoding prevents user/chat IDs containing ':' from aliasing.
    digest = hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()
    return f"{PREFIX}:{kind}:{digest}"


def _memory(app, kind):
    name = "_lab_gws_" + kind
    if not hasattr(app.state, name):
        setattr(app.state, name, {})
    return getattr(app.state, name)


async def _put_pending(app, nonce, flow):
    redis = app.state.redis
    if redis is None:
        _memory(app, "pending")[nonce] = (time.time() + PENDING_TTL, flow)
    else:
        await redis.set(_key("pending", nonce), json.dumps(flow), ex=PENDING_TTL)


async def _pop_pending(app, nonce):
    redis = app.state.redis
    if redis is None:
        entry = _memory(app, "pending").pop(nonce, None)
        return entry[1] if entry and entry[0] > time.time() else None
    raw = await redis.getdel(_key("pending", nonce))
    return json.loads(raw) if raw else None


async def _put_token(app, user_id, chat_id, bundle):
    ttl_ms = int((bundle["expires_at"] - time.time()) * 1000)
    if ttl_ms <= 0:
        await _clear_chat_token(app, user_id, chat_id)
        return
    if app.state.redis is None:
        _memory(app, "tokens")[(user_id, chat_id)] = bundle
    else:
        value = {**bundle, "granted_caps": sorted(bundle["granted_caps"])}
        await app.state.redis.set(_key("token", user_id, chat_id), json.dumps(value), px=ttl_ms)


async def _get_chat_token(app, user_id, chat_id):
    if app.state.redis is None:
        entry = _memory(app, "tokens").get((user_id, chat_id))
    else:
        raw = await app.state.redis.get(_key("token", user_id, chat_id))
        entry = json.loads(raw) if raw else None
        if entry:
            entry["granted_caps"] = set(entry["granted_caps"])
    if entry and entry["expires_at"] > time.time():
        return entry
    return None


async def _clear_chat_token(app, user_id, chat_id):
    if app.state.redis is None:
        _memory(app, "tokens").pop((user_id, chat_id), None)
    else:
        await app.state.redis.delete(_key("token", user_id, chat_id))


def load(path):
    source = path.read_text()

    def replace(old, new):
        nonlocal source
        if source.count(old) != 1:
            raise RuntimeError(f"GWS experiment source guard failed: {old[:65]!r}")
        source = source.replace(old, new)

    replace('        pending = _pending_states(request.app)\n        flow = pending.pop(state, None)',
            '        flow = await _pop_pending(request.app, state)')
    replace('        _token_cache(request.app)[(user_id, chat_id)] = {\n'
            '            "access_token": access_token,\n'
            '            "expires_at": expires_at,\n'
            '            "granted_caps": merged_caps,\n        }',
            '        await _put_token(request.app, user_id, chat_id, {\n'
            '            "access_token": access_token,\n'
            '            "expires_at": expires_at,\n'
            '            "granted_caps": merged_caps,\n        })')
    replace('    _pending_states(app)[state] = {\n'
            '        "user_id": user_id,\n        "chat_id": chat_id,\n    }',
            '    await _put_pending(app, state, {\n'
            '        "user_id": user_id,\n        "chat_id": chat_id,\n    })')
    replace('def _build_auth_url(', 'async def _build_auth_url(')

    class AwaitStateCalls(ast.NodeTransformer):
        def visit_Call(self, node):
            self.generic_visit(node)
            if isinstance(node.func, ast.Name) and node.func.id in {
                "_get_chat_token", "_clear_chat_token", "_build_auth_url",
            }:
                return ast.copy_location(ast.Await(value=node), node)
            return node

    tree = ast.fix_missing_locations(AwaitStateCalls().visit(ast.parse(source)))
    spec = importlib.util.spec_from_file_location("gws_experimental", path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(tree, str(path), "exec"), module.__dict__)
    for name in ("_put_pending", "_pop_pending", "_put_token", "_get_chat_token", "_clear_chat_token"):
        module.__dict__[name] = globals()[name]
    return module
