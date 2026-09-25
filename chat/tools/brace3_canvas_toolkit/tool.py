"""
title: Brace3 Canvas Toolkit
author: Adam Smith
description: Canvas LMS access and date localization tools for Brace3. Bound directly to the course workspace model; its own Canvas token valve supplies API access.
version: 1.0.2
"""

import re
import aiohttp
import jq
from datetime import datetime
from pydantic import BaseModel, Field
from zoneinfo import ZoneInfo
from urllib.parse import urlparse

CANVAS_BASE_URL = "https://canvas.ucsc.edu"

CANVAS_ALLOWED_PATTERNS = [
    re.compile(r"^/api/v1/courses/[\d]+(\?include\[]=syllabus_body)?$"),
    re.compile(r"^/api/v1/courses/[\d]+/assignments$"),
    re.compile(r"^/api/v1/courses/[\d]+/assignments/[\d]+$"),
    re.compile(r"^/api/v1/courses/[\d]+/quizzes/[\d]+$"),
    re.compile(r"^/api/v1/courses/[\d]+/pages$"),
    re.compile(r"^/api/v1/courses/[\d]+/pages/[\d\w%-]+$"),
]


def _is_allowed_canvas_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
        expected = urlparse(CANVAS_BASE_URL)
        if parsed.scheme != expected.scheme or parsed.netloc != expected.netloc:
            return False
        return any(pattern.match(parsed.path) for pattern in CANVAS_ALLOWED_PATTERNS)
    except Exception:
        return False


class Tools:
    class Valves(BaseModel):
        CANVAS_ACCESS_TOKEN: str = Field(
            default="", description="Canvas API token used for Brace3's read-only course tools."
        )

    def __init__(self):
        self.valves = self.Valves()

    def localize_iso_date(self, iso_date_str: str, timezone_str: str = "America/Los_Angeles") -> str:
        """
        Converts a UTC ISO date string (e.g. '2025-09-29T23:00:00Z') to a localized
        datetime string (default timezone: America/Los_Angeles).

        Always use this when presenting Canvas dates to students — Canvas returns all
        dates in GMT.
        """
        dt = datetime.fromisoformat(iso_date_str.replace("Z", "+00:00"))
        localized = dt.astimezone(ZoneInfo(timezone_str))
        return localized.strftime("%Y-%m-%d %H:%M:%S %Z")

    async def use_canvas_api(self, resource_url: str, jq_expr: str = ".") -> dict:
        """
        Make a read-only, paginated request against the UCSC Canvas LMS using
        the course instructor's credentials.

        Access is limited to a specific allowlist of non-sensitive endpoints.
        Canvas always returns dates in GMT — use localize_iso_date before
        presenting any date or time to a student.

        Allowed URL patterns and recommended jq field selectors:

        https://canvas.ucsc.edu/api/v1/courses/COURSE_ID?include[]=syllabus_body  {syllabus_body}
        https://canvas.ucsc.edu/api/v1/courses/COURSE_ID/assignments              .[] | {id, name, due_at}
        https://canvas.ucsc.edu/api/v1/courses/COURSE_ID/assignments/ASSIGNMENT_ID {description, submission_types}
        https://canvas.ucsc.edu/api/v1/courses/COURSE_ID/quizzes/QUIZ_ID          {title, description}
        https://canvas.ucsc.edu/api/v1/courses/COURSE_ID/pages                    .[] | {title, url}
        https://canvas.ucsc.edu/api/v1/courses/COURSE_ID/pages/PAGE_URL_OR_SLUG   {body}

        When listing assignments, always fetch id and name first to disambiguate
        before fetching details. Do not mention specific dates unless asked, and
        always localize them when you do.

        If an API request fails, do NOT guess or invent data. Report the failure
        and try a different approach if possible.
        """
        if not _is_allowed_canvas_url(resource_url):
            return {"failure": "URL not in the allowed Canvas API endpoint list."}

        token = self.valves.CANVAS_ACCESS_TOKEN
        if not token:
            return {"failure": "Canvas API token unavailable — configure the Brace3 Canvas toolkit valve."}

        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        }

        all_data = []
        url = resource_url

        async with aiohttp.ClientSession() as session:
            while url:
                async with session.get(url, headers=headers) as response:
                    if response.status != 200:
                        return {
                            "error": True,
                            "status": response.status,
                            "message": await response.text(),
                        }
                    data = await response.json()
                    if isinstance(data, list):
                        all_data.extend(data)
                    else:
                        all_data.append(data)

                    # Follow pagination via Link header
                    url = None
                    link_header = response.headers.get("Link", "")
                    for part in link_header.split(","):
                        if "; rel=\"next\"" in part:
                            url = part.split(";")[0].strip().lstrip("<").rstrip(">")
                            break

        try:
            return {"jq_expr": jq_expr, "result": jq.all(jq_expr.strip(), all_data)}
        except Exception as e:
            return {"jq_error": repr(e), "hint": "Check jq expression syntax. Example: '.[] | {id, name, due_at}'"}
