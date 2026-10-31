#!/bin/sh
# Runs the real AssetDownloader (java/src/.../pinball/AssetDownloader.java) on the desktop JVM
# against a running Reflipped, with small shims for android.util.Log and StubContext. No phone or
# AIR SDK needed, only a JDK and Python 3.
#
#   client/air-shell/test/downloader-test.sh [SERVER] [COUNT]
#
# SERVER defaults to http://127.0.0.1:8000; COUNT (default 3) is how many full archives from
# assets/asset_lists/en-android-full.json to fetch, plus the 2.1.108 diff (it has a .removed.csv).
# Runs twice: the second run must resume with nothing left to fetch. Output goes to build/.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SERVER="${1:-http://127.0.0.1:8000}"
COUNT="${2:-3}"
OUT="$HERE/../build/downloader-test"
JSON_JAR="$OUT/json-20240303.jar"
JSON_SHA1="0ebb88e8fb5122b7506d5cf1d69f1ccdb790d22a" # as published on Maven Central

mkdir -p "$OUT"
if [ ! -f "$JSON_JAR" ]; then
    # org.json: android.jar only has stubs of it, so the desktop run needs the real library.
    curl -fsSL -o "$JSON_JAR.tmp" https://repo1.maven.org/maven2/org/json/json/20240303/json-20240303.jar
    printf '%s  %s\n' "$JSON_SHA1" "$JSON_JAR.tmp" | sha1sum -c --quiet - || { rm -f "$JSON_JAR.tmp"; echo "org.json checksum mismatch" >&2; exit 1; }
    mv "$JSON_JAR.tmp" "$JSON_JAR"
fi

rm -rf "$OUT/classes" "$OUT/asset" "$OUT/partial_downloaded.platform"
javac -source 8 -target 8 -nowarn -d "$OUT/classes" -cp "$JSON_JAR" \
    "$HERE/shim/android/util/Log.java" "$HERE/shim/reflipped/shell/common/StubContext.java" \
    "$HERE/../java/src/reflipped/shell/pinball/AssetDownloader.java" \
    "$HERE/src/reflipped/shell/pinball/DownloaderHarness.java" 2>&1 | grep -v '^warning' || true

ARCHIVES="$(python3 -I - "$REPO/assets/asset_lists/en-android-full.json" "$COUNT" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
sel = d["full"]["archive"][: int(sys.argv[2])]
sel += [a for v in d["diff"] if v["version"] == "2.1.108" for a in v["archive"]]
print(" ".join(f"{a['location']} {a['size']}" for a in sel))
EOF
)"

for run in 1 2; do
    echo "== run $run"
    # shellcheck disable=SC2086
    java -cp "$OUT/classes:$JSON_JAR" reflipped.shell.pinball.DownloaderHarness \
        "$SERVER/patch/Live/2.0.0" "$OUT/asset" "$OUT/partial_downloaded.platform" $ARCHIVES
done
echo "extracted files: $(find "$OUT/asset" -type f | wc -l)"
