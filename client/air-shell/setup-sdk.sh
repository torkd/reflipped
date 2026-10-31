#!/bin/sh
# Installs the AIR shell's build tools into ONE folder (default ~/sdk-wf), with no system
# packages and no changes to shell profiles. Remove everything with --uninstall.
#
#   client/air-shell/setup-sdk.sh [--dir DIR] [--manager-zip PATH | --air-dir PATH | --air-zip PATH]
#                                 [--node] [--dry-run]
#   client/air-shell/setup-sdk.sh --uninstall [--dir DIR]
#
# Installs: JDK 17 (Temurin), Android command-line tools, platform-tools (adb) and
# platforms;android-34, and optionally Node 22 for the repo's tests. The AIR SDK comes from
# airsdk.wxlift.com and is never downloaded by this script: you accept its licence yourself in
# the AIR SDK Manager (docs/air-licence.md). Pass the Manager zip (--manager-zip,
# unpacked into DIR/manager), an SDK folder the manager downloaded (--air-dir, linked as DIR/air),
# or an SDK zip (--air-zip).
# Every download is checked against the checksum its publisher lists.
# Afterwards run `. DIR/env.sh` in a terminal to use the tools there.
set -eu

SDK_DIR="${SDK_WF:-$HOME/sdk-wf}"
AIR_ZIP=""
AIR_DIR=""
MANAGER_ZIP=""
WITH_NODE=false
DRY_RUN=false
UNINSTALL=false
ANDROID_PLATFORM="platforms;android-34"
ANDROID_BUILD_TOOLS="build-tools;34.0.0"
MARKER=".reflipped-sdk"

say() { printf '[setup-sdk] %s\n' "$*"; }
die() { printf '[setup-sdk] error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing '$1' (install it with your package manager)"; }

usage() {
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dir) SDK_DIR="$2"; shift 2 ;;
        --air-zip) AIR_ZIP="$2"; shift 2 ;;
        --air-dir) AIR_DIR="$2"; shift 2 ;;
        --manager-zip) MANAGER_ZIP="$2"; shift 2 ;;
        --node) WITH_NODE=true; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        --uninstall) UNINSTALL=true; shift ;;
        -h|--help) usage ;;
        *) die "unknown option: $1 (see --help)" ;;
    esac
done

