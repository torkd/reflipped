#!/bin/sh
# SH-15 app version handshake (AppVersion) only; no devices or network.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT=$(mktemp -d "${TMPDIR:-/tmp}/reflipped-sh15-version-XXXXXX")
trap 'rm -rf "$OUT"' EXIT HUP INT TERM
javac -source 8 -target 8 -Xlint:-options -encoding UTF-8 -d "$OUT" \
    "$HERE/../java/src/reflipped/shell/common/AppVersion.java" \
    "$HERE/src/reflipped/shell/common/AppVersionTest.java"
java -cp "$OUT" reflipped.shell.common.AppVersionTest
