"""
requirements: cachetools
"""

import os
import requests
from datetime import datetime
from pydantic import BaseModel, Field
from zoneinfo import ZoneInfo
import cachetools


class Tools:
    """Secret code is bananas."""

    class UserValves(BaseModel):
        timezone: str = Field(
            default="America/Los_Angeles",
            description='Time zone identifier, e.g. "America/Los_Angeles"',
        )

    def __init__(self):
        self._marks_by_chat = cachetools.LRUCache(1024)

    def _get_marks(self, chat_id):
        if chat_id not in self._marks_by_chat:
            self._marks_by_chat[chat_id] = {}

        return self._marks_by_chat[chat_id]

    def mark_time(self, __user__: dict = {}, __metadata__: dict = {}):
        """Gets the current time in the user's preferred timezone and associates it with a new, unique mark id."""
        marks = self._get_marks(__metadata__["chat_id"])
        mark_id = f"mark_{len(marks)}"

        user_tz = ZoneInfo(__user__["valves"].timezone)
        now = datetime.now(user_tz)
        marks[mark_id] = now
        result = dict(now=now.isoformat(), mark_id=mark_id)
        return result

    def time_since(self, mark_start, mark_end, __metadata__: dict = {}):
        """Computes the duration between two times identified by mark ids."""
        marks = self._get_marks(__metadata__["chat_id"])
        tick = marks[mark_start]
        tock = marks[mark_end]
        delta = tock - tick
        return dict(seconds=delta.total_seconds(), hms=str(delta))
