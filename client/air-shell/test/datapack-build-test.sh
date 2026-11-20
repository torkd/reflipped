#!/bin/sh
# Checks Local play's data pack built on the phone (SH-29) on the desktop JVM: lays out the files the pack takes from
# the game's files as a phone holds them after a full English install (the official list's archives replayed from the
# repository's CDN folder, only the members the pack needs), with one master changed by a layer (its original kept in
# reflipped-base/) and one under its shortened name, builds the pack with the app's own DataPackBuilder and
# LayerRecord (DataPackHarness: the pins, a missing record, a missing table, a bundle without the source), then opens
# it with the server's check (src/lib/dataPack.ts) against the digests a `--no-assets` bundle pins.
# No phone, AIR SDK or server bundle needed: a JDK, Node, Python 3 and the CDN's en archives.
#
#   client/air-shell/test/datapack-build-test.sh
#
# CDN_DIR picks the CDN folder (default <repo>/.cdn). Output goes to build/datapack-build-test/.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
CDN="${CDN_DIR:-$REPO/.cdn}"
OUT="$HERE/../build/datapack-build-test"
JSON_JAR="$HERE/../build/downloader-test/json-20240303.jar"
JSON_SHA1="0ebb88e8fb5122b7506d5cf1d69f1ccdb790d22a" # as published on Maven Central

mkdir -p "$OUT" "$(dirname "$JSON_JAR")"
if [ ! -f "$JSON_JAR" ]; then
    # org.json: android.jar only has stubs of it, so the desktop run needs the real library.
    curl -fsSL -o "$JSON_JAR.tmp" https://repo1.maven.org/maven2/org/json/json/20240303/json-20240303.jar
    printf '%s  %s\n' "$JSON_SHA1" "$JSON_JAR.tmp" | sha1sum -c --quiet - || { rm -f "$JSON_JAR.tmp"; echo "org.json checksum mismatch" >&2; exit 1; }
    mv "$JSON_JAR.tmp" "$JSON_JAR"
fi

rm -rf "$OUT/classes" "$OUT/work" "$OUT/root" "$OUT/source"
mkdir -p "$OUT/work" "$OUT/root/download" "$OUT/source/datapack-source"

# what scripts/bundle.mjs --no-assets puts into the bundle, zipped as build.py's pack_server does
(cd "$REPO" && node --import tsx src/datapack/source.ts "$OUT/source/datapack-source/source.json")
cp -R "$REPO/assets" "$OUT/source/datapack-source/assets"
python3 -I - "$OUT/source" "$OUT/bundle.zip" <<'PY'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
    for folder, dirs, files in os.walk(src):
        dirs.sort()
        for name in sorted(files):
            z.write(os.path.join(folder, name), os.path.relpath(os.path.join(folder, name), src).replace(os.sep, "/"))
PY

# the game files: the official en list's archives in order, only the members the pack needs, then one layer change
python3 -I - "$CDN" "$REPO/assets/asset_lists/en-android-full.json" "$OUT/source/datapack-source/source.json" "$OUT/root" <<'PY'
import json, os, re, sys, zipfile
cdn, listing, source, root = sys.argv[1:5]
files = json.load(open(source))["files"]
want = {f["member"] for f in files}
d = json.load(open(listing))
archives = [a["location"] for a in d["full"]["archive"]] + [a["location"] for v in d["diff"] for a in v["archive"]]
assets = os.path.join(root, "download")
for location in archives:
    with zipfile.ZipFile(os.path.join(cdn, location.replace("{$cdnAddress}/", ""))) as z:
        for name in z.namelist():
            if name == ".removed.csv":
                for row in z.read(name).decode().splitlines()[1:]:
                    path = row.split(",", 1)[-1].strip()
                    if path in want and os.path.exists(os.path.join(assets, path)): os.remove(os.path.join(assets, path))
            elif name in want:
                os.makedirs(os.path.dirname(os.path.join(assets, name)), exist_ok=True)
                with open(os.path.join(assets, name), "wb") as f: f.write(z.read(name))
masters = sorted(f["member"] for f in files if f["required"])
layered, twin = masters[-1], masters[-2]
kept = os.path.join(root, "reflipped-base", layered)
os.makedirs(os.path.dirname(kept), exist_ok=True)
os.rename(os.path.join(assets, layered), kept)
with open(os.path.join(assets, layered), "wb") as f: f.write(b"a schedule layer's copy")
with open(os.path.join(root, "reflipped-layers.txt"), "w") as f: f.write("reflipped-layer-paths 2\n" + layered + "\n")
short = re.sub(r"^(.*)/([^/]+/[^/]+)$", r"\1/hash/\2.hash", twin)
os.makedirs(os.path.dirname(os.path.join(assets, short)), exist_ok=True)
os.rename(os.path.join(assets, twin), os.path.join(assets, short))
print(f"{len(archives)} archives replayed; {len(want)} members; layered {layered}; shortened {short}")
PY

javac -source 8 -target 8 -nowarn -d "$OUT/classes" -cp "$JSON_JAR" \
    "$HERE/../java/src/reflipped/shell/pinball/ArchiveExtractor.java" \
    "$HERE/../java/src/reflipped/shell/pinball/LayerRecord.java" \
    "$HERE/../java/src/reflipped/shell/service/DataPackBuilder.java" \
    "$HERE/src/reflipped/shell/service/DataPackHarness.java" 2>&1 | grep -v '^warning' || true
PIN="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).mastersDigest)' "$REPO/src/datapack/pin.json")"
PACK="$(java -cp "$OUT/classes:$JSON_JAR" reflipped.shell.service.DataPackHarness "$OUT/bundle.zip" "$OUT/root" "$OUT/work" "$PIN" | tee /dev/stderr | tail -n 1)"

# the server's own start-up check, with the pins of a --no-assets bundle (scripts/bundle.mjs assetsDigest)
cd "$REPO"
node --import tsx -e '
const { DataPack, assetsDigest, sha256Hex } = require("./src/lib/dataPack")
const { readdirSync, readFileSync, statSync } = require("fs")
const path = require("path")
const files = []
const walk = (dir, base) => { for (const name of readdirSync(dir).sort()) { const rel = base ? base + "/" + name : name
    if (statSync(path.join(dir, name)).isDirectory()) walk(path.join(dir, name), rel)
    else files.push({ path: "assets/" + rel, sha256: sha256Hex(readFileSync(path.join(dir, name))) }) } }
walk("assets", "")
const pin = JSON.parse(readFileSync("src/datapack/pin.json", "utf8")).mastersDigest
const pack = DataPack.open(process.argv[1], { expectedAssetsDigest: assetsDigest(files), expectedMastersDigest: pin })
console.log("ok   the server opens the pack: " + pack.manifest.files.length + " files, " + pack.masterCount + " masters, CDN " + pack.manifest.cdnVersion)
' "$PACK"
