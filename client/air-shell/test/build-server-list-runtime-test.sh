#!/bin/sh
# Builds ONLY the new in-memory Android org.json harness. No adb/device/app/prefs access here.
# Usage: sh build-server-list-runtime-test.sh [current-client-common-dir] [output-dir]
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OWN_COMMON="$HERE/../java/src/reflipped/shell/common"
CLIENT_COMMON=${1:-$OWN_COMMON}
OUT=${2:-/tmp/reflipped-server-list-runtime}
SDK=${ANDROID_HOME:?Set ANDROID_HOME to the installed Android SDK}
ANDROID_JAR="$SDK/platforms/android-34/android.jar"
D8="$SDK/build-tools/34.0.0/d8"
mkdir -p "$OUT/classes" "$OUT/dex"
javac -source 8 -target 8 -Xlint:-options -encoding UTF-8 -cp "$ANDROID_JAR" -d "$OUT/classes" \
    "$OWN_COMMON/ServerListModel.java" "$OWN_COMMON/ServerListStore.java" \
    "$CLIENT_COMMON/DeviceKeys.java" "$CLIENT_COMMON/ServerIdentity.java" \
    "$CLIENT_COMMON/Progression.java" "$CLIENT_COMMON/ThumbnailPolicy.java" \
    "$HERE/runtime-store/shims/reflipped/shell/common/ShellConfig.java" \
    "$HERE/runtime-store/shims/reflipped/shell/common/ServerDirectory.java" \
    "$HERE/src/reflipped/shell/common/ServerListCodecRuntimeTest.java"
jar cf "$OUT/test-classes.jar" -C "$OUT/classes" .
"$D8" --min-api 21 --lib "$ANDROID_JAR" --output "$OUT/dex" "$OUT/test-classes.jar"
jar cf "$OUT/server-list-codec-runtime.jar" -C "$OUT/dex" classes.dex
printf '%s\n' "$OUT/server-list-codec-runtime.jar"
