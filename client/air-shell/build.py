#!/usr/bin/env python3
"""Build the Reflipped AIR shell: the original World Flipper SWF in a new APK with our own ANEs.

    python3 -I build.py --apk World_Flipper_0.0.81.apk
    python3 -I build.py --apk World_Flipper_0.0.81.apk --server http://192.168.1.10:8000   # fixed server, no prompt

Needs: Python 3.8+, a JDK (javac), the HARMAN AIR SDK (AIR_HOME) and an Android platform jar
(ANDROID_HOME/platforms/android-*/android.jar). `--stage-only` runs the steps that need none of
them (extract, descriptors, stub SWF/SWC) so the output can be inspected first.

Game files are read from the APK you pass in and only written under build/ (gitignored).
See README.md and docs/air-shell.md.
"""
import argparse
import glob
import hashlib
import os
import shutil
import struct
import subprocess
import sys
import zipfile
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "build")
JAVA_SRC = os.path.join(HERE, "java", "src")
DESCRIPTOR = os.path.join(HERE, "descriptor", "application.xml")

# Files taken from the original APK. bundle.zip is loaded from File.applicationDirectory.
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
    "com.sesisoft.PushService": ("reflipped.shell.other.PushServiceStub", ["reflipped/shell/other/PushServiceStub"]),
    "com.sesisoft.SingularSdk": ("reflipped.shell.other.SingularSdkStub", ["reflipped/shell/other/SingularSdkStub"]),
    "com.distriqt.InAppBilling": ("reflipped.shell.other.InAppBillingStub", ["reflipped/shell/other/InAppBillingStub"]),
    "com.distriqt.GameServices": ("reflipped.shell.other.GameServicesStub", ["reflipped/shell/other/GameServicesStub"]),
    "com.distriqt.Core": ("reflipped.shell.other.DistriqtCoreStub", ["reflipped/shell/other/DistriqtCoreStub"]),
    "com.distriqt.Application": ("reflipped.shell.other.DistriqtApplicationStub",
                                 ["reflipped/shell/other/DistriqtApplicationStub"]),
    "com.distriqt.Battery": ("reflipped.shell.other.DistriqtBatteryStub", ["reflipped/shell/other/DistriqtBatteryStub"]),
    "com.digitalstrawberry.ane.share": ("reflipped.shell.other.ShareStub", ["reflipped/shell/other/ShareStub"]),
    "pinball.assetDownload": ("reflipped.shell.pinball.AssetDownloadStub", ["reflipped/shell/pinball/AssetDownload"]),  # AssetDownloadStub + AssetDownloader
    "pinball.ane.getbuild": ("reflipped.shell.pinball.GetBuildStub", ["reflipped/shell/pinball/GetBuildStub"]),
    "pinball.checkapp": ("reflipped.shell.pinball.CheckAppStub", ["reflipped/shell/pinball/CheckAppStub"]),
    "pinball.screen": ("reflipped.shell.pinball.ScreenStub", ["reflipped/shell/pinball/ScreenStub"]),
    "pinball.vibration": ("reflipped.shell.pinball.VibrationStub", ["reflipped/shell/pinball/VibrationStub"]),
}
ANDROID_PLATFORMS = ["Android-ARM64", "Android-ARM"]
# adt merges an extension's android/res into the app; the adaptive launcher icon travels in this one
ICON_ANE = "pinball.screen"


def log(msg):
    print(f"[air-shell] {msg}", flush=True)


def run(cmd, **kw):
    log("$ " + " ".join(cmd))
    subprocess.run(cmd, check=True, **kw)


# ---------------------------------------------------------------- stub library.swf / .swc

def _u30(v):
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        out.append(b | (0x80 if v else 0))
        if not v:
            return bytes(out)


def stub_abc() -> bytes:
    """An ABC block with one empty script: valid bytecode, defines nothing.

    The ANE AS3 wrapper classes are already compiled into the game SWF, so the ANE's own
    library.swf only has to exist and load.
    """
    abc = bytearray(struct.pack("<HH", 16, 46))  # minor, major
    abc += _u30(0) * 7  # int, uint, double, string, namespace, ns-set, multiname pools: empty
    abc += _u30(1) + _u30(0) + _u30(0) + _u30(0) + b"\x00"  # 1 method: 0 params, return *, no name, no flags
    abc += _u30(0)  # metadata
    abc += _u30(0)  # classes
    abc += _u30(1) + _u30(0) + _u30(0)  # 1 script: init = method 0, no traits
    code = bytes([0xD0, 0x30, 0x47])  # getlocal0, pushscope, returnvoid
    abc += _u30(1) + _u30(0) + _u30(1) + _u30(1) + _u30(0) + _u30(1)  # body: method 0, stack, locals, scopes
    abc += _u30(len(code)) + code + _u30(0) + _u30(0)  # no exceptions, no traits
    return bytes(abc)


def _tag(code, payload=b""):
    if len(payload) < 0x3F:
        return struct.pack("<H", (code << 6) | len(payload)) + payload
    return struct.pack("<HI", (code << 6) | 0x3F, len(payload)) + payload


