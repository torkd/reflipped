"""Test copies of a .cdn folder for client/air-shell/test/cdncopy-test.sh (SH-29).

    python3 -I make_cdn_copies.py <repo> <cdn dir> <count> <out dir>

From the first COUNT archives of the official en list (assets/asset_lists/en-android-full.json), in the CDN folder,
writes into OUT:
- list.tsv: those archives as the app's list ("path<TAB>size<TAB>sha256"), a short unofficial list;
- cdn-pax.tar: a pax tar of a `.cdn/` folder, the archives in folder order (not the list's), with other languages,
  iOS archives, a mods file and a path over 100 characters around them;
- cdn-gnu.tar: the same as a GNU tar (long names in 'L' records), with no folder above en/;
- cdn.zip: the same as a deflated zip;
- cdn64.zip: the same, stored, with every zip64 record and field forced (as a zip over 4 GB has them);
- cdn.tar.gz: a gzip of cdn-pax.tar, which the app refuses;
- cut.tar: cdn-pax.tar without the list's last archive;
- damaged.zip: cdn64.zip with one byte changed inside the list's second archive.
"""
import gzip
import io
import json
import os
import struct
import sys
import tarfile
import zipfile
import zlib


def official_list(repo, count):
    with open(os.path.join(repo, "assets", "asset_lists", "en-android-full.json"), encoding="utf-8") as f:
        listed = json.load(f)
    archives = list(listed["full"]["archive"])
    for step in listed["diff"]:
        archives += step["archive"]
    prefix = "{$cdnAddress}/"
    return [(a["location"][len(prefix):], a["size"], a["sha256"]) for a in archives[:count]]


def members(cdn, archives, root):
    """(name, bytes) in folder order, with the extras a full copy holds."""
    files = {f"{root}{path}": open(os.path.join(cdn, path), "rb").read() for path, _, _ in archives}
    files[f"{root}ko/archive-android-full/asset-2.1.0-1-00000000.zip"] = b"not this language"
    files[f"{root}en/archive-ios-full/asset-2.1.0-1-00000000.zip"] = b"not this platform"
    files[f"{root}mods/readme.txt"] = b"a server's mods"
    files[f"{root}en/entities/files/" + "x" * 90 + "/long-name.bin"] = b"a path over 100 characters"
    return sorted(files.items())


def write_tar(path, files, fmt):
    with tarfile.open(path, "w", format=fmt) as tar:
        for name, data in files:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))


def write_zip64(path, files):
    """A stored zip whose every size and offset sits in zip64 fields, and with the zip64 end records."""
    out = open(path, "wb")
    central = []
    for name, data in files:
        raw = name.encode()
        crc = zlib.crc32(data) & 0xffffffff
        offset = out.tell()
        extra = struct.pack("<HHQQ", 1, 16, len(data), len(data))
        out.write(struct.pack("<IHHHHHIIIHH", 0x04034b50, 45, 0, 0, 0, 0, crc, 0xffffffff, 0xffffffff, len(raw), len(extra)))
        out.write(raw + extra + data)
        central.append((raw, crc, len(data), offset))
    start = out.tell()
    for raw, crc, size, offset in central:
        extra = struct.pack("<HHQQQ", 1, 24, size, size, offset)
        out.write(struct.pack("<IHHHHHHIIIHHHHHII", 0x02014b50, 45, 45, 0, 0, 0, 0, crc, 0xffffffff, 0xffffffff,
                              len(raw), len(extra), 0, 0, 0, 0, 0xffffffff))
        out.write(raw + extra)
    end = out.tell()
    out.write(struct.pack("<IQHHIIQQQQ", 0x06064b50, 44, 45, 45, 0, 0, len(central), len(central), end - start, start))
    out.write(struct.pack("<IIQI", 0x07064b50, 0, end, 1))
    out.write(struct.pack("<IHHHHIIH", 0x06054b50, 0, 0, 0xffff, 0xffff, 0xffffffff, 0xffffffff, 0))
    out.close()


def main():
    repo, cdn, count, out = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
    os.makedirs(out, exist_ok=True)
    archives = official_list(repo, count)
    with open(os.path.join(out, "list.tsv"), "w", encoding="utf-8", newline="\n") as f:
        for path, size, sha in archives:
            f.write(f"{path}\t{size}\t{sha}\n")
    dotted = members(cdn, archives, ".cdn/")
    write_tar(os.path.join(out, "cdn-pax.tar"), dotted, tarfile.PAX_FORMAT)
    write_tar(os.path.join(out, "cdn-gnu.tar"), members(cdn, archives, ""), tarfile.GNU_FORMAT)
    with zipfile.ZipFile(os.path.join(out, "cdn.zip"), "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in dotted:
            z.writestr(name, data)
    write_zip64(os.path.join(out, "cdn64.zip"), dotted)
    with open(os.path.join(out, "cdn-pax.tar"), "rb") as f, gzip.open(os.path.join(out, "cdn.tar.gz"), "wb") as g:
        g.write(f.read())
    last = ".cdn/" + archives[-1][0]
    write_tar(os.path.join(out, "cut.tar"), [m for m in dotted if m[0] != last], tarfile.PAX_FORMAT)
    data = bytearray(open(os.path.join(out, "cdn64.zip"), "rb").read())
    second = open(os.path.join(cdn, archives[1][0]), "rb").read()
    at = bytes(data).index(second)
    data[at + 1000] ^= 1
    open(os.path.join(out, "damaged.zip"), "wb").write(data)
    print(f"made test copies of {count} archives in {out}")


if __name__ == "__main__":
    main()
