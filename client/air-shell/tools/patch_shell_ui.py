"""Small SH-14 menu edits anchored to the statically mapped original 0.0.81 methods.

Only instructions/labels are changed; no vendor source or art is stored here. Unmatched/ambiguous shapes stop builds.
"""
import swf_patch as sp

I = sp.Instr


def unique(p, name, text=None):
    matches = []
    for index, method in enumerate(p.abc.methods):
        if method['body'] is None or not (method['owner'] or '').endswith('/' + name):
            continue
        if text is not None and not any(op == 'pushstring' and args[0] == text
                                        for _, op, args in p.abc.disasm(method['body'])):
            continue
        matches.append(index)
    assert len(matches) == 1, (name, text, matches)
    return p.body(matches[0])


def name(p, ins):
    return p.abc.mn(ins.args[0]) if ins.args else ''


def nop(ins):
    # Preserve instruction identity because branches and try ranges can point at it.
    ins.op, ins.args, ins.target, ins.cases = 'nop', [], None, None


def native_option(p, key):
    body = unique(p, 'hideFacebook')
    receiver = next(x for x in body.instrs if x.op == 'getlex')
    instance = next(x for x in body.instrs if x.op == 'callproperty' and x.args[1] == 0)
    getter = next(x for x in body.instrs if x.op == 'callproperty' and name(p, x) == 'kgAppOptionGetValue')
    return [I(receiver.op, *receiver.args), I(instance.op, *instance.args),
            I('pushstring', p.string(key)), I(getter.op, *getter.args)]


def replace_ui_string(p, body, key, replacement=None, option=None):
    hits = [i for i, x in enumerate(body.instrs)
            if x.op == 'pushstring' and x.args[0] < len(p.abc.strings) and p.abc.strings[x.args[0]] == key]
    assert len(hits) == 1, (key, hits)
    at = hits[0]
    call = body.instrs[at + 1]
    assert call.op == 'callproperty' and name(p, call) == 'getUiString', key
    # Asset receiver is already on the stack; replace its lookup with a literal or the native option.
    body.instrs[at].op, body.instrs[at].args = 'pop', []
    nop(call)
    body.instrs[at + 2:at + 2] = native_option(p, option) if option else [I('pushstring', p.string(replacement))]
    body.max_stack = max(body.max_stack, 12)


def redirect_case(p, body, case, key):
    switch = next(x for x in body.instrs if x.op == 'lookupswitch')
    assert len(switch.cases) > case
    show = next(x.args[0] for x in body.instrs if x.op == 'callpropvoid' and name(p, x) == 'showGeneralWebView')
    code = [I('getlocal2'), I('pushstring', p.string(key)), I('callpropvoid', show, 1), I('returnvoid')]
    switch.cases[case] = code[0]
    body.instrs[-1:-1] = code


def hide_idp(p, body, key):
    at = next(i for i, x in enumerate(body.instrs) if x.op == 'pushstring' and x.args[0] < len(p.abc.strings) and p.abc.strings[x.args[0]] == key)
    # Outer appId != KR branch controls this complete row, including off-screen placement in its else branch.
    app = max(i for i in range(at) if body.instrs[i].op == 'getproperty' and name(p, body.instrs[i]) == 'appId')
    assert body.instrs[app - 1].op == 'getlocal1'
    branch = body.instrs[app + 3]
    assert branch.op == 'ifeq' and branch.target is not None
    for ins in body.instrs[app - 1:app + 3]: nop(ins)
    branch.op, branch.args = 'jump', []


def drop_push_row(p, body, kind):
    at = next(i for i, x in enumerate(body.instrs) if x.op == 'getproperty' and name(p, x) == kind)
    start = max(i for i in range(at) if body.instrs[i].op.startswith('getlocal'))
    end = next(i for i in range(at, len(body.instrs)) if body.instrs[i].op == 'callpropvoid'
               and name(p, body.instrs[i]).endswith(':push'))
    assert all(x.target is None and x.cases is None for x in body.instrs[start:end + 1]), kind
    for ins in body.instrs[start:end + 1]: nop(ins)


