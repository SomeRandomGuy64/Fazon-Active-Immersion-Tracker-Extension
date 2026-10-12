#!/usr/bin/env python3
"""DEV ONLY: render icons/icon{,-active,-inactive}-{16,32,48,128}.png (needs Pillow).
Same geometry as icons/icon.svg; 16/32 px drop the ring so the play triangle stays legible."""
import math, os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
VARIANTS = {
    '':          {'bg': (195, 84, 10),  'fg': (255, 255, 255)},   # #c3540a — fazon.nexus accent
    '-active':   {'bg': (240, 108, 20), 'fg': (255, 255, 255)},   # vivid: tracking Japanese now
    '-inactive': {'bg': (112, 112, 112), 'fg': (226, 226, 226)},  # grey: not tracking
}

def draw(size, bg, fg):
    S = 8                       # supersample
    W = size * S
    k = W / 128.0
    im = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    pad = 4 * k if size >= 48 else 1 * k * 2
    d.rounded_rectangle([pad, pad, W - pad, W - pad], radius=(28 if size >= 48 else 30) * k, fill=bg + (255,))
    ring = size >= 48
    if ring:
        r, cx, cy, sw = 42 * k, 64 * k, 64 * k, 9 * k
        box = [cx - r, cy - r, cx + r, cy + r]
        faint = tuple(int(b + (f - b) * 0.35) for b, f in zip(bg, fg)) + (255,)
        d.arc(box, 180, 270, fill=faint, width=int(sw))
        d.arc(box, 270, 180 + 360, fill=fg + (255,), width=int(sw))
        for ang, col in ((180, faint), (270, fg + (255,)), (180 + 360, fg + (255,))):
            a = math.radians(ang)
            px, py = cx + (r - sw / 2) * math.cos(a), cy + (r - sw / 2) * math.sin(a)
            d.ellipse([px - sw / 2, py - sw / 2, px + sw / 2, py + sw / 2], fill=col)
        tri = [(54, 44.5), (85, 64), (54, 83.5)]
        rounding = 6
    else:
        tri = [(44, 30), (98, 64), (44, 98)]
        rounding = 10
    pts = [(x * k, y * k) for x, y in tri]
    d.polygon(pts, fill=fg + (255,))
    w = int(rounding * k)
    for i in range(3):   # round the triangle's corners with a stroke
        d.line([pts[i], pts[(i + 1) % 3]], fill=fg + (255,), width=w)
        x, y = pts[i]
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=fg + (255,))
    return im.resize((size, size), Image.LANCZOS)

for suffix, c in VARIANTS.items():
    for size in (16, 32, 48, 128):
        draw(size, c['bg'], c['fg']).save(os.path.join(OUT, f'icon{suffix}-{size}.png'), optimize=True)
print('ok')
