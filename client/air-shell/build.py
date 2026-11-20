#!/usr/bin/env python3
"""Build the Reflipped AIR shell: the original World Flipper SWF in a new APK with our own ANEs.

    python3 -I build.py --apk World_Flipper_0.0.81.apk
    python3 -I build.py --apk World_Flipper_0.0.81.apk --server http://192.168.1.10:8000   # fixed server, no prompt

Needs: Python 3.8+, a JDK (javac), the HARMAN AIR SDK (AIR_HOME) and an Android platform jar
(ANDROID_HOME/platforms/android-*/android.jar). `--stage-only` runs the steps that need none of
them (extract, icons, descriptors) so the output can be inspected first; it leaves out the extensions'
ActionScript libraries, which the AIR SDK's compiler builds from as3/.

Game files are read from the APK you pass in and only written under build/ (gitignored).
See README.md and docs/air-shell.md.
"""
import argparse
import concurrent.futures
import datetime
import json
import math
from urllib.parse import urlsplit
import glob
import hashlib
import importlib.util
import os
import shutil
import struct
import subprocess
import sys
import zipfile
import re
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "build")
DEFAULT_SERVERS = os.path.join(HERE, "community-servers.json")
JAVA_SRC = os.path.join(HERE, "java", "src")
# Each extension's ActionScript side, our own code: as3/<extension id>/<package path>/<Class>.as
AS3_SRC = os.path.join(HERE, "as3")
DESCRIPTOR = os.path.join(HERE, "descriptor", "application.xml")
# SH-15: the Reflipped app's own version (see app_version). The game keeps reporting 0.0.81: it sends the version
# compiled into its SWF (BuildInfo.versionNumber), never the AIR descriptor's.
VERSION_FILE = os.path.join(HERE, "VERSION")
# Every build before SH-15 had versionNumber 0.0.81, so Android version code 81; an update must have a higher one.
LEGACY_VERSION_CODE = 81
# The app version scheme. This file is its source; the app (java/.../common/AppVersion.java) and the server
# (src/lib/appVersion.ts) follow it. A version is MAJOR.MINOR.PATCH with an optional pre-release -alpha, -beta or
# -pre, optionally followed by .N: 0.2.0, 0.2.0-alpha, 0.2.0-beta.3, 1.0.0-pre.1. Leading zeros are dropped; anything
# else is refused. Its Android version code orders versions as semver does
# (0.2.0-alpha < 0.2.0-alpha.1 < 0.2.0-beta < 0.2.0-pre.1 < 0.2.0 < 0.2.1-alpha < 0.2.1):
#     code = MAJOR * 1000000 + MINOR * 10000 + PATCH * 100 + stage
# with stage alpha.N = N, beta.N = 30 + N, pre.N = 60 + N (a missing N is 0) and 99 for a final release.
APP_VERSION = re.compile(r"([0-9]{1,6})\.([0-9]{1,6})\.([0-9]{1,6})(?:-(alpha|beta|pre)(?:\.([0-9]{1,6}))?)?")
STAGE_BASE = {"alpha": 0, "beta": 30, "pre": 60}
# MAJOR stops at 999 because ADT accepts versionNumber parts of at most three digits (the code's MAJOR becomes the
# versionNumber's first part); that also keeps the code below Android's largest, 2100000000.
MAX_MAJOR, MAX_MINOR, MAX_PATCH, MAX_STAGE_NUMBER, FINAL_STAGE = 999, 99, 99, 29, 99

# The only files taken from the original APK (the extensions' libraries and the icons are our own, from as3/ and
# icon/). bundle.zip is loaded from File.applicationDirectory.
APK_FILES = {
    "assets/worldflipper_android_release.swf": "worldflipper_android_release.swf",
    "assets/bundle.zip": "bundle.zip",
    "assets/bundle.zip.sha1": "bundle.zip.sha1",
}
ICON_FILES = [f"icon{s}.png" for s in (36, 48, 72, 96, 144, 192)]

# Extension ID -> (initializer class, class-file prefixes that go into this ANE's jar).
# Every class must land in exactly one jar: adt dexes all ANE jars into one app.
EXTENSIONS = {
    "com.sesisoft.KakaoGameSdk": ("reflipped.shell.kakao.KakaoGameSdkStub",
                                  ["reflipped/shell/kakao/", "reflipped/shell/common/"]),
    "com.sesisoft.gxshield": ("reflipped.shell.gxshield.GxShieldStub", ["reflipped/shell/gxshield/"]),
    "com.sesisoft.PushService": ("reflipped.shell.other.PushServiceStub", ["reflipped/shell/other/PushServiceStub",
                                                                          "reflipped/shell/other/LocalNotification"]),
    "com.sesisoft.SingularSdk": ("reflipped.shell.other.SingularSdkStub", ["reflipped/shell/other/SingularSdkStub"]),
    "com.distriqt.InAppBilling": ("reflipped.shell.other.InAppBillingStub", ["reflipped/shell/other/InAppBillingStub"]),
    "com.distriqt.GameServices": ("reflipped.shell.other.GameServicesStub", ["reflipped/shell/other/GameServicesStub"]),
    "com.distriqt.Core": ("reflipped.shell.other.DistriqtCoreStub", ["reflipped/shell/other/DistriqtCoreStub"]),
    "com.distriqt.Application": ("reflipped.shell.other.DistriqtApplicationStub",
                                 ["reflipped/shell/other/DistriqtApplicationStub"]),
    "com.distriqt.Battery": ("reflipped.shell.other.DistriqtBatteryStub", ["reflipped/shell/other/DistriqtBatteryStub"]),
    "com.digitalstrawberry.ane.share": ("reflipped.shell.other.ShareStub", ["reflipped/shell/other/ShareStub"]),
    # AssetDownloadStub, AssetDownloader, and the extraction and game data pack installer they share (SH-25), and the
    # record of what server layers changed (SH-27) and the export of the game data (SH-29)
    "pinball.assetDownload": ("reflipped.shell.pinball.AssetDownloadStub", ["reflipped/shell/pinball/AssetDownload",
                                                                            "reflipped/shell/pinball/ArchiveExtractor",
                                                                            "reflipped/shell/pinball/LayerRecord",
                                                                            "reflipped/shell/pinball/GameFilesExport",
                                                                            "reflipped/shell/pinball/GamePack",
                                                                            "reflipped/shell/pinball/CdnCopy"]),
    "pinball.ane.getbuild": ("reflipped.shell.pinball.GetBuildStub", ["reflipped/shell/pinball/GetBuildStub"]),
    "pinball.checkapp": ("reflipped.shell.pinball.CheckAppStub", ["reflipped/shell/pinball/CheckAppStub"]),
    "pinball.screen": ("reflipped.shell.pinball.ScreenStub", ["reflipped/shell/pinball/ScreenStub"]),
    "pinball.vibration": ("reflipped.shell.pinball.VibrationStub", ["reflipped/shell/pinball/VibrationStub"]),
    # Ours, not the game's (SH-13): carries the server on the phone, its native libraries and its service, and the
    # asset download's service (SH-7)
    "reflipped.localserver": ("reflipped.shell.service.LocalServerExtension", ["reflipped/shell/service/"]),
}
# Exact platform names from AIR 51.5.1's com.adobe.air.Platforms. Java-only ANEs serve all four ABIs.
ANDROID_PLATFORM_BY_ARCH = {"armv8": "Android-ARM64", "armv7": "Android-ARM",
                            "x86": "Android-x86", "x64": "Android-x64"}
