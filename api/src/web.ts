/**
 * Web Search & Fetch Provider Clients
 *
 * Stateless helpers for web search and page content fetching, both backed by
 * Tavily. Mirrors the pattern of daytona.ts — all functions take env bindings
 * as a parameter and use provider API keys from Bindings.
 *
 * The API contract is provider-agnostic: Tavily could be swapped for Exa or
 * another provider without changing the route schemas.
 */

import type { Bindings } from './types';

// ── Types ──────────────────────────────────────────────────────────

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
  answer?: string;
}

export interface WebFetchResult {
  url: string;
  content: string;
}

export interface WebFetchFailure {
  url: string;
  error: string;
}

export interface WebFetchResponse {
  results: WebFetchResult[];
  failed_results?: WebFetchFailure[];
}

// ── Web Search (Tavily) ────────────────────────────────────────────

/**
 * Search the web using the Tavily Search API.
 *
 * @param query   Search query string
 * @param maxResults  Maximum number of results (1–20, default 5)
 * @param env     Worker bindings (must contain TAVILY_API_KEY)
 */
export async function searchWeb(
  query: string,
  maxResults: number,
  env: Bindings,
): Promise<WebSearchResponse> {
  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY,
      query,
      max_results: maxResults,
      include_answer: true,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Tavily search failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }

  const data = await resp.json() as {
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
    }>;
    answer?: string;
  };

  const results: WebSearchResult[] = (data.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }));

  return {
    results,
    answer: data.answer,
  };
}

// ── Web Fetch (Tavily Extract) ─────────────────────────────────────

/**
 * Fetch and extract clean content from one or more web pages using Tavily Extract.
 *
 * Accepts a single URL string or an array of URLs (up to 20). Returns
 * successfully-extracted pages in `results`, plus any failed URLs in
 * `failed_results`.
 *
 * @param urls    A URL or array of URLs to fetch
 * @param format  Response format: 'markdown' or 'text'
 * @param env     Worker bindings (must contain TAVILY_API_KEY)
 */
export async function fetchPage(
  urls: string | string[],
  format: string,
  env: Bindings,
): Promise<WebFetchResponse> {
  const urlList = typeof urls === 'string' ? [urls] : urls;
  const tavilyFormat = format === 'text' ? 'text' : 'markdown';

  const resp = await fetch('https://api.tavily.com/extract', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      urls: urlList,
      format: tavilyFormat,
      extract_depth: 'basic',
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Tavily extract failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }

  const data = await resp.json() as {
    results?: Array<{ url?: string; raw_content?: string }>;
    failed_results?: Array<{ url?: string; error?: string }>;
  };

  const results: WebFetchResult[] = (data.results ?? []).map((r) => ({
    url: r.url ?? '',
    content: r.raw_content ?? '',
  }));

  const failed_results: WebFetchFailure[] = (data.failed_results ?? []).map((f) => ({
    url: f.url ?? '',
    error: f.error ?? 'unknown error',
  }));

  return failed_results.length > 0
    ? { results, failed_results }
    : { results };
}
