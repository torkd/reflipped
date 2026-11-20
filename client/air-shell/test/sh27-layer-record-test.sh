#!/bin/sh
# SH-27: the app's record of what server layers changed (java/src/.../pinball/LayerRecord.java). Runs the real
# AssetDownloader on the desktop JVM against a small local CDN (python3 -m http.server): a fresh download of a base
# full archive and a mod must start the record and list exactly the paths the mod wrote or deleted, not the base
# archive's, and (SH-29) keep the base originals it replaced; a second run of the mod must not replace them. Putting
# the originals back, and separately a restore archive (as POST /shell/restore builds it) applied with
# ArchiveExtractor, must each leave the base files as they were and an empty record. No phone, SDK or Reflipped
# server needed: a JDK and Python 3.
#
#   client/air-shell/test/sh27-layer-record-test.sh
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../build/sh27-layer-record-test"
JSON_JAR="$HERE/../build/downloader-test/json-20240303.jar"
JSON_SHA1="0ebb88e8fb5122b7506d5cf1d69f1ccdb790d22a" # as published on Maven Central

mkdir -p "$(dirname "$JSON_JAR")"
if [ ! -f "$JSON_JAR" ]; then
    curl -fsSL -o "$JSON_JAR.tmp" https://repo1.maven.org/maven2/org/json/json/20240303/json-20240303.jar
    printf '%s  %s\n' "$JSON_SHA1" "$JSON_JAR.tmp" | sha1sum -c --quiet - || { rm -f "$JSON_JAR.tmp"; echo "org.json checksum mismatch" >&2; exit 1; }
    mv "$JSON_JAR.tmp" "$JSON_JAR"
fi

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/cdn" "$OUT/files"
javac -source 8 -target 8 -nowarn -d "$OUT/classes" -cp "$JSON_JAR" \
    "$HERE/shim/android/util/Log.java" "$HERE/shim/reflipped/shell/common/StubContext.java" \
    "$HERE/../java/src/reflipped/shell/pinball/AssetDownloader.java" \
    "$HERE/../java/src/reflipped/shell/pinball/ArchiveExtractor.java" \
    "$HERE/../java/src/reflipped/shell/pinball/LayerRecord.java" \
    "$HERE/src/reflipped/shell/pinball/DownloaderHarness.java" \
    "$HERE/src/reflipped/shell/pinball/LayerRecordHarness.java" 2>&1 | grep -v '^warning' || true

# The fixture: a base archive, a mod over it, and the restore archive the server would send for the mod's paths.
python3 -I - "$OUT/cdn" "$OUT/restore.zip" <<'PY'
import os, sys, zipfile
cdn, restore = sys.argv[1], sys.argv[2]
def write(path, entries):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries: z.writestr(name, data)
A, B, G = "production/upload/aa/0001", "production/upload/bb/0002", "production/upload/cc/0003"
S, S_ACTUAL, N = "production/medium_upload/hash/dd/0004.hash", "production/medium_upload/dd/0004", "production/upload/ee/0005"
write(f"{cdn}/en/archive-android-full/asset-2.1.0-1-0123abcd.zip", [(A, "base a"), (B, "base b"), (G, "base g"), (S, "base s")])
# the mod overwrites A, writes the long twin of S (which deletes S), adds N and deletes G
write(f"{cdn}/mods/mod.zip", [(A, "mod a"), (S_ACTUAL, "mod s"), (N, "mod n"), (".removed.csv", f"rowid,path\n1,{G}\n")])
write(restore, [(".removed.csv", f"rowid,path\n1,{N}\n"), (S, "base s"), (A, "base a"), (G, "base g")])
for f in [f"{cdn}/en/archive-android-full/asset-2.1.0-1-0123abcd.zip", f"{cdn}/mods/mod.zip"]: print(f[len(cdn):], os.path.getsize(f))
PY

PORT=$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
python3 -I -m http.server "$PORT" --bind 127.0.0.1 --directory "$OUT/cdn" >"$OUT/http.log" 2>&1 &
HTTP=$!
trap 'kill "$HTTP" 2>/dev/null || true' EXIT INT TERM
i=0
until python3 -I -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:$PORT/mods/mod.zip')" 2>/dev/null; do
    i=$((i + 1)); [ "$i" -lt 50 ] || { echo "the test CDN didn't start" >&2; exit 1; }; sleep 0.1
done

