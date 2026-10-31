#!/usr/bin/env python3
"""Dump World Flipper master tables from the CDN archives to JSON.

The game ships its master data (characters, items, quests, campaigns...) as "orderedmap" files inside the
CDN asset zips. Every asset is stored under a digested name, `production/upload/<h[:2]>/<h[2:]>` with
`h = sha1(<path> + SALT)`, where a master table's path is `master/<table>.orderedmap`. The table names are
the paths the client's master loader registers (e.g. `/campaign/multi_special_exchange/multi_special_exchange_campaign`);
find them in the SWF with `client/air-shell/tools/disasm.py <apk> ref <text>`, or let `--discover` try every
path-like string of the SWF.

Format (as decoded by wdfp-extractor, github.com/ScripterSugar/wdfp-extractor):
  - a plain table is a zlib-compressed CSV;
  - an orderedmap is `int32le headerSize`, then a zlib-compressed header (`int32le count`, `count` pairs of
    `int32le keyEnd, int32le valueEnd`, then the concatenated UTF-8 keys), then the concatenated values;
    each value is a zlib-compressed CSV or, recursively, another orderedmap.
Leaves are written like wdfp-extractor writes them (the CSV records flattened into one list of strings),
so `scripts/converter.py` reads the output unchanged.

When a table appears in several archives, the newest asset version wins (full archives count as 2.1.0, a
diff `asset-A-B-n-hash.zip` as version B); `--version` stops at a given version.

Usage (run from the repository root, CDN in `.cdn/` by default; `CDN_DIR` or `--cdn` override it):
  python3 -I scripts/extract_master.py campaign/multi_special_exchange/multi_special_exchange_campaign character/character
      writes <out>/campaign/multi_special_exchange/multi_special_exchange_campaign.json, ... (default out: ./master-out)
  python3 -I scripts/extract_master.py --out /tmp/master --version 2.1.100 item/item
  python3 -I scripts/extract_master.py --discover World+Flipper_0.0.81_APKPure.apk [--dump]
      lists every master table named in the SWF that the archives hold (with --dump, writes them all)
  python3 -I scripts/extract_master.py --raw master/campaign/foo.orderedmap
      any asset path, not only master tables (written as-is unless it decodes as an orderedmap)
Options: --region en (CDN subfolder, default en), --stdout (print JSON instead of writing files),
  --flat (write <out>/<last path part>.json, the layout `scripts/converter.py` reads from `scripts/in/`).

Feeding the converter, e.g. for the multi-special exchange tables (FT-13):
  python3 -I scripts/extract_master.py --flat --out scripts/in \
      campaign/multi_special_exchange/multi_special_exchange_campaign \
      campaign/multi_special_exchange/multi_special_exchange_campaign_character
  (cd scripts && python3 -I converter.py)   # then copy the files you need from scripts/out/ into assets/

Never commit the output: it is game data. Convert what the server needs into `assets/` instead.
"""
import argparse
import csv
import hashlib
import importlib.util
import io
import json
import os
import re
import struct
import sys
import zipfile
import zlib

SALT = "K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy"
ARCHIVE_RE = re.compile(r"^s?_?asset-(\d+\.\d+\.\d+)-(?:(\d+\.\d+\.\d+)-)?\d+-[0-9a-f]+\.zip$")


def digest_path(path):
    h = hashlib.sha1((path + SALT).encode("utf-8")).hexdigest()
    return f"production/upload/{h[:2]}/{h[2:]}"


def table_name(name):
    """A table name as given on the command line or found in the SWF, without "master/", ".orderedmap" or slashes."""
    return name.strip("/").removeprefix("master/").removesuffix(".orderedmap")


def table_path(name):
    return f"master/{table_name(name)}.orderedmap"


def parse_version(text):
    return tuple(int(x) for x in text.split("."))


class Cdn:
    """Index of every asset in the CDN archives: digested name -> (version, zip path)."""

    def __init__(self, root, max_version=None):
        self.index = {}
        if not os.path.isdir(root):
            sys.exit(f"CDN directory not found: {root}")
        for category in sorted(os.listdir(root)):
            folder = os.path.join(root, category)
            if not category.startswith("archive-") or not os.path.isdir(folder):
                continue
            for name in os.listdir(folder):
                m = ARCHIVE_RE.match(name)
                if not m:
                    continue
                version = parse_version(m.group(2) or m.group(1))
                if max_version is not None and version > max_version:
                    continue
                zip_path = os.path.join(folder, name)
                try:
                    with zipfile.ZipFile(zip_path) as z:
                        for member in z.namelist():
                            known = self.index.get(member)
                            if known is None or version > known[0]:
                                self.index[member] = (version, zip_path)
                except zipfile.BadZipFile:
                    print(f"skipping broken archive {zip_path}", file=sys.stderr)

    def read(self, path):
        """Returns (bytes, version) of an asset path, or None."""
        member = digest_path(path)
        found = self.index.get(member)
        if found is None:
            return None
        with zipfile.ZipFile(found[1]) as z:
            return z.read(member), found[0]


