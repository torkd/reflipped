#!/bin/sh
# Checks installing a copy of the .cdn folder (SH-29) on the desktop JVM: make_cdn_copies.py writes small copies (pax
# and GNU tars, a deflated zip and a zip64 one, with other languages and platforms around the archives, and a
# .tar.gz, a cut-short and a damaged copy) from the CDN's first COUNT archives of the en list, and CdnCopyHarness
# installs them with the app's own java/.../pinball/CdnCopy.java, GamePack.java and ArchiveExtractor.java. A small
# pack from `npm run gamepack` checks that a pack is told apart. No phone, AIR SDK or server needed: a JDK, Python 3,
# Node and the CDN's first COUNT archives.
#
#   client/air-shell/test/cdncopy-test.sh [COUNT]
#
# COUNT defaults to 3 (at least 2). CDN_DIR picks the CDN folder (default <repo>/.cdn). Output goes to
# build/cdncopy-test/.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
COUNT="${1:-3}"
CDN="${CDN_DIR:-$REPO/.cdn}"
OUT="$HERE/../build/cdncopy-test"
JSON_JAR="$HERE/../build/downloader-test/json-20240303.jar"
JSON_SHA1="0ebb88e8fb5122b7506d5cf1d69f1ccdb790d22a" # as published on Maven Central

mkdir -p "$OUT" "$(dirname "$JSON_JAR")"
if [ ! -f "$JSON_JAR" ]; then
    # org.json: GamePack reads a pack's manifest with it, and android.jar only has stubs of it
    curl -fsSL -o "$JSON_JAR.tmp" https://repo1.maven.org/maven2/org/json/json/20240303/json-20240303.jar
    printf '%s  %s\n' "$JSON_SHA1" "$JSON_JAR.tmp" | sha1sum -c --quiet - || { rm -f "$JSON_JAR.tmp"; echo "org.json checksum mismatch" >&2; exit 1; }
    mv "$JSON_JAR.tmp" "$JSON_JAR"
fi

rm -rf "$OUT/classes" "$OUT/work" "$OUT/copies"
mkdir -p "$OUT/work"
python3 -I "$HERE/make_cdn_copies.py" "$REPO" "$CDN" "$COUNT" "$OUT/copies"
CDN_DIR="$CDN" node "$REPO/scripts/gamepack.mjs" --limit 1 --out "$OUT/pack.tar"
javac -source 8 -target 8 -nowarn -d "$OUT/classes" -cp "$JSON_JAR" \
    "$HERE/../java/src/reflipped/shell/pinball/ArchiveExtractor.java" \
    "$HERE/../java/src/reflipped/shell/pinball/GamePack.java" \
    "$HERE/../java/src/reflipped/shell/pinball/CdnCopy.java" \
    "$HERE/src/reflipped/shell/pinball/CdnCopyHarness.java" 2>&1 | grep -v '^warning' || true
java -cp "$OUT/classes:$JSON_JAR" reflipped.shell.pinball.CdnCopyHarness "$OUT/copies" "$CDN" "$OUT/pack.tar" "$OUT/work"