BASE_SIZE=$(wc -c <"$OUT/cdn/en/archive-android-full/asset-2.1.0-1-0123abcd.zip")
MOD_SIZE=$(wc -c <"$OUT/cdn/mods/mod.zip")
FAIL=0
check() { # what, got, want
    if [ "$2" = "$3" ]; then echo "OK   $1"; else echo "FAIL $1: got [$2], want [$3]"; FAIL=1; fi
}
record() { java -cp "$OUT/classes:$JSON_JAR" reflipped.shell.pinball.LayerRecordHarness record "$OUT/files" | sort | tr '\n' ' '; }
file() { if [ -f "$OUT/files/download/$1" ]; then cat "$OUT/files/download/$1"; else echo "-"; fi; }

java -cp "$OUT/classes:$JSON_JAR" reflipped.shell.pinball.DownloaderHarness "http://127.0.0.1:$PORT" \
    "$OUT/files/download" "$OUT/files/download/partial_downloaded.platform" \
    "{\$cdnAddress}/en/archive-android-full/asset-2.1.0-1-0123abcd.zip" "$BASE_SIZE" \
    "{\$cdnAddress}/mods/mod.zip" "$MOD_SIZE" >/dev/null
check "the record (version 2) lists what the mod wrote or deleted, with the twin it deleted" "$(java -cp "$OUT/classes:$JSON_JAR" reflipped.shell.pinball.LayerRecordHarness version "$OUT/files") $(record)" \
    "2 production/medium_upload/dd/0004 production/medium_upload/hash/dd/0004.hash production/upload/aa/0001 production/upload/cc/0003 production/upload/ee/0005 "
check "the mod's files are on disk" "$(file production/upload/aa/0001) $(file production/medium_upload/hash/dd/0004.hash) $(file production/upload/cc/0003)" "mod a - -"
kept() { if [ -f "$OUT/files/reflipped-base/$1" ]; then cat "$OUT/files/reflipped-base/$1"; else echo "-"; fi; }
check "the originals it replaced are kept" "$(kept production/upload/aa/0001)|$(kept production/medium_upload/hash/dd/0004.hash)|$(kept production/upload/cc/0003)|$(kept production/upload/ee/0005)|$(kept production/upload/bb/0002)" \
    "base a|base s|base g|-|-"

# a later layer-only run (no base full archive) appends and keeps the record
rm -f "$OUT/files/download/partial_downloaded.platform"
java -cp "$OUT/classes:$JSON_JAR" reflipped.shell.pinball.DownloaderHarness "http://127.0.0.1:$PORT" \
    "$OUT/files/download" "$OUT/files/download/partial_downloaded.platform" "{\$cdnAddress}/mods/mod.zip" "$MOD_SIZE" >/dev/null
check "a layer-only run keeps the record" "$(record | wc -w | tr -d ' ')" "5"
check "and doesn't replace a kept original" "$(kept production/upload/aa/0001)" "base a"

java -cp "$OUT/classes:$JSON_JAR" reflipped.shell.pinball.LayerRecordHarness restore-local "$OUT/files"
check "the kept originals go back" \
    "$(file production/upload/aa/0001)|$(file production/upload/bb/0002)|$(file production/upload/cc/0003)|$(file production/medium_upload/hash/dd/0004.hash)|$(file production/medium_upload/dd/0004)|$(file production/upload/ee/0005)" \
    "base a|base b|base g|base s|-|-"
check "with an empty record and nothing left kept" "$(record)|$(find "$OUT/files/reflipped-base" -type f 2>/dev/null | wc -l | tr -d ' ')" "|0"

# the mod again, then the server's restore archive instead
rm -f "$OUT/files/download/partial_downloaded.platform"
java -cp "$OUT/classes:$JSON_JAR" reflipped.shell.pinball.DownloaderHarness "http://127.0.0.1:$PORT" \
    "$OUT/files/download" "$OUT/files/download/partial_downloaded.platform" "{\$cdnAddress}/mods/mod.zip" "$MOD_SIZE" >/dev/null

java -cp "$OUT/classes:$JSON_JAR" reflipped.shell.pinball.LayerRecordHarness restore "$OUT/files" "$OUT/restore.zip"
check "the restore puts the base files back" \
    "$(file production/upload/aa/0001)|$(file production/upload/bb/0002)|$(file production/upload/cc/0003)|$(file production/medium_upload/hash/dd/0004.hash)|$(file production/medium_upload/dd/0004)|$(file production/upload/ee/0005)" \
    "base a|base b|base g|base s|-|-"
check "and starts an empty record" "$(record)|$(find "$OUT/files/reflipped-base" -type f 2>/dev/null | wc -l | tr -d ' ')" "|0"

# files without a record (an older app's) are unknown
rm "$OUT/files/reflipped-layers.txt"
check "no record reads as unknown" "$(record)" "NULL "

exit "$FAIL"
