#!/bin/sh
# SH-20 import build: the op list (tools/swf_ops.py) and the app's importer, patcher and storage states
# (java/src/reflipped/shell/content/) on a desktop JVM, with a made-up game APK; no devices or network.
# Optional: sh20-import-test.sh <build/app/reflipped-import> <game.apk> also imports the real game with the files a
# real import build made, and prints timings.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT=$(mktemp -d "${TMPDIR:-/tmp}/reflipped-sh20-import-XXXXXX")
trap 'rm -rf "$OUT"' EXIT HUP INT TERM
SRC="$HERE/../java/src/reflipped/shell/content"
javac -source 8 -target 8 -Xlint:-options -encoding UTF-8 -d "$OUT/classes" \
    "$SRC/Hashes.java" "$SRC/ImportManifest.java" "$SRC/OpPatch.java" "$SRC/Swf.java" \
    "$SRC/GameFiles.java" "$SRC/GameImporter.java" \
    "$HERE/src/reflipped/shell/content/ImportTest.java"
mkdir -p "$OUT/scratch"
if [ $# -ge 2 ]; then
    java -cp "$OUT/classes" reflipped.shell.content.ImportTest "$1" "$OUT/scratch" "$2"
else
    python3 -I "$HERE/sh20-import-fixture.py" "$OUT/fixture"
    java -cp "$OUT/classes" reflipped.shell.content.ImportTest "$OUT/fixture" "$OUT/scratch"
fi