BRANCHES = {'jump', 'iftrue', 'iffalse', 'ifeq', 'ifne', 'iflt', 'ifle', 'ifgt', 'ifge', 'ifstricteq', 'ifstrictne',
            'ifnlt', 'ifnle', 'ifngt', 'ifnge', 'lookupswitch'}


def is_string(p, ins, text):
    return ins.op == 'pushstring' and ins.args[0] == p.string(text)


def straight(instrs):
    return all(x.op not in BRANCHES and x.target is None and x.cases is None for x in instrs)


def insert_before(body, old, code):
    """Insert `code` so that every branch that went to `old` now runs `code` first."""
    for ins in body.instrs:
        if ins.target is old:
            ins.target = code[0]
        if ins.cases:
            ins.cases = [code[0] if c is old else c for c in ins.cases]
    assert all(old not in e[:3] for e in body.exceptions)
    at = body.instrs.index(old)
    body.instrs[at:at] = code


def parsed_result(p, handler):
    """The `getlocal` of the parsed native result: the one read just before the handler's `isSuccess` check."""
    success = next(i for i, ins in enumerate(handler.instrs) if ins.op == 'getproperty' and name(p, ins) == 'isSuccess')
    result = handler.instrs[success - 1]
    assert result.op == 'getlocal' and result.args == [5], result
    return result


def end_when_cancelled(p, handler):
    """A native result with `reflippedCancelled` (the player backed out of a shell dialog) ends `handler` quietly."""
    result = parsed_result(p, handler)
    at = handler.instrs.index(result)
    handler.instrs[at:at] = [I('getlocal', *result.args), I('getproperty', p.qname('', 'reflippedCancelled')),
                             I('iftrue', target=next(ins for ins in reversed(handler.instrs) if ins.op == 'returnvoid'))]


def account_buttons(p, account):
    """Account Info: Sign out and the account button as real buttons (QA: the bare text rows didn't look tappable).

    The original draws Logout/Unregister as transparent text buttons (`transButton` 0 and 1, button indexes 12 and 13).
    Two unused full-width buttons with the game's button face take over: `fullButton` 0 (always parked off-screen)
    for the account button and `fullButton` 2 (the Google Play row, off-screen outside KR) for Sign out. Their code is
    a copy of the coupon/Admin panel row's straight-line block with other container and button indexes, inserted
    where the Google Play row's branches meet; the text rows are parked off-screen without registering their taps.
    """
    ins = account.instrs
    # -- hide the transparent rows (labels already replaced by "Sign out" / "Reflipped account")
    sign_out = [i for i, x in enumerate(ins) if is_string(p, x, 'Sign out')]
    assert len(sign_out) == 1, sign_out
    gate = max(i for i in range(sign_out[0]) if ins[i].op == 'ifne')
    assert [x.op for x in ins[gate - 4:gate]] == ['getlocal1', 'getproperty', 'getlex', 'getproperty'] \
        and name(p, ins[gate - 3]) == 'idpCode'
    for x in ins[gate - 4:gate]: nop(x)
    ins[gate].op, ins[gate].args = 'jump', []
    over = next(i for i in range(sign_out[0], len(ins)) if ins[i].op == 'jump')
    merge = ins.index(ins[over].target)
    parked = ins[over + 1:merge]
    assert straight(parked) and name(p, parked[-1]) == 'y' and [x.op for x in parked].count('pushbyte') == 1
    account_row = [i for i, x in enumerate(ins) if is_string(p, x, 'Reflipped account')]
    assert len(account_row) == 1, account_row
    end = next(i for i in range(account_row[0], len(ins)) if ins[i].op == 'callpropvoid'
               and name(p, ins[i]) == 'addWithConfig')
    second = ins[merge:end + 1]
    assert straight(second)
    assert not any(x.target in second[1:] or (x.cases and any(c in second[1:] for c in x.cases)) for x in ins)
    for x in second: nop(x)
    park = [I(x.op, *x.args) for x in parked]
    next(x for x in park if x.op == 'pushbyte').args = [1]
    ins[end + 1:end + 1] = park

    # -- the full-width rows, copied from the Admin panel (coupon) row
    label = [i for i, x in enumerate(ins) if is_string(p, x, 'Admin panel')]
    assert len(label) == 1, label
    start = max(i for i in range(label[0]) if ins[i].op == 'iffalse') + 1
    stop = next(i for i in range(label[0], len(ins)) if ins[i].op == 'jump')
    row = ins[start:stop]
    assert straight(row) and row[-1].op == 'setlocal' and row[-1].args == [7], row[-1]

    def copy(text, option, container, button):
        code = [I(x.op, *x.args) for x in row]
        boxes = [i for i, x in enumerate(code) if is_string(p, x, 'fullButton')]
        for i in boxes:
            box = next(x for x in code[i:i + 5] if x.op == 'pushbyte')
            assert box.args == [1]
            box.args = [container]
        group = [i for i, x in enumerate(code) if x.op == 'getproperty' and name(p, x) == 'buttonGroupView']
        assert len(group) == 1 and code[group[0] + 1].op == 'pushbyte' and code[group[0] + 1].args == [5]
        code[group[0] + 1].args = [button]
        at = next(i for i, x in enumerate(code) if is_string(p, x, 'Admin panel'))
        code[at:at + 1] = native_option(p, option) if option else [I('pushstring', p.string(text))]
        return code

    google = next(i for i, x in enumerate(ins) if is_string(p, x, 'kakao_googleplay_login'))
    meet = next(i for i in range(google, len(ins)) if ins[i].op == 'getlocal1' and name(p, ins[i + 1]) == 'appId')
    assert any(x.target is ins[meet] for x in ins), 'expected the Google Play row to rejoin here'
    insert_before(account, ins[meet], copy(None, 'accountLabel', 0, 13) + copy('Sign out', None, 2, 12))
    account.max_stack = max(account.max_stack, 12)