case "$SDK_DIR" in
    /*) ;;
    *) SDK_DIR="$(pwd)/$SDK_DIR" ;;
esac
case "$SDK_DIR" in
    /|"$HOME"|"$HOME/") die "refusing to use $SDK_DIR as the SDK folder" ;;
esac

# ------------------------------------------------------------------ uninstall
if $UNINSTALL; then
    if [ ! -d "$SDK_DIR" ]; then
        say "nothing to remove: $SDK_DIR does not exist"
        exit 0
    fi
    [ -f "$SDK_DIR/$MARKER" ] || [ -f "$SDK_DIR/.starpoint-sdk" ] || die "$SDK_DIR was not created by this script (no $MARKER); remove it by hand"
    printf 'Delete %s and everything in it? [y/N] ' "$SDK_DIR"
    read -r answer
    case "$answer" in
        y|Y|yes) rm -rf "$SDK_DIR"; say "removed $SDK_DIR" ;;
        *) say "cancelled"; exit 0 ;;
    esac
    say "Also created on use, remove if you want:"
    say "  ~/.android                         (adb keys, sdkmanager cache)"
    say "  ~/.config/starpoint/air-shell.p12  (the shell's signing key)"
    say "  client/air-shell/build/            (build output)"
    exit 0
fi

# ------------------------------------------------------------------ checks
[ "$(uname -s)" = Linux ] || die "this script supports Linux only"
[ "$(uname -m)" = x86_64 ] || die "this script supports x86_64 only"
for tool in curl tar unzip python3 sha1sum sha256sum; do need "$tool"; done
if $WITH_NODE; then need xz; fi

DL="$SDK_DIR/.downloads"

# Prints "<url> <sha256> <filename>" for the latest Temurin 17 JDK.
resolve_jdk() {
    curl -fsSL "https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&image_type=jdk&os=linux&vendor=eclipse" |
        python3 -I -c 'import json,sys; p=json.load(sys.stdin)[0]["binary"]["package"]; print(p["link"], p["checksum"], p["name"])'
}

# Prints "<url> <sha1> <filename>" for the latest stable Android command-line tools.
resolve_cmdtools() {
    curl -fsSL "https://dl.google.com/android/repository/repository2-3.xml" | python3 -I -c '
import sys, xml.etree.ElementTree as ET
root = ET.parse(sys.stdin).getroot()
def local(tag): return tag.rsplit("}", 1)[-1]
best = None
for pkg in root.iter():
    if local(pkg.tag) != "remotePackage" or not pkg.get("path", "").startswith("cmdline-tools;"):
        continue
    channel = next((c.get("ref") for c in pkg.iter() if local(c.tag) == "channelRef"), "channel-0")
    if channel != "channel-0":
        continue
    for archive in (a for a in pkg.iter() if local(a.tag) == "archive"):
        host = next((h.text for h in archive.iter() if local(h.tag) == "host-os"), None)
        if host != "linux":
            continue
        url = next(u.text for u in archive.iter() if local(u.tag) == "url")
        sha1 = next(c.text for c in archive.iter() if local(c.tag) == "checksum")
        rank = 1 if pkg.get("path") == "cmdline-tools;latest" else 0
        if best is None or rank > best[0]:
            best = (rank, url, sha1)
if best is None:
    sys.exit("no stable linux cmdline-tools package found")
print("https://dl.google.com/android/repository/" + best[1], best[2], best[1])
'
}

# Prints "<url> <sha256> <filename>" for the latest Node 22 linux-x64 tarball.
resolve_node() {
    base="https://nodejs.org/dist/latest-v22.x"
    curl -fsSL "$base/SHASUMS256.txt" |
        awk -v base="$base" '$2 ~ /^node-v22\.[0-9.]+-linux-x64\.tar\.xz$/ { print base "/" $2, $1, $2; exit }'
}

# fetch <url> <checksum> <algo: sha1|sha256> <file>
fetch() {
    say "downloading $4"
    curl -fL --retry 3 --progress-bar -o "$DL/$4" "$1"
    printf '%s  %s\n' "$2" "$DL/$4" | "${3}sum" -c --quiet - || die "checksum mismatch for $4"
}

# Moves the single top-level folder of an extracted archive to <dest>.
move_single_dir() {
    set -- "$1" "$2" "$1"/*
    [ $# -eq 3 ] && [ -d "$3" ] || die "unexpected archive layout in $1"
    mv "$3" "$2"
    rmdir "$1"
}

if $DRY_RUN; then
    say "dry run: SDK folder would be $SDK_DIR"
    say "JDK:           $(resolve_jdk)"
    say "Android tools: $(resolve_cmdtools)"
    if $WITH_NODE; then say "Node 22:       $(resolve_node)"; fi
    exit 0
fi

mkdir -p "$SDK_DIR" "$DL"
touch "$SDK_DIR/$MARKER"

# ------------------------------------------------------------------ JDK
if [ -x "$SDK_DIR/jdk/bin/javac" ]; then
    say "JDK already installed"
else
    set -- $(resolve_jdk)
    fetch "$1" "$2" sha256 "$3"
    rm -rf "$SDK_DIR/.tmp-jdk" && mkdir "$SDK_DIR/.tmp-jdk"
    tar -xzf "$DL/$3" -C "$SDK_DIR/.tmp-jdk"
    move_single_dir "$SDK_DIR/.tmp-jdk" "$SDK_DIR/jdk"
    say "JDK installed: $("$SDK_DIR/jdk/bin/java" -version 2>&1 | head -n 1)"
fi

# ------------------------------------------------------------------ Android command-line tools
SDKMANAGER="$SDK_DIR/android/cmdline-tools/latest/bin/sdkmanager"
if [ -x "$SDKMANAGER" ]; then
    say "Android command-line tools already installed"
else
    set -- $(resolve_cmdtools)
    fetch "$1" "$2" sha1 "$3"
    rm -rf "$SDK_DIR/.tmp-cmdtools" && mkdir -p "$SDK_DIR/.tmp-cmdtools" "$SDK_DIR/android/cmdline-tools"
    unzip -q "$DL/$3" -d "$SDK_DIR/.tmp-cmdtools"
    move_single_dir "$SDK_DIR/.tmp-cmdtools" "$SDK_DIR/android/cmdline-tools/latest"
    say "Android command-line tools installed"
fi

# ------------------------------------------------------------------ env.sh
cat > "$SDK_DIR/env.sh" <<EOF
# Source this file (. $SDK_DIR/env.sh) to use the AIR shell build tools in this terminal only.
export SDK_WF="$SDK_DIR"
export JAVA_HOME="\$SDK_WF/jdk"
export ANDROID_HOME="\$SDK_WF/android"
export AIR_HOME="\$SDK_WF/air"
PATH="\$JAVA_HOME/bin:\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/cmdline-tools/latest/bin:\$PATH"
if [ -d "\$SDK_WF/node/bin" ]; then PATH="\$SDK_WF/node/bin:\$PATH"; fi
if [ -d "\$SDK_WF/bin" ]; then PATH="\$SDK_WF/bin:\$PATH"; fi
export PATH
EOF
# shellcheck disable=SC1091
. "$SDK_DIR/env.sh"

# ------------------------------------------------------------------ adb + Android platform
if [ -x "$ANDROID_HOME/platform-tools/adb" ] && [ -f "$ANDROID_HOME/platforms/android-34/android.jar" ] &&
    [ -x "$ANDROID_HOME/build-tools/34.0.0/aapt" ]; then
    say "platform-tools, $ANDROID_PLATFORM and $ANDROID_BUILD_TOOLS already installed"
else
    ANDROID_CLI="$(dirname "$SDKMANAGER")/android"
    if [ -x "$ANDROID_CLI" ]; then
        # Newer command-line tools turn sdkmanager into a wrapper of the Android CLI, which shows Google's
        # terms instead of asking, and sends usage data unless --no-metrics is given.
        say "installing the Android SDK packages means accepting Google's Android SDK terms (linked below)"
        "$ANDROID_CLI" --no-metrics --sdk="$ANDROID_HOME" sdk install "platform-tools" "$ANDROID_PLATFORM" "$ANDROID_BUILD_TOOLS"
    else
        say "accept the Android SDK licences to continue (they are shown below)"
        "$SDKMANAGER" --sdk_root="$ANDROID_HOME" --licenses
        "$SDKMANAGER" --sdk_root="$ANDROID_HOME" "platform-tools" "$ANDROID_PLATFORM" "$ANDROID_BUILD_TOOLS"
    fi
fi

# ------------------------------------------------------------------ AIR SDK Manager (optional)
MANAGER_BIN="$SDK_DIR/manager/AIRSDKManager"
if [ -n "$MANAGER_ZIP" ]; then
    [ -f "$MANAGER_ZIP" ] || die "no such file: $MANAGER_ZIP"
    if [ -x "$MANAGER_BIN" ]; then
        say "AIR SDK Manager already unpacked"
    else
        rm -rf "$SDK_DIR/.tmp-manager" && mkdir "$SDK_DIR/.tmp-manager"
        unzip -q "$MANAGER_ZIP" -d "$SDK_DIR/.tmp-manager"
        move_single_dir "$SDK_DIR/.tmp-manager" "$SDK_DIR/manager"
        [ -x "$MANAGER_BIN" ] || die "$MANAGER_ZIP has no AIRSDKManager launcher; is it the AIR SDK Manager?"
        say "AIR SDK Manager unpacked to $SDK_DIR/manager"
    fi
fi

# The manager's AIR runtime links libxml2.so.2. Arch's libxml2 >= 2.14 only ships
# libxml2.so.16, so take libxml2.so.2 from Arch's libxml2-legacy package into DIR/lib
# (checksum from the official repo database) and start the manager through a wrapper.
fetch_arch_libxml2() {
    mirror="https://geo.mirror.pkgbuild.com/extra/os/x86_64"
    need zstd
    rm -rf "$SDK_DIR/.tmp-libxml2" && mkdir "$SDK_DIR/.tmp-libxml2"
    curl -fsSL -o "$DL/extra.db" "$mirror/extra.db"
    tar -xf "$DL/extra.db" -C "$SDK_DIR/.tmp-libxml2" --wildcards 'libxml2-legacy-*/desc' ||
        die "libxml2-legacy is not in Arch's extra repo any more; install libxml2.so.2 another way"
    desc="$(ls "$SDK_DIR"/.tmp-libxml2/libxml2-legacy-*/desc)"
    file="$(awk '/^%FILENAME%$/{getline; print; exit}' "$desc")"
    sum="$(awk '/^%SHA256SUM%$/{getline; print; exit}' "$desc")"
    [ -n "$file" ] && [ -n "$sum" ] || die "could not read libxml2-legacy from the repo database"
    fetch "$mirror/$file" "$sum" sha256 "$file"
    mkdir -p "$SDK_DIR/lib"
    tar -xf "$DL/$file" -C "$SDK_DIR/.tmp-libxml2" --wildcards 'usr/lib/libxml2.so.2*'
    cp -P "$SDK_DIR"/.tmp-libxml2/usr/lib/libxml2.so.2* "$SDK_DIR/lib/"
    rm -rf "$SDK_DIR/.tmp-libxml2"
    say "libxml2.so.2 (from $file) placed in $SDK_DIR/lib"
}

