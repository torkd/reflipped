#!/usr/bin/env python3
"""NEW SH-14 regression: patch a user-supplied original APK in memory and verify mapped control-flow changes.
No device, server, vendor fixture or binary output. Usage: python3 -I sh14-patches-test.py <original.apk>
"""
import os
import sys
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import patch_game
import swf_patch as sp


def main(apk):
    with zipfile.ZipFile(apk) as archive:
        original = archive.read('assets/worldflipper_android_release.swf')
    patched = patch_game.patch_swf(original)
    methods = []
    for _, block in sp.Swf(patched).abc_blocks():
        p = sp.AbcPatch(block)
        for index, method in enumerate(p.abc.methods):
            if method['body'] is not None:
                methods.append((p, index, method, list(p.abc.disasm(method['body']))))

    def find(suffix, marker=None):
        hits = [m for m in methods if (m[2]['owner'] or '').endswith('/' + suffix)
                and (marker is None or any(op == 'pushstring' and args[0] == marker for _, op, args in m[3]))]
        assert len(hits) == 1, (suffix, marker, len(hits))
        return hits[0]

    account = find('setupContents', 'Admin panel')
    text = {args[0] for _, op, args in account[3] if op == 'pushstring'}
    assert {'accountLabel', 'Sign out', 'Server', 'serverName'} <= text
    # Sign out (button 12) and the account button (13) are full-width rows now; the text rows register nothing.
    groups = [args[0] for (_, op, args), (_, prev, pargs) in zip(account[3][1:], account[3]) if op == 'pushbyte'
              and prev == 'getproperty' and pargs[0] == 'buttonGroupView']
    assert groups.count(12) == 1 and groups.count(13) == 1, groups
    # Both old IdP outer visibility conditions now enter their existing off-screen branches unconditionally.
    code = account[0].body(account[1]).instrs
    hidden = sum(1 for i, ins in enumerate(code) if ins.op == 'jump' and i >= 4
                 and all(x.op == 'nop' for x in code[i - 4:i]))
    assert hidden >= 2, hidden

    cancelled = find('kgSessionForCustomUiConnectHandler')
    assert any(op == 'getproperty' and args[0] == 'reflippedCancelled' for _, op, args in cancelled[3])
    logout = find('kgSessionLogoutHandler')
    assert not any(op == 'callpropvoid' and args[0] == 'delete' for _, op, args in logout[3])
    # SH-16: Cancel in the shell's sign-out confirmation ends the handler without the failed-logout popup.
    assert any(op == 'getproperty' and args[0] == 'reflippedCancelled' for _, op, args in logout[3])
    # SH-16: "Choose another server" at session start restarts straight away instead of showing the error popup.
    start = find('kgSessionStartHandler')
    restart = [i for i, (_, op, args) in enumerate(start[3]) if op == 'getproperty' and args[0] == 'reflippedRestart']
    assert len(restart) == 1
    assert [op for _, op, _ in start[3][restart[0] + 1:restart[0] + 6]] == \
        ['iffalse', 'findproperty', 'pushnull', 'callpropvoid', 'returnvoid']
    # FIX-12: after a login to another account, the game deletes only its kept viewer ID (the account store) and
    # acknowledges it, before choosing between sign-up and load.
    choose = find('startSignUpOrLoad', 'viewerReset')
    ops = [(op, args) for _, op, args in choose[3]]
    reset = ops.index(('pushstring', ['viewerReset']))
    cleared = ops.index(('pushstring', ['viewerCleared']))
    assert [op for op, _ in ops[reset + 2:reset + 4]] == ['pushstring', 'ifne']
    assert [op for op, _ in ops[reset + 4:reset + 10]] == \
        ['getlex', 'findproperty', 'getproperty', 'callproperty', 'coerce', 'callpropvoid']
    assert reset + 10 < cleared and ops[cleared + 2][0] == 'pop'
    assert [op for op, _ in ops[cleared + 3:cleared + 6]] == ['getlex', 'findproperty', 'getproperty']
    assert not any(op == 'callpropvoid' and args[0] == 'delete' for op, args in ops)
    account_owner = logout[2]['owner'].rsplit('/', 1)[0]
    clicked = next(m for m in methods if m[2]['owner'] == account_owner + '/buttonClicked')
    body = clicked[0].body(clicked[1])
    switch = next(x for x in body.instrs if x.op == 'lookupswitch')
    at = body.instrs.index(switch.cases[13])
    routed = body.instrs[at:at + 4]
    assert [x.op for x in routed] == ['getlocal2', 'pushstring', 'callpropvoid', 'returnvoid']
    assert clicked[0].abc.strings[routed[1].args[0]] == 'urlAccount'
    assert clicked[0].abc.mn(routed[2].args[0]) == 'showGeneralWebView'

    load = find('kgSessionLoadAppInfosHandler')
    assert any(op == 'pushstring' and args[0] == 'serverAssetReset' for _, op, args in load[3])
    assert any(op == 'callpropvoid' and args[0] == 'clearCaches' for _, op, args in load[3])
    complete = find('assetDeleteInput', 'assetsCleared')
    assert complete[3][0][1] == 'getlex'  # acknowledgment precedes original restart command
    title = find('updateInfoTextField')
    assert sum(op == 'pushstring' and args[0] == 'serverInfo' for _, op, args in title[3]) == 4
    # Removed native push switches must not leave the old rows in the settings view.
    for m in methods:
        if 'application_option_push_notification_stamina_description' in [args[0] for _, op, args in m[3] if op == 'pushstring']:
            raise AssertionError('Removed stamina notification row remains')
    other = find('createMenuListData', 'kakao_menu_terms')
    assert not any(op == 'getproperty' and args[0] in {'Comic', 'ComicHelp'} for _, op, args in other[3])
    other_owner = other[2]['owner'].rsplit('/', 1)[0]
    other_click = next(m for m in methods if m[2]['owner'] == other_owner + '/listSelected')
    other_body = other_click[0].body(other_click[1])
    other_switch = next(x for x in other_body.instrs if x.op == 'lookupswitch')
    credits_at = other_body.instrs.index(other_switch.cases[6])
    assert other_click[0].abc.strings[other_body.instrs[credits_at + 1].args[0]] == 'urlCredits'
    assert any(op == 'pushstring' and args[0] == 'rich_text/right' for _, op, args in other_click[3])
    banners = find('getViewableBanners')
    assert sum(op == 'callproperty' and args[0] == 'getId' for _, op, args in banners[3]) == 2
    assert sum(any(op == 'pushstring' and args[0] == 'Reflipped credits' for _, op, args in method[3])
               for method in methods if (method[2]['owner'] or '').endswith('/getUiString')) == 3

    # Re-encoding every edited body validates all jump/exception targets against actual instruction objects.
    for p, index, method, _ in methods:
        if method['owner'] in {account[2]['owner'], logout[2]['owner'], clicked[2]['owner'], load[2]['owner'],
                               complete[2]['owner'], title[2]['owner'], other[2]['owner'], start[2]['owner'],
                               choose[2]['owner']}:
            p.body(index).build()
    print('SH-14 patched menu, logout, viewer reset, server label and cache-reset control-flow checks passed')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