ANDROID_PLATFORMS = list(ANDROID_PLATFORM_BY_ARCH.values())
# adt merges an extension's android/res into the app; the adaptive launcher icon travels in this one
ICON_ANE = "pinball.screen"
# SH-13, the server on the phone: this extension's android/libs/<abi>/ holds Node and our launcher (adt puts them in
# the APK's lib/<abi>/), and the server bundle rides along as an application file (assets/<name> in the APK)
LOCAL_SERVER_ANE = "reflipped.localserver"
SERVER_ZIP = "reflipped-server.zip"
# nodejs-mobile ships arm64-v8a, armeabi-v7a and x86_64; there is no Node for 32-bit x86
NODE_ABI_BY_ARCH = {"armv8": "arm64-v8a", "armv7": "armeabi-v7a", "x64": "x86_64"}
REPO = os.path.dirname(os.path.dirname(HERE))


def log(msg):
    print(f"[air-shell] {msg}", flush=True)


def run(cmd, **kw):
    log("$ " + " ".join(cmd))
    subprocess.run(cmd, check=True, **kw)


# ---------------------------------------------------------------- extension descriptors and AS3 libraries

def extension_xml(ext_id, initializer, jar, ns):
    platforms = "".join(
        f'    <platform name="{p}">\n'
        f'      <applicationDeployment>\n'
        f'        <nativeLibrary>{jar}</nativeLibrary>\n'
        f'        <initializer>{escape(initializer)}</initializer>\n'
        f'      </applicationDeployment>\n'
        f'    </platform>\n' for p in ANDROID_PLATFORMS)
    return (f'<?xml version="1.0" encoding="utf-8"?>\n'
            f'<extension xmlns="http://ns.adobe.com/air/extension/{ns}">\n'
            f'  <id>{ext_id}</id>\n'
            f'  <versionNumber>1.0.0</versionNumber>\n'
            f'  <platforms>\n{platforms}'
            f'    <platform name="default"><applicationDeployment/></platform>\n'
            f'  </platforms>\n'
            f'</extension>\n')


def compile_wrappers(home, ane_root):
    """Compile each extension's AS3 side (as3/<extension id>/) into its library.swf and library.swc.

    AIR only accepts ExtensionContext.createExtensionContext from code in the extension's own library.swf, and the
    classes there win over the game's built-in copies, so each library defines the wrapper classes the game calls
    (docs/air-shell-internals.md, "Extension libraries"). acompc (the AIR SDK's compc) writes a .swc whose
    library.swf (ABC 46.16) goes into the ANE; the .swc itself is the ANE's -swc.
    """
    jar = os.path.join(home, "lib", "compc-cli.jar")
    if not os.path.exists(jar):
        sys.exit(f"Missing {jar}: the AIR SDK's ActionScript compiler (acompc)")
    out = os.path.join(BUILD, "as3")
    shutil.rmtree(out, ignore_errors=True)

    def one(ext_id):
        src = os.path.join(AS3_SRC, ext_id)
        if not glob.glob(os.path.join(src, "**", "*.as"), recursive=True):
            return ext_id, f"no ActionScript sources in {src}"
        os.makedirs(os.path.join(out, ext_id))
        swc = os.path.join(out, ext_id, "library.swc")
        # what bin/acompc runs, without relying on the SDK's shell scripts being executable
        cmd = ["java", "-Xmx512m", f"-Dflexlib={os.path.join(home, 'frameworks')}", "-jar", jar,
               "+configname=airmobile", "-swf-version=51", "-source-path", src, "-include-sources", src,
               "-output", swc]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0 or not os.path.exists(swc):
            return ext_id, "$ " + " ".join(cmd) + "\n" + result.stdout + result.stderr
        with zipfile.ZipFile(swc) as z:
            swf = z.read("library.swf")
        d = os.path.join(ane_root, ext_id)
        for sub in ("android", "default"):
            with open(os.path.join(d, sub, "library.swf"), "wb") as f:
                f.write(swf)
        shutil.copy(swc, os.path.join(d, "library.swc"))
        return ext_id, None

    # one JVM per library; they're independent, so run a few at once
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 1)) as pool:
        failures = [(ext_id, error) for ext_id, error in pool.map(one, EXTENSIONS) if error]
    for ext_id, error in failures:
        log(f"{ext_id}: compiling its ActionScript library failed\n{error}")
    if failures:
        sys.exit(f"{len(failures)} extension libraries didn't compile")
    log(f"compiled {len(EXTENSIONS)} extension libraries from {AS3_SRC}")


# ---------------------------------------------------------------- steps

def extract(apk):
    app = os.path.join(BUILD, "app")
    os.makedirs(app, exist_ok=True)
    with zipfile.ZipFile(apk) as z:
        names = set(z.namelist())
        for src, dst in APK_FILES.items():
            if src not in names:
                sys.exit(f"{apk} has no {src}: is this the World Flipper APK?")
            with z.open(src) as fin, open(os.path.join(app, dst), "wb") as fout:
                shutil.copyfileobj(fin, fout)
    with open(os.path.join(app, "bundle.zip"), "rb") as f:
        digest = hashlib.sha1(f.read()).hexdigest()
    with open(os.path.join(app, "bundle.zip.sha1")) as f:
        expected = f.read().strip()
    if digest != expected:
        log(f"note: bundle.zip sha1 {digest} differs from bundle.zip.sha1 ({expected}); the original APK ships the same pair")
    log(f"extracted game files to {app}")
    subprocess.run([sys.executable, "-I", os.path.join(HERE, "tools", "make_logo.py"),
                    os.path.join(app, "bundle.zip")], check=True)
    subprocess.run([sys.executable, "-I", os.path.join(HERE, "tools", "patch_game.py"),
                    os.path.join(app, "worldflipper_android_release.swf")], check=True)


