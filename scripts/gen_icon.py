#!/usr/bin/env python3
"""Generate Android app icon PNGs with white ĕ on blue background."""

from PIL import Image, ImageDraw, ImageFont
import os

base = "/Users/andreidima/hass_memory/android/MeminiBridge/app/src/main/res"
blue = (3, 7, 18)  # #030712 - main app background
font_path = "/Library/Fonts/Arial Unicode.ttf"

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


def create_foreground(size, output_path):
    """White ĕ centered on transparent background for adaptive icon."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font_size = int(size * 0.52)
    font = ImageFont.truetype(font_path, font_size)
    char = "\u0115"  # ĕ
    bbox = draw.textbbox((0, 0), char, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (size - tw) / 2 - bbox[0]
    y = (size - th) / 2 - bbox[1]
    draw.text((x, y), char, fill=(255, 255, 255, 255), font=font)
    img.save(output_path, "PNG")
    print(f"  Foreground: {output_path} ({size}x{size})")


def create_legacy(size, output_path):
    """Full icon: blue circle with white ĕ for legacy launchers."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    margin = int(size * 0.02)
    draw.ellipse(
        [margin, margin, size - margin - 1, size - margin - 1],
        fill=blue + (255,),
    )
    font_size = int(size * 0.58)
    font = ImageFont.truetype(font_path, font_size)
    char = "\u0115"  # ĕ
    bbox = draw.textbbox((0, 0), char, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (size - tw) / 2 - bbox[0]
    y = (size - th) / 2 - bbox[1]
    draw.text((x, y), char, fill=(255, 255, 255, 255), font=font)
    img.save(output_path, "PNG")
    print(f"  Legacy: {output_path} ({size}x{size})")


for folder, size in adaptive_sizes.items():
    dir_path = os.path.join(base, folder)
    os.makedirs(dir_path, exist_ok=True)
    create_foreground(size, os.path.join(dir_path, "ic_launcher_foreground.png"))

for folder, size in legacy_sizes.items():
    dir_path = os.path.join(base, folder)
    os.makedirs(dir_path, exist_ok=True)
    create_legacy(size, os.path.join(dir_path, "ic_launcher.png"))
    create_legacy(size, os.path.join(dir_path, "ic_launcher_round.png"))

print("\nDone! All icon PNGs generated.")
