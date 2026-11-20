#!/usr/bin/env python3
"""Draw the Reflipped app's launcher icons from the Reflipped mark.

    python3 -I make_icons.py <out-dir>

The mark is icon/reflipped.svg, the same drawing as the admin site's logo (web/public/img/logo.svg): our own art,
nothing from the game. It is drawn with Pillow from the SVG's shapes, so the build needs no SVG renderer; only the
few SVG features the mark uses are read (rect, circle, path with M/L/H/V/Z, fill, stroke, rotate), and anything else
stops the build so a changed drawing can't come out wrong unnoticed.

Writes icon{36,48,72,96,144,192}.png (the mark as drawn, for build.py's descriptor <icon>) and res/ with an adaptive
icon for Android 8+: the backdrop colour as one layer, the flipper and ball scaled into the launcher's safe zone as
the other; and the white status-bar icon for the app's notifications. Needs Pillow.
"""
import math
import os
import re
import shutil
import sys
import xml.etree.ElementTree as ET

from PIL import Image, ImageColor, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
MARK = os.path.join(HERE, "..", "icon", "reflipped.svg")
SIZES = (36, 48, 72, 96, 144, 192)
BASE = 432          # the adaptive-icon layers' xxxhdpi size (108 dp)
SAFE_RADIUS = 33 / 108  # Android keeps a circle of 66 dp out of the layer's 108 dp visible under every mask
SS = 4              # supersampling
NS = "{http://www.w3.org/2000/svg}"


def fail(message):
    sys.exit(f"make_icons: {MARK}: {message}")


def number(element, name, default=None):
    value = element.get(name)
    if value is None:
        if default is None:
            fail(f"<{element.tag.replace(NS, '')}> has no {name}")
        return default
    return float(value)


def rotation(transform):
    """A point mapping for transform="rotate(a [cx cy])" (degrees, clockwise on screen), the only one the mark uses."""
    if not transform:
        return lambda p: p
    match = re.fullmatch(r"\s*rotate\(\s*([-\d.]+)(?:[\s,]+([-\d.]+)[\s,]+([-\d.]+))?\s*\)\s*", transform)
    if not match:
        fail(f"unsupported transform {transform!r}")
    angle = math.radians(float(match.group(1)))
    cx, cy = float(match.group(2) or 0), float(match.group(3) or 0)
    cos, sin = math.cos(angle), math.sin(angle)
    return lambda p: (cx + (p[0] - cx) * cos - (p[1] - cy) * sin, cy + (p[0] - cx) * sin + (p[1] - cy) * cos)


def path_points(d):
    """Polygon points of a path made of straight lines (M, L, H, V, Z; absolute)."""
    tokens = re.findall(r"[MLHVZmlhvz]|-?\d*\.?\d+(?:e-?\d+)?", d)
    points, command, i = [], None, 0
    while i < len(tokens):
        token = tokens[i]
        if token.isalpha():
            if token.islower() or token not in "MLHVZ":
                fail(f"unsupported path command {token!r}")
            command, i = token, i + 1
            if command == "Z":
                continue
            continue
        if command in ("M", "L"):
            points.append((float(tokens[i]), float(tokens[i + 1])))
            i += 2
        elif command == "H":
            points.append((float(token), points[-1][1]))
            i += 1
        elif command == "V":
            points.append((points[-1][0], float(token)))
            i += 1
        else:
            fail(f"path data {d!r}")
    return points


def shapes(svg):
    """The mark as (kind, data, fill, stroke, stroke width) in viewBox units, in drawing order."""
    out = []

    def walk(element, fill, transform):
        tag = element.tag.replace(NS, "")
        fill = element.get("fill", fill)
        if element.get("transform"):
            if transform is not None:
                fail("nested transforms")
            transform = rotation(element.get("transform"))
        move = transform or (lambda p: p)
        stroke, width = element.get("stroke"), float(element.get("stroke-width", 1))
        if tag == "g":
            for child in element:
                walk(child, fill, transform)
        elif tag == "rect":
            if transform is not None:
                fail("a rotated rect")
            x, y, w, h = (number(element, n) for n in ("x", "y", "width", "height"))
            out.append(("rect", (x, y, w, h, number(element, "rx", 0)), fill, stroke, width))
        elif tag == "circle":
            out.append(("circle", (*move((number(element, "cx"), number(element, "cy"))), number(element, "r")),
                        fill, stroke, width))
        elif tag == "path":
            out.append(("polygon", [move(p) for p in path_points(element.get("d", ""))], fill, stroke, width))
        elif tag not in ("title", "desc"):
            fail(f"unsupported element <{tag}>")
        if stroke and tag != "rect":
            fail(f"a stroke on <{tag}>")

    for child in svg:
        walk(child, svg.get("fill", "#000"), None)
    return out


def load():
    svg = ET.parse(MARK).getroot()
    box = [float(v) for v in svg.get("viewBox", "").replace(",", " ").split()]
    if len(box) != 4 or box[2] != box[3]:
        fail("needs a square viewBox")
    marks = shapes(svg)
    first = marks[0] if marks else None
    if not first or first[0] != "rect" or first[1][2] < box[2] * 0.9:
        fail("the first shape must be the backdrop rect")
    return box, first, marks[1:]


