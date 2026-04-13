"""
title: Help
author: Adam Smith
description: Help users understand their group memberships, available models, and manage invite codes.
version: 0.1.0
"""

import re
import jwt
from pydantic import BaseModel, Field

from open_webui.env import WEBUI_SECRET_KEY
from open_webui.models.groups import Groups
from open_webui.models.models import Models
from open_webui.models.access_grants import AccessGrants

from datetime import datetime, timezone
from typing import Optional

ALGORITHM = "HS256"


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


class Valves(BaseModel):
    INVITE_SIGNING_KEY: str = Field(
        default="",
        description="Secret key for signing/verifying invite JWTs. If empty, falls back to WEBUI_SECRET_KEY.",
    )


class Tools:

    def __init__(self):
        self.valves = Valves()

    @property
    def _signing_key(self) -> str:
        return self.valves.INVITE_SIGNING_KEY or WEBUI_SECRET_KEY

    # ── Informational ───────────────────────────────────────────────

    def list_my_groups(self, __user__: dict = {}):
        """
        List all groups the current user belongs to, with descriptions.
        Useful when a user asks "what groups am I in?" or wants to understand their access level.
        """
        user_groups = Groups.get_groups_by_member_id(__user__["id"])
        if not user_groups:
            return "You are not a member of any groups."

        lines = []
        for g in user_groups:
            desc = f": {g.description}" if g.description else ""
            lines.append(f"- **{g.name}**{desc}")
        return f"You belong to {len(user_groups)} group(s):\n\n" + "\n".join(lines)

    def list_available_models(self, __user__: dict = {}):
        """
        List all models the current user can access, grouped by the reason they have access (public, group membership, or direct grant).
        Useful when a user asks "what models can I use?" or "why can't I find a model?".
        """
        accessible = Models.get_models_by_user_id(__user__["id"], permission="read")
        if not accessible:
            return "You don't currently have access to any models."

        # Categorize each model by how the user got access
        user_groups = Groups.get_groups_by_member_id(__user__["id"])
        group_names = {g.id: g.name for g in user_groups}
        user_group_ids = set(group_names.keys())

        public_models = []
        by_group = {}  # group_name -> [model_name]
        direct_models = []

        for m in accessible:
            display = m.name or m.id
            grants = AccessGrants.get_grants_by_resource("model", m.id)
            read_grants = [g for g in grants if g.permission == "read"]

            is_public = any(g.principal_id == "*" for g in read_grants)
            if is_public:
                public_models.append(display)
                continue

            # Check group grants the user benefits from
            matched = False
            for g in read_grants:
                if g.principal_type == "group" and g.principal_id in user_group_ids:
                    name = group_names[g.principal_id]
                    by_group.setdefault(name, []).append(display)
                    matched = True
                    break  # attribute to first matching group
            if not matched:
                direct_models.append(display)

        lines = []
        if public_models:
            lines.append("**Available to everyone:**")
            for name in sorted(public_models):
                lines.append(f"- {name}")
        for gname in sorted(by_group):
            lines.append(f"\n**Via group {gname}:**")
            for name in sorted(by_group[gname]):
                lines.append(f"- {name}")
        if direct_models:
            lines.append("\n**Direct access:**")
            for name in sorted(direct_models):
                lines.append(f"- {name}")

        return f"You have access to {len(accessible)} model(s):\n\n" + "\n".join(lines)

    # ── Invite management ───────────────────────────────────────────

    async def accept_invite(
        self, invite_key: Optional[str] = None, __user__: dict = {}, __event_call__=None
    ):
        """
        Accept a group invitation using an invite key that starts with 'invite-' followed by a JWT. Users sometimes paste the code with _italic_ or *bold* formatting, but you should strip that when submitting the code. If the invite key is not already known from context, calling this tool without invite_key will offer the user a dialog box where they can provide it interactively without serializing it into the conversation history. This interactive input mode is preferred because LLMs sometimes make mistakes when copying detailed texts like keys.
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
            self._signing_key,
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
        Yields an 'invite-' style invite code to join the given group by name (the name is often also a URL).
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

        key = jwt.encode(invite, self._signing_key, ALGORITHM)
        return "invite-" + key
