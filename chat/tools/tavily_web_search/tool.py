"""
title: Tavily Search Tool
author: victor1203
description: This tool performs internet searches using the Tavily API to get real-time information with advanced context and Q&A capabilities
required_open_webui_version: 0.4.0
requirements: tavily-python
version: 1.0.0
licence: MIT
"""

from pydantic import BaseModel, Field
from typing import Optional, Literal
from tavily import TavilyClient


class Tools:
    def __init__(self):
        """Initialize the Tool with valves."""
        self.valves = self.Valves()
        self._client = None

    class Valves(BaseModel):
        tavily_api_key: str = Field(
            "", description="Your Tavily API key (starts with 'tvly-')"
        )
        search_depth: str = Field(
            "basic", description="Search depth - basic or advanced"
        )
        include_answer: bool = Field(
            True, description="Include an AI-generated answer in the response"
        )
        max_results: int = Field(
            5, description="Maximum number of search results to return (1-10)"
        )

    async def search(
        self,
        query: str,
        search_type: Literal["regular", "context", "qa"] = "regular",
        __event_emitter__=None,
    ) -> str:
        """
        Perform a Tavily search and return the results.

        Args:
            query: The search query string
            search_type: Type of search to perform:
                - regular: Standard search with full results
                - context: Optimized for RAG applications
                - qa: Quick answer to a specific question

        Returns:
            A formatted string containing the search results
        """
        try:
            # Input validation
            if not self.valves.tavily_api_key:
                return "Error: Tavily API key not configured. Please set up the API key in the tool settings."

            # Emit status that search is starting
            if __event_emitter__:
                await __event_emitter__(
                    {
                        "type": "status",
                        "data": {
                            "description": f"Initiating Tavily {search_type} search...",
                            "done": False,
                        },
                    }
                )

            if self._client is None:
                self._client = TavilyClient(api_key=self.valves.tavily_api_key)
            client = self._client

            # Perform the search based on type
            if search_type == "context":
                if __event_emitter__:
                    await __event_emitter__(
                        {
                            "type": "status",
                            "data": {
                                "description": "Generating search context...",
                                "done": False,
                            },
                        }
                    )
                result = client.get_search_context(query=query)
                formatted_results = f"Search Context:\n\n{result}"

            elif search_type == "qa":
                if __event_emitter__:
                    await __event_emitter__(
                        {
                            "type": "status",
                            "data": {"description": "Finding answer...", "done": False},
                        }
                    )
                result = client.qna_search(query=query)
                formatted_results = f"Answer:\n\n{result}"

            else:  # regular search
                if __event_emitter__:
                    await __event_emitter__(
                        {
                            "type": "status",
                            "data": {
                                "description": "Fetching search results...",
                                "done": False,
                            },
                        }
                    )
                result = client.search(
                    query=query,
                    search_depth=self.valves.search_depth,
                    include_answer=self.valves.include_answer,
                    max_results=self.valves.max_results,
                )

                # Format regular search results
                formatted_results = ""

                # Include AI answer if available
                if self.valves.include_answer and "answer" in result:
                    formatted_results += f"AI Answer:\n{result['answer']}\n\n"

                # Add search results
                formatted_results += "Search Results:\n\n"
                for i, item in enumerate(
                    result.get("results", [])[: self.valves.max_results], 1
                ):
                    formatted_results += f"{i}. {item.get('title', 'No title')}\n"
                    formatted_results += f"URL: {item.get('url', 'No URL')}\n"
                    if "snippet" in item:
                        formatted_results += f"Description: {item['snippet']}\n"
                    formatted_results += "\n"

            if __event_emitter__:
                await __event_emitter__(
                    {
                        "type": "status",
                        "data": {
                            "description": "Search completed successfully",
                            "done": True,
                        },
                    }
                )

            return formatted_results

        except Exception as e:
            error_message = f"An error occurred while performing the search: {str(e)}"
            if __event_emitter__:
                await __event_emitter__(
                    {
                        "type": "status",
                        "data": {"description": error_message, "done": True},
                    }
                )
            return error_message
