from pydantic import BaseModel, Field
from typing import Optional

# This filter limits the cost of conversations in a soft manner.
# Rather than, say, clipping conversations after 10 rounds, it gradually
# reduces the number of tokens allowed in the assistant reply by half
# after each round. Deeper conversations become more laborious for the user.


class Filter:

    class Valves(BaseModel):
        initial_token_budget: Optional[int] = Field(
            default=16384,
            description="Maximum number of tokens to allow in the assistant reply (reducing by half for each additional user message in the conversation)",
        )

    def __init__(self):
        self.valves = self.Valves()

    def inlet(self, body: dict) -> dict:
        depth = len([m for m in body["messages"] if m["role"] == "user"])
        body["max_tokens"] = self.valves.initial_token_budget // depth
        return body
