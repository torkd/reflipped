#!/bin/sh
# Desktop-JVM checks added in the SH-14 review: local-network thumbnails and the addresses tried for a typed server.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC="$HERE/../java/src/reflipped/shell/common"
OUT=$(mktemp -d "${TMPDIR:-/tmp}/reflipped-sh14-review-fixes-XXXXXX")
trap 'rm -rf "$OUT"' EXIT HUP INT TERM
javac -source 8 -target 8 -Xlint:-options -encoding UTF-8 -d "$OUT" \
    "$SRC/ServerIdentity.java" "$SRC/ThumbnailPolicy.java" "$SRC/AddressCandidates.java" \
    "$HERE/src/reflipped/shell/common/ThumbnailLocalPolicyTest.java" \
    "$HERE/src/reflipped/shell/common/AddressCandidatesTest.java"
java -cp "$OUT" reflipped.shell.common.ThumbnailLocalPolicyTest
java -cp "$OUT" reflipped.shell.common.AddressCandidatesTest