def stub_swf() -> bytes:
    body = b"\x00"  # RECT with Nbits = 0
    body += struct.pack("<HH", 24 << 8, 1)  # 24 fps, 1 frame
    body += _tag(69, struct.pack("<I", 0x08))  # FileAttributes: ActionScript 3
    body += _tag(82, struct.pack("<I", 1) + b"\x00" + stub_abc())  # DoABC2, lazy, unnamed
    body += _tag(1) + _tag(0)  # ShowFrame, End
    return b"FWS" + bytes([44]) + struct.pack("<I", 8 + len(body)) + body


def stub_swc(swf: bytes) -> bytes:
    catalog = ('<?xml version="1.0" encoding="utf-8"?>\n'
               '<swc xmlns="http://www.adobe.com/flash/swccatalog/9">\n'
               '  <versions><swc version="1.2"/></versions>\n'
               '  <features><feature-script-deps/><feature-files/></features>\n'
               '  <libraries><library path="library.swf"></library></libraries>\n'
               '  <files></files>\n'
               '</swc>\n')
    path = os.path.join(BUILD, "tmp.swc")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("catalog.xml", catalog)
        z.writestr("library.swf", swf)
    with open(path, "rb") as f:
        data = f.read()
    os.remove(path)
    return data


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


# ---------------------------------------------------------------- steps

def extract(apk, original_library_swf):
    app = os.path.join(BUILD, "app")
    os.makedirs(app, exist_ok=True)
    with zipfile.ZipFile(apk) as z:
        names = set(z.namelist())
        for src, dst in APK_FILES.items():
            if src not in names:
                sys.exit(f"{apk} has no {src}: is this the World Flipper APK?")
            with z.open(src) as fin, open(os.path.join(app, dst), "wb") as fout:
                shutil.copyfileobj(fin, fout)
        originals = {}
        if original_library_swf:
            for ext_id in EXTENSIONS:
                name = f"assets/META-INF/AIR/extensions/{ext_id}/META-INF/ANE/Android-ARM64/library.swf"
                if name in names:
                    originals[ext_id] = z.read(name)
    with open(os.path.join(app, "bundle.zip"), "rb") as f:
        digest = hashlib.sha1(f.read()).hexdigest()
    with open(os.path.join(app, "bundle.zip.sha1")) as f:
        expected = f.read().strip()
    if digest != expected:
        log(f"note: bundle.zip sha1 {digest} differs from bundle.zip.sha1 ({expected}); the original APK ships the same pair")
    log(f"extracted game files to {app}")
    subprocess.run([sys.executable, "-I", os.path.join(HERE, "tools", "make_icons.py"), apk, app], check=True)
    subprocess.run([sys.executable, "-I", os.path.join(HERE, "tools", "make_logo.py"),
                    os.path.join(app, "bundle.zip")], check=True)
    subprocess.run([sys.executable, "-I", os.path.join(HERE, "tools", "patch_game.py"),
                    os.path.join(app, "worldflipper_android_release.swf")], check=True)
    return originals


def write_descriptor(app_id, version, name, server, cdn, ns, target_sdk):
    with open(DESCRIPTOR, encoding="utf-8") as f:
        text = f.read()
    exts = "\n".join(f"    <extensionID>{e}</extensionID>" for e in EXTENSIONS)
    for key, value in {"NS": ns, "APP_ID": app_id, "VERSION": version, "NAME": escape(name),
                       "EXTENSIONS": exts, "SERVER": escape(server, {'"': "&quot;"}),
                       "CDN": escape(cdn, {'"': "&quot;"}),
                       "TARGET_SDK": str(target_sdk)}.items():
        text = text.replace("${" + key + "}", value)
    out = os.path.join(BUILD, "application.xml")
    with open(out, "w", encoding="utf-8") as f:
        f.write(text)
    log(f"wrote {out}")
    return out


def stage_anes(ns, originals):
    swf = stub_swf()
    swc = stub_swc(swf)
    root = os.path.join(BUILD, "ane-src")
    for ext_id, (initializer, _) in EXTENSIONS.items():
        d = os.path.join(root, ext_id)
        for sub in ("android", "default"):
            os.makedirs(os.path.join(d, sub), exist_ok=True)
        lib = originals.get(ext_id, swf)
        with open(os.path.join(d, "android", "library.swf"), "wb") as f:
            f.write(lib)
        with open(os.path.join(d, "default", "library.swf"), "wb") as f:
            f.write(lib)
        with open(os.path.join(d, "library.swc"), "wb") as f:
            f.write(swc)
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


