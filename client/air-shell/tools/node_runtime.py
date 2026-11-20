#!/usr/bin/env python3
"""The native side of the server on the phone (SH-13, docs/on-device-server.md): Node for one Android ABI.

    python3 -I tools/node_runtime.py --abi arm64-v8a --out build/node-libs/arm64-v8a [--cache build/cache/node]

Writes three libraries into --out, which build.py puts into the local-server extension's libs/<abi>/ (they land in the
APK's lib/<abi>/):
  libnode.so          Node from the digidem nodejs-mobile fork (full flavour: it has node:sqlite), stripped
  libc++_shared.so    the C++ runtime libnode was linked against, from the NDK release that built it (r27d)
  libreflippednode.so our JNI launcher (native/launcher.c), compiled here with clang and lld

Nothing is committed: both downloads are checked against the SHA-256 pinned below. The NDK is about 660 MB, so only
libc++_shared.so is read out of Google's zip with HTTP range requests (a few MB); a local NDK r27d (ANDROID_NDK_HOME,
ANDROID_NDK_ROOT or $ANDROID_HOME/ndk/27.3.13750724) is used instead when there is one. The launcher needs no NDK headers or sysroot: it declares the few C library
functions it calls itself and is linked against stub libraries generated here, so the host's clang, ld.lld and
llvm-strip are enough (CLANG and LLVM_STRIP override them).
"""
import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile

# seconds without an answer before a download gives up
TIMEOUT = 60

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAUNCHER_SRC = os.path.join(HERE, "native", "launcher.c")

NODE_VERSION = "24.20.0-0"
NODE_ZIP = f"nodejs-mobile-android-{NODE_VERSION}.zip"
NODE_URL = f"https://github.com/digidem/nodejs-mobile/releases/download/v{NODE_VERSION}/{NODE_ZIP}"
# GitHub's asset digest; the release has no checksum file of its own
NODE_SHA256 = "f5ffbaf4f2679fa9180b0758c637c2f8fc8828300f95129badf213a028fb37bb"

# libnode's .note.android.ident says NDK r27d (27.3.13750724); its libc++_shared.so must come from the same release
NDK_DIR = "android-ndk-r27d"
NDK_SDK_VERSION = "27.3.13750724"  # its folder under $ANDROID_HOME/ndk/ when sdkmanager installed it
NDK_URL = "https://dl.google.com/android/repository/android-ndk-r27d-linux.zip"
NDK_LIB = "toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/{triple}/libc++_shared.so"

# ABI -> (NDK library folder, clang target at API 24, SHA-256 of r27d's libc++_shared.so)
ABIS = {
    "arm64-v8a": ("aarch64-linux-android", "aarch64-linux-android24",
                  "d523468d62d9b603cb3354294d70d4b2feabf2c3f1e43b0c96c9aabf32813708"),
    "armeabi-v7a": ("arm-linux-androideabi", "armv7a-linux-androideabi24",
                    "fd7bbe2586a529ed0eb98ca8a9d1507468173069f80e58db1c007ce874fa1588"),
    "x86_64": ("x86_64-linux-android", "x86_64-linux-android24",
               "3d8817f3a50515665b9152c620dedfd8509f84b68307f5f7ef20a75d9ae08f69"),
}

# What the launcher calls, by the library that has it. Linking with --no-undefined against stubs of exactly these
# makes any other symbol the compiler pulls in (a stack protector, a compiler-rt helper) a build error.
STUB_SYMBOLS = {
    "libc.so": ["chdir", "close", "dup2", "getenv", "malloc", "memcpy", "memmove", "memset", "open", "pipe",
                "pthread_create", "pthread_detach",
                "read", "strlen", "usleep", "write", "__cxa_atexit"],
    "liblog.so": ["__android_log_write"],
}


def log(msg):
    print(f"[node-runtime] {msg}", flush=True)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url, dest, expected):
    """dest, downloaded once and checked against its SHA-256 every time."""
    if not os.path.exists(dest):
        log(f"downloading {url}")
        part = dest + ".part"
        with urllib.request.urlopen(url, timeout=TIMEOUT) as response, open(part, "wb") as out:
            shutil.copyfileobj(response, out, 1 << 20)
        os.replace(part, dest)
    actual = sha256(dest)
    if actual != expected:
        os.remove(dest)
        sys.exit(f"{dest}: SHA-256 {actual}, expected {expected}; deleted it, run the build again")
    return dest


class HttpRange:
    """A read-only, seekable file over HTTP range requests, so zipfile reads one member out of a large remote zip."""

    def __init__(self, url):
        self.url, self.pos = url, 0
        request = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            if response.headers.get("Accept-Ranges") != "bytes":
                raise OSError(f"{url} doesn't accept range requests")
            self.size = int(response.headers["Content-Length"])

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = {0: offset, 1: self.pos + offset, 2: self.size + offset}[whence]
        return self.pos

    def read(self, n=-1):
        end = self.size if n is None or n < 0 else min(self.size, self.pos + n)
        if end <= self.pos:
            return b""
        request = urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{end - 1}"})
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            if response.status != 206:
                raise OSError(f"{self.url}: range request answered {response.status}")
            data = response.read()
        self.pos += len(data)
        return data