if [ -x "$MANAGER_BIN" ]; then
    if ldconfig -p 2>/dev/null | grep -q 'libxml2\.so\.2 ' || [ -e "$SDK_DIR/lib/libxml2.so.2" ]; then
        :
    elif command -v pacman >/dev/null 2>&1; then
        fetch_arch_libxml2
    else
        say "warning: libxml2.so.2 is missing; install your distro's libxml2 2.13 / legacy package"
    fi
    mkdir -p "$SDK_DIR/bin"
    cat > "$SDK_DIR/bin/airsdkmanager" <<EOF
#!/bin/sh
# Starts the AIR SDK Manager with the libraries setup-sdk.sh placed in $SDK_DIR/lib.
LD_LIBRARY_PATH="$SDK_DIR/lib\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}" exec "$MANAGER_BIN" "\$@"
EOF
    chmod +x "$SDK_DIR/bin/airsdkmanager"
    MANAGER_BIN="$SDK_DIR/bin/airsdkmanager"
fi

# ------------------------------------------------------------------ AIR SDK
if [ -n "$AIR_DIR" ]; then
    case "$AIR_DIR" in /*) ;; *) AIR_DIR="$(pwd)/$AIR_DIR" ;; esac
    [ -f "$AIR_DIR/lib/adt.jar" ] || die "$AIR_DIR has no lib/adt.jar; pass the SDK version folder itself"
    if [ -e "$AIR_HOME" ] && [ ! -L "$AIR_HOME" ]; then
        die "$AIR_HOME already holds an SDK; remove it first to link $AIR_DIR instead"
    fi
    ln -sfn "$AIR_DIR" "$AIR_HOME"
    say "AIR SDK linked: $AIR_HOME -> $AIR_DIR"
fi
# The AIR SDK ships macOS binaries under the plain names (aapt, adb, ...) and Linux ones as
# *_linux64; its bin/configure_linux.sh relinks them but breaks when called by absolute path.
# Make the same links here, inside the SDK only.
configure_air_linux() {
    for spec in bin:adl:adl_linux64 lib:FlashRuntimeExtensions.so:FlashRuntimeExtensions_linux64.so \
        lib/nai/bin:naip:naip_linux64 runtimes/air:linux:linux-x64 lib/android/bin:adb:adb_linux64 \
        lib/android/bin:aapt:aapt_linux64 lib/android/bin:aapt2:aapt2_linux64; do
        dir="$AIR_HOME/${spec%%:*}"; rest="${spec#*:}"; name="${rest%%:*}"; target="${rest#*:}"
        # leave real directories alone (runtimes/air/linux is the desktop runtime, unused here)
        if [ -d "$dir/$name" ] && [ ! -L "$dir/$name" ]; then continue; fi
        # aapt points at build-tools below; relinking it first only flips it back and forth
        if [ "$name" = aapt ] && [ -x "$ANDROID_HOME/build-tools/34.0.0/aapt" ]; then continue; fi
        if [ -e "$dir/$target" ] && [ "$(readlink "$dir/$name" 2>/dev/null)" != "$target" ]; then
            rm -f "$dir/$name"
            ln -s "$target" "$dir/$name"
            say "AIR SDK: $name -> $target"
        fi
    done
    # The SDK's aapt_linux64 needs a libc++ symbol its bundled lib64/libc++.so lacks
    # ("undefined symbol ...basic_ostringstream..."). Use the Android build-tools aapt, which
    # ships with its matching libc++.
    bt_aapt="$ANDROID_HOME/build-tools/34.0.0/aapt"
    if [ -x "$bt_aapt" ] && [ "$(readlink "$AIR_HOME/lib/android/bin/aapt")" != "$bt_aapt" ]; then
        rm -f "$AIR_HOME/lib/android/bin/aapt"
        ln -s "$bt_aapt" "$AIR_HOME/lib/android/bin/aapt"
        say "AIR SDK: aapt -> $bt_aapt"
    fi
}

air_licence_note() {
    say "AIR SDK licence: you must have accepted it yourself (AIR SDK Manager or airsdk.wxlift.com);"
    say "  the free tier keeps the AIR splash screen. Terms and conditions: docs/air-licence.md"
}

if [ -f "$AIR_HOME/lib/adt.jar" ]; then
    configure_air_linux
    say "AIR SDK ready at $AIR_HOME"
    air_licence_note
elif [ -n "$AIR_ZIP" ]; then
    [ -f "$AIR_ZIP" ] || die "no such file: $AIR_ZIP"
    rm -rf "$SDK_DIR/.tmp-air" && mkdir "$SDK_DIR/.tmp-air"
    unzip -q "$AIR_ZIP" -d "$SDK_DIR/.tmp-air"
    adt="$(find "$SDK_DIR/.tmp-air" -path '*/lib/adt.jar' | head -n 1)"
    [ -n "$adt" ] || die "$AIR_ZIP does not contain lib/adt.jar; is it the AIR SDK?"
    mv "$(dirname "$(dirname "$adt")")" "$AIR_HOME"
    rm -rf "$SDK_DIR/.tmp-air"
    configure_air_linux
    say "AIR SDK installed"
    air_licence_note