def reset_viewer_on_account_change(p):
    """FIX-12: the game keeps the viewer ID it signed up with and signs up (tool/signup) only when it has none, and
    the shell's Sign out no longer deletes the game's local data. So when the app logged in to another account or
    server than the one that ID came from (native options `viewerReset`/`viewerCleared`, `ShellConfig`), the game deletes
    only its stored account (viewer ID, UDID) before choosing between sign-up and load, as the original Sign out's
    `localStore.delete()` did along with everything else, and signs up again: the server then hands it the account's
    own ID instead of /load refusing one another account still holds.
    """
    body = unique(p, 'startSignUpOrLoad')
    ins = body.instrs
    assert [x.op for x in ins[:7]] == ['getlocal0', 'pushscope', 'getlex', 'findproperty', 'getproperty',
                                       'callproperty', 'coerce']
    assert name(p, ins[3]) == 'localStore' and name(p, ins[4]) == 'localStore' \
        and name(p, ins[5]).split(':')[-1] == 'get_account'
    # localStore.delete() deletes the account store with the account class's own static; reuse that call
    stores = [i for i, m in enumerate(p.abc.methods) if m['body'] is not None and (m['owner'] or '').endswith('/delete')
              and any(op == 'findproperty' and args[0] == 'get_account' for _, op, args in p.abc.disasm(m['body']))]
    assert len(stores) == 1, stores
    store = p.body(stores[0]).instrs
    at = next(i for i, x in enumerate(store) if x.op == 'findproperty' and name(p, x) == 'get_account')
    assert [x.op for x in store[at - 1:at + 4]] == ['getlex', 'findproperty', 'callproperty', 'coerce', 'callpropvoid']
    assert name(p, store[at - 1]) == name(p, ins[2]) and store[at + 3].args[1] == 1
    original = ins[2]
    code = native_option(p, 'viewerReset') + [I('pushstring', p.string('true')), I('ifne', target=original)]
    code += [I(x.op, *x.args) for x in ins[2:7]] + [I('callpropvoid', *store[at + 3].args)]
    # acknowledged once deleted: a crash before this asks again at the next launch
    code += native_option(p, 'viewerCleared') + [I('pop')]
    ins[2:2] = code
    body.max_stack = max(body.max_stack, 12)


