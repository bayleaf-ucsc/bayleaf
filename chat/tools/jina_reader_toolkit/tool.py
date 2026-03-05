import os
import re
import requests
from typing import Optional
from datetime import datetime
from pydantic import BaseModel, Field
import aiohttp
from typing import Literal


class Tools:

    class Valves(BaseModel):
        JINA_API_KEY: str = Field(
            default=None,
            description="a Jina API key",
        )

    def __init__(self):
        self.valves = self.Valves()

    async def use_jina_reader_api(
        self,
        url: str,
        format: None | Literal["html"] | Literal["text"] | Literal["markdown"] = None,
    ):
        """
        Use the Jina Reader API to fetch a view of the content of a public web page.
        """
        headers = {
            "Authorization": f"token {self.valves.JINA_API_KEY}",
        }
        if format:
            headers["X-Return-Format"] = format

        resource_url = "https://r.jina.ai/" + url

        async with aiohttp.ClientSession() as session:
            async with session.get(resource_url, headers=headers) as response:
                if response.status == 200:
                    return await response.text()
                else:
                    return {
                        "error": True,
                        "status": response.status,
                        "message": await response.text(),
                    }
