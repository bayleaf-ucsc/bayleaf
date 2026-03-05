"""
requirements: jq,google-auth,google-api-python-client,google-auth-oauthlib,google-auth-httplib2
"""

import jq
import os
import io
import re
import json
import requests
from typing import Optional
from datetime import datetime
from pydantic import BaseModel, Field
import aiohttp

CANVAS_ALLOWED_PATTERNS = [
    re.compile(r"^/api/v1/courses/[\d]+(\?include\[]=syllabus_body)?$"),
    re.compile(r"^/api/v1/courses/[\d]+/assignments$"),
    re.compile(r"^/api/v1/courses/[\d]+/assignments/[\d]+$"),
    re.compile(r"^/api/v1/courses/[\d]+/quizzes/[\d]+$"),
    re.compile(r"^/api/v1/courses/[\d]+/pages$"),
    re.compile(r"^/api/v1/courses/[\d]+/pages/[\d\w%-]+$"),
]

CANVAS_BASE_URL = "https://canvas.ucsc.edu"


def is_allowed_canvas_url(url: str) -> Optional[str]:
    """
    Validates the given URL is a permitted Canvas API endpoint.
    Returns the matched path if allowed, None otherwise.
    """
    try:
        parsed = aiohttp.helpers.URL(url)
        if parsed.origin() != aiohttp.helpers.URL(CANVAS_BASE_URL):
            return None
        path = parsed.path
        return (
            path
            if any(pattern.match(path) for pattern in CANVAS_ALLOWED_PATTERNS)
            else None
        )
    except:
        return None