def patch_shell_ui(p):
    if not any(method['body'] is not None and (method['owner'] or '').endswith('/setupContents')
               and any(op == 'pushstring' and args[0] == 'kakao_coupon_input'
                       for _, op, args in p.abc.disasm(method['body'])) for method in p.abc.methods):
        return False
    account = unique(p, 'setupContents', 'kakao_coupon_input')
    for key, value in [('kakao_coupon_input', 'Admin panel'), ('kakao_logout', 'Sign out'),
                       ('kakao_game_unregister', 'Reflipped account'), ('kakao_server_info', 'Server')]:
        replace_ui_string(p, account, key, replacement=value)
    hide_idp(p, account, 'kakao_google_login')
    hide_idp(p, account, 'kakao_apple_login')
    for key in ['kakao_kr_server', 'kakao_eu_server', 'kakao_na_server', 'kakao_sea_server']:
        replace_ui_string(p, account, key, option='serverName')
    account_buttons(p, account)
    title = unique(p, 'updateInfoTextField')
    for key in ['kakao_kr_server', 'kakao_eu_server', 'kakao_na_server', 'kakao_sea_server']:
        replace_ui_string(p, title, key, option='serverInfo')

    # Actual origin switches reuse the complete original Clear Cache flow, not a version-counter guess.
    # Its successful delete completion acknowledges the pending flag before the existing soft restart.
    load = unique(p, 'kgSessionLoadAppInfosHandler')
    clear = unique(p, 'cacheClearOkHandler')
    assert [x.op for x in clear.instrs[:2]] == ['getlocal0', 'pushscope']
    assert clear.instrs[-2].op == 'returnvoid'
    copied = clear.instrs[2:-2]
    assert all(x.target is None and x.cases is None for x in copied)
    assert [x.op for x in load.instrs[:2]] == ['getlocal0', 'pushscope']
    original = load.instrs[2]
    code = native_option(p, 'serverAssetReset') + [I('pushstring', p.string('true')), I('ifne', target=original)]
    code += [I(x.op, *x.args) for x in copied] + [I('returnvoid')]
    load.instrs[2:2] = code
    load.max_stack = max(load.max_stack, clear.max_stack, 12)
    flow_class = next(name(p, x) for x in copied if x.op == 'constructprop')
    completed_ids = p.methods(flow_class + '/assetDeleteInput')
    assert len(completed_ids) == 1
    completed = p.body(completed_ids[0])
    completed.instrs[0:0] = native_option(p, 'assetsCleared') + [I('pop')]
    completed.max_stack = max(completed.max_stack, 12)

    logout = unique(p, 'kgSessionLogoutHandler')
    delete = [i for i, x in enumerate(logout.instrs) if x.op == 'callpropvoid' and name(p, x) == 'delete']
    assert len(delete) == 1
    at = delete[0]
    assert [x.op for x in logout.instrs[at - 3:at]] == ['getlex', 'getproperty', 'getproperty']
    assert name(p, logout.instrs[at - 1]) == 'localStore'
    for ins in logout.instrs[at - 3:at + 1]: nop(ins)
    owner = p.abc.methods[logout.method]['owner'].rsplit('/', 1)[0]
    handler = p.methods(owner + '/buttonClicked')
    assert len(handler) == 1
    redirect_case(p, p.body(handler[0]), 13, 'urlAccount')

    # Hidden legacy CONNECT callers must not turn a cancelled portal form into a failed-link popup.
    end_when_cancelled(p, unique(p, 'kgSessionForCustomUiConnectHandler'))
    # SH-16: Sign out asks first (KakaoGameSdkStub); its Cancel must not show "logout failed" either.
    end_when_cancelled(p, logout)
    # FIX-12: the kept viewer ID goes when the next session plays another account (Sign out keeps the rest above).
    reset_viewer_on_account_change(p)

    # SH-16: "Choose another server" at session start (PortalSignIn.deviceSecret) restarts at once, as the connection
    # error's Close button would, so the restarted title opens the server list without showing an error first.
    start = unique(p, 'kgSessionStartHandler')
    error = [i for i, ins in enumerate(start.instrs) if is_string(p, ins, 'common_remote_error_description')]
    assert len(error) == 1
    failure = max(i for i in range(error[0]) if start.instrs[i].op == 'getlex' and name(p, start.instrs[i]) == 'Std')
    restart = [i for i, ins in enumerate(start.instrs) if ins.op == 'findproperty' and name(p, ins) == 'dlgRestartHandler']
    assert len(restart) == 1 and name(p, start.instrs[restart[0] + 1]) == 'dlgRestartHandler'
    result = parsed_result(p, start)
    insert_before(start, start.instrs[failure], [
        I('getlocal', *result.args), I('getproperty', p.qname('', 'reflippedRestart')),
        I('iffalse', target=start.instrs[failure]),
        I('findproperty', *start.instrs[restart[0]].args), I('pushnull'),
        I('callpropvoid', start.instrs[restart[0] + 1].args[0], 1), I('returnvoid')])
    start.max_stack = max(start.max_stack, 2)

    other = unique(p, 'createMenuListData', 'kakao_menu_achievement')
    drop_push_row(p, other, 'Comic')
    drop_push_row(p, other, 'ComicHelp')
    for ins in other.instrs:
        if ins.op == 'pushstring' and p.abc.strings[ins.args[0]] == 'scene/general/sprite_sheet/vector_icon-assets/achievement_android':
            ins.args = [p.string('scene/general/sprite_sheet/vector_icon-assets/copyright')]
    owner = p.abc.methods[other.method]['owner'].rsplit('/', 1)[0]
    handler = p.methods(owner + '/listSelected')
    assert len(handler) == 1
    redirect_case(p, p.body(handler[0]), 6, 'urlCredits')
    # Keep case 9 and rich_text/right: original third-party/legal notices remain accessible.
    strings = [i for i, method in enumerate(p.abc.methods) if method['body'] is not None
               and (method['owner'] or '').endswith('/getUiString')]
    assert len(strings) == 3
    for index in strings:
        body = p.body(index)
        original = body.instrs[0]
        body.instrs[0:0] = [I('getlocal1'), I('pushstring', p.string('kakao_menu_achievement')),
                            I('ifne', target=original), I('pushstring', p.string('Reflipped credits')), I('returnvalue')]
        body.max_stack = max(body.max_stack, 2)

    # Home's two dynamic comic banners are master feature_banner rows 2 and 16 in the original EN data.
    # Filter those rows before the carousel is built; other feature/event banners retain their existing logic.
    banners = unique(p, 'getViewableBanners')
    gate = next(i for i, ins in enumerate(banners.instrs) if ins.op == 'callproperty' and name(p, ins) == 'isViewable')
    assert banners.instrs[gate - 1].op == 'getlocal'
    skip = next(ins.target for ins in banners.instrs[gate:] if ins.op == 'iffalse')
    checks = []
    for banner_id in [2, 16]:
        checks += [I('getlocal', 4), I('callproperty', p.qname('', 'getId'), 0), I('pushbyte', banner_id), I('ifeq', target=skip)]
    banners.instrs[gate - 1:gate - 1] = checks
    banners.max_stack = max(banners.max_stack, 2)

    # Notification Settings keeps its stamina switch (SH-7: the app schedules the reminder); the Kakao server-push
    # row goes, since no server sends pushes.
    settings = unique(p, 'run', 'application_option_push_notification_stamina_title')
    drop_push_row(p, settings, 'KakaoEnablePush')
    prepare = unique(p, 'prepareScene', 'pinball.scene.applicationOption.ApplicationOptionScene')
    for kind in ['KakaoEnablePush']:
        at = next(i for i, x in enumerate(prepare.instrs) if x.op == 'getproperty' and name(p, x) == kind)
        start = at - 2
        assert prepare.instrs[start].op == 'getlocal'
        end = next(i for i in range(at, len(prepare.instrs)) if prepare.instrs[i].op == 'callpropvoid' and name(p, prepare.instrs[i]) == 'set')
        for ins in prepare.instrs[start:end + 1]: nop(ins)
    return True
