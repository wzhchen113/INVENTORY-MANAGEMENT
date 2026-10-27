#!/usr/bin/env python3
"""Generate the I.M.R brand logo at every size the app needs.

Outputs (grouped by --target; the default `all` writes both groups):

  native (spec 181 — the EAS iOS/Android build):
  assets/icon.png             1024x1024  App icon: full-bleed, OPAQUE (RGB, no
                                         alpha). iOS / the launcher applies its
                                         own rounding mask.
  assets/adaptive-icon.png    1024x1024  Android adaptive FOREGROUND: transparent
                                         background, mark inside the centered 66%
                                         safe zone. The background colour is
                                         app.json `android.adaptiveIcon.
                                         backgroundColor` (= BG below).
  assets/splash-icon.png      1024x1024  Splash mark: white I.M.R on transparent;
                                         the expo-splash-screen plugin paints BG.

  web (unchanged recipes):
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

Run:  python3 scripts/gen_logo.py [--target {all,native,web}]   (default: all)

Colour source of truth: `BG` below. app.json carries the literal hex (JSON
can't import a Python constant); a jest pin (src/lib/nativeAppConfig.spec181.
test.ts) parses BG out of this file and asserts app.json matches.
"""

from __future__ import annotations
import argparse
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
    transparent_bg: bool = False,
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
    transparent_bg=True skips the BG fill entirely (mark only, on a
                        transparent canvas) — for the Android adaptive
                        foreground and the splash image.
    """
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background — none, full-bleed, or rounded square
    if transparent_bg:
        pass
    elif full_bleed:
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


def generate_native(assets: Path) -> list[Path]:
    """Spec 181 — the EAS native build's icon, adaptive icon and splash."""
    out = [
        assets / "icon.png",
        assets / "adaptive-icon.png",
        assets / "splash-icon.png",
    ]
    # App icon — full-bleed and OPAQUE (no alpha channel): iOS rejects / shows
    # black for transparent icon pixels and applies its own rounding mask.
    render_full_imr(1024, full_bleed=True).convert("RGB").save(out[0])

    # Android adaptive FOREGROUND — transparent, mark inside the 66% safe zone.
    # The launcher composites it over android.adaptiveIcon.backgroundColor (BG).
    render_full_imr(
        1024, full_bleed=True, safe_zone_pct=0.66, transparent_bg=True
    ).save(out[1])

    # Splash mark — white I.M.R on transparent; expo-splash-screen paints BG.
    render_full_imr(1024, transparent_bg=True).save(out[2])
    return out


def generate_web(assets: Path, public: Path) -> list[Path]:
    """PWA / favicon set — recipes UNCHANGED from before spec 181."""
    # PWA maskable 512 — full-bleed + safe zone, BG-filled
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
    return [
        assets / "favicon.png",
        public / "favicon.png",
        public / "favicon-16.png",
        public / "icon-192.png",
        public / "icon-512.png",
        public / "apple-touch-icon.png",
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate the I.M.R logo set.")
    parser.add_argument(
        "--target",
        choices=("all", "native", "web"),
        default="all",
        help="native = app icon/adaptive/splash; web = PWA + favicons; all = both",
    )
    args = parser.parse_args()

    public = REPO / "public"
    assets = REPO / "assets"
    public.mkdir(exist_ok=True)
    assets.mkdir(exist_ok=True)

    written: list[Path] = []
    if args.target in ("all", "native"):
        written += generate_native(assets)
    if args.target in ("all", "web"):
        written += generate_web(assets, public)

    print("Generated icons:")
    for p in sorted(written):
        print(f"  {p.relative_to(REPO)}")


if __name__ == "__main__":
    main()
