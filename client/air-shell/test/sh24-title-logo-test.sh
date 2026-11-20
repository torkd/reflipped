#!/bin/sh
# SH-24 import build: the REFLIPPED line the app adds to the title logo after an import (LogoStamp, PngWriter,
# BundleLogo and the storage check in GameFiles, java/src/reflipped/shell/content/) on a desktop JVM, with made-up
# images and bundles; no game files, devices or network.
# Optional: sh24-title-logo-test.sh <bundle.zip> <the same bundle stamped by tools/make_logo.py> also stamps the real
# bundle and checks the logo is pixel for pixel make_logo.py's (the scratch copies are deleted afterwards).
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT=$(mktemp -d "${TMPDIR:-/tmp}/reflipped-sh24-logo-XXXXXX")
trap 'rm -rf "$OUT"' EXIT HUP INT TERM
SRC="$HERE/../java/src/reflipped/shell/content"
javac -source 8 -target 8 -Xlint:-options -encoding UTF-8 -d "$OUT/classes" \
    "$SRC/Hashes.java" "$SRC/ImportManifest.java" "$SRC/OpPatch.java" "$SRC/Swf.java" "$SRC/GameFiles.java" \
    "$SRC/LogoStamp.java" "$SRC/PngWriter.java" "$SRC/BundleLogo.java" \
    "$HERE/src/reflipped/shell/content/TitleLogoTest.java"
mkdir -p "$OUT/scratch"
java -Djava.awt.headless=true -cp "$OUT/classes" reflipped.shell.content.TitleLogoTest "$OUT/scratch" "$@"
