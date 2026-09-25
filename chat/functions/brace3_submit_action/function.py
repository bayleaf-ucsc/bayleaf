"""
title: Submit Brace3 conversation to Canvas
author: Adam Smith
description: Submit this Brace3 conversation as an HTML file to a Canvas assignment in the Fall 2026 CMPM 121 course.
requirements: pyyaml
version: 1.6.0
"""

import html
import json
import re
from datetime import datetime, timezone
from urllib.parse import urlsplit

import aiohttp
import yaml
from pydantic import BaseModel, Field


COURSE_ID = 94741
MODEL_ID = f"brace3-{COURSE_ID}"
CANVAS_ORIGIN = "https://canvas.ucsc.edu"
API_ROOT = f"{CANVAS_ORIGIN}/api/v1"
COLLAPSE_RESULT_AFTER_BYTES = 256


def assignment_id_from_url(value):
    url = urlsplit(value.strip())
    if (url.scheme, url.netloc) != ("https", "canvas.ucsc.edu") or url.query or url.fragment:
        raise ValueError("Use the full https://canvas.ucsc.edu assignment URL, without a query or fragment.")
    match = re.fullmatch(rf"/courses/{COURSE_ID}/assignments/(\d+)/?", url.path)
    if not match:
        raise ValueError(f"The assignment must belong to Canvas course {COURSE_ID}.")
    return int(match.group(1))


def assignment_id_from_user_messages(branch):
    """Auto-select only when this branch contains exactly one valid URL occurrence."""
    # Match within each user message, including lines after a user's preamble;
    # never scan assistant text, tool results, or other chat branches.
    user_text = "\n".join(message.get("content", "") for message in branch
                          if message.get("role") == "user" and isinstance(message.get("content"), str))
    matches = []
    for candidate in re.findall(r"(?<![\w@./-])https://[^\s<>'\"\\]+", user_text):
        try:
            matches.append(assignment_id_from_url(candidate.rstrip(".,;:!?)]}")))
        except ValueError:
            continue
    return matches[0] if len(matches) == 1 else None


