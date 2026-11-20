#!/bin/sh
# New origin-row identity test only; no devices or network.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT=$(mktemp -d "${TMPDIR:-/tmp}/reflipped-sh14-address-XXXXXX")
trap 'rm -rf "$OUT"' EXIT HUP INT TERM
javac -source 8 -target 8 -Xlint:-options -encoding UTF-8 -d "$OUT" \
    "$HERE/../java/src/reflipped/shell/common/ServerIdentity.java" \
    "$HERE/../java/src/reflipped/shell/common/OriginRows.java" \
    "$HERE/src/reflipped/shell/common/OriginRowsTest.java"
java -cp "$OUT" reflipped.shell.common.OriginRowsTest
