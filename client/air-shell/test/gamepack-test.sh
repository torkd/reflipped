#!/bin/sh
# Checks the game data pack installer (SH-25) on the desktop JVM: builds a small pack with the real tool
# (`npm run gamepack -- --limit COUNT`, from the repository's CDN folder) and installs it with the app's own
# java/.../pinball/GamePack.java and ArchiveExtractor.java (GamePackHarness: the files, an unofficial list, a changed
# byte, a cut-off pack, a file that isn't a pack). No phone, AIR SDK or server needed: a JDK, Node and the CDN's
# first COUNT full archives.
#
#   client/air-shell/test/gamepack-test.sh [COUNT]
#
# COUNT defaults to 3. CDN_DIR picks the CDN folder (default <repo>/.cdn). Output goes to build/gamepack-test/.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
COUNT="${1:-3}"
CDN="${CDN_DIR:-$REPO/.cdn}"
OUT="$HERE/../build/gamepack-test"
JSON_JAR="$HERE/../build/downloader-test/json-20240303.jar"
JSON_SHA1="0ebb88e8fb5122b7506d5cf1d69f1ccdb790d22a" # as published on Maven Central

mkdir -p "$OUT" "$(dirname "$JSON_JAR")"
if [ ! -f "$JSON_JAR" ]; then
    # org.json: android.jar only has stubs of it, so the desktop run needs the real library.
    curl -fsSL -o "$JSON_JAR.tmp" https://repo1.maven.org/maven2/org/json/json/20240303/json-20240303.jar
    printf '%s  %s\n' "$JSON_SHA1" "$JSON_JAR.tmp" | sha1sum -c --quiet - || { rm -f "$JSON_JAR.tmp"; echo "org.json checksum mismatch" >&2; exit 1; }
    mv "$JSON_JAR.tmp" "$JSON_JAR"
fi

rm -rf "$OUT/classes" "$OUT/work"
mkdir -p "$OUT/work"
CDN_DIR="$CDN" node "$REPO/scripts/gamepack.mjs" --limit "$COUNT" --out "$OUT/test-pack.tar"
javac -source 8 -target 8 -nowarn -d "$OUT/classes" -cp "$JSON_JAR" \
    "$HERE/../java/src/reflipped/shell/pinball/ArchiveExtractor.java" \
    "$HERE/../java/src/reflipped/shell/pinball/GamePack.java" \
    "$HERE/src/reflipped/shell/pinball/GamePackHarness.java" 2>&1 | grep -v '^warning' || true
java -cp "$OUT/classes:$JSON_JAR" reflipped.shell.pinball.GamePackHarness "$OUT/test-pack.tar" "$CDN" "$OUT/work"
