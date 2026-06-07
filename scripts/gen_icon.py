#!/usr/bin/env python3
"""Generate simple Hyve Android launcher icons from the wordmark tile."""

from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageColor, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "android" / "HyveBridge" / "app" / "src" / "main" / "res"

BACKGROUND = ImageColor.getrgb("#1F222A")
TEXT = ImageColor.getrgb("#F8FAFC")

# Adaptive icon foreground sizes (108dp per density)
adaptive_sizes = {
    "mipmap-mdpi": 108,
    "mipmap-hdpi": 162,
    "mipmap-xhdpi": 216,
    "mipmap-xxhdpi": 324,
    "mipmap-xxxhdpi": 432,
}

# Legacy icon sizes
legacy_sizes = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}


def _font_path() -> str:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        "/Library/Fonts/Arial.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return candidate
    raise FileNotFoundError("Could not find a usable system font for icon generation")


FONT_PATH = _font_path()


def _draw_wordmark(canvas: Image.Image, box: tuple[int, int, int, int], font_scale: float) -> None:
    draw = ImageDraw.Draw(canvas)
    left, top, right, bottom = box
    box_width = right - left
    box_height = bottom - top
    font = ImageFont.truetype(FONT_PATH, max(12, int(box_height * font_scale)))
    text = "Hyve"
    text_bbox = draw.textbbox((0, 0), text, font=font)
    text_width = text_bbox[2] - text_bbox[0]
    text_height = text_bbox[3] - text_bbox[1]
    start_x = left + int((box_width - text_width) / 2) - text_bbox[0]
    baseline_y = top + int((box_height - text_height) / 2) - text_bbox[1] - int(box_height * 0.035)
    draw.text((start_x, baseline_y), text, fill=TEXT, font=font)


def _draw_tile(canvas: Image.Image, box: tuple[int, int, int, int], font_scale: float) -> None:
    draw = ImageDraw.Draw(canvas)
    draw.rectangle(box, fill=BACKGROUND + (255,))
    _draw_wordmark(canvas, box, font_scale=font_scale)

def create_foreground(size: int, output_path: Path) -> None:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inset = int(size * 0.13)
    _draw_tile(image, (inset, inset, size - inset, size - inset), font_scale=0.31)
    image.save(output_path, "PNG")
    print(f"  Foreground: {output_path} ({size}x{size})")


def create_legacy(size: int, output_path: Path) -> None:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    _draw_tile(image, (0, 0, size, size), font_scale=0.36)
    image.save(output_path, "PNG")
    print(f"  Legacy: {output_path} ({size}x{size})")


for folder, size in adaptive_sizes.items():
    dir_path = BASE / folder
    dir_path.mkdir(parents=True, exist_ok=True)
    create_foreground(size, dir_path / "ic_launcher_foreground.png")

for folder, size in legacy_sizes.items():
    dir_path = BASE / folder
    dir_path.mkdir(parents=True, exist_ok=True)
    create_legacy(size, dir_path / "ic_launcher.png")
    create_legacy(size, dir_path / "ic_launcher_round.png")

print("\nDone! All icon PNGs generated.")
