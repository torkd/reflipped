#!/bin/sh
# Only the new independent SH-14 review regressions, without Android or a device.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT=$(mktemp -d "${TMPDIR:-/tmp}/reflipped-sh14-review-XXXXXX")
trap 'rm -rf "$OUT"' EXIT HUP INT TERM
javac -source 8 -target 8 -Xlint:-options -encoding UTF-8 -d "$OUT" \
    "$HERE/../java/src/reflipped/shell/common/ServerIdentity.java" \
    "$HERE/../java/src/reflipped/shell/common/DeviceKeys.java" \
    "$HERE/../java/src/reflipped/shell/common/CredentialRequests.java" \
    "$HERE/src/reflipped/shell/common/OriginReviewTest.java" \
    "$HERE/src/reflipped/shell/common/CredentialRedirectReviewTest.java"
java -cp "$OUT" reflipped.shell.common.OriginReviewTest
java -cp "$OUT" reflipped.shell.common.CredentialRedirectReviewTest
