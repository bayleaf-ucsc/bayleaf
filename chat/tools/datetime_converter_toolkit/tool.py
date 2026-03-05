import os
import requests
from datetime import datetime
from pydantic import BaseModel, Field
import pytz
from datetime import datetime


class Tools:
    def __init__(self):
        pass

    def localize_iso_date(
        self, iso_date_str: str, timezone_str: str = "America/Los_Angeles"
    ):
        """
        Takes an ISO date string (e.g., '2025-09-29T23:00:00Z') and a timezone (e.g., 'America/Los_Angeles'),
        and returns the localized datetime string.
        """
        dt = datetime.fromisoformat(iso_date_str.replace("Z", "+00:00"))
        target_tz = pytz.timezone(timezone_str)
        localized_dt = dt.astimezone(target_tz)
        return localized_dt.strftime("%Y-%m-%d %H:%M:%S %Z")