GAME_DATA_LISTS = "gamedata-lists"


def write_game_data_lists():
    """SH-29: the official archive lists (assets/asset_lists/<lang>-android-full.json) as the app reads them to install
    a copy of the .cdn folder: one "path<TAB>size<TAB>sha256" line per archive, the full set then every diff step, as
    scripts/gamepack.mjs lists them. Their digests are pinned in GamePack.java, so the app checks them itself."""
    out = os.path.join(BUILD, "app", GAME_DATA_LISTS)
    os.makedirs(out, exist_ok=True)
    for lang in ("en", "ko", "th"):
        with open(os.path.join(REPO, "assets", "asset_lists", f"{lang}-android-full.json"), encoding="utf-8") as f:
            listed = json.load(f)
        archives = list(listed["full"]["archive"])
        version = listed["full"]["version"]
        for step in listed["diff"]:
            if step["original_version"] != version:
                sys.exit(f"{lang}: diff {step['version']} doesn't follow {version}")
            archives += step["archive"]
            version = step["version"]
        prefix = "{$cdnAddress}/"
        with open(os.path.join(out, f"{lang}.tsv"), "w", encoding="utf-8", newline="\n") as f:
            for a in archives:
                if not a["location"].startswith(prefix):
                    sys.exit(f"{lang}: unexpected location {a['location']}")
                f.write(f"{a['location'][len(prefix):]}\t{a['size']}\t{a['sha256']}\n")


def draw_icons():
    """The launcher icons, drawn from the Reflipped mark (icon/reflipped.svg) by tools/make_icons.py."""
    subprocess.run([sys.executable, "-I", os.path.join(HERE, "tools", "make_icons.py"), os.path.join(BUILD, "app")],
                   check=True)


def parse_app_version(text):
    """(normalized text, Android version code) for an app version of the scheme above, or None."""
    match = APP_VERSION.fullmatch(text.strip())
    if not match:
        return None
    major, minor, patch = (int(part) for part in match.group(1, 2, 3))
    stage, number = match.group(4), match.group(5)
    if major > MAX_MAJOR or minor > MAX_MINOR or patch > MAX_PATCH or int(number or 0) > MAX_STAGE_NUMBER:
        return None
    normalized = f"{major}.{minor}.{patch}" + (f"-{stage}" if stage else "") + (f".{int(number)}" if number else "")
    stage_code = STAGE_BASE[stage] + int(number or 0) if stage else FINAL_STAGE
    return normalized, major * 1000000 + minor * 10000 + patch * 100 + stage_code


def version_code(version):
    """The Android version code of an app version (0.1.0 -> 10099, 0.2.0-beta.1 -> 20031)."""
    return parse_app_version(version)[1]


def version_number(version):
    """The descriptor's versionNumber for an app version: ADT makes the Android version code from versionNumber as
    MAJOR * 1000000 + MINOR * 1000 + PATCH (each part 0-999), so this is the triple that gives back version_code
    (0.1.0 -> 0.10.99)."""
    code = version_code(version)
    return f"{code // 1000000}.{code // 1000 % 1000}.{code % 1000}"


def app_version(text):
    """The normalized Reflipped app version, if it follows the scheme above and its version code is above every
    pre-SH-15 build's."""
    value = text.strip()
    parsed = parse_app_version(value)
    if parsed is None:
        raise argparse.ArgumentTypeError(f"app version {value!r} must be MAJOR.MINOR.PATCH, optionally with -alpha, "
                                         "-beta or -pre and .N, e.g. 0.2.0 or 0.2.0-beta.1 (MAJOR up to 999, "
                                         "MINOR and PATCH up to 99, N up to 29)")
    value, code = parsed
    if code <= LEGACY_VERSION_CODE:
        raise argparse.ArgumentTypeError(f"app version {value} gives Android version code {code}; builds before app "
                                         f"versions had {LEGACY_VERSION_CODE}, so this one couldn't update them")
    return value


def default_app_version():
    with open(VERSION_FILE, encoding="utf-8") as f:
        return app_version(f.read())