elif [ -x "$MANAGER_BIN" ]; then
    mkdir -p "$SDK_DIR/air-sdks"
    say "AIR SDK not downloaded yet. Start the manager:  $MANAGER_BIN"
    say "  accept the licence, choose the install folder $SDK_DIR/air-sdks, install an AIR SDK, then rerun:"
    say "  $0 --dir $SDK_DIR --air-dir $SDK_DIR/air-sdks/<version>"
else
    say "AIR SDK not installed yet: download the AIR SDK Manager from https://airsdk.wxlift.com/download"
    say "  then rerun:  $0 --dir $SDK_DIR --manager-zip /path/to/AIRSDKManager_linux_amd64_*.zip"
fi

# ------------------------------------------------------------------ Node 22 (optional)
if $WITH_NODE; then
    if [ -x "$SDK_DIR/node/bin/node" ]; then
        say "Node already installed"
    else
        set -- $(resolve_node)
        [ $# -eq 3 ] || die "could not resolve the Node 22 download"
        fetch "$1" "$2" sha256 "$3"
        rm -rf "$SDK_DIR/.tmp-node" && mkdir "$SDK_DIR/.tmp-node"
        tar -xJf "$DL/$3" -C "$SDK_DIR/.tmp-node"
        move_single_dir "$SDK_DIR/.tmp-node" "$SDK_DIR/node"
        say "Node installed: $("$SDK_DIR/node/bin/node" --version) (run 'npm ci' in the repo after sourcing env.sh)"
    fi
fi

rm -rf "$DL"
say "done. Use the tools with:  . $SDK_DIR/env.sh"
say "remove everything with:    $0 --uninstall --dir $SDK_DIR"
