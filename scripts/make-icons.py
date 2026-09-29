#!/usr/bin/env python3
"""Rasterise the Hadron mark (client/favicon.svg) into the PNG icons the web
app manifest and Safari's Add to Dock need — they ignore SVG icons in practice.

Draws the same geometry as favicon.svg with Pillow (no SVG renderer needed),
super-sampled 4x for clean edges:
  icon-192.png / icon-512.png   transparent background, purpose "any"
  icon-maskable-512.png         opaque #0d1117, mark scaled into the safe zone
                                (a maskable icon may be cropped to a circle
                                inside 80% of its width — the ring must fit)
  apple-touch-icon.png (180)    opaque #0d1117 (iOS/macOS composite it on white otherwise)

Run once after changing favicon.svg:  python3 scripts/make-icons.py
Requires Pillow (python3 -m pip install Pillow).
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "client" / "assets" / "icons"
BG = (13, 17, 23, 255)  # #0d1117
SS = 4                  # supersampling factor

def draw_mark(size, *, opaque, scale=1.0):
    """The favicon geometry lives in a 64-unit box; `scale` shrinks it about the centre."""
    big = size * SS
    img = Image.new("RGBA", (big, big), BG if opaque else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = big / 64 * scale
    off = (big - 64 * u) / 2
    P = lambda x, y: (off + x * u, off + y * u)
    w = max(1, round(2 * u))
    # outer ring
    d.ellipse([P(5, 5), P(59, 59)], outline=(48, 54, 61, 255), width=w)
    # orbit triangle, 60% grey (alpha-blended so it reads the same on both backgrounds)
    line = (139, 148, 158, 153)
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    for a, b in (((32, 18), (20, 42)), ((20, 42), (44, 42)), ((44, 42), (32, 18))):
        ld.line([P(*a), P(*b)], fill=line, width=w)
        ld.ellipse([P(a[0] - 1, a[1] - 1), P(a[0] + 1, a[1] + 1)], fill=line)  # round caps
    img.alpha_composite(layer)
    d = ImageDraw.Draw(img)
    for (cx, cy), c in (((32, 18), (248, 81, 73)), ((20, 42), (63, 185, 80)), ((44, 42), (88, 166, 255))):
        d.ellipse([P(cx - 7, cy - 7), P(cx + 7, cy + 7)], fill=c + (255,))
    return img.resize((size, size), Image.LANCZOS)

OUT.mkdir(parents=True, exist_ok=True)
draw_mark(192, opaque=False).save(OUT / "icon-192.png", optimize=True)
draw_mark(512, opaque=False).save(OUT / "icon-512.png", optimize=True)
# safe zone = circle of 80% width; the ring's diameter is 54/64 of the box → scale 0.8*64/54 ≈ 0.9 leaves a margin
draw_mark(512, opaque=True, scale=0.85).save(OUT / "icon-maskable-512.png", optimize=True)
draw_mark(180, opaque=True, scale=0.92).save(OUT / "apple-touch-icon.png", optimize=True)
for f in sorted(OUT.glob("*.png")):
    im = Image.open(f)
    print(f"{f.relative_to(ROOT)}  {im.size[0]}x{im.size[1]} {im.mode}  {f.stat().st_size} B")
