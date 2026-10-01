"""Offline checks for the generated model-selection FAQ."""

import json
from pathlib import Path
import tempfile
import unittest

from build_pages import model_link, render_current_models, replace_section


class CurrentModelsTests(unittest.TestCase):
    def test_openrouter_prefixes(self):
        for prefix in ("openrouter.", "openrouter:"):
            self.assertEqual(
                model_link(prefix + "z-ai/glm-5.3-flash", prefix, "config"),
                '<a href="https://openrouter.ai/z-ai/glm-5.3-flash"><code>z-ai/glm-5.3-flash</code></a>',
            )

    def test_other_prefix_links_to_config_and_escapes_identifier(self):
        link = model_link('tinfoil:<model>&"', "openrouter:", "api/wrangler.jsonc")
        self.assertIn('href="https://github.com/bayleaf-ucsc/bayleaf/blob/main/api/wrangler.jsonc"', link)
        self.assertIn("<code>tinfoil:&lt;model&gt;&amp;&quot;</code>", link)

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
            rendered = render_current_models(repo)
            self.assertIn("https://openrouter.ai/owner/chat", rendered)
            self.assertIn("https://openrouter.ai/owner/api", rendered)
            self.assertIn("refreshed daily", rendered)
            api.write_text('{"vars": {}}')
            with self.assertRaises(ValueError):
                render_current_models(repo)

    def test_replacement_preserves_surrounding_html(self):
        with tempfile.TemporaryDirectory() as directory:
            index = Path(directory) / "index.html"
            index.write_text("before<!-- start -->fallback<!-- end -->after")
            replace_section(index, "<!-- start -->", "<!-- end -->", "generated")
            self.assertEqual(index.read_text(),
                             "before<!-- start -->\ngenerated\n        <!-- end -->after")
            with self.assertRaises(ValueError):
                replace_section(index, "missing", "<!-- end -->", "generated")


if __name__ == "__main__":
    unittest.main()