def time_label(value):
    if not isinstance(value, (int, float)):
        return "Time not recorded"
    return datetime.fromtimestamp(value, timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def output_text(parts):
    if isinstance(parts, str):
        return parts
    if isinstance(parts, list):
        return "\n".join(str(part.get("text", "")) for part in parts
                         if isinstance(part, dict) and part.get("type") in ("output_text", "text"))
    return ""


def exact_event_time(item):
    timestamp = item.get("timestamp") or item.get("started_at")
    return f" · {time_label(timestamp)}" if isinstance(timestamp, (int, float)) else ""


def attributes(**values):
    return "".join(f' {key.replace("_", "-")}="{html.escape(str(value), quote=True)}"'
                   for key, value in values.items() if value is not None)


def recorded_time(value):
    """Display the time and retain the source epoch with subsecond precision."""
    if not isinstance(value, (int, float)):
        return ""
    iso = datetime.fromtimestamp(value, timezone.utc).isoformat()
    return f"<time{attributes(datetime=iso, data_timestamp=value)}>{time_label(value)}</time>"


def event_attributes(item, index):
    return attributes(data_event_type=item.get("type"), data_event_index=index,
                      data_event_id=item.get("id"), data_call_id=item.get("call_id"),
                      data_timestamp=item.get("timestamp") or item.get("started_at"))


def yaml_arguments(arguments):
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except (ValueError, TypeError):
            return yaml.safe_dump(arguments, allow_unicode=True, default_style="|", width=100).rstrip()
    return yaml.safe_dump(arguments, allow_unicode=True, sort_keys=False, default_flow_style=False, width=100).rstrip()


def yaml_result(result):
    text = output_text(result)
    if text:
        try:
            return yaml_arguments(json.loads(text))
        except (ValueError, TypeError):
            # Plain text is still valid YAML, represented as a block scalar.
            return yaml.safe_dump(text, allow_unicode=True, default_style="|", width=100).rstrip()
    return yaml_arguments(result) if result is not None else ""


def branch_to_message(chat, message_id):
    """Walk the selected branch only, not other branches of the user's chat."""
    messages = chat.get("history", {}).get("messages", {})
    branch, seen = [], set()
    while message_id:
        if message_id in seen or message_id not in messages:
            raise ValueError("Could not resolve the selected conversation branch.")
        seen.add(message_id)
        message = messages[message_id]
        branch.append(message)
        message_id = message.get("parentId")
    branch.reverse()
    if not branch or branch[-1].get("role") != "assistant":
        raise ValueError("Choose a Brace assistant reply to submit.")
    return branch


def conversation_html(messages, chat_id=None, assignment_id=None):
    """Human-readable and machine-parseable, script-free transcript schema v1."""
    sections = []
    turn_index = 0
    for message in messages:
        role = message.get("role")
        if role not in ("user", "assistant"):
            continue
        started = message.get("timestamp")
        sections.append(f"<section class='turn turn--{role}'"
                        + attributes(data_role=role, data_turn_index=turn_index,
                                     data_message_id=message.get("id"), data_timestamp=started)
                        + f"><h2>{html.escape(role.title())}"
                        + (f" · {recorded_time(started)}" if isinstance(started, (int, float)) else "")
                        + "</h2>")
        events = message.get("output") if role == "assistant" else None
        if not isinstance(events, list) or not events:
            content = message.get("content", "")
            sections.append("<div class='event event--message' data-event-type='message' data-event-index='0'>"
                            f"<pre class='payload' data-format='markdown'>{html.escape(content if isinstance(content, str) else '[Non-text message omitted]')}</pre></div>")
        else:
            rendered_text = False
            for index, item in enumerate(events):
                kind = item.get("type")
                event = event_attributes(item, index)
                if kind == "message":
                    text = output_text(item.get("content"))
                    if text:
                        rendered_text = True
                        sections.append(f"<div class='event event--message reply'{event}>"
                                        f"<strong>Assistant reply</strong><pre class='payload' data-format='markdown'>{html.escape(text)}</pre></div>")
                elif kind == "reasoning":
                    text = output_text(item.get("content")) or output_text(item.get("summary"))
                    if text:
                        when = item.get("timestamp") or item.get("started_at")
                        sections.append(f"<details class='event event--reasoning'{event}><summary>Reasoning"
                                        + (f" · {recorded_time(when)}" if when else "")
                                        + f"</summary><pre class='payload' data-format='text'>{html.escape(text)}</pre></details>")
                elif kind == "function_call":
                    name = html.escape(str(item.get("name") or "Unknown tool"))
                    args = yaml_arguments(item.get("arguments", ""))
                    sections.append(f"<details class='event event--function-call tool' open{event}"
                                    + attributes(data_tool_name=item.get("name"))
                                    + f"><summary>Tool call: {name}{exact_event_time(item)}</summary>"
                                    f"<pre class='payload' data-format='yaml'>{html.escape(args)}</pre></details>")
                elif kind == "function_call_output":
                    result = yaml_result(item.get("output"))
                    expanded = " open" if len(result.encode("utf-8")) <= COLLAPSE_RESULT_AFTER_BYTES else ""
                    sections.append(f"<details class='event event--function-call-output tool-result'{expanded}{event}>"
                                    f"<summary>Tool result{exact_event_time(item)}</summary>"
                                    f"<pre class='payload' data-format='yaml'>{html.escape(result)}</pre></details>")
                else:
                    # Unknown OWUI event types remain inspectable rather than
                    # silently disappearing from an evidentiary export.
                    text = yaml.safe_dump(item, allow_unicode=True, sort_keys=False)
                    sections.append(f"<details class='event event--other'{event}><summary>Other event: "
                                    f"{html.escape(str(kind))}</summary>"
                                    f"<pre class='payload' data-format='yaml'>{html.escape(text)}</pre></details>")
            if not rendered_text and isinstance(message.get("content"), str):
                sections.append("<div class='event event--message' data-event-type='message' data-event-index='fallback'>"
                                f"<pre class='payload' data-format='markdown'>{html.escape(message['content'])}</pre></div>")
        sections.append("</section>")
        turn_index += 1
    if not sections:
        raise ValueError("No text messages to submit.")
    return ("<!doctype html><html lang='en'><head><meta charset='utf-8'>"
            "<title>Brace3 conversation</title><style>body{font:1rem/1.5 sans-serif;"
            "max-width:75ch;margin:2rem auto;padding:0 1rem}section{border-top:1px solid #aaa;"
            "padding:1rem 0}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}"
            ".tool,.reply,details{margin:1rem 0;padding:.6rem;border:1px solid #ccc}"
            ".tool{background:#f5f5f5}small{display:block}summary{cursor:pointer}"
            "</style></head><body><main><article class='brace3-transcript'"
            + attributes(data_schema="brace3-transcript", data_schema_version="1",
                         data_course_id=COURSE_ID, data_assignment_id=assignment_id,
                         data_chat_id=chat_id)
            + "><h1>Brace3 conversation</h1>"
            + "".join(sections) + "</article></main></body></html>")


def canvas_file_id_from_location(location):
    parsed = urlsplit(location)
    if (parsed.scheme, parsed.netloc) != ("https", "canvas.ucsc.edu"):
        raise RuntimeError("Canvas returned an unexpected upload confirmation URL.")
    match = re.fullmatch(r"/api/v1/files/(\d+)", parsed.path)
    if not match:
        raise RuntimeError("Canvas returned an unexpected file URL.")
    return int(match.group(1))


async def upload_submission(session, assignment_id, student_id, document):
    """Canvas three-step file upload, then submit the resulting file ID."""
    root = f"{API_ROOT}/courses/{COURSE_ID}/assignments/{assignment_id}/submissions"
    data = document.encode("utf-8")
    async with session.post(
        f"{root}/{student_id}/files",
        data={"name": "brace3-conversation.html", "size": str(len(data)), "content_type": "text/html"},
    ) as response:
        response.raise_for_status()
        upload = await response.json()

    form = aiohttp.FormData()
    for key, value in upload["upload_params"].items():
        form.add_field(key, value)
    form.add_field("file", data, filename="brace3-conversation.html", content_type="text/html")
    # Canvas may return a presigned third-party upload URL: never send the bearer token there.
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60)) as external:
        async with external.post(upload["upload_url"], data=form, allow_redirects=False) as response:
            response.raise_for_status()
            if response.status not in (201, 301, 302, 303, 307, 308):
                raise RuntimeError("Canvas did not confirm the file upload.")
            location = response.headers.get("Location")
            if response.status == 201:
                # 201 means upload complete. Canvas may deny a subsequent GET on
                # this student-private file to the instructor token (403), even
                # though it gave us the file ID in Location. No GET is needed.
                file_id = (canvas_file_id_from_location(location) if location
                           else (await response.json())["id"])

    if response.status != 201:
        # A 3xx (unlike 201) must be followed to finalize the pending upload.
        if not location:
            raise RuntimeError("Canvas returned no upload confirmation URL.")
        parsed = urlsplit(location)
        if (parsed.scheme, parsed.netloc) != ("https", "canvas.ucsc.edu") or not parsed.path.startswith("/api/v1/files/"):
            raise RuntimeError("Canvas returned an unexpected upload confirmation URL.")
        async with session.get(location) as response:
            response.raise_for_status()
            file_info = await response.json()
        file_id = file_info["id"]

    async with session.post(
        root,
        data={"submission[submission_type]": "online_upload",
              "submission[file_ids][]": str(file_id), "submission[user_id]": str(student_id)},
    ) as response:
        response.raise_for_status()
        submission = await response.json()
    if str(submission.get("user_id")) != str(student_id):
        raise RuntimeError("Canvas did not confirm the intended student's submission.")


