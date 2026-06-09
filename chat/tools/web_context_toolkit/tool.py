"""
title: Web Context Toolkit
author: Adam Smith (BayLeaf), based on Tavily Search Tool by victor1203 (https://github.com/victor1203)
description: Search the web and extract clean page content via the Tavily API. Batch + concurrent search returns compact, relevance-ranked summaries; extract returns bounded verbatim chunks by default. Async and non-blocking. Uses Tavily's zero-data-retention endpoints.
required_open_webui_version: 0.4.0
requirements: tavily-python
version: 3.1.0
licence: MIT
"""

import asyncio
import functools
from datetime import datetime
from pydantic import BaseModel, Field
from typing import Literal, List
from tavily import AsyncTavilyClient


def _tool(fn):
    """Wrap a tool coroutine: require an API key, and turn any exception into a
    returned error string (since this toolkit emits no status events, the return
    value is the only channel back to the model)."""

    @functools.wraps(fn)
    async def wrapper(self, *args, **kwargs):
        if not self.valves.tavily_api_key:
            return "Error: Tavily API key not configured. Set it in the tool settings."
        try:
            return await fn(self, *args, **kwargs)
        except Exception as e:
            return f"Error in {fn.__name__}: {e}"

    return wrapper


class Tools:
    def __init__(self):
        self.valves = self.Valves()
        self._client = None
        # OWUI reads each tool's docstring once at load time, so we stamp the
        # approximate current date in at instantiation. This nudges models with
        # stale knowledge cutoffs away from hardcoding old years into queries
        # (e.g. "react best practices 2024"). Month+year only: the docstring is
        # fixed at load, so day-level precision would be a false promise.
        self.search.__func__.__doc__ = self._SEARCH_DOC.replace(
            "{approx_date}", datetime.now().strftime("%B %Y")
        )

    class Valves(BaseModel):
        tavily_api_key: str = Field(
            "", description="Your Tavily API key (starts with 'tvly-')"
        )
        search_depth: Literal["basic", "advanced"] = Field(
            "basic",
            description="Search depth. 'basic' is faster (1 credit); 'advanced' is slower but more relevant (2 credits).",
        )
        max_results: int = Field(
            5, description="Maximum number of search results per query (1-20)."
        )
        extract_depth: Literal["basic", "advanced"] = Field(
            "basic",
            description="Extract depth. 'basic' is faster/cheaper; 'advanced' captures tables and embedded content with higher success but more latency.",
        )

    def _get_client(self) -> AsyncTavilyClient:
        # Reuse one client (and its httpx connection pool) across calls.
        if self._client is None:
            self._client = AsyncTavilyClient(api_key=self.valves.tavily_api_key)
        return self._client

    _SEARCH_DOC = """
        Run one or more Tavily web searches concurrently and return merged,
        deduplicated, relevance-ranked results. Pass a single query as a
        one-element array; pass several to run them all at once (much faster
        than searching one at a time).

        Approximate current date: {approx_date}. Do NOT hardcode older years
        into queries based on your training cutoff; only add a year when the
        user explicitly asks about a specific one.

        Each result gives a title, URL, relevance score, and a short summary,
        enough to decide which sources are worth reading. To read a page's
        actual text, follow up with extract() on the chosen URLs.

        Args:
            queries: A JSON array of 1-8 query strings, e.g. ["who is X", "X recent news"].
                Always pass a real array, never a bare string. For a single search,
                pass a one-element array: ["my query"].
        """

    @_tool
    async def search(self, queries: List[str]) -> str:
        """Placeholder; real docstring set in __init__ with the current date."""
        q_list = [q.strip() for q in (queries or []) if q and q.strip()]
        if not q_list:
            return "Error: no queries provided. Pass a non-empty JSON array."
        if len(q_list) > 8:
            return f"Error: pass at most 8 queries per call (got {len(q_list)})."

        client = self._get_client()
        responses = await asyncio.gather(
            *(
                client.search(
                    query=q,
                    search_depth=self.valves.search_depth,
                    include_answer=False,
                    max_results=self.valves.max_results,
                )
                for q in q_list
            ),
            return_exceptions=True,
        )

        results, errors = [], []
        for q, resp in zip(q_list, responses):
            if isinstance(resp, Exception):
                errors.append(f"- {q}: {resp}")
            else:
                results.extend(resp.get("results", []))

        seen, unique = set(), []
        for r in sorted(results, key=lambda x: x.get("score", 0), reverse=True):
            url = r.get("url")
            if url and url not in seen:
                seen.add(url)
                unique.append(r)

        lines = [f"Search results ({len(unique)} unique):", ""]
        for i, item in enumerate(unique, 1):
            lines.append(f"{i}. {item.get('title', 'No title')}")
            lines.append(f"URL: {item.get('url', 'No URL')}")
            if item.get("content"):
                lines.append(f"Summary: {item['content']}")
            lines.append("")
        if errors:
            lines.append("Failed queries:")
            lines.extend(errors)
        return "\n".join(lines)

    @_tool
    async def extract(
        self,
        urls: List[str],
        query: str = "",
        chunks_per_source: int = 3,
    ) -> str:
        """
        Read the content of one or more public web pages with Tavily Extract.
        Accepts up to 20 URLs in a single call. This is the deep-read step after
        a search.

        By default this returns only the top relevance-ranked verbatim excerpts
        (chunks, ~500 chars each, taken directly from the page, NOT re-summarized),
        which keeps results compact and avoids dumping huge pages into the chat.
        For a chunked read you should pass a query describing what you're after.

        To pull a page's FULL text instead, set chunks_per_source=0.

        Args:
            urls: A JSON array of 1-20 URL strings, e.g. ["https://a.com", "https://b.com"].
                Always pass a real array, never a single string. For one page,
                pass a one-element array: ["https://a.com"].
            query: What you're looking for on these pages. Used to rank the
                returned chunks by relevance. Strongly recommended; required for
                chunked mode to be meaningful.
            chunks_per_source: 1-5 top excerpts per page (default 3). Set to 0 to
                retrieve each page's full text instead (larger; only when needed).
        """
        url_list = list(urls or [])
        if not url_list:
            return "Error: no URLs provided. Pass a non-empty JSON array."
        if len(url_list) > 20:
            return f"Error: Tavily Extract accepts at most 20 URLs per call (got {len(url_list)})."

        kwargs = dict(urls=url_list, extract_depth=self.valves.extract_depth)
        # Chunked mode needs a query; without one we fall back to whole-page.
        if chunks_per_source and query.strip():
            kwargs["query"] = query.strip()
            kwargs["chunks_per_source"] = max(1, min(5, chunks_per_source))

        response = await self._get_client().extract(**kwargs)

        parts = [
            f"## {item.get('url', '(unknown URL)')}\n\n{item.get('raw_content', '') or ''}"
            for item in (response.get("results") or [])
        ]
        output = "\n\n---\n\n".join(parts) if parts else "No content extracted."

        failed = response.get("failed_results") or []
        if failed:
            output += "\n\n---\n\nFailed URLs:\n" + "\n".join(
                f"- {f.get('url', '?')}: {f.get('error', 'unknown error')}" for f in failed
            )
        return output
