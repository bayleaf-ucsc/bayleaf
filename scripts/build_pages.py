#!/usr/bin/env python3
"""Build the GitHub Pages artifact from landing/ and public data sources."""

from __future__ import annotations

import argparse
import html
import json
from datetime import UTC
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
import re
import shutil
import sys
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


BLOG_FEED = "https://blog.bayleaf.dev/feed"
POSTS_START = "<!-- recent-posts:start -->"
POSTS_END = "<!-- recent-posts:end -->"
MODELS_START = "<!-- current-models:start -->"
MODELS_END = "<!-- current-models:end -->"
REPO_URL = "https://github.com/bayleaf-ucsc/bayleaf/blob/main/"


class TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def plain_text(value: str) -> str:
    parser = TextExtractor()
    parser.feed(value)
    return " ".join("".join(parser.parts).split())


def fetch_recent_posts(feed_url: str, limit: int) -> list[dict[str, str]]:
    request = Request(feed_url, headers={"User-Agent": "BayLeaf-Pages-Builder/1.0"})
    with urlopen(request, timeout=30) as response:
        root = ET.fromstring(response.read())

    posts: list[dict[str, str]] = []
    for item in root.findall("./channel/item")[:limit]:
        title = plain_text(item.findtext("title", ""))
        description = plain_text(item.findtext("description", ""))
        link = item.findtext("link", "").strip()
        published = parsedate_to_datetime(item.findtext("pubDate", ""))
        if published.tzinfo is None:
            published = published.replace(tzinfo=UTC)

        parsed_link = urlparse(link)
        if not title or parsed_link.scheme != "https" or parsed_link.hostname != "blog.bayleaf.dev":
            raise ValueError(f"Invalid blog post in feed: {title!r} {link!r}")

        posts.append(
            {
                "title": title,
                "description": description,
                "link": link,
                "date": published.date().isoformat(),
                "date_label": published.strftime("%b %d, %Y").replace(" 0", " "),
            }
        )

    if len(posts) != limit:
        raise ValueError(f"Expected {limit} blog posts, found {len(posts)}")
    return posts


def render_recent_posts(posts: list[dict[str, str]]) -> str:
    lines = ['        <ol class="recent-posts">']
    for post in posts:
        title = html.escape(post["title"])
        description = html.escape(post["description"])
        link = html.escape(post["link"], quote=True)
        date = html.escape(post["date"], quote=True)
        date_label = html.escape(post["date_label"])
        lines.extend(
            [
                '            <li class="recent-post">',
                '                <span class="recent-post__entry">',
                f'                    <a class="recent-post__title" href="{link}">{title}</a>',
                f'                    <span class="recent-post__description">{description}</span>',
                "                </span>",
                f'                <time datetime="{date}">{date_label}</time>',
                "            </li>",
            ]
        )
    lines.append("        </ol>")
    return "\n".join(lines)


def replace_section(index_path: Path, start_marker: str, end_marker: str, content: str) -> None:
    document = index_path.read_text(encoding="utf-8")
    if document.count(start_marker) != 1 or document.count(end_marker) != 1:
        raise ValueError(f"index.html must contain one {start_marker} marker pair")

    start = document.index(start_marker) + len(start_marker)
    end = document.index(end_marker, start)
    generated = "\n" + content + "\n        "
    index_path.write_text(document[:start] + generated + document[end:], encoding="utf-8")


def model_link(identifier: str, prefix: str, config_path: str) -> str:
    if not isinstance(identifier, str) or not identifier.strip():
        raise ValueError(f"Missing model identifier in {config_path}")
    if identifier.startswith(prefix) and identifier[len(prefix):]:
        slug = identifier[len(prefix):]
        url = "https://openrouter.ai/" + quote(slug, safe="/")
        label = slug
    else:
        url = REPO_URL + config_path
        label = identifier
    return f'<a href="{html.escape(url, quote=True)}"><code>{html.escape(label)}</code></a>'


def render_current_models(repo: Path) -> str:
    chat_path = "chat/models/basic/model.json"
    api_path = "api/wrangler.jsonc"
    basic = json.loads((repo / chat_path).read_text(encoding="utf-8"))["base_model_id"]
    # Extract only this string-valued setting, not the whole JSONC document.
    # Anchoring to a line excludes commented-out settings; JSON handles string escapes.
    matches = re.findall(
        r'^\s*"RECOMMENDED_MODEL"\s*:\s*("(?:[^"\\]|\\.)*")\s*[,}]',
        (repo / api_path).read_text(encoding="utf-8"),
        flags=re.MULTILINE,
    )
    if len(matches) != 1:
        raise ValueError("Expected exactly one RECOMMENDED_MODEL setting in api/wrangler.jsonc")
    recommended = json.loads(matches[0])
    return "\n".join([
        "                <p>",
        f'                    BayLeaf Chat’s Basic agent uses {model_link(basic, "openrouter.", chat_path)}.',
        f'                    The BayLeaf API recommends {model_link(recommended, "openrouter:", api_path)}',
        "                    for standard inference. These are the configured selections, not a list",
        "                    of every model available through BayLeaf.",
        "                </p>",
        "                <p>",
        "                    This precise model selection information is generated from the repository’s",
        "                    configuration files and refreshed daily, as well as when site changes are",
        "                    published. OpenRouter links lead to its authoritative model information;",
        "                    other identifiers link to their BayLeaf configuration files.",
        "                </p>",
    ])


def build(source: Path, output: Path, feed_url: str, post_count: int) -> None:
    source = source.resolve()
    output = output.resolve()
    if source == output or source in output.parents or output in source.parents:
        raise ValueError("Output directory must not contain or overwrite the source")

    if output.exists():
        shutil.rmtree(output)
    shutil.copytree(source, output)
    replace_section(output / "index.html", POSTS_START, POSTS_END,
                    render_recent_posts(fetch_recent_posts(feed_url, post_count)))
    replace_section(output / "index.html", MODELS_START, MODELS_END,
                    render_current_models(source.parent))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path("landing"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--feed", default=BLOG_FEED)
    parser.add_argument("--post-count", type=int, default=5)
    args = parser.parse_args()

    try:
        build(args.source, args.output, args.feed, args.post_count)
    except (OSError, ValueError, KeyError, ET.ParseError) as error:
        print(f"Pages build failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
