#!/usr/bin/env python3
"""Generate the I.M.R brand logo at every size the app needs.

Outputs:
  assets/icon.png             1024x1024  Expo iOS app icon (rounded square)
  assets/adaptive-icon.png    1024x1024  Android adaptive (full-bleed, safe-zone)
  assets/favicon.png            32x32    Expo web auto-copies this to dist
  public/favicon.png            32x32    Static-host fallback (manifest)
  public/favicon-16.png         16x16    Old browser tabs
  public/icon-192.png          192x192   PWA standard install
  public/icon-512.png          512x512   PWA maskable install (Android shapes)
  public/apple-touch-icon.png  180x180   iOS Safari "Add to Home Screen"

Why each size is rendered NATIVELY (rather than downscaling a 1024 master):
  Pillow's freetype rendering tunes hinting per-size. Lanczos downscaling a
  big rasterized "I.M.R" produces mushy dots and unreadable letters at <=32px.
  Rendering at the target size lets the font engine pick the right hinting.

Sub-32px legibility:
  "I.M.R" is 5 glyphs (3 letters + 2 dots). At 32x32 each glyph gets ~3px,
  at 16x16 it's ~1.5px — illegible regardless of rendering technique. The
  generator falls back to a single bold "I" at <=32px so the favicon at
  least reads as a brand mark rather than a smudge.

Run:  python3 scripts/gen_logo.py
"""

from __future__ import annotations
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
BG = (26, 26, 24, 255)        # #1A1A18 — matches Colors.textPrimary
FG = (255, 255, 255, 255)
TEXT = "I.M.R"
TINY_TEXT = "I"

# macOS system Arial Black — installed by default. Falls back to bundled DejaVu
# if missing (the script will still run, just with slightly less weight).
ARIAL_BLACK = "/System/Library/Fonts/Supplemental/Arial Black.ttf"
DEJAVU = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"


def _load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in (ARIAL_BLACK, DEJAVU):
        try:
            return ImageFont.truetype(path, size=size)
        except OSError:
            continue
    raise SystemExit("No suitable font found — install Arial Black or Arial Bold.")


def _rounded_rect_mask(size: int, radius: int) -> Image.Image:
    """Alpha mask for a rounded square — used to clip the BG of non-maskable icons."""
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=radius, fill=255
    )
    return mask


def _fit_font_size(text: str, max_width: int, max_size: int) -> ImageFont.FreeTypeFont:
    """Pick the largest font size such that `text` width <= max_width."""
    # Binary-search-ish: start big and step down. Coarse is fine since we
    # only need ~5px granularity.
    size = max_size
    while size > 8:
        font = _load_font(size)
        bbox = font.getbbox(text)
        width = bbox[2] - bbox[0]
        if width <= max_width:
            return font
        size -= max(1, size // 20)
    return _load_font(8)


def render_full_imr(
    size: int,
    full_bleed: bool = False,
    radius_pct: float = 0.16,
    safe_zone_pct: float = 1.0,
) -> Image.Image:
    """Render the full "I.M.R" brand at `size`x`size`.

    full_bleed=True   → solid BG to the canvas edges (no rounded mask). Use
                        for Android adaptive + PWA maskable; the device or
                        OS applies its own clip.
    full_bleed=False  → rounded square (radius_pct of side, matches in-app
                        login logo's 16/64 ratio).
    safe_zone_pct=0.66 keeps the text inside the inner 66% of the canvas —
                        required for adaptive icons because Android's mask
                        clips up to 33% of each edge depending on shape.
    """
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background — full-bleed or rounded square
    if full_bleed:
        draw.rectangle((0, 0, size, size), fill=BG)
    else:
        radius = int(size * radius_pct)
        draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=BG)

    # Text fits inside the safe zone
    text_box = int(size * safe_zone_pct)
    # Aim for the text width ~80% of the safe zone so there's breathing room
    target_width = int(text_box * 0.80)
    font = _fit_font_size(TEXT, max_width=target_width, max_size=int(size * 0.6))
    bbox = font.getbbox(TEXT)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    # Center horizontally; vertically center using the bbox top so optical
    # alignment is right (font ascenders/descenders eat the bbox top).
    x = (size - tw) // 2 - bbox[0]
    y = (size - th) // 2 - bbox[1]
    draw.text((x, y), TEXT, fill=FG, font=font)
    return img


def render_tiny_initial(size: int) -> Image.Image:
    """Single bold 'I' rendering for <=32px sizes where I.M.R is illegible."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # No rounded corners at this size — the radius would be sub-pixel and
    # would just blur the edge. Solid fill reads cleaner on a tab strip.
    draw.rectangle((0, 0, size, size), fill=BG)
    # 'I' fills ~70% of the canvas height
    font = _fit_font_size(TINY_TEXT, max_width=int(size * 0.5), max_size=int(size * 0.85))
    bbox = font.getbbox(TINY_TEXT)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (size - tw) // 2 - bbox[0]
    y = (size - th) // 2 - bbox[1]
    draw.text((x, y), TINY_TEXT, fill=FG, font=font)
    return img


def main() -> None:
    public = REPO / "public"
    assets = REPO / "assets"
    public.mkdir(exist_ok=True)
    assets.mkdir(exist_ok=True)

    # Master + iOS app icon (rounded)
    render_full_imr(1024).save(assets / "icon.png")

    # Android adaptive — full-bleed, content inside 66% safe zone
    render_full_imr(1024, full_bleed=True, safe_zone_pct=0.66).save(
        assets / "adaptive-icon.png"
    )

    # PWA maskable 512 — full-bleed + safe zone (same recipe as adaptive)
    render_full_imr(512, full_bleed=True, safe_zone_pct=0.66).save(
        public / "icon-512.png"
    )

    # PWA standard 192 — rounded, normal text
    render_full_imr(192).save(public / "icon-192.png")

    # iOS Apple touch icon — rounded (iOS doesn't apply its own mask)
    render_full_imr(180).save(public / "apple-touch-icon.png")

    # Favicons — single 'I' fallback for legibility
    render_tiny_initial(32).save(assets / "favicon.png")
    render_tiny_initial(32).save(public / "favicon.png")
    render_tiny_initial(16).save(public / "favicon-16.png")

    print("Generated icons:")
    for p in sorted([
        assets / "icon.png",
        assets / "adaptive-icon.png",
        assets / "favicon.png",
        public / "favicon.png",
        public / "favicon-16.png",
        public / "icon-192.png",
        public / "icon-512.png",
        public / "apple-touch-icon.png",
    ]):
        print(f"  {p.relative_to(REPO)}")


if __name__ == "__main__":
    main()
