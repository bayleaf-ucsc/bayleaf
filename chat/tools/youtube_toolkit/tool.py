import os
import requests
from datetime import datetime
from pydantic import BaseModel, Field

from youtube_transcript_api import YouTubeTranscriptApi

template = """uv run --with youtube-transcript-api youtube_transcript_api VIDEO_ID_GOES_HERE --format webvtt"""


class Tools:
    def fetch_youtube_video_transcript(self, video_id: str):
        return dict(
            message="The YouTube API is not accessible from this server, but the user can fetch the transcript using their own device and paste the results back into the conversation. Instruct the user to run the shell script below (with the video_id helpfully inlined into the script for them).",
            template=template,
        )
