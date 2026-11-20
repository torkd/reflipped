#!/usr/bin/env python3
"""SH-20 test fixture: a made-up "game APK" and the import files build.py would make for it (no game content).

    python3 -I sh20-import-fixture.py <out dir>

Writes <out>/assets/{manifest.properties,swf.ops} (what an import build's APK carries) and the inputs the importer
test reads: game.apk, game.xapk (the APK inside a bundle), wrong.apk (another "version": a changed bundle.zip),
oversized.apk (a crafted entry larger than the game's), damaged.apk, stored-dd.apk (STORED entries with data descriptors),
notgame.zip and notzip.bin. The SWF is a zlib SWF of random bytes; its "patched" form has insertions, deletions and
changed bytes, like our bytecode patches.
"""
import hashlib
import importlib.util
import io
import os
import random
import struct
import sys
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build = load("reflipped_build", os.path.join(HERE, "..", "build.py"))
swf_ops = load("swf_ops", os.path.join(HERE, "..", "tools", "swf_ops.py"))


def cws(body):
    return b"CWS" + bytes([51]) + struct.pack("<I", len(body) + 8) + zlib.compress(body, 6)


def main():
    out = sys.argv[1]
    os.makedirs(os.path.join(out, "assets"), exist_ok=True)
    rng = random.Random(20)
    body = bytes(rng.getrandbits(8) for _ in range(300000)) + b"\0" * 20000 + bytes(rng.getrandbits(8) for _ in range(80000))
    patched = bytearray(body)
    patched[1000:1004] = b"\x01\x02\x03\x04"            # changed bytes
    patched[50000:50000] = b"Reflipped account" * 3     # an insertion
    del patched[120000:120300]                           # a deletion
    patched[250000:250010] = b"our code, longer than before"
    patched += b"appended pool"
    original = cws(body)
    entries_data = {
        build.GAME_SWF_ENTRY: original,
        "assets/bundle.zip": bytes(rng.getrandbits(8) for _ in range(60000)),
        "assets/bundle.zip.sha1": b"0123456789abcdef0123456789abcdef01234567",
    }
    apk = os.path.join(out, "game.apk")
    with zipfile.ZipFile(apk, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("AndroidManifest.xml", b"\0" * 100)
        z.writestr("lib/arm64-v8a/libsomething.so", bytes(rng.getrandbits(8) for _ in range(30000)))
        for name, data in entries_data.items():
            z.writestr(name, data)
    with zipfile.ZipFile(os.path.join(out, "game.xapk"), "w", zipfile.ZIP_STORED) as z:
        z.writestr("manifest.json", b"{}")
        z.writestr("config.arm64_v8a.apk", b"PK\x05\x06" + b"\0" * 18)
        with open(apk, "rb") as f:
            z.writestr("com.example.game.apk", f.read())
    with zipfile.ZipFile(os.path.join(out, "wrong.apk"), "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries_data.items():
            z.writestr(name, data if name != "assets/bundle.zip" else data[:-1] + b"!")
    # a crafted entry far larger than the game's (here 8 MB of zeros as bundle.zip.sha1, 40 B in the game)
    with zipfile.ZipFile(os.path.join(out, "oversized.apk"), "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries_data.items():
            z.writestr(name, data if name != "assets/bundle.zip.sha1" else b"\0" * (8 << 20))
    # bundle.zip's compressed data damaged in the middle
    damaged = os.path.join(out, "damaged.apk")
    with zipfile.ZipFile(damaged, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries_data.items():
            z.writestr(name, data)
    with zipfile.ZipFile(damaged) as z:
        info = z.getinfo("assets/bundle.zip")
    with open(damaged, "r+b") as f:
        f.seek(info.header_offset + 30 + len(info.filename) + info.compress_size // 2)
        f.write(bytes(rng.getrandbits(8) for _ in range(64)))
    # STORED entries with data descriptors (a zip written to a stream): valid, but ZipInputStream refuses them

    class Unseekable(io.RawIOBase):
        def __init__(self, f):
            self.f = f

        def writable(self):
            return True

        def write(self, b):
            return self.f.write(b)

    with open(os.path.join(out, "stored-dd.apk"), "wb") as f:
        with zipfile.ZipFile(Unseekable(f), "w", zipfile.ZIP_STORED) as z:
            z.writestr("AndroidManifest.xml", b"\0" * 100)
            for name, data in entries_data.items():
                z.writestr(name, data)
    with zipfile.ZipFile(os.path.join(out, "notgame.zip"), "w") as z:
        z.writestr("readme.txt", "hello")
    with open(os.path.join(out, "notzip.bin"), "wb") as f:
        f.write(b"this is not a zip file at all" * 100)

    old = swf_ops.fws(original)
    new = b"FWS" + original[3:4] + struct.pack("<I", len(patched) + 8) + bytes(patched)
    ops = swf_ops.encode(old, new, swf_ops.make_ops(old, new))
    assert swf_ops.apply(old, ops) == new
    with open(os.path.join(out, "assets", "swf.ops"), "wb") as f:
        f.write(ops)
    entries = {name: (len(data), hashlib.sha256(data).hexdigest()) for name, data in entries_data.items()}
    with open(apk, "rb") as f:
        apk_sha256 = hashlib.sha256(f.read()).hexdigest()
    with open(os.path.join(out, "assets", "manifest.properties"), "w", encoding="utf-8") as f:
        f.write(build.import_manifest(entries, apk_sha256, ops, old, new))
    with open(os.path.join(out, "expected.sha256"), "w") as f:
        f.write(hashlib.sha256(new).hexdigest())
    print(f"fixture in {out}: op list {len(ops)} B, {swf_ops.stats(swf_ops.decode(ops)[4])}")


if __name__ == "__main__":
    main()
