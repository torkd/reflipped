#!/usr/bin/env python3
"""Make the "World Flipper Reflipped" launcher icons from the original APK's icon.

    python3 -I make_icons.py <original.apk> <out-dir>

Procedural edit, no generative AI: the original icon has its backdrop hue-rotated (so the two apps
are told apart at a glance) and a navy ribbon carrying the name, set in the title logo's own letters (via make_logo.py), is drawn across
the bottom. Writes icon{36,48,72,96,144,192}.png, which
build.py lists under <icon> in the descriptor. The art comes from the APK you pass in
and the output goes under build/ only, so no game art is committed.
Needs Pillow.
"""
import io
import os
import shutil
import sys
import zipfile

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I drops the script dir
import make_logo  # noqa: E402

SIZES = (36, 48, 72, 96, 144, 192)
BASE = 432          # the adaptive-icon layers' xxxhdpi size
SS = 4              # supersampling for the drawn parts
HUE_SHIFT = 0.42    # fraction of the colour wheel; pink/blue -> amber/green


def load(apk, name):
    with zipfile.ZipFile(apk) as z:
        return Image.open(io.BytesIO(z.read(name))).convert("RGBA")


def hue_shift(img, shift):
    # Rotate hue on a 256-entry table per channel via HSV, keeping alpha.
    hsv = img.convert("RGB").convert("HSV")
    h, s, v = hsv.split()
    h = h.point(lambda x: (x + int(shift * 256)) % 256)
    out = Image.merge("HSV", (h, s, v)).convert("RGB").convert("RGBA")
    out.putalpha(img.getchannel("A"))
    return out


def name_image(apk):
    """REFLIPPED in the title logo's own lettering, cut out of the APK's bundle (see make_logo.py)."""
    with zipfile.ZipFile(apk) as z, zipfile.ZipFile(io.BytesIO(z.read("assets/bundle.zip"))) as bundle:
        logo = make_logo.load_logo(bundle.read(make_logo.ENTRY))
    if logo is None:
        sys.exit("the APK's title logo isn't the expected one; can't draw the icon's name")
    word = make_logo.word_image(logo, pad=2, flat=True)
    return word.crop(word.getchannel("A").getbbox())


def ribbon(size, word):
    """Slanted navy ribbon across the bottom carrying the name."""
    w, h = size
    n = (w * SS, h * SS)
    img = Image.new("RGBA", n, (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    lean = h * SS * 0.12
    # amber rule above a navy band, both with a slanted top edge
    rule = h * SS * 0.06
    d.polygon([(0, lean), (n[0], 0), (n[0], n[1]), (0, n[1])], fill=(255, 196, 51, 255))
    d.polygon([(0, lean + rule), (n[0], rule), (n[0], n[1]), (0, n[1])], fill=(20, 30, 84, 255))
    img = img.resize((w, h), Image.LANCZOS)
    # Keep the word inside the launcher's own mask (a circle is ~67% wide down here).
    scale = min(w * 0.64 / word.width, h * 0.45 / word.height)
    word = word.resize((round(word.width * scale), round(word.height * scale)), Image.LANCZOS)
    img.alpha_composite(word, ((w - word.width) // 2, round(h * 0.45 - word.height / 2)))
    return img


def build(apk):
    bg = load(apk, "res/mipmap-xxxhdpi-v4/ic_launcher_background.png")
    fg = load(apk, "res/mipmap-xxxhdpi-v4/ic_launcher_foreground.png")
    # Recolour only the backdrop so the characters keep their own colours.
    art = Image.alpha_composite(hue_shift(bg, HUE_SHIFT), fg)
    # The adaptive layers have a safe-zone margin; the legacy icon crops to the middle 2/3.
    m = int(BASE * (1 - 2 / 3) / 2 * 0.6)
    art = art.crop((m, m, BASE - m, BASE - m)).resize((BASE, BASE), Image.LANCZOS)

    band = (BASE, int(BASE * 0.30))
    art.alpha_composite(ribbon(band, name_image(apk)), (0, BASE - band[1]))

    # Full-bleed and opaque: the launcher (Samsung's squircle, a circle) applies its own mask, and
    # transparent corners would make it shrink the icon onto a white plate instead.
    art.putalpha(255)
    return art


ADAPTIVE_XML = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/reflipped_icon_bg"/>
    <foreground android:drawable="@drawable/reflipped_icon_fg"/>
</adaptive-icon>
"""


def adaptive(apk):
    """Backdrop and foreground layers for Android 8+ launchers, which mask and scale them as one icon.

    Only the middle 2/3 of a layer is guaranteed to be visible, so the ribbon sits inside it.
    A plain PNG icon gets shrunk onto a tinted plate by the Android 13+ launchers instead."""
    bg = hue_shift(load(apk, "res/mipmap-xxxhdpi-v4/ic_launcher_background.png"), HUE_SHIFT)
    bg.putalpha(255)
    fg = load(apk, "res/mipmap-xxxhdpi-v4/ic_launcher_foreground.png")
    safe = BASE // 6
    band = (BASE - 2 * safe, int(BASE * 0.30 * 2 / 3))
    fg.alpha_composite(ribbon(band, name_image(apk)), (safe, BASE - safe - band[1]))
    return bg, fg


def write_res(apk, out):
    """<out>/res: an API 26+ variant of the app's own @mipmap/icon (the PNGs stay the fallback below 26).

    AIR forbids overriding android:icon, but resources from an extension merge by name. build.py ships this in an ANE."""
    res = os.path.join(out, "res")
    shutil.rmtree(res, ignore_errors=True)
    for d in ("drawable-xxxhdpi", "mipmap-anydpi-v26"):
        os.makedirs(os.path.join(res, d), exist_ok=True)
    bg, fg = adaptive(apk)
    bg.save(os.path.join(res, "drawable-xxxhdpi", "reflipped_icon_bg.png"))
    fg.save(os.path.join(res, "drawable-xxxhdpi", "reflipped_icon_fg.png"))
    with open(os.path.join(res, "mipmap-anydpi-v26", "icon.xml"), "w") as f:
        f.write(ADAPTIVE_XML)


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    apk, out = sys.argv[1:]
    art = build(apk)
    for s in SIZES:
        art.resize((s, s), Image.LANCZOS).save(f"{out}/icon{s}.png")
    write_res(apk, out)
    print(f"wrote {len(SIZES)} icons and the adaptive icon to {out}")


if __name__ == "__main__":
    main()