def parse_csv(data):
    text = data.decode("utf-8")
    return [field for record in csv.reader(io.StringIO(text)) for field in record]


def read_orderedmap(data):
    """Decodes an orderedmap (or a plain zlib CSV table) into nested dicts of flattened CSV rows."""
    try:
        return parse_csv(zlib.decompress(data))
    except zlib.error:
        pass
    header_size = struct.unpack_from("<i", data, 0)[0]
    header = zlib.decompress(data[4:4 + header_size])
    count = struct.unpack_from("<i", header, 0)[0]
    offsets = [struct.unpack_from("<ii", header, 4 + i * 8) for i in range(count)]
    keys_blob = header[4 + count * 8:]
    content = data[4 + header_size:]
    result = {}
    key_start = value_start = 0
    for key_end, value_end in offsets:
        key = keys_blob[key_start:key_end].decode("utf-8")
        value = content[value_start:value_end]
        key_start, value_start = key_end, value_end
        try:
            result[key] = parse_csv(zlib.decompress(value))
        except zlib.error:
            result[key] = read_orderedmap(value)
    return result


TABLE_NAME_RE = re.compile(r"/?[a-z0-9_]+(?:/[a-z0-9_]+)+")


def load_abc_module():
    """The SWF/ABC reader of the AIR shell tools (client/air-shell/tools/abc.py), loaded the way disasm.py does."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "client", "air-shell", "tools", "abc.py")
    spec = importlib.util.spec_from_file_location("abcr", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def swf_table_names(path):
    """Path-like strings in the constant pools of the game SWF (from the APK or a bare SWF), as table names."""
    if path.endswith(".apk"):
        with zipfile.ZipFile(path) as z:
            swf = z.read("assets/worldflipper_android_release.swf")
    else:
        with open(path, "rb") as f:
            swf = f.read()
    abc = load_abc_module()
    names = set()
    for _, block in abc.abc_blocks(swf):
        for text in abc.Abc(block).strings:
            if text and TABLE_NAME_RE.fullmatch(text):
                names.add(table_name(text))
    return sorted(names)


def write_json(obj, out_dir, name, to_stdout, flat=False):
    if to_stdout:
        json.dump(obj, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return
    target = os.path.join(out_dir, (os.path.basename(name) if flat else name) + ".json")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    print(target)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("tables", nargs="*", help="master table names, e.g. character/character")
    parser.add_argument("--cdn", default=os.environ.get("CDN_DIR", ".cdn"), help="CDN root (default .cdn or $CDN_DIR)")
    parser.add_argument("--region", default="en", help="CDN region folder (default en)")
    parser.add_argument("--out", default="master-out", help="output directory (default ./master-out)")
    parser.add_argument("--version", help="ignore archives newer than this asset version, e.g. 2.1.100")
    parser.add_argument("--discover", metavar="APK_OR_SWF", help="list the master tables named in the SWF")
    parser.add_argument("--dump", action="store_true", help="with --discover, dump every table found")
    parser.add_argument("--raw", action="append", default=[], metavar="PATH", help="extract an asset by its path")
    parser.add_argument("--stdout", action="store_true", help="print JSON instead of writing files")
    parser.add_argument("--flat", action="store_true", help="write <out>/<table base name>.json")
    args = parser.parse_args()
    if not args.tables and not args.discover and not args.raw:
        parser.error("name at least one table, --raw path or --discover")
    if args.dump and not args.discover:
        parser.error("--dump needs --discover")

    root = os.path.join(args.cdn, args.region) if os.path.isdir(os.path.join(args.cdn, args.region)) else args.cdn
    cdn = Cdn(root, parse_version(args.version) if args.version else None)

    tables = list(args.tables)
    if args.discover:
        found = []
        for name in swf_table_names(args.discover):
            entry = cdn.index.get(digest_path(table_path(name)))
            if entry is None:
                continue
            found.append(name)
            print(f"{name}\t{'.'.join(map(str, entry[0]))}")
        if args.dump:
            tables += found

    missing = 0
    for name in tables:
        got = cdn.read(table_path(name))
        if got is None:
            print(f"not found: {table_path(name)}", file=sys.stderr)
            missing += 1
            continue
        write_json(read_orderedmap(got[0]), args.out, table_name(name), args.stdout, args.flat)

    for path in args.raw:
        got = cdn.read(path)
        if got is None:
            print(f"not found: {path}", file=sys.stderr)
            missing += 1
            continue
        try:
            write_json(read_orderedmap(got[0]), args.out, path, args.stdout, args.flat)
        except (zlib.error, struct.error, UnicodeDecodeError):
            if args.stdout:
                sys.stdout.buffer.write(got[0])
            else:
                target = os.path.join(args.out, path)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, "wb") as f:
                    f.write(got[0])
                print(target)
    sys.exit(1 if missing else 0)


if __name__ == "__main__":
    main()
