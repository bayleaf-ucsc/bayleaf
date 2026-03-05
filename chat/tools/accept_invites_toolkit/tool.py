import re
import os
import jwt
import requests
from pydantic import BaseModel, Field

from open_webui.env import WEBUI_SECRET_KEY
from open_webui.models.groups import Groups

from datetime import datetime, timezone

SESSION_SECRET = WEBUI_SECRET_KEY
ALGORITHM = "HS256"

from typing import Optional


def duration_to_seconds(duration: str) -> int:
    """
    Convert shorthand duration strings to seconds.
    Examples: "1y", "6mo", "30d", "12h", "45m", "90s"
    """
    unit_to_seconds = {
        "s": 1,
        "m": 60,
        "h": 3600,
        "d": 86400,
        "w": 86400 * 7,
        "mo": 86400 * 30,  # Approximate month (30 days)
        "y": 86400 * 365,  # Approximate year (365 days)
    }

    match = re.match(r"^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$", duration.strip())
    if not match:
        raise ValueError(f"Invalid duration format: {duration}")

    amount_str, unit = match.groups()
    amount = float(amount_str)
    unit_key = unit.lower()

    if unit_key not in unit_to_seconds:
        valid_units = ", ".join(unit_to_seconds.keys())
        raise ValueError(f"Unknown unit: {unit}. Valid units: {valid_units}")

    total_seconds = int(amount * unit_to_seconds[unit_key])
    return total_seconds


class Tools:

    async def accept_invite(
        self, invite_key: Optional[str] = None, __user__: dict = {}, __event_call__=None
    ):
        """
        Accept a group invitation using an invite key that starts with 'invite-' follows with a JWT. Users sometimes paste the code with _italic_ or *bold* formatting, but you should strip that when submitting the code. If the invite key is not already known from context, calling this tool without invite_key will offer the user a dialog box where they can provide it interactively without serializing it into the conversation history. This interactive input mode is preferred because LLMs sometimes make mistakes when copying detailed texts like keys.
        """

        if not invite_key:
            invite_key = await __event_call__(
                {
                    "type": "input",
                    "data": {
                        "title": "Invite key?",
                        "message": f"Provide your invite key.",
                        "placeholder": "invite-...",
                    },
                }
            )

        invite = jwt.decode(
            invite_key.removeprefix("invite-"),
            SESSION_SECRET,
            algorithms=[ALGORITHM],
        )

        if "eml" in invite:
            if __user__["email"] != invite["eml"]:
                raise ValueError(
                    "This invite key is incompatible with your email address."
                )
        group = Groups.get_group_by_id(invite["grp"])
        if not group:
            raise ValueError("The group associated with this invite does not exist.")

        confirmed = await __event_call__(
            {
                "type": "confirmation",
                "data": {
                    "title": "Join group?",
                    "message": f"Group: {group.name}\n\nDescription: {group.description}\n\n**Are you sure you want to accept this invite?**",
                },
            }
        )
        if confirmed:
            res = Groups.add_users_to_group(group.id, [__user__["id"]])
            if res:
                return f"Successfully added user to group: {group.name}. Users should now start a *fresh* conversation rather than switching to any newly-available models in the middle of this conversation about invite codes."
            else:
                return "Unknown failure when adding user to group."
        else:
            return "User declined to accept invite."

    def create_invite(
        self,
        group_name: str,
        expiry_delta: str = "30d",
        restrict_email: Optional[str] = None,
        __user__: dict = {},
    ):
        """
        Yields an 'invite-' style invite code to join the given group by name (the name of often also a URL).
        expiry_delta is a phrase like "1y", "6mo", "30d", "12h", "45m", "90s" for how long the invite code stays valid. 30 days is a good default duration.
        restrict_email optional makes an invite only usable by one user (otherwise all users, default)
        """
        if __user__["role"] != "admin":
            raise ValueError("Only admins can create invites.")

        invite = {}

        group_uuid = None
        for g in Groups.get_groups(filter=None):
            if g.name == group_name:
                group_uuid = g.id
                break
        else:
            raise ValueError("Group not found.")

        invite["grp"] = group_uuid
        invite["exp"] = int(
            datetime.now(tz=timezone.utc).timestamp()
        ) + duration_to_seconds(expiry_delta)
        if restrict_email:
            invite["eml"] = restrict_email

        key = jwt.encode(invite, SESSION_SECRET, ALGORITHM)
        return "invite-" + key
