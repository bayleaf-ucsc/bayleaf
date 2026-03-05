"""
requirements: async-lru
"""

from pydantic import BaseModel, Field
from typing import Optional

from async_lru import alru_cache
import aiohttp

from open_webui.utils.task import prompt_template


@alru_cache(maxsize=256)
async def get_system_prompt_for_course(course_id, chat_id, api_key):
    # chat_id is unused inside the function, only included as input to uniqueify the cache key for this session

    headers = {
        "Authorization": f"Bearer {api_key}",
    }

    try:
        url = f"https://canvas.ucsc.edu/api/v1/courses/{course_id}/pages/braces-system-prompt"
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.get(url) as response:
                response.raise_for_status()
                page = await response.json()
                return page["body"]
    except Exception as e:
        return "You could not access the \"Brace's System Prompt\" page on the course's Canvas, so we'll continue without a dynamic system prompt. You know you are Brace, an assistant for students in *some* course at UC Santa Cruz, but you don't seem to be able to access more specific behavioral instructions right now. Hopefully the situation is temporary. Try to be helpful using the available tool in the meantime."


class Filter:

    class Valves(BaseModel):
        CANVAS_ACCESS_TOKEN: str = Field(
            default=None, description="Instructor's Canvas access token"
        )

    def __init__(self):
        self.valves = self.Valves()

    async def inlet(self, body, __user__, __metadata__):

        # force-enable Brace's toolkit
        body.setdefault("tool_ids", []).append("brace_toolkit")

        # install course-specific system prompt if available
        chat_id = __metadata__["chat_id"]
        course_id = __metadata__["model"]["id"].removeprefix("brace-")
        system_prompt = await get_system_prompt_for_course(
            course_id, chat_id, self.valves.CANVAS_ACCESS_TOKEN
        )
        system_prompt = prompt_template(system_prompt, __user__)

        body["messages"].insert(0, {"role": "system", "content": system_prompt})

        return body
