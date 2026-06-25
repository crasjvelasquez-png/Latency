#!/usr/bin/env python3
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ICONSET = ROOT / "assets" / "Latency.iconset"
ICNS = ROOT / "assets" / "Latency.icns"


def draw_icon(size):
    image = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    draw = ImageDraw.Draw(image)

    margin = int(size * 0.18)
    stroke = max(4, int(size * 0.055))
    center = size // 2
    background = (42, 42, 42, 255)
    white = (244, 244, 244, 255)
    radius = int(size * 0.22)

    draw.rounded_rectangle(
        [(0, 0), (size - 1, size - 1)],
        radius=radius,
        fill=background,
    )

    points = [
        (margin, center),
        (int(size * 0.32), center),
        (int(size * 0.42), int(size * 0.30)),
        (int(size * 0.52), int(size * 0.70)),
        (int(size * 0.62), center),
        (size - margin, center),
    ]
    draw.line(points, fill=white, width=stroke, joint="curve")

    echo_x = int(size * 0.74)
    echo_gap = int(size * 0.08)
    echo_height = int(size * 0.18)
    for offset, alpha in ((0, 255), (echo_gap, 130)):
        x = echo_x + offset
        draw.line(
            [(x, center - echo_height), (x, center + echo_height)],
            fill=(244, 244, 244, alpha),
            width=max(2, stroke // 2),
        )

    return image


def main():
    ICONSET.mkdir(parents=True, exist_ok=True)
    sizes = {
        "icon_16x16.png": 16,
        "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32,
        "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128,
        "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256,
        "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512,
        "icon_512x512@2x.png": 1024,
    }
    for filename, size in sizes.items():
        draw_icon(size).save(ICONSET / filename)

    print(f"Wrote {ICONSET}")
    print(f"Run: iconutil -c icns {ICONSET} -o {ICNS}")


if __name__ == "__main__":
    main()
