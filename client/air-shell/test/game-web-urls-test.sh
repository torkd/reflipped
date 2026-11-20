#!/bin/sh
# Runs only the new read-only menu URL policy test, with a desktop JDK; no Android/device/server needed.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT=$(mktemp -d "${TMPDIR:-/tmp}/reflipped-game-web-urls-XXXXXX")
trap 'rm -rf "$OUT"' EXIT HUP INT TERM
javac -source 8 -target 8 -Xlint:-options -encoding UTF-8 -d "$OUT" \
    "$HERE/../java/src/reflipped/shell/common/GameWebUrls.java" \
    "$HERE/src/reflipped/shell/common/GameWebUrlsTest.java"
java -cp "$OUT" reflipped.shell.common.GameWebUrlsTest
