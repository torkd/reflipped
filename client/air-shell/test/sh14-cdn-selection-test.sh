#!/bin/sh
# Runs only the independent SH-14 CDN origin selection regression written with this fix.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT=$(mktemp -d "${TMPDIR:-/tmp}/reflipped-sh14-cdn-XXXXXX")
trap 'rm -rf "$OUT"' EXIT HUP INT TERM
javac -source 8 -target 8 -Xlint:-options -encoding UTF-8 -d "$OUT" \
    "$HERE/../java/src/reflipped/shell/common/ServerIdentity.java" \
    "$HERE/../java/src/reflipped/shell/common/DeviceKeys.java" \
    "$HERE/../java/src/reflipped/shell/common/CdnSelection.java" \
    "$HERE/src/reflipped/shell/common/CdnSelectionTest.java"
java -cp "$OUT" reflipped.shell.common.CdnSelectionTest
