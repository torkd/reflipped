#!/usr/bin/env python3
"""Disassemble methods of the World Flipper SWF (AVM2 bytecode), no Java or decompiler needed.

Usage:
  python3 -I disasm.py <apk|swf> owner <text> [--list]   methods whose owner ("Class/method") contains <text>
  python3 -I disasm.py <apk|swf> ref <text> [--list]     methods whose code mentions <text> (string, name)

Class names are obfuscated (e.g. "–.‐.⼀....:int"), but method names, strings and Haxe debug info
are not, so "owner /kgSessionStartHandler" or "ref KGSESSION_START" find things quickly.
--list prints only the matching method owners. Debug/line-number noise is filtered out.
"""
import importlib.util
import os
import sys
import zipfile

_spec = importlib.util.spec_from_file_location("abcr", os.path.join(os.path.dirname(os.path.abspath(__file__)), "abc.py"))
abcr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(abcr)

NOISE_OPS = {"debugline", "debugfile", "debug"}
NOISE_STRINGS = {"fileName", "lineNumber", "className", "methodName"}


def load(path):
    if path.endswith(".apk"):
        with zipfile.ZipFile(path) as z:
            return z.read("assets/worldflipper_android_release.swf")
    with open(path, "rb") as f:
        return f.read()


def main():
    if len(sys.argv) < 4 or sys.argv[2] not in ("owner", "ref"):
        sys.exit(__doc__)
    swf, mode, needle = load(sys.argv[1]), sys.argv[2], sys.argv[3]
    list_only = "--list" in sys.argv
    for _, block in abcr.abc_blocks(swf):
        abc = abcr.Abc(block)
        for m in abc.methods:
            if not m["body"]:
                continue
            owner = m["owner"] or "?"
            ins = list(abc.disasm(m["body"]))
            if mode == "owner":
                hit = needle in owner
            else:
                hit = any(needle in str(x) for _, _, args in ins for x in args)
            if not hit:
                continue
            print("=====", owner)
            if list_only:
                continue
            for off, op, args in ins:
                if op in NOISE_OPS or (op == "pushstring" and args and args[0] in NOISE_STRINGS):
                    continue
                print(f"  {off:5} {op} {' '.join(map(str, args))}")


if __name__ == "__main__":
    main()
