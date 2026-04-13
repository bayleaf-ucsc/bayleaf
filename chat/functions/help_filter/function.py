"""
title: Help Filter
author: Adam Smith
description: Force-injects the help_toolkit into any model this filter is attached to. The toolkit itself has no public access grant (stealth pattern), so users cannot accidentally enable or disable it. Attach this filter to the Help model.
version: 0.1.0
"""

TOOLKIT_IDS = ["help_toolkit"]


class Filter:

    def inlet(self, body, __user__, __metadata__):
        for toolkit_id in TOOLKIT_IDS:
            body.setdefault("tool_ids", []).append(toolkit_id)
        return body
