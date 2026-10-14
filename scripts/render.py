"""Render a tuirun.py snapshot as a screenshot-like PNG in a macOS window frame.

usage: python scripts/render.py SNAPSHOT.json OUT.png "Window title"
needs: pip install pillow fonttools; uses macOS fonts (Menlo, with symbol fallbacks)
"""
import json, os, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from fontTools.ttLib import TTFont, TTCollection

cells = json.load(open(sys.argv[1])); out = sys.argv[2]; title = sys.argv[3]
SCALE = 2; SIZE = 13 * SCALE
CHAIN = [("/System/Library/Fonts/Menlo.ttc", 0), (os.path.expanduser("~/Library/Fonts/HackNerdFont-Regular.ttf"), 0),
         ("/System/Library/Fonts/Apple Symbols.ttf", 0), ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0)]
fonts, cmaps = [], []
for path, idx in CHAIN:
    try:
        fonts.append(ImageFont.truetype(path, SIZE, index=idx))
        tt = TTCollection(path).fonts[idx] if path.endswith(".ttc") else TTFont(path)
        cmaps.append(set(tt.getBestCmap()))
    except Exception:
        pass  # a fallback font this Mac does not have
bold = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", SIZE, index=1)
def font_for(ch, b):
    for f, cm in zip(fonts, cmaps):
        if ord(ch) in cm:
            return bold if (b and f is fonts[0]) else f
    return fonts[0]

NAMED = {"black": "000000", "red": "cd3131", "green": "0dbc79", "brown": "e5e510", "yellow": "e5e510", "blue": "2472c8",
         "magenta": "bc3fbc", "cyan": "11a8cd", "white": "e5e5e5"}
DEF_FG, DEF_BG = "bfbdb6", "0b0e14"
def color(v, default):
    if v in ("default", None): v = default
    v = NAMED.get(v, v)
    return "#" + v if len(v) == 6 else "#" + default

rows, cols = len(cells), len(cells[0])
cw = round(fonts[0].getlength("M")); ch = round(SIZE * 1.32)
W, H = cols * cw, rows * ch
term = Image.new("RGB", (W, H), color(None, DEF_BG))
d = ImageDraw.Draw(term)
for y, row in enumerate(cells):
    for x, (data, fg, bg, b, rev) in enumerate(row):
        f, g = color(fg, DEF_FG), color(bg, DEF_BG)
        if rev: f, g = g, f
        d.rectangle([x * cw, y * ch, (x + 1) * cw, (y + 1) * ch], fill=g)
for y, row in enumerate(cells):
    for x, (data, fg, bg, b, rev) in enumerate(row):
        if not data.strip(): continue
        f = color(bg if rev else fg, DEF_BG if rev else DEF_FG)
        fnt = font_for(data[0], b)
        d.text((x * cw, y * ch + (ch - SIZE) // 2 - SCALE), data, font=fnt, fill=f)

# window frame: title bar with traffic lights, rounded corners, soft shadow
BAR = 28 * SCALE; PAD = 40 * SCALE; R = 10 * SCALE
win = Image.new("RGBA", (W, H + BAR), (0, 0, 0, 0))
mask = Image.new("L", win.size, 0); ImageDraw.Draw(mask).rounded_rectangle([0, 0, win.width - 1, win.height - 1], R, fill=255)
body = Image.new("RGBA", win.size, "#1e1f22"); body.paste(term, (0, BAR))
bd = ImageDraw.Draw(body)
for i, c in enumerate(["#ff5f57", "#febc2e", "#28c840"]):
    cx, cy, r = (14 + i * 20) * SCALE, BAR // 2, 6 * SCALE
    bd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)
tf = ImageFont.truetype("/System/Library/Fonts/SFNS.ttf", 13 * SCALE)
bd.text(((win.width - bd.textlength(title, font=tf)) / 2, BAR // 2 - 8 * SCALE), title, font=tf, fill="#c9c9c9")
win.paste(body, (0, 0), mask)
canvas = Image.new("RGBA", (win.width + 2 * PAD, win.height + 2 * PAD), (0, 0, 0, 0))
shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle([PAD, PAD + 8 * SCALE, PAD + win.width, PAD + win.height + 8 * SCALE], R, fill=(0, 0, 0, 120))
shadow = shadow.filter(ImageFilter.GaussianBlur(14 * SCALE))
canvas = Image.alpha_composite(shadow, canvas); canvas.paste(win, (PAD, PAD), win)
canvas.save(out, optimize=True)
print(out, canvas.size)
