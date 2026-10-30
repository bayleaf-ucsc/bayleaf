#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow"]
# ///
"""
Generate Pouch's app icons from the BayLeaf logo.

    ./pouch/icons/make-icons.py

Writes icon-192.png, icon-512.png (the logo on a rounded light tile),
maskable-512.png (full-bleed tile, logo inside the 80% safe zone, for Android's
adaptive shapes) and apple-touch-icon.png (180, opaque: iOS fills transparency
with black). build.mjs copies them into dist/icons/ and lists them in SHA256SUMS.

Source art: chat/models/basic/profile.png (250x250), the canonical BayLeaf mark
(see landing/images/make-og-card.py). Colors track pouch.html's light theme:
--bg #f7f9fa, --leaf-soft #e8f1ea. If those change, change them here too.
"""

from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
LOGO = HERE.parent.parent / "chat/models/basic/profile.png"
BG = (247, 249, 250, 255)
TILE = (232, 241, 234, 255)


def icon(size, *, logo_frac, rounded, opaque):
    img = Image.new("RGBA", (size, size), BG if opaque else (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    radius = round(size * 0.22) if rounded else 0
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=TILE)
    side = round(size * logo_frac)
    # The source is a round mark on an opaque white square: keep the circle.
    big = side * 4
    mark = Image.open(LOGO).convert("RGBA").resize((big, big), Image.LANCZOS)
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).ellipse((big * 0.005, big * 0.005, big * 0.995, big * 0.995), fill=255)
    mark.putalpha(mask)
    mark = mark.resize((side, side), Image.LANCZOS)
    img.alpha_composite(mark, ((size - side) // 2, (size - side) // 2))
    return img


def main():
    icon(192, logo_frac=0.8, rounded=True, opaque=False).save(HERE / "icon-192.png", optimize=True)
    icon(512, logo_frac=0.8, rounded=True, opaque=False).save(HERE / "icon-512.png", optimize=True)
    # Maskable: the platform crops to a circle or squircle, keeping the
    # central 80%, so the tile is full-bleed and the mark sits inside it.
    icon(512, logo_frac=0.62, rounded=False, opaque=True).save(HERE / "maskable-512.png", optimize=True)
    icon(180, logo_frac=0.78, rounded=False, opaque=True).convert("RGB").save(HERE / "apple-touch-icon.png", optimize=True)
    print("wrote", ", ".join(p.name for p in sorted(HERE.glob("*.png"))))


if __name__ == "__main__":
    main()
