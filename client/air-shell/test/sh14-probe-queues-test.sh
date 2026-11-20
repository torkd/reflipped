#!/bin/sh
# New probe priority scheduling regression only; no Android, network or credentials.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT=$(mktemp -d "${TMPDIR:-/tmp}/reflipped-sh14-probe-queues-XXXXXX")
trap 'rm -rf "$OUT"' EXIT HUP INT TERM
javac -source 8 -target 8 -Xlint:-options -encoding UTF-8 -d "$OUT" \
    "$HERE/../java/src/reflipped/shell/common/ServerProbeQueues.java" \
    "$HERE/src/reflipped/shell/common/ServerProbeQueuesTest.java"
java -cp "$OUT" reflipped.shell.common.ServerProbeQueuesTest
