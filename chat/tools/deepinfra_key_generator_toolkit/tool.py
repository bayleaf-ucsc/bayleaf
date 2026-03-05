"""
requirements: cachetools,aiohttp
"""

import os
import requests
from datetime import datetime
from pydantic import BaseModel, Field
from typing import List

from cachetools import cached, TTLCache
import aiohttp

cache = TTLCache(maxsize=4096, ttl=3600)


class Tools:
    class Valves(BaseModel):
        API_KEY: str = ""
        API_TOKEN_NAME: str = ""
        MODELS: List[str] = ["Qwen/Qwen3-Next-80B-A3B-Instruct"]
        EXPIRES_DELTA: int = 86400

    def __init__(self):
        self.valves = self.Valves()

    async def generate_temporary_deepinfra_key(self, __user__) -> str:
        """
        Generates an API key for DeepInfra specific to this user, relevant for making LLM-powered demos inside of the chat UI.
        Do not call this tool unless the user is specifically requesting an API key for accessing LLM services outside of the BayLeaf platform.
        Users can also visit https://api.bayleaf.chat personal API key for use in external tools like coding agents.
        """
        user_id = __user__["id"]
        if user_id not in cache:

            headers = {
                "Authorization": f"Bearer {self.valves.API_KEY}",
            }

            resource_url = "https://api.deepinfra.com/v1/scoped-jwt"

            data = {
                "api_key_name": self.valves.API_TOKEN_NAME,
                "models": self.valves.MODELS,
                "expires_delta": self.valves.EXPIRES_DELTA,
            }

            async with aiohttp.ClientSession() as session:
                async with session.post(
                    resource_url, headers=headers, json=data
                ) as response:
                    if response.status == 200:
                        key = (await response.json())["token"]
                        result = dict(
                            key=key,
                            models=self.valves.MODELS,
                            expires_delta_seconds=self.valves.EXPIRES_DELTA,
                            base_url="https://api.deepinfra.com/v1/openai",
                            note_to_assistant="Tell the user to expand the tool call details above to retrieve the exact result details. (You, the assistant, are bad at transcribing JWTs properly.) The results of this tool are cached for about an hour, so users will need to wait for a fresh key if they use up an earlier one.",
                        )
                        cache[user_id] = result
                    else:
                        return {
                            "error": True,
                            "status": response.status,
                            "message": await response.text(),
                        }

        return cache[user_id]
