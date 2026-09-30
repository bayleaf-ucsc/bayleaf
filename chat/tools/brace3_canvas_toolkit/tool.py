"""
title: Brace3 Canvas Toolkit
author: Adam Smith
description: Course-scoped Canvas LMS access and date localization tools for Brace3. Its own Canvas token valve supplies API access.
version: 2.0.3
"""

import re
import aiohttp
from datetime import datetime
from pydantic import BaseModel, Field
from zoneinfo import ZoneInfo
from urllib.parse import parse_qsl, urlparse

CANVAS_BASE_URL = "https://canvas.ucsc.edu"
COURSE_ID = 94741
COURSE_API_URL = f"{CANVAS_BASE_URL}/api/v1/courses/{COURSE_ID}"
COURSE_TIMEZONE = "America/Los_Angeles"
UNAVAILABLE = "This resource might not exist or might be unpublished or otherwise unavailable in Brace's general student view. Check Canvas for your own access."


def _student_visible(resource: dict) -> bool:
    # Instructor credentials are transport only, never a student's identity.
    return (resource.get("published") is True
            and not resource.get("hide_from_students", False)
            and not resource.get("only_visible_to_overrides", False)
            and resource.get("visible_to_everyone", True) is not False)


def _project(resource: dict, fields: str) -> dict:
    result = {key: resource[key] for key in fields.split() if key in resource}
    for key in ("due_at", "unlock_at", "lock_at"):
        if key in result:
            value = result[key]
            result[key + "_local"] = (
                datetime.fromisoformat(value.replace("Z", "+00:00"))
                .astimezone(ZoneInfo(COURSE_TIMEZONE)).isoformat() if value else None
            )
    return result


ASSIGNMENT_SUMMARY = "id name html_url published due_at unlock_at lock_at quiz_id submission_types"
ASSIGNMENT_DETAIL = ASSIGNMENT_SUMMARY + " description allowed_extensions allowed_attempts points_possible grading_type rubric rubric_settings has_overrides"
PAGE_SUMMARY = "page_id title url html_url published"
QUIZ_SUMMARY = "id title html_url published assignment_id due_at unlock_at lock_at"
QUIZ_DETAIL = QUIZ_SUMMARY + " description quiz_type time_limit allowed_attempts question_count points_possible"

