#!/usr/bin/env python3
"""The extra SWF patch of an "import" build (build.py --content import), applied after patch_game.py (in place).

    python3 -I patch_import.py <worldflipper_android_release.swf>

  bundle-from-storage   The game's bundle extractor (the one method that pushes both "bundle.zip" and
            "bundle.zip.sha1") reads the two files from File.applicationStorageDirectory instead of
            File.applicationDirectory: an import build has no bundle.zip in its APK, the app copies it from the
            player's game into its own storage. It extracts into app-storage:/asset as before. Two multiname swaps.

An embedded build doesn't use it: its bundle.zip is in the APK, where the original code looks.
Tools: swf_patch.py (edit AVM2 code), disasm.py (find the code to change).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import swf_patch as sp  # noqa: E402

BUNDLE_NAMES = {"bundle.zip", "bundle.zip.sha1"}


def patch_bundle_from_storage(p):
    """Number of File.applicationDirectory reads moved to applicationStorageDirectory in this ABC block."""
    hits = 0
    for i, m in enumerate(p.abc.methods):
        if m["body"] is None:
            continue
        strings = {args[0] for _, op, args in p.abc.disasm(m["body"]) if op == "pushstring" and args}
        if not BUNDLE_NAMES <= strings:
            continue
        body = p.body(i)
        storage = p.qname("", "applicationStorageDirectory")
        for k, x in enumerate(body.instrs):
            if k and x.op == "getproperty" and p.abc.mn(x.args[0]).endswith("applicationDirectory") \
                    and body.instrs[k - 1].op == "getlex" and p.abc.mn(body.instrs[k - 1].args[0]).endswith("File"):
                x.args[0] = storage
                hits += 1
    return hits


def patch_swf(data: bytes) -> bytes:
    swf = sp.Swf(data)
    total = 0
    for idx, block in swf.abc_blocks():
        p = sp.AbcPatch(block)
        n = patch_bundle_from_storage(p)
        if n:
            swf.set_abc(idx, p.build())
            total += n
    if total != 2:
        sys.exit(f"patch_import: expected 2 bundle.zip reads from File.applicationDirectory, found {total}: "
                 "is this the flipper game 0.0.81?")
    return swf.build()


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    path = sys.argv[1]
    with open(path, "rb") as f:
        data = f.read()
    with open(path, "wb") as f:
        f.write(patch_swf(data))
    print(f"patched {path}: bundle-from-storage")


if __name__ == "__main__":
    main()
