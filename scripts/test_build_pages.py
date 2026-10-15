"""Offline contracts for the generated Pages artifact."""

from html.parser import HTMLParser
import json
from pathlib import Path
import tempfile
import unittest

from build_pages import build, model_link, render_current_models, replace_section


class HTMLFacts(HTMLParser):
    """Read link destinations and labels without fixing their serialization."""

    def __init__(self, document):
        super().__init__()
        self.links = []
        self.link_code = []
        self.tags = []
        self.text = []
        self._link = None
        self._code = None
        self.feed(document)
        self.close()

    def handle_starttag(self, tag, attrs):
        self.tags.append(tag)
        if tag == "a":
            self._link = {"href": dict(attrs).get("href"), "text": ""}
            self.links.append(self._link)
        elif tag == "code" and self._link is not None:
            self._code = (len(self.links) - 1, [])

    def handle_endtag(self, tag):
        if tag == "code" and self._code is not None:
            index, text = self._code
            self.link_code.append((index, "".join(text)))
            self._code = None
        if tag == "a":
            self._link = None

    def handle_data(self, data):
        self.text.append(data)
        if self._link is not None:
            self._link["text"] += data
        if self._code is not None:
            self._code[1].append(data)


class CurrentModelsTests(unittest.TestCase):
    def test_openrouter_prefixes(self):
        for prefix in ("openrouter.", "openrouter:"):
            with self.subTest(prefix=prefix):
                parsed = HTMLFacts(model_link(prefix + "z-ai/glm-5.3-flash", prefix, "config"))
                self.assertEqual(parsed.links, [{
                    "href": "https://openrouter.ai/z-ai/glm-5.3-flash",
                    "text": "z-ai/glm-5.3-flash",
                }])
                self.assertEqual(parsed.link_code, [(0, "z-ai/glm-5.3-flash")])

    def test_other_prefix_links_to_config_and_escapes_identifier(self):
        parsed = HTMLFacts(model_link('tinfoil:<model>&"', "openrouter:", "api/wrangler.jsonc"))
        self.assertEqual(parsed.links, [{
            "href": "https://github.com/bayleaf-ucsc/bayleaf/blob/main/api/wrangler.jsonc",
            "text": 'tinfoil:<model>&"',
        }])
        self.assertEqual(parsed.link_code, [(0, 'tinfoil:<model>&"')])
        self.assertNotIn("model", parsed.tags, "identifier markup must be rendered as text")

    def test_openrouter_slug_is_url_encoded_and_displayed_as_text(self):
        parsed = HTMLFacts(model_link('openrouter:owner/<model>?x=1&y="', "openrouter:", "config"))
        self.assertEqual(parsed.links, [{
            "href": "https://openrouter.ai/owner/%3Cmodel%3E%3Fx%3D1%26y%3D%22",
            "text": 'owner/<model>?x=1&y="',
        }])
        self.assertNotIn("model", parsed.tags)

    def test_empty_identifier_fails(self):
        with self.assertRaises(ValueError):
            model_link("", "openrouter:", "config")

    def test_configuration_reading(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            chat = repo / "chat/models/basic/model.json"
            chat.parent.mkdir(parents=True)
            chat.write_text(json.dumps({"base_model_id": "openrouter.owner/chat"}))
            api = repo / "api/wrangler.jsonc"
            api.parent.mkdir()
            api.write_text('{\n // "RECOMMENDED_MODEL": "ignore",\n "vars": {\n'
                           ' "RECOMMENDED_MODEL": "openrouter:owner/api", // comment\n }\n}')
            parsed = HTMLFacts(render_current_models(repo))
            self.assertEqual(parsed.links, [
                {"href": "https://openrouter.ai/owner/chat", "text": "owner/chat"},
                {"href": "https://openrouter.ai/owner/api", "text": "owner/api"},
            ])
            self.assertRegex(" ".join(parsed.text), r"\b(?:refreshed|updated)\s+(?:daily|every day|once a day)\b")
            api.write_text('{"vars": {}}')
            with self.assertRaises(ValueError):
                render_current_models(repo)

    def test_replacement_preserves_surrounding_html(self):
        with tempfile.TemporaryDirectory() as directory:
            index = Path(directory) / "index.html"
            index.write_text("before<!-- start -->fallback<!-- end -->after")
            replace_section(index, "<!-- start -->", "<!-- end -->", "generated")
            before, _, rest = index.read_text().partition("<!-- start -->")
            generated, _, after = rest.partition("<!-- end -->")
            self.assertEqual(before, "before")
            self.assertEqual(after, "after")
            self.assertEqual(generated.strip(), "generated")
            self.assertEqual(index.read_text().count("<!-- start -->"), 1)
            self.assertEqual(index.read_text().count("<!-- end -->"), 1)
            with self.assertRaises(ValueError):
                replace_section(index, "missing", "<!-- end -->", "generated")


class BuildTests(unittest.TestCase):
    def test_offline_build_generates_both_sections_without_modifying_source(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repo"
            source = repo / "landing"
            source.mkdir(parents=True)
            document = (
                '<header>Keep this</header><!-- recent-posts:start -->old posts<!-- recent-posts:end -->'
                '<!-- current-models:start -->old models<!-- current-models:end --><footer>Keep that</footer>'
            )
            (source / "index.html").write_text(document)
            (source / "style.css").write_text("/* copied asset */")
            chat = repo / "chat/models/basic/model.json"
            chat.parent.mkdir(parents=True)
            chat.write_text(json.dumps({"base_model_id": "openrouter.owner/chat"}))
            api = repo / "api/wrangler.jsonc"
            api.parent.mkdir()
            api.write_text('{\n"vars": {\n"RECOMMENDED_MODEL": "openrouter:owner/api"\n}\n}')
            feed = Path(directory) / "feed.xml"
            feed.write_text('''<rss><channel><item>
                <title>A &amp; B</title>
                <description><![CDATA[<p>A description &amp; more</p>]]></description>
                <link>https://blog.bayleaf.dev/example</link>
                <pubDate>Wed, 14 Oct 2026 12:00:00 GMT</pubDate>
                </item></channel></rss>''')
            output = Path(directory) / "published"

            build(source, output, feed.as_uri(), 1)

            rendered = (output / "index.html").read_text()
            parsed = HTMLFacts(rendered)
            self.assertEqual(parsed.links, [
                {"href": "https://blog.bayleaf.dev/example", "text": "A & B"},
                {"href": "https://openrouter.ai/owner/chat", "text": "owner/chat"},
                {"href": "https://openrouter.ai/owner/api", "text": "owner/api"},
            ])
            self.assertIn("A description & more", "".join(parsed.text))
            self.assertIn("time", parsed.tags)
            self.assertNotIn("script", parsed.tags)
            self.assertTrue(rendered.startswith("<header>Keep this</header>"))
            self.assertTrue(rendered.endswith("<footer>Keep that</footer>"))
            self.assertNotIn("old posts", rendered)
            self.assertNotIn("old models", rendered)
            for marker in ("recent-posts:start", "recent-posts:end", "current-models:start", "current-models:end"):
                self.assertEqual(rendered.count("<!-- " + marker + " -->"), 1)
            self.assertEqual((output / "style.css").read_text(), "/* copied asset */")
            self.assertEqual((source / "index.html").read_text(), document)


if __name__ == "__main__":
    unittest.main()
