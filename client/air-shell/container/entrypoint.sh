#!/bin/sh
# Entry point of the AIR shell build container (container/Dockerfile).
#
#   /sdk   volume: JDK, Android SDK and AIR SDK, set up on the first run and reused afterwards
#   /work  your folder: the World Flipper APK and AIRSDK_*.zip in, reflipped-shell.apk and air-shell.p12 out
#
# Extra arguments go to build.py, e.g. --server https://wf.example.org or --arch armv7.
# APK=<file name in /work> picks the APK when the folder holds more than one.
set -eu

say() { printf '[shell-builder] %s\n' "$*"; }
die() { printf '[shell-builder] error: %s\n' "$*" >&2; exit 1; }

# the defaults are the container's paths; overriding them runs the same steps on a Linux host
WORK="${WORK:-/work}"
SDK="${SDK:-/sdk}"
SRC="${SRC:-/src}"
[ -d "$WORK" ] || die "mount your folder at /work (-v \"<folder>:/work\")"

# the original APK: APK=<name>, else the only .apk in /work that isn't one of our builds
if [ -n "${APK:-}" ]; then
    apk="$WORK/$APK"
else
    apk=""
    for f in "$WORK"/*.apk; do
        [ -f "$f" ] || continue
        case "$(basename "$f")" in reflipped-shell*) continue ;; esac
        [ -z "$apk" ] || die "more than one APK in your folder; pick one with -e APK=<file name>"
        apk="$f"
    done
fi
[ -n "$apk" ] && [ -f "$apk" ] || die "put the World Flipper 0.0.81 APK in your folder (none found in /work)"

if [ -f "$SDK/air/lib/adt.jar" ]; then
    "$SRC/setup-sdk.sh" --dir "$SDK"
else
    air_zip=""
    for f in "$WORK"/AIRSDK*.zip; do
        [ -f "$f" ] && air_zip="$f"
    done
    [ -n "$air_zip" ] || die "put the AIR SDK zip you downloaded (AIRSDK_Linux.zip) in your folder; see docs/connecting-air-shell.md"
    say "installing the AIR SDK from $(basename "$air_zip")"
    "$SRC/setup-sdk.sh" --dir "$SDK" --air-zip "$air_zip"
fi
. "$SDK/env.sh"

# keep the signing key next to the output, outside the container: updates need the same key
SHELL_KEYSTORE="${SHELL_KEYSTORE:-$WORK/air-shell.p12}"
export SHELL_KEYSTORE

python3 -I "$SRC/build.py" --apk "$apk" --out "$WORK/reflipped-shell.apk" "$@"
# the container runs as root: hand the outputs to whoever owns the folder (a no-op where Docker maps owners itself)
owner="$(stat -c %u:%g "$WORK")"
chown "$owner" "$WORK/reflipped-shell.apk" "$SHELL_KEYSTORE" 2>/dev/null || true
say "done: reflipped-shell.apk is in your folder. Keep air-shell.p12 too: updates must be signed with it."
