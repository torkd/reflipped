#!/bin/sh
# SH-29: exporting the game data a phone holds as a game data pack (format 2) and installing it elsewhere, on the
# desktop JVM (java/src/.../pinball/{GameFilesExport,GamePack,LayerRecord}.java). Base archives and then a mod are
# extracted as the app does (the mod through LayerRecord.Keeper, so its originals are kept); the export must hold
# exactly the base files, with the list the server tools compute for the same archives (npm run gamefiles); an install
# must give back the base files; a changed byte, an added file or a missing list must be refused with nothing left
# behind; and files without a version 2 record can't be exported. Needs a JDK, Python 3 and Node (the repository's).
#
#   client/air-shell/test/sh29-export-test.sh
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
OUT="$HERE/../build/sh29-export-test"
JSON_JAR="$HERE/../build/downloader-test/json-20240303.jar"
JSON_SHA1="0ebb88e8fb5122b7506d5cf1d69f1ccdb790d22a" # as published on Maven Central

mkdir -p "$(dirname "$JSON_JAR")"
if [ ! -f "$JSON_JAR" ]; then
    curl -fsSL -o "$JSON_JAR.tmp" https://repo1.maven.org/maven2/org/json/json/20240303/json-20240303.jar
    printf '%s  %s\n' "$JSON_SHA1" "$JSON_JAR.tmp" | sha1sum -c --quiet - || { rm -f "$JSON_JAR.tmp"; echo "org.json checksum mismatch" >&2; exit 1; }
    mv "$JSON_JAR.tmp" "$JSON_JAR"
fi

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/zips"
javac -source 8 -target 8 -nowarn -d "$OUT/classes" -cp "$JSON_JAR" \
    "$HERE/../java/src/reflipped/shell/pinball/ArchiveExtractor.java" \
    "$HERE/../java/src/reflipped/shell/pinball/LayerRecord.java" \
    "$HERE/../java/src/reflipped/shell/pinball/GamePack.java" \
    "$HERE/../java/src/reflipped/shell/pinball/GameFilesExport.java" \
    "$HERE/src/reflipped/shell/pinball/ExportHarness.java" 2>&1 | grep -v '^warning\|^Note' || true
run() { java -cp "$OUT/classes:$JSON_JAR" reflipped.shell.pinball.ExportHarness "$@"; }

python3 -I - "$OUT/zips" <<'PY'
import sys, zipfile
out = sys.argv[1]
def write(name, entries):
    with zipfile.ZipFile(f"{out}/{name}", "w", zipfile.ZIP_DEFLATED) as z:
        for n, d in entries: z.writestr(n, d)
A, B, G = "production/upload/aa/0001", "production/upload/bb/0002", "production/upload/cc/0003"
S, S_ACTUAL, N = "production/medium_upload/hash/dd/0004.hash", "production/medium_upload/dd/0004", "production/upload/ee/0005"
LONG = "production/android_medium_upload/hash/07/97a7b82da2315ea1a96a25e186cb30e6e187ef" + "x" * 40 + ".hash"
write("full.zip", [(A, "a old"), (B, "b"), (G, "g"), (S, "s"), (LONG, "long name")])
write("diff.zip", [(A, "a new"), (".removed.csv", f"rowid,path\n1,{G}\n")])
# the mod overwrites A and B's twin form, adds N and deletes the base file B
write("mod.zip", [(A, "mod a"), (S_ACTUAL, "mod s"), (N, "mod n"), (".removed.csv", f"rowid,path\n1,{B}\n")])
PY

FAIL=0
check() { if [ "$2" = "$3" ]; then echo "OK   $1"; else echo "FAIL $1: got [$2], want [$3]"; FAIL=1; fi; }
tree() { (cd "$1/download" 2>/dev/null && find . -type f | sort | while read -r f; do printf '%s=%s;' "$f" "$(cat "$f")"; done); }

PHONE="$OUT/phone"
run start "$PHONE"
run extract "$PHONE" "$OUT/zips/full.zip"
run extract "$PHONE" "$OUT/zips/diff.zip"
BASE="$(tree "$PHONE")"
run extract "$PHONE" "$OUT/zips/mod.zip" layer
check "the export holds the base files only" "$(run export "$PHONE" en "$OUT/export.tar")" "OK 4"

# the pack's list is the one the server tools compute for the same archives
(cd "$REPO" && npx --no-install tsx src/gamepack/cli.ts --list "$OUT/expected.tsv" --archives "$OUT/zips/full.zip,$OUT/zips/diff.zip" >/dev/null 2>&1)
python3 -I - "$OUT/export.tar" "$OUT/got.tsv" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1]) as t:
    names = t.getnames()
    assert names[0] == "reflipped-gamepack.json" and names[-1] == "reflipped-gamefiles.tsv", names
    open(sys.argv[2], "wb").write(t.extractfile("reflipped-gamefiles.tsv").read())
PY
check "its list is the server tools' list" "$(cmp -s "$OUT/expected.tsv" "$OUT/got.tsv" && echo same || echo differs)" "same"

run install "$OUT/other" "$OUT/export.tar" >/dev/null
check "installing it gives the base files back" "$(tree "$OUT/other")" "$BASE"

# tampered packs: a changed byte, an extra file, no list
python3 -I - "$OUT/export.tar" "$OUT" <<'PY'
import io, sys, tarfile
src, out = sys.argv[1], sys.argv[2]
with tarfile.open(src) as t:
    members = [(m, t.extractfile(m).read()) for m in t.getmembers()]
def write(name, items):
    with tarfile.open(f"{out}/{name}", "w", format=tarfile.USTAR_FORMAT) as t:
        for m, d in items:
            info = tarfile.TarInfo(m.name); info.size = len(d); t.addfile(info, io.BytesIO(d))
changed = [(m, (d[:-1] + bytes([d[-1] ^ 1])) if m.name.endswith("aa/0001") else d) for m, d in members]
write("changed.tar", changed)
extra = members[:-1] + [(tarfile.TarInfo("production/upload/zz/extra"), b"extra")] + members[-1:]
write("extra.tar", extra)
write("nolist.tar", members[:-1])
PY
for bad in changed extra nolist; do
    result="$(run install "$OUT/bad-$bad" "$OUT/$bad.tar")"
    check "a pack with $bad is refused" "$(echo "$result" | cut -c1-7)" "REFUSED"
    check "and leaves no files ($bad)" "$(find "$OUT/bad-$bad/download" -type f 2>/dev/null | wc -l | tr -d ' ')" "0"
done

# files from before the originals were kept can't be exported
OLD="$OUT/old"
run start-v1 "$OLD"
run extract "$OLD" "$OUT/zips/full.zip"
check "files with a version 1 record are refused" "$(run export "$OLD" en "$OUT/old.tar" | cut -c1-7)" "REFUSED"
exit "$FAIL"
