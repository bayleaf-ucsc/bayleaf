"""Offline compatibility checks for the lab-only async memory fallback."""

import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import gws_redis as state


class MemoryFallback(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.app = SimpleNamespace(state=SimpleNamespace(redis=None))

    async def test_nonce_consumed_once(self):
        flow = {"user_id": "u", "chat_id": "c"}
        await state._put_pending(self.app, "nonce", flow)
        self.assertEqual(await state._pop_pending(self.app, "nonce"), flow)
        self.assertIsNone(await state._pop_pending(self.app, "nonce"))

    async def test_pending_expiry(self):
        await state._put_pending(self.app, "nonce", {})
        with patch.object(state.time, "time", return_value=time.time() + 601):
            self.assertIsNone(await state._pop_pending(self.app, "nonce"))

    async def test_token_isolation_and_clear(self):
        bundle = {"access_token": "synthetic", "expires_at": time.time() + 60,
                  "granted_caps": {"calendar.readonly"}}
        await state._put_token(self.app, "u", "c", bundle)
        self.assertEqual(await state._get_chat_token(self.app, "u", "c"), bundle)
        self.assertIsNone(await state._get_chat_token(self.app, "other", "c"))
        self.assertIsNone(await state._get_chat_token(self.app, "u", "other"))
        await state._clear_chat_token(self.app, "u", "c")
        self.assertIsNone(await state._get_chat_token(self.app, "u", "c"))

    async def test_token_expiry(self):
        bundle = {"access_token": "synthetic", "expires_at": time.time() + 60,
                  "granted_caps": set()}
        await state._put_token(self.app, "u", "c", bundle)
        with patch.object(state.time, "time", return_value=time.time() + 61):
            self.assertIsNone(await state._get_chat_token(self.app, "u", "c"))

    async def test_expired_write_does_not_extend_validity(self):
        await state._put_token(self.app, "u", "c", {"expires_at": time.time() - 1})
        self.assertIsNone(await state._get_chat_token(self.app, "u", "c"))

    async def test_fallback_is_process_local(self):
        other = SimpleNamespace(state=SimpleNamespace(redis=None))
        await state._put_pending(self.app, "nonce", {})
        self.assertIsNone(await state._pop_pending(other, "nonce"))

    async def test_guarded_loader(self):
        module = state.load(Path("/lab/gws.py"))
        self.assertTrue(callable(module.Tools().gws_authorize))


if __name__ == "__main__":
    unittest.main()