class Tools:

    class Valves(BaseModel):
        GITHUB_API_TOKEN: str = Field(
            default=None,
            description="a GitHub API token capable of read-only public repo access",
        )
        CANVAS_ACCESS_TOKEN: str = Field(
            default=None, description="Instructor's Canvas access token"
        )
        GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_JSON: str = Field(
            default="", description="JSON-structured access key for the service account"
        )

    def __init__(self):
        self.valves = self.Valves()

    # def get_current_canvas_course_id(self, __metadata__):
    #     return repr(__metadata__["model"].get("id").removeprefix("brace-"))

    def localize_iso_date(
        self, iso_date_str: str, timezone_str: str = "America/Los_Angeles"
    ):
        """
        Takes an ISO date string (e.g., '2025-09-29T23:00:00Z') and a timezone (e.g., 'America/Los_Angeles'),
        and returns the localized datetime string.
        """
        import pytz
        from datetime import datetime

        dt = datetime.fromisoformat(iso_date_str.replace("Z", "+00:00"))
        target_tz = pytz.timezone(timezone_str)
        localized_dt = dt.astimezone(target_tz)
        return localized_dt.strftime("%Y-%m-%d %H:%M:%S %Z")

    async def use_canvas_api(self, resource_url: str, jq_expr: str = None):
        """
        Make request against the university's Canvas LMS using the instructor's credentials.

        Beware that Canvas always gives dates and times in the GMT time zone. If your reponse will mentions a date/time, you should localize it using the appropriate tool.

        Access is limited to just a few non-sensitive, read-only endpoints. Examples with recommended fields:

        https://canvas.ucsc.edu/api/v1/courses/COURSE_ID?include[]=syllabus_body {syllabus_body} <-- the include[] part is critical
        https://canvas.ucsc.edu/api/v1/courses/COURSE_ID/assignments {id, name, due_at}
        https://canvas.ucsc.edu/api/v1/courses/COURSE_ID/assignments/ASSIGNMENT_ID {description, submission_types}
        https://canvas.ucsc.edu/api/v1/courses/COURSE_ID/quizzes/QUIZ_ID {title, description}
        https://canvas.ucsc.edu/api/v1/courses/COURSE_ID/pages {title, url}
        https://canvas.ucsc.edu/api/v1/courses/COURSE_ID/pages/URL {body}


        If the URL of the course webpage is known, it can be used to identify the course id.
        Pattern for selecting specific fields: `.[] | {x,y}`

        When searching for assignments, it is a good idea to get the id and name of all assignments to disambiguate results. Don't talk about precise dates unless they are specifically requested (and even then they should be appropriately localized).
        """

        if not is_allowed_canvas_url(resource_url):
            return dict(failure="Stick to one of the allowed resource url patterns!")

        headers = {
            "Authorization": f"Bearer {self.valves.CANVAS_ACCESS_TOKEN}",
            "Accept": "application/json",
        }
        all_data = []
        url = resource_url

        async with aiohttp.ClientSession() as session:
            while url:
                async with session.get(url, headers=headers) as response:
                    if response.status == 200:
                        data = await response.json()
                        if isinstance(data, list):
                            all_data.extend(data)
                        else:
                            # For single-object responses (e.g. a specific assignment or page)
                            all_data.append(data)

                        # Parse Link headers for pagination
                        link_header = response.headers.get("Link")
                        url = None
                        if link_header:
                            links = {}
                            for part in link_header.split(","):
                                href, rel = part.split(";", 1)
                                href = href.strip()[1:-1]  # remove < >
                                rel = rel.split("=")[1].strip()[1:-1]
                                links[rel] = href
                            url = links.get("next")  # follow 'next' page only
                    else:
                        return {
                            "error": True,
                            "status": response.status,
                            "message": await response.text(),
                        }

        if jq_expr is None:
            jq_expr = "."
        jq_expr = jq_expr.strip()
        if jq_expr.startswith("{"):
            jq_expr = ".[] | " + jq_expr
        if "{" in jq_expr and not jq_expr.endswith("}"):
            jq_expr = jq_expr + "}"
        try:
            return dict(jq_expr=jq_expr, result=jq.all(jq_expr, all_data))
        except Exception as e:
            return dict(exception=repr(e))

    async def use_github_api(
        self,
        resource_url: str,
        jq_expr: str = None,
    ):
        """
        Make a request against the GitHub API using public read only access. Examples (some with jq expressions):

        https://api.github.com/repos/OWNER/REPO/readme
        https://api.github.com/repos/OWNER/REPO/commits
        https://api.github.com/repos/OWNER/REPO/commits/REF
        https://api.github.com/repos/OWNER/REPO/contents .[]|{path,type}
        https://api.github.com/repos/OWNER/REPO/contents/PATH/TO/DIRECTORY/OR/FILE .content
        https://api.github.com/repos/OWNER/REPO/actions/runs
        https://api.github.com/gists/GIST_ID [{id: .[].id, filenames: .[].files | keys}]

        If an API request fails, it is important to NOT guess or imagine what the result would be. Only use the authoritative data that is successfully fetched. (It is okay try multiple attempts with different arguments.)
        ...
        """
        headers = {
            "Authorization": f"token {self.valves.GITHUB_API_TOKEN}",
            "Accept": "application/vnd.github.v3+json",
        }

        async with aiohttp.ClientSession() as session:
            async with session.get(resource_url, headers=headers) as response:
                if response.status == 200:
                    data = await response.json()
                    if jq_expr is None:
                        if type(data) == list:
                            jq_expr = '{length: length, ".[0]|keys": .[0]|keys}'
                        elif type(data) == dict:
                            jq_expr = "{keys: keys}"
                        else:
                            jq_expr = "."
                        return dict(jq_expr=jq_expr, result=jq.all(jq_expr, data))
                    else:
                        return jq.all(jq_expr, data)
                else:
                    return {
                        "error": True,
                        "status": response.status,
                        "message": await response.text(),
                    }

    # def submit_conversation_to_canvas_assignment(self, assignment_url):
    #     """
    #     Submits a transcript of this conversation to a Canvas assignment as an HTML file attachment as the current user (presumed to be a student and verified upon submission).
    #     """
    #     return dict(
    #         failure="Agentic submissions are disabled at this time. The user should use the sparkle (✨) tool below the last assistant message to submit the conversation to a specific assignment on Canvas."
    #     )

    def get_google_drive_service_account_email(self):
        """
        The assistant can only access Google Drive files that are readable by "anyone with the link" or have been shared to the service account email address (sharing to anyone within the org is not enough).
        Often, a file appears to be missing when the underlying problem is permissions.
        Do not use this tool unless the user is specifically trying to share their own file with the assistant.
        """
        try:
            service_account_key = json.loads(
                self.valves.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_JSON
            )
            return dict(client_email=service_account_key["client_email"])
        except Exception as e:
            return dict(failure=repr(e))

    def read_google_drive_file(self, file_id: str):
        """Reads a Google Drive file (Docs/Slides/Sheets) and returns its content in a near-text format."""
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaIoBaseDownload

        google_drive_service_account_key_json = (
            self.valves.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_JSON
        )
        if not google_drive_service_account_key_json:
            return dict(
                failure="No service account key configured to access Google Drive."
            )

        try:
            service_account_key = json.loads(google_drive_service_account_key_json)
        except Exception as e:
            return dict(failure=repr(e))

        scopes = ["https://www.googleapis.com/auth/drive.readonly"]
        credentials = service_account.Credentials.from_service_account_info(
            service_account_key, scopes=scopes
        )

        service = build("drive", "v3", credentials=credentials)

        if service is None:
            return dict(failure="Authentication failed.")

        try:
            # Get file metadata
            file_metadata = (
                service.files().get(fileId=file_id, fields="name, mimeType").execute()
            )
            file_name = file_metadata["name"]
            mime_type = file_metadata["mimeType"]

            # Handle different file types (https://developers.google.com/workspace/drive/api/guides/ref-export-formats)

            if mime_type == "application/vnd.google-apps.document":
                # Export Google Docs file as markdown
                request = service.files().export_media(
                    fileId=file_id, mimeType="text/markdown"
                )
                file_name = f"{file_name}.md"
            elif mime_type == "application/vnd.google-apps.presentation":
                # Export Google Slides file as plain text
                request = service.files().export_media(
                    fileId=file_id, mimeType="text/plain"
                )
                file_name = f"{file_name}.txt"
            elif mime_type == "application/vnd.google-apps.spreadsheet":
                # Export Google Sheets as CSV
                request = service.files().export_media(
                    fileId=file_id, mimeType="text/csv"
                )
                file_name = f"{file_name}.csv"
            else:
                return dict(failure=f"Unsupported mime_type {mime_type}.")

            # Create a BytesIO stream to hold the downloaded content
            file_content = io.BytesIO()

            # Create a downloader
            downloader = MediaIoBaseDownload(file_content, request)

            # Download the file
            done = False
            while not done:
                status, done = downloader.next_chunk()

            # Compactify and truncate
            content = file_content.getvalue().decode("utf-8")
            content = re.sub(
                r"<data:[^>]+>", "(inline data removed for text format)", content
            )[:16384]

            # Produce result dict
            return dict(
                mime_type=mime_type,
                file_name=file_name,
                content=content,
            )

        except Exception as e:
            return dict(failure=repr(e))

    def read_google_drive_folder(self, folder_id: str):
        """Reads a Google Drive folder and gets a list of references to the files it contains."""
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaIoBaseDownload

        google_drive_service_account_key_json = (
            self.valves.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_JSON
        )
        if not google_drive_service_account_key_json:
            return dict(
                failure="No service account key configured to access Google Drive."
            )

        try:
            service_account_key = json.loads(google_drive_service_account_key_json)
        except Exception as e:
            return dict(failure=repr(e))

        scopes = ["https://www.googleapis.com/auth/drive.readonly"]
        credentials = service_account.Credentials.from_service_account_info(
            service_account_key, scopes=scopes
        )

        service = build("drive", "v3", credentials=credentials)

        if service is None:
            return dict(failure="Authentication failed.")

        try:
            page_token = None
            all_files = []

            while True:
                results = (
                    service.files()
                    .list(q=f"'{folder_id}' in parents", pageToken=page_token)
                    .execute()
                )

                all_files.extend(results.get("files", []))
                page_token = results.get("nextPageToken")

                if not page_token:
                    break

            return dict(
                results=results,
            )

        except Exception as e:
            return dict(failure=repr(e))
