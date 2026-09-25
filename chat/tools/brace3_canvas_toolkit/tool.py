"""
title: Brace3 Canvas Toolkit
author: Adam Smith
description: Course-scoped Canvas LMS access and date localization tools for Brace3. Its own Canvas token valve supplies API access.
version: 1.0.3
"""

import re
import aiohttp
import jq
from datetime import datetime
from pydantic import BaseModel, Field
from zoneinfo import ZoneInfo
from urllib.parse import parse_qsl, urlparse

CANVAS_BASE_URL = "https://canvas.ucsc.edu"
COURSE_ID = 94741

CANVAS_ALLOWED_PATTERNS = [
    re.compile(rf"^/api/v1/courses/{COURSE_ID}$"),
    re.compile(rf"^/api/v1/courses/{COURSE_ID}/assignments$"),
    re.compile(rf"^/api/v1/courses/{COURSE_ID}/assignments/[\d]+$"),
    re.compile(rf"^/api/v1/courses/{COURSE_ID}/quizzes/[\d]+$"),
    re.compile(rf"^/api/v1/courses/{COURSE_ID}/pages$"),
    re.compile(rf"^/api/v1/courses/{COURSE_ID}/pages/[\d\w-]+$"),
]


def _is_allowed_canvas_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
        expected = urlparse(CANVAS_BASE_URL)
        if (parsed.scheme != expected.scheme or parsed.netloc != expected.netloc
                or parsed.fragment or parsed.username or parsed.password):
            return False
        if not any(pattern.fullmatch(parsed.path) for pattern in CANVAS_ALLOWED_PATTERNS):
            return False
        for key, value in parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True):
            if key == "include[]" and value == "syllabus_body" and parsed.path == f"/api/v1/courses/{COURSE_ID}":
                continue
            if key in ("page", "per_page") and value.isdecimal() and int(value) > 0:
                continue
            return False
        return True
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

        Access is limited to non-sensitive endpoints in course 94741.
        Canvas always returns dates in GMT — use localize_iso_date before
        presenting any date or time to a student.

        Allowed URL patterns and recommended jq field selectors:

        https://canvas.ucsc.edu/api/v1/courses/94741?include[]=syllabus_body  {syllabus_body}
        https://canvas.ucsc.edu/api/v1/courses/94741/assignments              .[] | {id, name, due_at}
        https://canvas.ucsc.edu/api/v1/courses/94741/assignments/ASSIGNMENT_ID {description, submission_types}
        https://canvas.ucsc.edu/api/v1/courses/94741/quizzes/QUIZ_ID          {title, description}
        https://canvas.ucsc.edu/api/v1/courses/94741/pages                    .[] | {title, url}
        https://canvas.ucsc.edu/api/v1/courses/94741/pages/PAGE_URL_OR_SLUG   {body}

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
                if not _is_allowed_canvas_url(url):
                    return {"failure": "Canvas pagination URL left the allowed course endpoints."}
                async with session.get(url, headers=headers, allow_redirects=False) as response:
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
