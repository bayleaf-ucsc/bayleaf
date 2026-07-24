#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow"]
# ///
"""
Generate the Open Graph share card for bayleaf.dev.

    ./docs/images/make-og-card.py

Writes docs/images/og-card.png at 1200x630 (the size Slack, Discord, Canvas,
Mastodon, and Bluesky all render as a large summary image).

Design notes:
  - The mark is chat/models/basic/profile.png, the BayLeaf logo (bay leaf plus
    banana slug). It lived only as an Open WebUI model avatar until this card
    started reusing it; treat that file as the canonical source art.
  - Colors track docs/style.css: #2a5298 headings, #555 secondary text. If the
    site palette changes, change them here too. There is no shared token file
    yet (see the site-wide palette question in AGENTS.md).
  - Fonts are macOS system faces resolved by path. On another platform, point
    TITLE_FONT/BODY_FONT at any available bold/regular pair; the layout is
    measured, not hardcoded, so substitutions reflow cleanly.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent

LOGO = REPO / "chat" / "models" / "basic" / "profile.png"
OUT = HERE / "og-card.png"

W, H = 1200, 630
BG = "#ffffff"
INK = "#1a1a1a"
ACCENT = "#2a5298"
MUTED = "#555555"

TITLE_FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
BODY_FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"

TITLE = "BayLeaf AI Playground"
TAGLINE = "A situated counterplatform for\nGenerative AI at UC Santa Cruz"
FOOTER = "bayleaf.dev"


def main() -> None:
    card = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(card)

    # Accent rule along the top edge: cheap way to make the card read as
    # deliberate rather than as a default screenshot.
    draw.rectangle([0, 0, W, 12], fill=ACCENT)

    logo_size = 300
    logo = Image.open(LOGO).convert("RGBA").resize(
        (logo_size, logo_size), Image.LANCZOS
    )
    logo_x, logo_y = 90, (H - logo_size) // 2 - 10
    card.paste(logo, (logo_x, logo_y), logo)

    text_x = logo_x + logo_size + 70
    title_font = ImageFont.truetype(TITLE_FONT, 62)
    body_font = ImageFont.truetype(BODY_FONT, 34)
    footer_font = ImageFont.truetype(BODY_FONT, 28)

    # Measure the block so it stays optically centered against the logo
    # regardless of font substitution or copy edits.
    title_h = draw.textbbox((0, 0), TITLE, font=title_font)[3]
    tagline_h = draw.textbbox((0, 0), TAGLINE, font=body_font, spacing=12)[3]
    block_h = title_h + 34 + tagline_h
    y = (H - block_h) // 2 - 10

    draw.text((text_x, y), TITLE, font=title_font, fill=INK)
    draw.text((text_x, y + title_h + 34), TAGLINE, font=body_font,
              fill=MUTED, spacing=12)
    draw.text((text_x, H - 100), FOOTER, font=footer_font, fill=ACCENT)

    card.save(OUT, optimize=True)
    print(f"wrote {OUT.relative_to(REPO)} ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