class Action:
    class Valves(BaseModel):
        CANVAS_ACCESS_TOKEN: str = Field(default="", description="Instructor Canvas API token. Never expose to users.")
        CANVAS_TEST_STUDENT_ID: int | None = Field(default=None, description="Canvas Test Student ID for admin trials.")

    def __init__(self):
        self.name = "Submit conversation to Canvas"
        self.valves = self.Valves()

    async def action(self, body: dict, __user__=None, __event_emitter__=None,
                     __event_call__=None):
        async def status(message):
            if __event_emitter__:
                await __event_emitter__({"type": "status", "data": {"description": message, "done": True}})

        try:
            if body.get("model") != MODEL_ID or not __user__ or not self.valves.CANVAS_ACCESS_TOKEN:
                raise ValueError("This action is configured only for the Fall 2026 Brace3 course model.")
            if not __event_call__:
                raise ValueError("Open this chat in the browser to confirm the submission.")

            from open_webui.models.chats import Chats

            chat = await Chats.get_chat_by_id_and_user_id(body["chat_id"], __user__["id"])
            if chat is None:
                raise ValueError("This chat must be saved before it can be submitted.")
            branch = branch_to_message(chat.chat, body["id"])
            assignment_id = assignment_id_from_user_messages(branch)
            if assignment_id is None:
                url = await __event_call__({"type": "input", "data": {
                    "title": "Canvas assignment URL",
                    "message": f"Paste the URL of an HTML-upload assignment in course {COURSE_ID}.",
                    "placeholder": f"{CANVAS_ORIGIN}/courses/{COURSE_ID}/assignments/…",
                }})
                if not url or isinstance(url, dict):
                    await status("Submission cancelled.")
                    return
                assignment_id = assignment_id_from_url(str(url))

            headers = {"Authorization": f"Bearer {self.valves.CANVAS_ACCESS_TOKEN}"}
            async with aiohttp.ClientSession(headers=headers, timeout=aiohttp.ClientTimeout(total=60)) as session:
                if __user__.get("role") == "admin":
                    student_id = self.valves.CANVAS_TEST_STUDENT_ID
                    student_name = "Test Student"
                    if student_id is None:
                        raise ValueError("Set CANVAS_TEST_STUDENT_ID before an admin trial.")
                else:
                    # Check the course roster, not an ID or email supplied in the action payload.
                    student_id = None
                    next_url = f"{API_ROOT}/courses/{COURSE_ID}/enrollments?type[]=StudentEnrollment&per_page=100"
                    while next_url:
                        async with session.get(next_url) as response:
                            response.raise_for_status()
                            enrollments = await response.json()
                            next_url = next((part.split(";")[0].strip(" <>") for part in
                                             response.headers.get("Link", "").split(",")
                                             if 'rel="next"' in part), None)
                        for enrollment in enrollments:
                            student = enrollment.get("user") or {}
                            if student.get("login_id", "").casefold() == __user__.get("email", "").casefold():
                                student_id, student_name = student["id"], student["name"]
                                break
                        if student_id is not None:
                            break
                    if student_id is None:
                        raise ValueError("Your BayLeaf email does not match a student enrollment in this course.")

                async with session.get(f"{API_ROOT}/courses/{COURSE_ID}/assignments/{assignment_id}") as response:
                    response.raise_for_status()
                    assignment = await response.json()
                if (assignment.get("course_id") != COURSE_ID
                        or "online_upload" not in assignment.get("submission_types", [])
                        or "html" not in assignment.get("allowed_extensions", [])):
                    raise ValueError("This assignment does not accept HTML file submissions.")

                confirmed = await __event_call__({"type": "confirmation", "data": {
                    "title": "Submit conversation to Canvas?",
                    "message": (f"Submit this conversation to ‘{assignment['name']}’ as {student_name}? "
                                "The transcript will be stored in Canvas, outside BayLeaf Chat's retention policy."),
                }})
                if confirmed is not True:
                    await status("Submission cancelled.")
                    return
                # The Action payload flattens assistant text. Use only the
                # owner-scoped stored branch for the complete transcript.
                transcript = conversation_html(branch, body["chat_id"], assignment_id)
                await upload_submission(session, assignment_id, student_id, transcript)
            message = f"Submitted to Canvas: {assignment['name']} as {student_name}."
            await status(message)
            if __event_emitter__:
                await __event_emitter__({"type": "notification", "data": {"type": "success", "content": message}})
            # The success dialog is informational. A closed tab or a dismissed
            # popup cannot undo a submission that Canvas has already accepted.
            try:
                await __event_call__({"type": "confirmation", "data": {
                    "title": "Submission complete",
                    "message": f"{message} Your conversation is now stored in Canvas. Dismiss this dialog to continue.",
                }})
            except Exception:
                pass
        except Exception as exc:
            await status(f"Submission failed: {exc}")
            raise
