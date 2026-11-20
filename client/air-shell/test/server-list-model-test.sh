#!/bin/sh
# Only the newly written pure bookmark regressions; no Android runtime, server or device.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT=$(mktemp -d "${TMPDIR:-/tmp}/reflipped-server-list-test-XXXXXX")
trap 'rm -rf "$OUT"' EXIT HUP INT TERM
javac -source 8 -target 8 -Xlint:-options -encoding UTF-8 -d "$OUT" \
    "$HERE/../java/src/reflipped/shell/common/ServerListModel.java" \
    "$HERE/src/reflipped/shell/common/ServerListModelTest.java"
java -cp "$OUT" reflipped.shell.common.ServerListModelTest