CANVAS_ALLOWED_PATTERNS = [
    re.compile(rf"^/api/v1/courses/{COURSE_ID}$"),
    re.compile(rf"^/api/v1/courses/{COURSE_ID}/assignments$"),
    re.compile(rf"^/api/v1/courses/{COURSE_ID}/assignments/[\d]+$"),
    re.compile(rf"^/api/v1/courses/{COURSE_ID}/quizzes/[\d]+$"),
    re.compile(rf"^/api/v1/courses/{COURSE_ID}/quizzes$"),
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

    def canvas_localize_date(self, iso_date_str: str, timezone_str: str = "America/Los_Angeles") -> str:
        """
        Convert an ISO date to a named timezone (default: America/Los_Angeles).
        Canvas read tools already include localized dates in *_local fields.
        Use this for another timezone or a date without a localized counterpart.
        Do not mention specific dates unless asked. Never infer a student's extension
        from course-wide dates.
        """
        dt = datetime.fromisoformat(iso_date_str.replace("Z", "+00:00"))
        localized = dt.astimezone(ZoneInfo(timezone_str))
        return localized.strftime("%Y-%m-%d %H:%M:%S %Z")

    async def canvas_list_assignments(self) -> dict:
        """List published course-94741 assignments with IDs, names, links and dates.
        Use this to disambiguate assignment names before reading details; a supplied
        assignment URL already gives its ID. Descriptions and rubrics require
        canvas_read_assignment. Dates are course-wide, not personal extensions;
        use *_local when asked about dates. Never invent data after a failure.
        """
        return await _read(self, "/assignments?per_page=100", ASSIGNMENT_SUMMARY, "assignments")

    async def canvas_read_assignment(self, assignment_id: int) -> dict:
        """Read a published assignment's full HTML description, submission types,
        allowed file extensions, attempts and rubric when present. For a course-94741
        assignment URL, use its final numeric ID directly. A quiz_id links to
        canvas_read_quiz for the quiz description (not questions or answers).
        Dates are course-wide; present *_local only when asked. Missing fields are
        not evidence of no requirement. Never invent data after a failure.
        """
        return await _read(self, f"/assignments/{assignment_id}", ASSIGNMENT_DETAIL)

    async def canvas_list_pages(self) -> dict:
        """List published, non-hidden course-94741 pages with titles, slugs (url),
        page IDs and links. Use canvas_read_page with the returned slug for content.
        Unpublished or student-hidden pages are excluded. Never invent missing data.
        """
        return await _read(self, "/pages?per_page=100", PAGE_SUMMARY, "pages")

    async def canvas_read_page(self, page_slug: str) -> dict:
        """Read a published, non-hidden course-94741 page's full HTML body.
        Supply the url slug from canvas_list_pages or the last segment of a Canvas
        page URL, not the title or full URL. Never invent data after a failure.
        """
        if not re.fullmatch(r"[\d\w-]+", page_slug):
            return {"failure": "Supply a page slug, not a full URL or path."}
        return await _read(self, f"/pages/{page_slug}", PAGE_SUMMARY + " body")

    async def canvas_read_syllabus(self) -> dict:
        """Read course 94741's full HTML syllabus, course name and timezone.
        Follow links for authoritative course policies and resources. An empty
        syllabus is returned as empty; never guess its contents after a failure.
        If the course's policy on AI assistance is not already in context, start
        with the syllabus and follow relevant policy links. Absence of a stated
        policy is not permission; do not invent one.
        When answering from the syllabus, usually cite it conspicuously using the
        returned html_url: "As written in [the course syllabus](URL), ...".
        Link directly to the syllabus page, not merely the course homepage.
        """
        return await _read(self, "?include[]=syllabus_body", "id name course_code time_zone syllabus_body", syllabus=True)

    async def canvas_list_quizzes(self) -> dict:
        """List published course-94741 quizzes with IDs, titles, assignment IDs,
        links and course-wide dates. Use canvas_read_quiz for a description.
        This does not read questions, answers or student attempts. Present *_local
        dates only when asked. Never invent data after a failure.
        """
        return await _read(self, "/quizzes?per_page=100", QUIZ_SUMMARY, "quizzes")

    async def canvas_read_quiz(self, quiz_id: int) -> dict:
        """Read a published course-94741 quiz's full HTML description and general
        requirements (time limit, allowed attempts, points and question count).
        Use a quiz_id from an assignment or canvas_list_quizzes, not an assignment
        ID. No questions, answers, access codes or student attempts are returned.
        This intentionally sanitized, depersonalized view provides student-facing
        information, not instructor-only grading data or a specific student's view.
        Quizzes often assess learning: be especially cautious with explanations
        that could solve an assessed task. Elicit the student's reasoning and support
        their understanding without supplying answers or making claims for them.
        Instructors also use Canvas quizzes as multi-step activity containers,
        surveys and generic forms. Judge the activity by its instructions, not its
        Canvas label: explain guidance and logistics, help students reflect, and
        leave survey responses and completion attestations to the student.
        Present *_local dates only when asked; they are not personal extensions.
        Never invent data after a failure.
        """
        return await _read(self, f"/quizzes/{quiz_id}", QUIZ_DETAIL)


async def _read(tools: Tools, path: str, fields: str, collection: str = "", syllabus: bool = False) -> dict:
    data = await _fetch(tools.valves.CANVAS_ACCESS_TOKEN, COURSE_API_URL + path, bool(collection))
    if isinstance(data, dict) and "failure" in data:
        return data
    if collection:
        return {collection: [_project(item, fields) for item in data if _student_visible(item)],
                "view": "Published course-wide material, not a specific student's access or deadlines.",
                "time_zone": COURSE_TIMEZONE}
    if not (data.get("workflow_state") == "available" if syllabus else _student_visible(data)):
        return {"failure": UNAVAILABLE}
    result = _project(data, fields)
    if syllabus:
        result["html_url"] = f"{CANVAS_BASE_URL}/courses/{COURSE_ID}/assignments/syllabus"
    return result


async def _fetch(token: str, url: str, collection: bool):
    if not token:
        return {"failure": "Canvas API token unavailable. Configure the Brace3 Canvas toolkit valve."}
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    items, visited = [], set()
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
            while url:
                if not _is_allowed_canvas_url(url) or url in visited:
                    return {"failure": "Canvas URL or pagination link is invalid for this course."}
                visited.add(url)
                async with session.get(url, headers=headers, allow_redirects=False) as response:
                    if response.status in (403, 404):
                        return {"failure": UNAVAILABLE}
                    if response.status != 200:
                        return {"failure": "Canvas request failed. Do not infer missing content.", "status": response.status}
                    data = await response.json()
                    if not collection:
                        return data if isinstance(data, dict) else {"failure": "Unexpected Canvas response shape."}
                    if not isinstance(data, list) or not all(isinstance(item, dict) for item in data):
                        return {"failure": "Unexpected Canvas response shape."}
                    items.extend(data)
                    next_link = response.links.get("next")
                    url = str(next_link["url"]) if next_link else None
        return items
    except (aiohttp.ClientError, TimeoutError, ValueError):
        return {"failure": "Canvas request failed or returned invalid data. Try again; do not invent content."}
