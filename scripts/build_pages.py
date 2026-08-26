#!/usr/bin/env python3
"""Build the GitHub Pages artifact from docs/ and public data sources."""

from __future__ import annotations

import argparse
import html
from datetime import UTC
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
import shutil
import sys
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


BLOG_FEED = "https://blog.bayleaf.dev/feed"
POSTS_START = "<!-- recent-posts:start -->"
POSTS_END = "<!-- recent-posts:end -->"


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


def replace_recent_posts(index_path: Path, posts: list[dict[str, str]]) -> None:
    document = index_path.read_text(encoding="utf-8")
    if document.count(POSTS_START) != 1 or document.count(POSTS_END) != 1:
        raise ValueError("index.html must contain one recent-posts marker pair")

    start = document.index(POSTS_START) + len(POSTS_START)
    end = document.index(POSTS_END, start)
    generated = "\n" + render_recent_posts(posts) + "\n        "
    index_path.write_text(document[:start] + generated + document[end:], encoding="utf-8")


def build(source: Path, output: Path, feed_url: str, post_count: int) -> None:
    source = source.resolve()
    output = output.resolve()
    if source == output or source in output.parents or output in source.parents:
        raise ValueError("Output directory must not contain or overwrite the source")

    if output.exists():
        shutil.rmtree(output)
    shutil.copytree(source, output)
    replace_recent_posts(output / "index.html", fetch_recent_posts(feed_url, post_count))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path("docs"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--feed", default=BLOG_FEED)
    parser.add_argument("--post-count", type=int, default=5)
    args = parser.parse_args()

    try:
        build(args.source, args.output, args.feed, args.post_count)
    except (OSError, ValueError, ET.ParseError) as error:
        print(f"Pages build failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
