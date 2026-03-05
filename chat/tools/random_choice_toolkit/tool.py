import os
import requests
from datetime import datetime
from pydantic import BaseModel, Field

import random
from typing import List


class Tools:
    def choice(
        self,
        purpose: str,
        options: List[str],
    ):
        """
        Make a choice from a list of options, sampled uniformly. Try to keep the options extremely compact for token efficiency.
        This is a good tool to use when we think the user will want to regenerate the assistant's replies to see highly varied responses.
        """
        return random.choice(options)