def colour(value):
    return ImageColor.getcolor(value, "RGBA")


def draw(size, box, items, scale=1.0):
    """items drawn on a transparent size x size image; scale shrinks them about the viewBox centre."""
    n = size * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    unit = n / box[2] * scale
    cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2

    def at(p):
        return (n / 2 + (p[0] - cx) * unit, n / 2 + (p[1] - cy) * unit)

    for kind, data, fill, stroke, width in items:
        if kind == "rect":
            x, y, w, h, rx = data
            # SVG centres a stroke on the outline: draw the stroke colour out to its outer edge, then the fill inside
            half = width / 2 if stroke else 0
            if stroke:
                d.rounded_rectangle([at((x - half, y - half)), at((x + w + half, y + h + half))],
                                    radius=(rx + half) * unit, fill=colour(stroke))
            d.rounded_rectangle([at((x + half, y + half)), at((x + w - half, y + h - half))],
                                radius=max(rx - half, 0) * unit, fill=colour(fill))
        elif kind == "circle":
            (x, y), r = at(data[:2]), data[2] * unit
            d.ellipse([x - r, y - r, x + r, y + r], fill=colour(fill))
        else:
            d.polygon([at(p) for p in data], fill=colour(fill))
    return img.resize((size, size), Image.LANCZOS)


def reach(box, items):
    """How far the drawing reaches from the viewBox centre, in viewBox units."""
    cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2
    far = 0.0
    for kind, data, _, _, _ in items:
        if kind == "circle":
            far = max(far, math.hypot(data[0] - cx, data[1] - cy) + data[2])
        elif kind == "polygon":
            far = max(far, *(math.hypot(x - cx, y - cy) for x, y in data))
        else:
            fail("only the backdrop may be a rect")
    return far


ADAPTIVE_XML = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/reflipped_icon_bg"/>
    <foreground android:drawable="@drawable/reflipped_icon_fg"/>
</adaptive-icon>
"""


def write_res(out, box, backdrop, items):
    """<out>/res: an API 26+ variant of the app's own @mipmap/icon (the PNGs stay the icon below 26).

    Android 8+ launchers cut an adaptive icon to their own shape; a plain PNG would be shrunk onto a tinted plate
    by Android 13+ launchers instead. AIR forbids overriding android:icon, but resources from an extension merge by
    name, so build.py ships these in an ANE."""
    res = os.path.join(out, "res")
    shutil.rmtree(res, ignore_errors=True)
    for d in ("drawable-xxxhdpi", "mipmap-anydpi-v26"):
        os.makedirs(os.path.join(res, d), exist_ok=True)
    Image.new("RGBA", (BASE, BASE), colour(backdrop[2])).save(os.path.join(res, "drawable-xxxhdpi", "reflipped_icon_bg.png"))
    # the whole drawing inside the safe circle, so no launcher shape cuts into the flipper or the lane
    scale = SAFE_RADIUS * box[2] / reach(box, items)
    draw(BASE, box, items, scale).save(os.path.join(res, "drawable-xxxhdpi", "reflipped_icon_fg.png"))
    with open(os.path.join(res, "mipmap-anydpi-v26", "icon.xml"), "w") as f:
        f.write(ADAPTIVE_XML)


NOTIFICATION_SIZES = {"mdpi": 24, "hdpi": 36, "xhdpi": 48, "xxhdpi": 72, "xxxhdpi": 96}


def write_notification_icon(out, box, backdrop, items):
    """<out>/res/drawable-*/reflipped_notification.png: the status-bar icon of the app's foreground services (the
    server on the phone). Android draws only its alpha, so it is the flipper and the ball in white, the flipper's pivot
    cut out, without the lane, filling the 24 dp icon. A launcher icon there is a white blob (and an adaptive one
    crashed SystemUI on Android 8.0)."""
    white = "#FFFFFF"
    marks = []
    for kind, data, fill, stroke, width in items:
        if kind == "polygon" and fill.upper() == "#BD93F9":
            continue  # the lane
        # shapes in the backdrop's colour are holes in the drawing
        marks.append((kind, data, "#00000000" if fill.upper() == backdrop[2].upper() else white, None, 0))
    drawn = [m for m in marks if m[2] == white]
    scale = 0.47 * box[2] / reach(box, drawn)
    for density, size in NOTIFICATION_SIZES.items():
        folder = os.path.join(out, "res", f"drawable-{density}")
        os.makedirs(folder, exist_ok=True)
        draw(size, box, marks, scale).save(os.path.join(folder, "reflipped_notification.png"))


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    box, backdrop, items = load()
    for s in SIZES:
        draw(s, box, [backdrop] + items).save(os.path.join(out, f"icon{s}.png"))
    write_res(out, box, backdrop, items)
    write_notification_icon(out, box, backdrop, items)
    print(f"wrote {len(SIZES)} icons and the adaptive icon to {out}")


if __name__ == "__main__":
    main()
