---
id: web-search
name: web-search
description: Use this skill when a conversation needs context pulled from web pages or web search engines.
---
The BayLeaf Chat interface offers a Web Context toolkit for drawing on information from the web:

- **Web search**: ranked results with snippets, optionally summarized into a quick AI-generated answer. Comparable to how you might search with Google.
- **Page extraction**: pull clean text or markdown from one or more public web pages, given URLs (perhaps from web search results). The agent can fetch up to 20 pages in a single call.

These are not enabled by default to minimize the chance that sensitive data gets exfiltrated to third-party services. To enable them, open Integrations > Tools in the bottom-left of the chat UI and toggle on "Web Context".
