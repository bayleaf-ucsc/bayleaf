"""
title: Brace3 Filter
author: Adam Smith
description: Injects the Brace3 Canvas toolkit and fetches the course-specific system prompt from a Canvas wiki page. Attach to any model named brace3-NNN where NNN is the Canvas course ID.
requirements: async-lru,markdownify
version: 1.0.0
"""

from pydantic import BaseModel, Field
from async_lru import alru_cache
from markdownify import markdownify
import aiohttp

from open_webui.utils.task import prompt_template

CANVAS_PAGE_TITLE = "Brace3 System Prompt"
TOOLKIT_IDS = ["brace3_canvas_toolkit"]
CANVAS_BASE_URL = "https://canvas.ucsc.edu/api/v1"


async def get_system_prompt_for_course(course_id, chat_id, api_key):
    # Caches successful fetches only — failures propagate as exceptions and are
    # not cached, so a transient error doesn't permanently break a session.
    # chat_id is passed through to scope the cache per session, so a new chat
    # always re-fetches (picking up edits) and a deleted page is detectable.
    return await _fetch_system_prompt(course_id, chat_id, api_key)


@alru_cache(maxsize=256)
async def _fetch_system_prompt(course_id, chat_id, api_key):
    # Look up by title rather than slug — slugs are Canvas internals that shift
    # unpredictably when pages are deleted and recreated. Title is what faculty see.
    headers = {"Authorization": f"Bearer {api_key}"}
    async with aiohttp.ClientSession(headers=headers) as session:
        # Paginate the full page list — don't silently miss the page on large courses
        pages = []
        next_url = f"{CANVAS_BASE_URL}/courses/{course_id}/pages?per_page=100"
        while next_url:
            async with session.get(next_url) as response:
                response.raise_for_status()
                pages.extend(await response.json())
                link = response.headers.get("Link", "")
                next_url = None
                for part in link.split(","):
                    if '; rel="next"' in part:
                        next_url = part.split(";")[0].strip().lstrip("<").rstrip(">")
                        break

        match = next((p for p in pages if p.get("title", "").strip() == CANVAS_PAGE_TITLE), None)
        if match is None:
            pages_url = f"https://canvas.ucsc.edu/courses/{course_id}/pages"
            raise RuntimeError(
                f"No Canvas page titled \"{CANVAS_PAGE_TITLE}\" found in course {course_id} "
                f"({len(pages)} pages searched). "
                f"Create it at: {pages_url}"
            )

        page_url = f"https://canvas.ucsc.edu/courses/{course_id}/pages/{match['url']}"
        async with session.get(f"{CANVAS_BASE_URL}/courses/{course_id}/pages/{match['url']}") as response:
            response.raise_for_status()
            page = await response.json()

            # Canvas wraps page bodies in injected CSS/JS (e.g. DesignPlus).
            # Convert to markdown so faculty-authored structure (headings, lists,
            # bold) is preserved in a form the model can interpret.
            body = markdownify(page["body"], heading_style="ATX").strip()

            prefix = f"# Brace3 educational agent — COURSE_ID={course_id} — system prompt from {page_url}\n\n"
            return prefix + body


class Filter:

    class Valves(BaseModel):
        CANVAS_ACCESS_TOKEN: str = Field(
            default="", description="Canvas API token used to fetch the course system prompt page."
        )

    def __init__(self):
        self.valves = self.Valves()

    async def inlet(self, body, __user__, __metadata__):
        # Force-inject the Brace3 toolkits for this request
        for toolkit_id in TOOLKIT_IDS:
            body.setdefault("tool_ids", []).append(toolkit_id)

        # Derive course ID from the model ID: brace3-92591 -> 92591
        model_id = __metadata__["model"]["id"]
        if not model_id.startswith("brace3-"):
            raise RuntimeError(
                f"brace3_filter is attached to model '{model_id}' which is not named brace3-NNN. "
                f"This filter should only be attached to models with IDs matching 'brace3-<course_id>'."
            )
        course_id = model_id.removeprefix("brace3-")

        # Fetch (and cache per session) the system prompt from Canvas
        chat_id = __metadata__["chat_id"]
        system_prompt = await get_system_prompt_for_course(
            course_id, chat_id, self.valves.CANVAS_ACCESS_TOKEN
        )
        system_prompt = await prompt_template(system_prompt, __user__)

        body["messages"].insert(0, {"role": "system", "content": system_prompt})
        return body
