#!/bin/sh
# Runs ONLY this synthetic in-memory harness on the explicitly reserved QA test3 emulator.
# Coordinate its availability first. No app/prefs/logcat/settings commands are used.
set -eu
if [ "${1:-}" != "--test3-only" ]; then
    printf '%s\n' 'Usage: sh run-server-list-runtime-test.sh --test3-only [harness.jar]' >&2
    exit 2
fi
APK_TEST_JAR=${2:-/tmp/reflipped-server-list-runtime/server-list-codec-runtime.jar}
REMOTE=/data/local/tmp/reflipped-server-list-codec-runtime.jar
adb -s emulator-5558 push "$APK_TEST_JAR" "$REMOTE"
trap 'adb -s emulator-5558 shell rm -f /data/local/tmp/reflipped-server-list-codec-runtime.jar >/dev/null 2>&1' EXIT HUP INT TERM
adb -s emulator-5558 shell 'CLASSPATH=/data/local/tmp/reflipped-server-list-codec-runtime.jar app_process /system/bin reflipped.shell.common.ServerListCodecRuntimeTest'