def git(*args):
    try:
        return subprocess.run(["git", "-C", HERE, *args], check=True, capture_output=True, text=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def build_id(server):
    """commit[-dirty].YYYYMMDD.baked|picker: the shell's source commit (REFLIPPED_COMMIT overrides it, e.g. in the
    container, which has no .git), the UTC build date, and whether a default server was baked in with --server."""
    commit = (os.environ.get("REFLIPPED_COMMIT") or "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{7,40}(-dirty)?", commit):
        head = git("rev-parse", "--short=12", "HEAD")
        if head:
            # tracked changes under client/air-shell only: the server code isn't in the APK
            commit = head + ("-dirty" if git("status", "--porcelain", "--untracked-files=no", "--", ".") else "")
        else:
            commit = "nogit"
    date = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d")
    return f"{commit}.{date}.{'baked' if server else 'picker'}"


def write_descriptor(app_id, version, build, name, server, cdn, ns, target_sdk):
    with open(DESCRIPTOR, encoding="utf-8") as f:
        text = f.read()
    exts = "\n".join(f"    <extensionID>{e}</extensionID>" for e in EXTENSIONS)
    for key, value in {"NS": ns, "APP_ID": app_id, "VERSION_NUMBER": version_number(version), "VERSION": version,
                       "BUILD": escape(build, {'"': "&quot;"}),
                       "NAME": escape(name),
                       "EXTENSIONS": exts, "SERVER": escape(server, {'"': "&quot;"}),
                       "CDN": escape(cdn, {'"': "&quot;"}),
                       "TARGET_SDK": str(target_sdk)}.items():
        text = text.replace("${" + key + "}", value)
    out = os.path.join(BUILD, "application.xml")
    with open(out, "w", encoding="utf-8") as f:
        f.write(text)
    log(f"wrote {out}")
    return out


def stage_anes(ns):
    """build/ane-src/<id>/: extension.xml and (in the icon's extension) the launcher icon resources.
    compile_wrappers adds library.swf/.swc and compile_java the jar."""
    root = os.path.join(BUILD, "ane-src")
    shutil.rmtree(root, ignore_errors=True)
    for ext_id, (initializer, _) in EXTENSIONS.items():
        d = os.path.join(root, ext_id)
        for sub in ("android", "default"):
            os.makedirs(os.path.join(d, sub), exist_ok=True)
        if ext_id == ICON_ANE:
            res = os.path.join(d, "android", "res")
            shutil.rmtree(res, ignore_errors=True)
            shutil.copytree(os.path.join(BUILD, "app", "res"), res)
        with open(os.path.join(d, "extension.xml"), "w", encoding="utf-8") as f:
            f.write(extension_xml(ext_id, initializer, jar_name(ext_id), ns))
    log(f"staged {len(EXTENSIONS)} extensions in {root}")
    return root


def jar_name(ext_id):
    # adt rejects some file names (e.g. with underscores) with "error 105"; the original
    # Sesisoft ANEs all use classes.jar, and each ANE is packaged from its own folder.
    return "classes.jar"


def android_jar():
    home = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if not home:
        sys.exit("Set ANDROID_HOME (needs platforms/android-*/android.jar)")
    jars = sorted(glob.glob(os.path.join(home, "platforms", "android-*", "android.jar")),
                  key=lambda p: int("".join(c for c in p.split("android-")[-1].split(os.sep)[0] if c.isdigit()) or 0))
    if not jars:
        sys.exit(f"No platforms/android-*/android.jar under {home} (install one with sdkmanager)")
    return jars[-1]


def air_home():
    home = os.environ.get("AIR_HOME")
    if not home or not os.path.exists(os.path.join(home, "lib", "adt.jar")):
        sys.exit("Set AIR_HOME to the HARMAN AIR SDK directory (the one containing lib/adt.jar)")
    return home


def adt(home, *args):
    run(["java", "-jar", os.path.join(home, "lib", "adt.jar"), *args])


def compile_java(home, ane_root):
    fre = os.path.join(home, "lib", "android", "FlashRuntimeExtensions.jar")
    if not os.path.exists(fre):
        sys.exit(f"Missing {fre}")
    classes = os.path.join(BUILD, "classes")
    shutil.rmtree(classes, ignore_errors=True)
    os.makedirs(classes)
    sources = java_sources()
    run(["javac", "-source", "8", "-target", "8", "-Xlint:-options", "-encoding", "UTF-8",
         "-cp", os.pathsep.join([android_jar(), fre]), "-d", classes, *sources])

    all_classes = sorted(os.path.relpath(p, classes).replace(os.sep, "/")
                         for p in glob.glob(os.path.join(classes, "**", "*.class"), recursive=True))
    used = set()
    for ext_id, (_, prefixes) in EXTENSIONS.items():
        mine = [c for c in all_classes if any(c.startswith(p) for p in prefixes) and c not in used]
        if not mine:
            sys.exit(f"No classes matched {ext_id}")
        used.update(mine)
        with zipfile.ZipFile(os.path.join(ane_root, ext_id, "android", jar_name(ext_id)), "w", zipfile.ZIP_DEFLATED) as z:
            for c in mine:
                z.write(os.path.join(classes, c), c)
    missing = set(all_classes) - used
    if missing:
        sys.exit(f"Classes not assigned to any ANE jar: {sorted(missing)}")
    log(f"compiled {len(all_classes)} classes into {len(EXTENSIONS)} jars")


def package_anes(home, ane_root, arch):
    out = os.path.join(BUILD, "anes")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    for ext_id in EXTENSIONS:
        d = os.path.join(ane_root, ext_id)
        platform_args = []
        for p in ANDROID_PLATFORMS:
            files = ["library.swf", jar_name(ext_id)] + (["res"] if ext_id == ICON_ANE else [])
            files += native_lib_files(ane_root, ext_id, p, arch)
            platform_args += ["-platform", p, "-C", os.path.join(d, "android"), *files]
        adt(home, "-package", "-target", "ane", os.path.join(out, ext_id + ".ane"), os.path.join(d, "extension.xml"),
            "-swc", os.path.join(d, "library.swc"), *platform_args,
            "-platform", "default", "-C", os.path.join(d, "default"), "library.swf")
    return out


def keystore(home):
    # The path and password keep the project's old name: installed builds only accept updates signed with this key.
    path = os.environ.get("SHELL_KEYSTORE") or os.path.expanduser("~/.config/starpoint/air-shell.p12")
    password = os.environ.get("SHELL_KEYSTORE_PASS", "starpoint")
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        adt(home, "-certificate", "-cn", "Reflipped AIR shell", "2048-RSA", path, password)
        log(f"created signing key {path}")
    return path, password


# Opt-in diagnostics read by tools/patch_game.py; they change the game's code, so a release build must not carry them.
DEBUG_ENV_VARS = ("REFLIPPED_TRACE_ASSETS", "REFLIPPED_READY_SECONDS")


def warn_debug_env(debug):
    if debug:
        return
    for name in DEBUG_ENV_VARS:
        if os.environ.get(name):
            log(f"WARNING: {name} is set, so this build (not --debug) contains its diagnostic patch; "
                f"unset it for a build you hand out")


def dex_defined_classes(data):
    """Read actual DEX class definitions, not incidental descriptor strings in constants or resources."""
    if len(data) < 112 or not data.startswith(b"dex\n") or struct.unpack_from("<I", data, 40)[0] != 0x12345678:
        raise ValueError("Unsupported DEX header")
    string_count, string_offset = struct.unpack_from("<II", data, 56)
    type_count, type_offset = struct.unpack_from("<II", data, 64)
    class_count, class_offset = struct.unpack_from("<II", data, 96)
    result = set()
    for index in range(class_count):
        type_index = struct.unpack_from("<I", data, class_offset + index * 32)[0]
        if type_index >= type_count:
            raise ValueError("Invalid DEX class type")
        string_index = struct.unpack_from("<I", data, type_offset + type_index * 4)[0]
        if string_index >= string_count:
            raise ValueError("Invalid DEX class descriptor")
        offset = struct.unpack_from("<I", data, string_offset + string_index * 4)[0]
        for _ in range(5):
            value = data[offset]
            offset += 1
            if value < 128:
                break
        else:
            raise ValueError("Invalid DEX string length")
        result.add(data[offset:data.index(b"\0", offset)].decode("utf-8"))
    return result


def validate_packaged_extensions(apk, arch):
    """ADT can silently select AS3-only default ANEs: reject that unusable package before reporting success."""
    platform = ANDROID_PLATFORM_BY_ARCH[arch]
    with zipfile.ZipFile(apk) as package:
        classes = set()
        for name in package.namelist():
            if re.fullmatch(r"classes(?:\d+)?\.dex", name):
                classes.update(dex_defined_classes(package.read(name)))
        for ext_id, (initializer, _) in EXTENSIONS.items():
            base = f"assets/META-INF/AIR/extensions/{ext_id}/META-INF/ANE/"
            if base + platform + "/library.swf" not in package.namelist():
                raise ValueError(f"{ext_id}: missing {platform} implementation (default fallback is not supported)")
            descriptor = ET.fromstring(package.read(base + "extension.xml"))
            deployment = descriptor.find(f"{{*}}platforms/{{*}}platform[@name='{platform}']/{{*}}applicationDeployment")
            if deployment is None or deployment.findtext("{*}initializer") != initializer \
                    or deployment.findtext("{*}nativeLibrary") != jar_name(ext_id):
                raise ValueError(f"{ext_id}: missing native initializer/library for {platform}")
            if "L" + initializer.replace(".", "/") + ";" not in classes:
                raise ValueError(f"{ext_id}: native initializer is not defined in packaged DEX")


def package_apk(home, descriptor, anes, out, arch, debug_port=None, content_files=None):
    store, password = keystore(home)
    log(f"signing with {store}: keep this file, a build signed with another key can't update an installed app")
    app = os.path.join(BUILD, "app")
    # apk-debug waits for fdb on debug_port (adb forward tcp:P tcp:P; fdb -p P): shows AS3
    # traces and uncaught errors, which the release runtime swallows.
    target = ["-target", "apk-debug", "-listen", str(debug_port)] if debug_port else ["-target", "apk-captive-runtime"]
    server = [SERVER_ZIP] if os.path.exists(os.path.join(app, SERVER_ZIP)) else []
    adt(home, "-package", *target, "-arch", arch,
        "-storetype", "pkcs12", "-keystore", store, "-storepass", password,
        out, descriptor, "-extdir", anes,
        "-C", app, *(content_files or APK_FILES.values()), "servers.json", GAME_DATA_LISTS, *ICON_FILES, *server)
    validate_packaged_extensions(out, arch)
    log(f"verified native ANEs for {ANDROID_PLATFORM_BY_ARCH[arch]}")
    log(f"built {out}")


# ---------------------------------------------------------------- the server on the phone (SH-13)

def native_lib_files(ane_root, ext_id, platform, arch):
    """The local-server extension's libs/ folder, for the build's own platform only: one ABI per APK."""
    if ext_id != LOCAL_SERVER_ANE or platform != ANDROID_PLATFORM_BY_ARCH[arch]:
        return []
    return ["libs"] if os.path.isdir(os.path.join(ane_root, ext_id, "android", "libs")) else []


def stage_node_libs(ane_root, arch):
    """Node for the build's ABI into the local-server extension's android/libs/<abi>/ (tools/node_runtime.py downloads
    and checks it, and compiles the launcher)."""
    abi = NODE_ABI_BY_ARCH.get(arch)
    if abi is None:
        sys.exit(f"--arch {arch}: nodejs-mobile has no Node for it; build with --no-node")
    libs = os.path.join(ane_root, LOCAL_SERVER_ANE, "android", "libs", abi)
    subprocess.run([sys.executable, "-I", os.path.join(HERE, "tools", "node_runtime.py"), "--abi", abi,
                    "--out", libs], check=True)


def server_bundle(prebuilt, game_data):
    """The server bundle's folder: --server-bundle, or `npm run bundle` in the repository this shell is part of. Without
    `game_data` it is a `--no-assets` bundle, which reads the converted game data from the data pack (DATA_PACK_DIR):
    a bundle that expects assets/ beside it would crash at start, since the app doesn't carry them."""
    if prebuilt:
        server_js = os.path.join(prebuilt, "server.js")
        if not os.path.isfile(server_js):
            sys.exit(f"--server-bundle {prebuilt}: no server.js there (make it with `npm run bundle`)")
        with open(server_js, "rb") as f:
            reads_beside = b'"./assets/' in f.read()
        if reads_beside and not game_data:
            sys.exit(f"--server-bundle {prebuilt} reads its game data from assets/ beside it, which the app doesn't "
                     "carry: make it with `npm run bundle -- --no-assets`, or pass --server-game-data")
        if game_data and not reads_beside:
            sys.exit(f"--server-bundle {prebuilt} reads its game data from the data pack (--no-assets): make it "
                     "without --no-assets for --server-game-data")
        return prebuilt
    if not os.path.isfile(os.path.join(REPO, "package.json")) or not os.path.isdir(os.path.join(REPO, "src")):
        sys.exit("The app carries the Reflipped server, but the server's sources aren't beside this folder: pass "
                 "--server-bundle <folder from `npm run bundle -- --no-assets`>, or --no-node for a build without it")
    if not os.path.isdir(os.path.join(REPO, "node_modules")):
        sys.exit(f"Run `npm ci` in {REPO} first (the server bundle needs its dependencies), or pass --no-node")
    npm = shutil.which("npm")
    if not npm:
        sys.exit("npm is missing: install Node 24 (setup-sdk.sh --node), or pass --no-node")
    out = os.path.join(BUILD, "server-bundle")
    run([npm, "run", "--silent", "bundle", "--", "--minify", *([] if game_data else ["--no-assets"]), "--out", out],
        cwd=REPO)
    return out


def pack_server(bundle, game_data):
    """build/app/reflipped-server.zip: the bundle's code and web pages, entries stored (the APK deflates the whole
    file). Its assets/ (tables converted from the game's data) stay out unless `game_data`: they come with the data
    pack, outside the APK."""
    out = os.path.join(BUILD, "app", SERVER_ZIP)
    count = size = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
        for folder, dirs, files in os.walk(bundle):
            dirs.sort()
            rel_dir = os.path.relpath(folder, bundle)
            if rel_dir.split(os.sep)[0] == "assets" and not game_data:
                dirs[:] = []
                continue
            for name in sorted(files):
                arc = os.path.normpath(os.path.join(rel_dir, name)).replace(os.sep, "/")
                if arc.startswith("."):
                    continue
                info = zipfile.ZipInfo(arc, date_time=(2020, 1, 1, 0, 0, 0))
                info.external_attr = 0o644 << 16
                with open(os.path.join(folder, name), "rb") as f:
                    data = f.read()
                z.writestr(info, data)
                count += 1
                size += len(data)
    log(f"packed the server ({count} files, {size / 1e6:.1f} MB{', with assets/' if game_data else ''}) into {out}")


def server_address(text):
    """Same host-only connection policy as the shell; validate baked defaults before extracting/staging anything."""
    value = text.strip()
    if not value:
        return ""  # empty --server is the existing no-default build mode
    if "://" not in value:
        value = "https://" + value
    value = value.rstrip("/")
    try:
        url = urlsplit(value)
        if (url.scheme not in ("http", "https") or not url.hostname or url.username is not None
                or url.password is not None or url.path or "?" in value or "#" in value
                or url.port == 0 or url.netloc.endswith(":") or any(c.isspace() for c in value)):
            raise ValueError()
        return value
    except ValueError:
        raise argparse.ArgumentTypeError("--server needs an http(s) host and optional valid port, without a path, credentials, query or fragment") from None


CATALOG_MAX_BYTES = 256 * 1024


def utf16_length(value):
    return len(value.encode("utf-16-le")) // 2


def server_catalog(path):
    if not path:
        return []
    try:
        with open(path, encoding="utf-8") as source:
            rows = json.load(source)
        if not isinstance(rows, list) or len(rows) > 50:
            raise ValueError("expected at most 50 entries")
        result = []
        seen = set()
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError("each entry must be an object")
            name, description = row.get("name"), row.get("description", "")
            if not isinstance(name, str) or not 1 <= utf16_length(name.strip()) <= 64:
                raise ValueError("name must contain 1–64 characters")
            if not isinstance(description, str) or utf16_length(description.strip()) > 500:
                raise ValueError("description must be text up to 500 characters")
            if not isinstance(row.get("address"), str):
                raise ValueError("address must be text")
            address = server_address(row["address"])
            if not address:
                raise ValueError("address is required")
            if address in seen:
                raise ValueError("duplicate address")
            kind, thumbnail, mode = row.get("type", ""), row.get("thumbnail", ""), row.get("mode", "online")
            if thumbnail is None:
                thumbnail = ""
            if not isinstance(kind, str) or utf16_length(kind.strip()) > 40:
                raise ValueError("type must be text up to 40 UTF-16 units")
            if not isinstance(thumbnail, str) or utf16_length(thumbnail.strip()) > 2048:
                raise ValueError("thumbnail must be an optional HTTP(S) URL up to 2048 UTF-16 units")
            thumbnail = thumbnail.strip()
            if thumbnail:
                image = urlsplit(thumbnail)
                if image.scheme.lower() not in ("http", "https") or not image.hostname or image.username is not None or image.password is not None or "#" in thumbnail or image.port == 0 or any(c.isspace() for c in thumbnail):
                    raise ValueError("thumbnail needs HTTP(S) without credentials or fragment")
            if mode not in ("online", "local"):
                raise ValueError("mode must be online or local")
            progression = row.get("progression")
            if progression is not None:
                if not isinstance(progression, dict) or progression.get("mode") not in ("classic", "accelerated", "time-travel", "manual", "legacy"):
                    raise ValueError("progression.mode must be a known scheduling mode")
                factor = progression.get("acceleration", 1)
                if progression["mode"] == "accelerated" and (isinstance(factor, bool) or not isinstance(factor, (int, float)) or factor < 2 or factor > 10 or not math.isfinite(factor) or factor != int(factor)):
                    raise ValueError("progression.acceleration must be an integer from 2 to 10")
                progression = dict(mode=progression["mode"], acceleration=factor if progression["mode"] == "accelerated" else 1)
            seen.add(address)
            result.append(dict(name=name.strip(), address=address, description=description.strip(), type=kind.strip(), thumbnail=thumbnail, mode=mode))
            if progression is not None:
                result[-1]["progression"] = progression
        if len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > CATALOG_MAX_BYTES:
            raise ValueError("encoded catalogue exceeds 256 KiB")
        return result
    except (OSError, ValueError, argparse.ArgumentTypeError) as error:
        raise argparse.ArgumentTypeError("Invalid --servers catalogue: " + str(error)) from None


# ---------------------------------------------------------------- SH-20: the "import" build (no game content in the APK)
# `--content import` builds an APK without the game: its main SWF is our loader (loader/ReflippedLoader.as), and on
# first launch our importer (java/.../content/, the reflipped.content extension) copies the game SWF, bundle.zip and
# its .sha1 out of the player's own game app, applies the patch op list (tools/swf_ops.py) and keeps the files in the
# app's storage. The APK carries only the op list (offsets and our own bytes) and hashes. The loader checks the stored
# SWF's SHA-256 before every launch, since the code it loads runs with the app's full rights. See
# docs/air-shell-internals.md, "Import build".

IMPORT_EXTENSIONS = {
    "reflipped.content": ("reflipped.shell.content.ContentStub", ["reflipped/shell/content/"]),
}
IMPORT_JAVA_PACKAGE = os.path.join("reflipped", "shell", "content")
LOADER_SRC = os.path.join(HERE, "loader")
LOADER_SWF = "loader.swf"
# The import files' folder in the APK's assets (the app reads it with AssetManager)
IMPORT_ASSETS = "reflipped-import"
GAME_PACKAGE = "com.kakaogames.wdfp"   # the original app, which the importer may read (<queries>)
GAME_VERSION = "0.0.81"
GAME_SWF_ENTRY = "assets/worldflipper_android_release.swf"
import_content = False


def enable_import_content():
    """Adds our own extension for the loader and importer to this build (module state, like EXTENSIONS itself)."""
    global import_content
    import_content = True
    EXTENSIONS.update(IMPORT_EXTENSIONS)


def java_sources():
    """Every Java source, without the importer's unless this is an import build (its classes would match no ANE)."""
    sources = sorted(glob.glob(os.path.join(JAVA_SRC, "**", "*.java"), recursive=True))
    if import_content:
        return sources
    skip = os.path.join(JAVA_SRC, IMPORT_JAVA_PACKAGE) + os.sep
    return [path for path in sources if not path.startswith(skip)]


def _tool(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, "tools", name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_import_files(apk):
    """build/app/reflipped-import/: manifest.properties (the game entries' sizes and SHA-256, the op list's hashes) and
    swf.ops, made from the maintainer's own game APK. Neither holds game content; the game files themselves are only
    worked on in build/import-work/. Returns {entry: (size, sha256)}."""
    app = os.path.join(BUILD, "app")
    work = os.path.join(BUILD, "import-work")
    out = os.path.join(app, IMPORT_ASSETS)
    for path in (work, out):
        shutil.rmtree(path, ignore_errors=True)
        os.makedirs(path)
    for name in APK_FILES.values():  # an earlier embedded build's game files must not be packaged by mistake
        if os.path.exists(os.path.join(app, name)):
            os.remove(os.path.join(app, name))
    entries = {}
    with zipfile.ZipFile(apk) as z:
        names = set(z.namelist())
        for src in APK_FILES:
            if src not in names:
                sys.exit(f"{apk} has no {src}: is this the game's APK?")
            data = z.read(src)
            entries[src] = (len(data), hashlib.sha256(data).hexdigest())
            if src == GAME_SWF_ENTRY:
                with open(os.path.join(work, "original.swf"), "wb") as f:
                    f.write(data)
    digest = hashlib.sha256()
    with open(apk, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    patched = os.path.join(work, "patched.swf")
    shutil.copy(os.path.join(work, "original.swf"), patched)
    for tool in ("patch_game.py", "patch_import.py"):
        subprocess.run([sys.executable, "-I", os.path.join(HERE, "tools", tool), patched], check=True)
    swf_ops = _tool("swf_ops")
    with open(os.path.join(work, "original.swf"), "rb") as f:
        old = swf_ops.fws(f.read())
    with open(patched, "rb") as f:
        new = swf_ops.fws(f.read())
    ops = swf_ops.make_ops(old, new)
    data = swf_ops.encode(old, new, ops)
    if swf_ops.apply(old, data) != new:
        sys.exit("the op list doesn't reproduce the patched SWF")
    stats = swf_ops.stats(ops)
    problems = swf_ops.check_own_bytes(old, ops)
    if problems:
        sys.exit("the op list may carry game content (" + "; ".join(problems) + "): check the patches and "
                 "tools/swf_ops.py (MAX_OWN_BYTES, MAX_INSERT_BYTES)")
    with open(os.path.join(out, "swf.ops"), "wb") as f:
        f.write(data)
    with open(os.path.join(out, "manifest.properties"), "w", encoding="utf-8") as f:
        f.write(import_manifest(entries, digest.hexdigest(), data, old, new))
    log(f"import build: op list {len(data)} B ({stats['ops']} ops, {stats['literal_bytes']} bytes of our own, "
        f"longest run {stats['longest_insert']}), patched SWF sha256 {hashlib.sha256(new).hexdigest()}")
    return entries


def import_manifest(entries, apk_sha256, ops, old, new):
    """manifest.properties (read by java/.../content/ImportManifest.java): {entry: (size, sha256)} of the game files,
    the op list's hash, and the sizes and hashes of the uncompressed original and patched SWFs."""
    lines = ["# What the Reflipped app imports from the player's game app and how it patches the SWF "
             "(build.py --content import)",
             "format=1",
             f"game.package={GAME_PACKAGE}",
             f"game.version={GAME_VERSION}",
             f"game.apk.sha256={apk_sha256}"]
    for i, (src, (size, sha256)) in enumerate(entries.items()):
        lines += [f"entry.{i}.name={src}", f"entry.{i}.size={size}", f"entry.{i}.sha256={sha256}"]
    lines += [f"swf.entry={GAME_SWF_ENTRY}",
              "swf.ops=swf.ops",
              f"swf.ops.sha256={hashlib.sha256(ops).hexdigest()}",
              f"swf.input.size={len(old)}",
              f"swf.input.sha256={hashlib.sha256(old).hexdigest()}",
              f"swf.output.size={len(new)}",
              f"swf.output.sha256={hashlib.sha256(new).hexdigest()}"]
    return "\n".join(lines) + "\n"


def import_app_files():
    """What the APK's assets hold instead of the game files."""
    return [LOADER_SWF, f"{IMPORT_ASSETS}/manifest.properties", f"{IMPORT_ASSETS}/swf.ops"]


def import_descriptor(path):
    """The loader is the main SWF, and the app may look at the installed game app (Android 11+ hides other apps)."""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    content = "<content>worldflipper_android_release.swf</content>"
    manifest = '<manifest android:installLocation="auto">'
    if content not in text or manifest not in text:
        sys.exit(f"{path}: no <content> or <manifest> line to change for the import build")
    text = text.replace(content, f"<content>{LOADER_SWF}</content>")
    text = text.replace(manifest, manifest + f'\n  <queries><package android:name="{GAME_PACKAGE}"/></queries>')
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def compile_loader(home):
    """loader/ReflippedLoader.as -> build/app/loader.swf. reflipped.content's library stays external: AIR only lets
    that extension's own library.swf create its context, so the loader must use the class from there."""
    jar = os.path.join(home, "lib", "mxmlc-cli.jar")
    if not os.path.exists(jar):
        sys.exit(f"Missing {jar}: the AIR SDK's ActionScript compiler (amxmlc)")
    swc = os.path.join(BUILD, "as3", "reflipped.content", "library.swc")
    out = os.path.join(BUILD, "app", LOADER_SWF)
    run(["java", "-Xmx512m", f"-Dflexlib={os.path.join(home, 'frameworks')}", "-jar", jar,
         "+configname=airmobile", "-swf-version=51", "-default-frame-rate=60", "-default-size=1080,1920",
         "-default-background-color=0x000000", f"-external-library-path+={swc}", "-source-path", LOADER_SRC,
         "-output", out, os.path.join(LOADER_SRC, "ReflippedLoader.as")])
    log(f"compiled {out} ({os.path.getsize(out)} B)")


def validate_import_apk(apk, entries):
    """An import build must not contain a game file, by name or by content."""
    hashes = {sha256 for _, sha256 in entries.values()}
    sizes = {size for size, _ in entries.values()}
    with zipfile.ZipFile(apk) as package:
        for info in package.infolist():
            if info.filename in {f"assets/{name}" for name in APK_FILES.values()}:
                raise ValueError(f"the import build contains {info.filename}")
            if info.file_size in sizes and hashlib.sha256(package.read(info)).hexdigest() in hashes:
                raise ValueError(f"the import build contains a game file as {info.filename}")
    log("verified: no game files in the APK")


def check_import_apk(apk, entries):
    """validate_import_apk, and an APK that fails it is renamed to *.invalid, so it can't be handed out by mistake."""
    try:
        validate_import_apk(apk, entries)
    except ValueError as error:
        os.replace(apk, apk + ".invalid")
        sys.exit(f"{error}; the APK was renamed to {apk}.invalid and must not be shared")


def stage_local_server(args, ane_root):
    """SH-13: Node into the local-server extension and the server bundle into the app's files, unless --no-node."""
    stale = os.path.join(BUILD, "app", SERVER_ZIP)
    if os.path.exists(stale):
        os.remove(stale)
    if not args.no_node and args.arch not in NODE_ABI_BY_ARCH:
        args.no_node = True
        log(f"--arch {args.arch}: there is no Node for it, so this build can't run the server on the phone")
    elif args.no_node:
        log("--no-node: this build can't run the server on the phone")
    if not args.no_node and not args.stage_only:
        stage_node_libs(ane_root, args.arch)
        pack_server(server_bundle(args.server_bundle, args.server_game_data), args.server_game_data)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--apk", required=True, help="original World Flipper APK (read only)")
    p.add_argument("--content", choices=("embedded", "import"), default="embedded",
                   help="embedded (default): the patched game is packed into the APK. import: the APK holds no game "
                        "content and the app imports the player's own game app on first launch (--apk is then only "
                        "read to make the patch op list)")
    p.add_argument("--server", default="", type=server_address,
                   help="suggest a default Reflipped base URL (Sign out can choose another); "
                        "default: the shell asks for the address on first launch")
    p.add_argument("--servers", default=DEFAULT_SERVERS,
                   help="JSON community servers: [{name,address,description?}]; default: included community list")
    p.add_argument("--cdn", default="",
                   help="override the CDN for the baked server origin, or the first selected origin on a fresh install "
                        "without --server; other servers use their own reported CDN or /patch/Live/2.0.0")
    # The default keeps the project's old name: a new ID would be a separate app, without the old one's account or assets.
    p.add_argument("--app-id", default="com.kakaogames.wdfp.starpoint",
                   help="Android package id (default installs beside the official app)")
    p.add_argument("--name", default="World Flipper Reflipped")
    p.add_argument("--version", type=app_version, default=None,
                   help="Reflipped app version, MAJOR.MINOR.PATCH with an optional -alpha, -beta or -pre and .N, e.g. "
                        "0.2.0 or 0.2.0-beta.1 (default: the VERSION file). It makes the Android version code, "
                        "MAJOR*1000000 + MINOR*10000 + PATCH*100 + 0-29 for alpha.N, 30-59 for beta.N, 60-89 for "
                        "pre.N and 99 for a release, so a newer app gets a higher one; MAJOR goes up to 999, MINOR and "
                        "PATCH up to 99, N up to 29. The game keeps reporting its own 0.0.81")
    p.add_argument("--air-namespace", default="51.0", help="AIR descriptor namespace version (match your SDK)")
    p.add_argument("--target-sdk", type=int, default=34)
    p.add_argument("--arch", default="armv8", choices=list(ANDROID_PLATFORM_BY_ARCH))
    p.add_argument("--out", default=os.path.join(BUILD, "reflipped-shell.apk"))
    p.add_argument("--stage-only", action="store_true",
                   help="stop before the steps that need the SDKs (acompc, javac, adt)")
    p.add_argument("--debug", nargs="?", const=7936, type=int, metavar="PORT",
                   help="build an apk-debug that waits for the fdb debugger on PORT (default 7936)")
    # SH-13: every build carries the server for playing on the phone
    p.add_argument("--no-node", action="store_true",
                   help="developer switch: leave the server on the phone (Node and the server bundle) out")
    p.add_argument("--server-bundle", default="", metavar="DIR",
                   help="a prebuilt `npm run bundle -- --no-assets` folder; default: bundle the repository this folder is in")
    p.add_argument("--server-game-data", action="store_true",
                   help="developer switch: a bundle with its assets/ (converted game data) in the app, for tests "
                        "without a data pack; normally they come with the data pack, outside the APK")
    args = p.parse_args()

    try:
        catalog = server_catalog(args.servers)
        version = args.version or default_app_version()
    except argparse.ArgumentTypeError as error:
        p.error(str(error))
    build = build_id(args.server)
    log(f"Reflipped app {version} (Android versionName {version}, versionCode {version_code(version)}, "
        f"AIR versionNumber {version_number(version)}), build {build}")
    os.makedirs(BUILD, exist_ok=True)
    warn_debug_env(args.debug)
    if not args.server:
        log("no --server: the shell asks for the address on first launch")
    if args.content == "import":
        enable_import_content()
        game_entries = make_import_files(args.apk)
    else:
        extract(args.apk)
    draw_icons()
    write_game_data_lists()
    with open(os.path.join(BUILD, "app", "servers.json"), "w", encoding="utf-8") as output:
        json.dump(catalog, output, ensure_ascii=False)
    descriptor = write_descriptor(args.app_id, version, build, args.name, args.server, args.cdn, args.air_namespace,
                                  args.target_sdk)
    if args.content == "import":
        import_descriptor(descriptor)
    ane_root = stage_anes(args.air_namespace)
    stage_local_server(args, ane_root)
    if args.stage_only:
        log("stage-only: stopping before acompc/javac/adt (the extensions' library.swf/.swc and jars aren't built)")
        return
    home = air_home()
    compile_wrappers(home, ane_root)
    if args.content == "import":
        compile_loader(home)
    compile_java(home, ane_root)
    anes = package_anes(home, ane_root, args.arch)
    package_apk(home, descriptor, anes, args.out, args.arch, args.debug,
                import_app_files() if args.content == "import" else None)
    if args.content == "import":
        check_import_apk(args.out, game_entries)
    write_checksum(args.out)


def write_checksum(apk):
    """SH-15: <apk>.sha256 in `sha256sum` format, for players to check a download and for a server's Update APK
    SHA-256 setting (the app refuses an update that doesn't match it). A check of the file, not a proof of who built it."""
    digest = hashlib.sha256()
    with open(apk, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    with open(apk + ".sha256", "w", encoding="utf-8") as f:
        f.write(f"{digest.hexdigest()}  {os.path.basename(apk)}\n")
    log(f"SHA-256 {digest.hexdigest()} (written to {apk}.sha256)")


if __name__ == "__main__":
    main()
