#!/usr/bin/env python3
"""Add "REFLIPPED" under the title-screen logo inside bundle.zip (in place).

    python3 -I make_logo.py <bundle.zip>

The title screen's logo and "TAP TO START" banner is one 1015x683 PNG in the bundle,
stored with a lowercase "png" magic (\\x89png) that the game's loader accepts. The new
line is built from the logo's own lettering: every letter of REFLIPPED occurs in
"WORLD FLIPPER", so the glyph shapes are cut out of the logo and restyled flat, with
the logo's white rim: "RE" in the game's UI orange, "FLIPPED" in black like the logo's letters
(white on the icon's navy ribbon). No generative AI, no font, no gradient or glow. The
logo's long lightning-bolt tail is faded out so it doesn't run through the new text.
The entry is checked by size and the lowercase magic before it's replaced, so a different
bundle is left alone. bundle.zip.sha1 is rewritten with the new zip's hash.
Needs Pillow.
"""
import hashlib
import io
import os
import sys
import zipfile

from PIL import Image, ImageChops, ImageFilter

ENTRY = "production/bundle/ec/f7af5920a31dd5d4812d3c3b01b1b430cb4540"
SIZE = (1015, 683)
MAGIC = b"\x89png\r\n\x1a\n"

# Boxes (x0, y0, x1, y1) around single letters of the logo's "WORLD FLIPPER" lettering.
GLYPHS = {
    "R": (426, 296, 499, 415), "D": (559, 296, 634, 415),
    "F": (258, 412, 324, 510), "L": (326, 412, 381, 510), "I": (381, 412, 407, 510),
    "P": (413, 412, 482, 510), "E": (555, 412, 624, 510),
}
WORD = "REFLIPPED"
SCALE = 0.66            # glyph size relative to the logo's letters
GAP = 9                 # px between letters, at final size
TOP_Y = 556             # top of the letters, close under the logo
CENTER_X = 460          # horizontal centre of the logo art (dark body spans x 14..905)
ACCENT = (255, 150, 30)  # "RE": the orange of the game's Home tab and energy bar
PLAIN = (255, 255, 255)  # "FLIPPED"
INK = (14, 6, 24)        # the logo's black keyline
BOLT_X0, BOLT_X1 = 540, 720   # columns holding the bolt's tail (nothing else is down there)
BOLT_FADE_START, BOLT_FADE_END = 470, 560


def trim_bolt(logo):
    """Fade out the lightning bolt's long tail so it doesn't run through the new text."""
    w, h = logo.size
    fade = Image.new("L", (w, h), 255)
    ramp = Image.linear_gradient("L").rotate(180).resize((BOLT_X1 - BOLT_X0, BOLT_FADE_END - BOLT_FADE_START))
    fade.paste(ramp, (BOLT_X0, BOLT_FADE_START))
    fade.paste(0, (BOLT_X0, BOLT_FADE_END, BOLT_X1, h))
    out = logo.copy()
    out.putalpha(ImageChops.multiply(logo.getchannel("A"), fade))
    return out


def glyph_coverage(logo):
    """Coverage (0..255) of the letters' ink: dark or blue pixels, not the white keyline or glow."""
    lum = logo.convert("L").point(lambda v: max(0, min(255, int((150 - v) * 255 / 50))))
    return ImageChops.multiply(lum, logo.getchannel("A"))


def word_mask(logo):
    cov = glyph_coverage(logo)
    parts = []
    for ch in WORD:
        g = cov.crop(GLYPHS[ch])
        g = g.crop(g.point(lambda v: 255 if v > 40 else 0).getbbox())
        parts.append(g.resize((round(g.width * SCALE), round(g.height * SCALE)), Image.LANCZOS))
    width = sum(g.width for g in parts) + GAP * (len(parts) - 1)
    mask = Image.new("L", (width, max(g.height for g in parts)), 0)
    x = 0
    split = 0
    for i, g in enumerate(parts):  # tops aligned, like the logo's lettering
        mask.paste(g, (x, 0))
        x += g.width + GAP
        if i == 1:
            split = x - GAP // 2  # between "RE" and "FLIPPED"
    return mask, split


def solid(size, rgb, alpha):
    r, g, b = rgb
    return Image.merge("RGBA", (Image.new("L", size, r), Image.new("L", size, g), Image.new("L", size, b), alpha))


def load_logo(raw):
    """The logo entry's bytes as an image, or None if it isn't the expected logo."""
    if raw[:8] != MAGIC:
        return None
    logo = Image.open(io.BytesIO(b"\x89PNG" + raw[4:])).convert("RGBA")
    return logo if logo.size == SIZE else None


def word_image(logo, pad=14, flat=False):
    """REFLIPPED as a styled RGBA image with `pad` px of transparent margin for the keylines.

    flat=True drops the white keyline (just a dark outline), for small uses like the launcher
    icon where the extra rim eats the letters."""
    mask, split = word_mask(logo)
    size = (mask.width + 2 * pad, mask.height + 2 * pad)
    letters = Image.new("L", size, 0)
    letters.paste(mask, (pad, pad))
    fill = Image.new("RGBA", size, (0, 0, 0, 0))
    rest = PLAIN if flat else INK  # on the logo, black like its own letters; white on the icon's navy
    for (x0, x1), rgb in (((0, pad + split), ACCENT), ((pad + split, size[0]), rest)):
        part = Image.new("L", size, 0)
        part.paste(255, (x0, 0, x1, size[1]))
        fill.alpha_composite(solid(size, rgb, ImageChops.multiply(letters, part)))
    dark = solid(size, INK, letters.filter(ImageFilter.MaxFilter(5)))
    if flat:
        txt = dark
    else:
        txt = solid(size, (255, 255, 255), letters.filter(ImageFilter.MaxFilter(11)))  # the logo's white rim
        txt.alpha_composite(dark)
    txt.alpha_composite(fill)
    return txt


def stamp(logo):
    pad = 14
    txt = word_image(logo, pad)
    out = trim_bolt(logo)
    out.alpha_composite(txt, (CENTER_X - txt.width // 2, TOP_Y - pad))
    return out


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    path = sys.argv[1]
    with zipfile.ZipFile(path) as z:
        try:
            raw = z.read(ENTRY)
        except KeyError:
            sys.exit(f"{path} has no {ENTRY}: logo left as is")
        infos = z.infolist()
        data = {i.filename: z.read(i.filename) for i in infos}
    logo = load_logo(raw)
    if logo is None:
        sys.exit(f"{ENTRY} isn't the expected logo: left as is")
    buf = io.BytesIO()
    stamp(logo).save(buf, "PNG", optimize=True)
    data[ENTRY] = b"\x89png" + buf.getvalue()[4:]
    tmp = path + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for i in infos:
            z.writestr(i, data[i.filename], i.compress_type)
    os.replace(tmp, path)
    # The game re-extracts the bundle when this hash changes, so a reinstall shows the new logo.
    with open(path, "rb") as f, open(path + ".sha1", "w") as out:
        out.write(hashlib.sha1(f.read()).hexdigest())
    print("added REFLIPPED to the title logo")


if __name__ == "__main__":
    main()