def libnode(cache, abi):
    """The stripped libnode.so for abi, from the pinned release. Cached with the SHA-256 it had when it was stripped
    from the checked zip (libnode.so.sha256); a copy that doesn't match is stripped again."""
    out = os.path.join(cache, NODE_VERSION, abi, "libnode.so")
    stamp = out + ".sha256"
    if os.path.exists(out) and os.path.exists(stamp):
        with open(stamp) as f:
            if f.read().strip() == f"{NODE_SHA256} {sha256(out)}":
                return out
        log(f"the cached {out} doesn't match the one stripped from the checked release: stripping it again")
    archive = download(NODE_URL, os.path.join(cache, NODE_ZIP), NODE_SHA256)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    raw = out + ".unstripped"
    with zipfile.ZipFile(archive) as z, z.open(f"bin/{abi}/libnode.so") as src, open(raw, "wb") as dst:
        shutil.copyfileobj(src, dst, 1 << 20)
    # as shipped it carries its symbol table and partial DWARF: 87 MB for arm64, 65 MB stripped
    subprocess.run([tool("LLVM_STRIP", "llvm-strip"), "--strip-unneeded", "-o", out + ".part", raw], check=True)
    os.remove(raw)
    os.replace(out + ".part", out)
    with open(stamp, "w") as f:
        f.write(f"{NODE_SHA256} {sha256(out)}\n")
    log(f"libnode.so {abi}: {os.path.getsize(out):,} bytes stripped")
    return out


def libcxx(cache, abi):
    """r27d's libc++_shared.so for abi: from a local NDK r27d, else read out of Google's NDK zip (cached)."""
    triple, _, expected = ABIS[abi]
    out = os.path.join(cache, NDK_DIR, abi, "libc++_shared.so")
    if not os.path.exists(out):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
        homes = (os.environ.get("ANDROID_NDK_HOME"), os.environ.get("ANDROID_NDK_ROOT"),
                 sdk and os.path.join(sdk, "ndk", NDK_SDK_VERSION))
        local = next((os.path.join(home, NDK_LIB.format(triple=triple)) for home in homes if home
                      and os.path.exists(os.path.join(home, NDK_LIB.format(triple=triple)))), None)
        if local:
            shutil.copyfile(local, out + ".part")
        else:
            log(f"reading libc++_shared.so ({abi}) out of {NDK_URL}")
            with zipfile.ZipFile(HttpRange(NDK_URL)) as z, \
                    z.open(f"{NDK_DIR}/" + NDK_LIB.format(triple=triple)) as src, open(out + ".part", "wb") as dst:
                shutil.copyfileobj(src, dst, 1 << 20)  # zipfile checks the member's CRC
        os.replace(out + ".part", out)
    actual = sha256(out)
    if actual != expected:
        os.remove(out)
        sys.exit(f"libc++_shared.so ({abi}): SHA-256 {actual}, expected {expected} (NDK r27d's); deleted it")
    return out


def tool(env, name):
    path = os.environ.get(env) or shutil.which(name)
    if not path:
        sys.exit(f"Missing {name}: install clang and lld (LLVM) with your package manager, or set {env}")
    return path


def launcher(abi, node_dir, out):
    """Compiles native/launcher.c into libreflippednode.so, linked against libnode.so and stub C/log libraries."""
    _, target, _ = ABIS[abi]
    clang = tool("CLANG", "clang")
    flags = [f"--target={target}", "-fPIC", "-nostdlib", "-fuse-ld=lld", "-ffreestanding", "-fno-stack-protector",
             "-fno-unwind-tables", "-fno-asynchronous-unwind-tables"]
    with tempfile.TemporaryDirectory() as work:
        for lib, symbols in STUB_SYMBOLS.items():
            source = os.path.join(work, lib + ".c")
            with open(source, "w") as f:
                f.write("".join(f"void {symbol}(void) {{}}\n" for symbol in symbols))
            subprocess.run([clang, *flags, "-shared", "-o", os.path.join(work, lib), source,
                            f"-Wl,-soname,{lib}"], check=True)
        subprocess.run([clang, *flags, "-fvisibility=hidden", "-O2", "-Wall", "-Werror", "-shared", "-o", out, LAUNCHER_SRC,
                        "-L", work, "-L", node_dir, "-lnode", "-lc", "-llog",
                        "-Wl,--no-undefined", "-Wl,-z,max-page-size=16384", "-Wl,-soname,libreflippednode.so",
                        "-Wl,--hash-style=both", "-Wl,--build-id=sha1", "-Wl,-z,relro", "-Wl,-z,now"], check=True)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--abi", required=True, choices=list(ABIS))
    p.add_argument("--out", required=True, help="folder for the three .so files")
    p.add_argument("--cache", default=os.environ.get("REFLIPPED_NODE_CACHE") or os.path.join(HERE, "build", "cache", "node"),
                   help="downloads and stripped libraries, kept between builds (default: $REFLIPPED_NODE_CACHE, "
                        "else build/cache/node; the build container keeps them in its /sdk volume)")
    args = p.parse_args()
    os.makedirs(args.out, exist_ok=True)
    os.makedirs(args.cache, exist_ok=True)
    try:
        node = libnode(args.cache, args.abi)
        cxx = libcxx(args.cache, args.abi)
    except (urllib.error.URLError, OSError, zipfile.BadZipFile) as error:
        reason = getattr(error, "reason", None) or error
        sys.exit(f"[node-runtime] couldn't fetch Node for the app ({reason}). The first build downloads it (about "
                 f"80 MB, kept in {args.cache}): check the internet connection and build again, or build with "
                 f"--no-node for an app without the server for playing on the phone")
    shutil.copyfile(node, os.path.join(args.out, "libnode.so"))
    shutil.copyfile(cxx, os.path.join(args.out, "libc++_shared.so"))
    launcher(args.abi, os.path.dirname(node), os.path.join(args.out, "libreflippednode.so"))
    for name in sorted(os.listdir(args.out)):
        log(f"{args.abi}/{name}: {os.path.getsize(os.path.join(args.out, name)):,} bytes")


if __name__ == "__main__":
    main()
