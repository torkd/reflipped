#!/usr/bin/env python3
"""SH-28 regression: Search Players' Search button enables for any typed ID, not only for 12 or more characters.

Patches a user-supplied original APK's game SWF in memory and checks the search scene's per-frame update
(UserSearchTopScene.update: enabled = N <= searchInputText.text.length) uses 1 instead of 12, and nothing else in
the method changed. No device, server, vendor fixture or binary output.

    python3 -I sh28-search-id-length-test.py <original.apk>
"""
import os
import sys
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import patch_game
import swf_patch as sp


def search_update(swf):
    """The disassembly of the one `update` method that reads searchInputText and sets a button's enabled state."""
    hits = []
    for _, block in sp.Swf(swf).abc_blocks():
        p = sp.AbcPatch(block)
        for method in p.abc.methods:
            if method['body'] is None or not (method['owner'] or '').endswith(':int/update'):
                continue
            code = [(op, args) for _, op, args in p.abc.disasm(method['body'])]
            names = {str(args[0]) for op, args in code if args}
            if {'searchInputText', 'setVisualEnabled'} <= names:
                hits.append(code)
    assert len(hits) == 1, f'expected one search update method, found {len(hits)}'
    return hits[0]


def minimum(code):
    """N in `N <= searchInputText.text.length`."""
    found = [code[k][1][0] for k in range(len(code) - 5)
             if code[k][0] == 'pushbyte' and code[k + 2][0] == 'getproperty'
             and str(code[k + 2][1][0]) == 'searchInputText' and str(code[k + 4][1][0]) == 'length'
             and code[k + 5][0] == 'lessequals']
    assert len(found) == 1, found
    return found[0]


def main(apk):
    with zipfile.ZipFile(apk) as archive:
        original = archive.read('assets/worldflipper_android_release.swf')
    before = search_update(original)
    after = search_update(patch_game.patch_swf(original))
    assert minimum(before) == 12, minimum(before)
    assert minimum(after) == 1, minimum(after)
    changed = [(b, a) for b, a in zip(before, after) if b != a]
    assert len(before) == len(after) and len(changed) == 1, changed
    print('sh28-search-id-length-test: ok')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
