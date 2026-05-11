"""
title: Web Context Toolkit
author: Adam Smith (BayLeaf), based on Tavily Search Tool by victor1203
description: Search the web and extract clean page content via the Tavily API.
required_open_webui_version: 0.4.0
requirements: tavily-python
version: 1.0.0
licence: MIT
"""

from pydantic import BaseModel, Field
from typing import Literal, Union

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
        extract_depth: str = Field(
            "basic",
            description="Extract depth - basic (faster, cheaper) or advanced (more complete, includes tables and embedded content)",
        )

    def _get_client(self) -> TavilyClient:
        if self._client is None:
            self._client = TavilyClient(api_key=self.valves.tavily_api_key)
        return self._client

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

            client = self._get_client()

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

    async def extract(
        self,
        urls: Union[str, list[str]],
        format: Literal["markdown", "text"] = "markdown",
        __event_emitter__=None,
    ) -> str:
        """
        Extract clean content from one or more web pages using Tavily Extract.

        Pass a single URL string for one page, or a list of URLs (up to 20)
        to fetch many pages in a single call. Returns a formatted string with
        each page's content separated by clear delimiters, plus a list of any
        URLs that failed.

        Args:
            urls: A URL string, or a list of URL strings (up to 20)
            format: Output format for page content - "markdown" (default) or "text"

        Returns:
            A formatted string containing the extracted page content
        """
        try:
            if not self.valves.tavily_api_key:
                return "Error: Tavily API key not configured. Please set up the API key in the tool settings."

            # Normalize: accept a single URL or a list
            url_list = [urls] if isinstance(urls, str) else list(urls)

            if not url_list:
                return "Error: No URLs provided."

            if len(url_list) > 20:
                return f"Error: Tavily Extract accepts at most 20 URLs per call (got {len(url_list)})."

            n = len(url_list)
            label = "page" if n == 1 else f"{n} pages"

            if __event_emitter__:
                await __event_emitter__(
                    {
                        "type": "status",
                        "data": {
                            "description": f"Extracting content from {label}...",
                            "done": False,
                        },
                    }
                )

            client = self._get_client()

            # tavily-python's extract() accepts str or list[str] directly.
            result = client.extract(
                urls=url_list,
                extract_depth=self.valves.extract_depth,
                format=format,
            )

            results = result.get("results", []) or []
            failed = result.get("failed_results", []) or []

            # Format the response. For one URL, return just the content (with
            # a small header). For many URLs, separate them with clear delimiters
            # so the LLM can attribute claims to specific sources.
            parts: list[str] = []

            if n == 1 and len(results) == 1:
                hit = results[0]
                parts.append(f"# {hit.get('url', url_list[0])}\n\n{hit.get('raw_content', '')}")
            else:
                for i, hit in enumerate(results, 1):
                    parts.append(
                        f"--- Source {i}: {hit.get('url', '')} ---\n\n"
                        f"{hit.get('raw_content', '')}"
                    )

            if failed:
                fail_lines = [
                    f"- {f.get('url', '?')}: {f.get('error', 'unknown error')}"
                    for f in failed
                ]
                parts.append("Failed to extract:\n" + "\n".join(fail_lines))

            formatted_results = "\n\n".join(parts) if parts else "No content extracted."

            if __event_emitter__:
                ok = len(results)
                bad = len(failed)
                summary = f"Extracted {ok}/{n} page{'s' if n != 1 else ''}"
                if bad:
                    summary += f" ({bad} failed)"
                await __event_emitter__(
                    {
                        "type": "status",
                        "data": {"description": summary, "done": True},
                    }
                )

            return formatted_results

        except Exception as e:
            error_message = f"An error occurred while extracting page content: {str(e)}"
            if __event_emitter__:
                await __event_emitter__(
                    {
                        "type": "status",
                        "data": {"description": error_message, "done": True},
                    }
                )
            return error_message