def known_functions_java(originals):
    """Java source listing every ANE function each original AS3 wrapper calls.

    StubExtension registers any of these the stub doesn't handle itself as a logged no-op, so a
    wrapper calling an unexpected function doesn't fail with Error #3500.
    """
    import importlib.util
    spec = importlib.util.spec_from_file_location("ane_calls", os.path.join(HERE, "tools", "ane_calls.py"))
    ane_calls = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ane_calls)
    cases = []
    for ext_id, swf in sorted(originals.items()):
        _, calls, _, _ = ane_calls.scan(swf)
        names = sorted({n for per_source in calls.values() for n in per_source if not n.startswith("<")})
        if names:
            quoted = ", ".join('"' + n + '"' for n in names)
            cases.append(f'            case "{ext_id}": return new String[]{{{quoted}}};')
    return ("package reflipped.shell.common;\n\n"
            "/** Generated by build.py from the APK's ANE wrappers. Do not edit. */\n"
            "final class KnownFunctions {\n"
            "    private KnownFunctions() {\n    }\n\n"
            "    static String[] forExtension(String id) {\n"
            "        switch (id) {\n" + "\n".join(cases) + "\n"
            "            default: return new String[0];\n"
            "        }\n    }\n}\n")


def compile_java(home, ane_root, originals):
    fre = os.path.join(home, "lib", "android", "FlashRuntimeExtensions.jar")
    if not os.path.exists(fre):
        sys.exit(f"Missing {fre}")
    classes = os.path.join(BUILD, "classes")
    shutil.rmtree(classes, ignore_errors=True)
    os.makedirs(classes)
    gen = os.path.join(BUILD, "gen", "reflipped", "shell", "common")
    os.makedirs(gen, exist_ok=True)
    with open(os.path.join(gen, "KnownFunctions.java"), "w", encoding="utf-8") as f:
        f.write(known_functions_java(originals))
    sources = sorted(glob.glob(os.path.join(JAVA_SRC, "**", "*.java"), recursive=True)) + [os.path.join(gen, "KnownFunctions.java")]
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


def package_anes(home, ane_root):
    out = os.path.join(BUILD, "anes")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    for ext_id in EXTENSIONS:
        d = os.path.join(ane_root, ext_id)
        platform_args = []
        for p in ANDROID_PLATFORMS:
            files = ["library.swf", jar_name(ext_id)] + (["res"] if ext_id == ICON_ANE else [])
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


def package_apk(home, descriptor, anes, out, arch, debug_port=None):
    store, password = keystore(home)
    log(f"signing with {store}: keep this file, a build signed with another key can't update an installed app")
    app = os.path.join(BUILD, "app")
    # apk-debug waits for fdb on debug_port (adb forward tcp:P tcp:P; fdb -p P): shows AS3
    # traces and uncaught errors, which the release runtime swallows.
    target = ["-target", "apk-debug", "-listen", str(debug_port)] if debug_port else ["-target", "apk-captive-runtime"]
    adt(home, "-package", *target, "-arch", arch,
        "-storetype", "pkcs12", "-keystore", store, "-storepass", password,
        out, descriptor, "-extdir", anes,
        "-C", app, *APK_FILES.values(), *ICON_FILES)
    log(f"built {out}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--apk", required=True, help="original World Flipper APK (read only)")
    p.add_argument("--server", default="",
                   help="bake a Reflipped base URL into the build (the shell then never asks); "
                        "default: the shell asks for the address on first launch")
    p.add_argument("--cdn", default="",
                   help="bake a CDN base URL for asset archives (default: the one the server's /shell/config "
                        "names, else <server>/patch/Live/2.0.0)")
    # The default keeps the project's old name: a new ID would be a separate app, without the old one's account or assets.
    p.add_argument("--app-id", default="com.kakaogames.wdfp.starpoint",
                   help="Android package id (default installs beside the official app)")
    p.add_argument("--name", default="World Flipper Reflipped")
    p.add_argument("--version", default="0.0.81")
    p.add_argument("--air-namespace", default="51.0", help="AIR descriptor namespace version (match your SDK)")
    p.add_argument("--target-sdk", type=int, default=34)
    p.add_argument("--arch", default="armv8", choices=["armv8", "armv7", "x86", "x64"])
    p.add_argument("--out", default=os.path.join(BUILD, "reflipped-shell.apk"))
    p.add_argument("--stub-library-swf", action="store_true",
                   help="pack a generated empty library.swf instead of each ANE's original AS3 wrapper "
                        "(fails at runtime: AIR throws Error #2113 loading it)")
    p.add_argument("--stage-only", action="store_true", help="stop before javac/adt")
    p.add_argument("--debug", nargs="?", const=7936, type=int, metavar="PORT",
                   help="build an apk-debug that waits for the fdb debugger on PORT (default 7936)")
    args = p.parse_args()

    os.makedirs(BUILD, exist_ok=True)
    warn_debug_env(args.debug)
    if not args.server:
        log("no --server: the shell asks for the address on first launch")
    originals = extract(args.apk, not args.stub_library_swf)
    descriptor = write_descriptor(args.app_id, args.version, args.name, args.server, args.cdn, args.air_namespace,
                                  args.target_sdk)
    ane_root = stage_anes(args.air_namespace, originals)
    if args.stage_only:
        log("stage-only: stopping before javac/adt")
        return
    home = air_home()
    compile_java(home, ane_root, originals)
    anes = package_anes(home, ane_root)
    package_apk(home, descriptor, anes, args.out, args.arch, args.debug)


if __name__ == "__main__":
    main()
