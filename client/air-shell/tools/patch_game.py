#!/usr/bin/env python3
"""Reflipped changes to the game SWF's bytecode, applied at build time (in place).

    python3 -I patch_game.py <worldflipper_android_release.swf>

What changes (each patch must find exactly one target, or the build stops):
  shell-ui   Reflipped account/admin/server labels, Sign out and account as full buttons, safe logout and
             cross-origin cache refresh, dead menu rows and the server-push switch hidden.
  no-plus   The header's "+" buttons for stamina, beads and mana are hidden (and so can't be
            tapped): they led to the shop's paid currency.
  tall-screen   Phones taller than 20:9 got white bars of 115 (top) and 89 (bottom) design pixels.
  tutorial-locks   Events and Boss Battles can't be opened during the tutorial (they only showed a padlock).
  tutorial-lock-status   Their padlock and "locked" message come from the game's real unlock rules, not the
            generic Japanese-only tutorial message.
  medium-images   Screens under 1440 design pixels high asked for the small image set ("small_upload"), which the
            CDN doesn't have (its manifest and archives are medium only): every asset image was "not found" and
            the game showed "insufficient data". Medium is used on every screen.
  no-package-shop   The Shop tab's "Adventurer's Shop" row (paid packs) is removed.
  any-beads-portal   The portal draws that took paid beads only (the daily discounted pull, the once-per-account
            10-pull) take any beads, free ones first: the client's getPaymentType reports them as payment type 1
            (beads, free first) instead of 2 (paid only), so its cost and shortage checks count both kinds and the
            request says so. Reflipped charges them free first whichever type the client sends.
  any-beads-bundles   The Bundle Marketplace's bundles, priced in paid beads, are checked against all the player's beads
            (the bundle product's isPaidOnly is false, and TradeCostKind 1 reads all beads), and its Shop row shows all
            beads as owned.
  any-beads-ticket   The special exchange ticket bundle (Scouting / Dream Armament seasons), sold for paid beads only,
            is checked against all the player's beads (get_virtualMoney) rather than the paid ones.
  any-beads-portal-dialog   The confirmation dialog of those portal draws shows free and paid beads, before and after,
            like a regular pull's, instead of the paid ones only (which read 0 for a player who has only free beads).
  any-beads-ticket-dialog   The ticket bundle's purchase dialog (Scouting and Dream Armament seasons, the Start Dash
            bundle) shows all the player's beads, titled "Owned", instead of the paid ones titled "Paid".
  search-id-length   Search Players' Search button enabled only for IDs of 12 or more characters (a Kakao player
            ID's length); Reflipped's player IDs are shorter, so it never enabled. Any typed ID enables it.

Opt-in diagnostic (not part of the normal build): with REFLIPPED_TRACE_ASSETS=<base url> in the environment, the
  trace-missing-files patch makes the game request <base url>/fnf?f=<asset name>&p=<paths>&e=<exists>&c=<cached> whenever it
  can't open an asset file, so Reflipped's request log names the files behind "insufficient data" and the
  paths it looked in (e = File.exists now, c = the game's cached answer). Point it at a URL that answers 200
  (e.g. http://<ip>:8000/patch/Live/2.0.0 with an empty file `.cdn/fnf`), or the failed request raises F2032.

Opt-in for co-op testing: with REFLIPPED_READY_SECONDS=<1..32767> in the environment, the ready-seconds patch
  replaces the lobby's 60 s idle limit. Guests who don't touch the room for that long are marked ready
  automatically, which locks their party and ready button; testers editing equipment need longer.

Tools: swf_patch.py (edit AVM2 code), abc.py (read it), disasm.py (find the code to change).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import swf_patch as sp  # noqa: E402
from patch_shell_ui import patch_shell_ui  # noqa: E402

def I(name, *args, target=None):
    return sp.Instr(name, *args, target=target)


def find_method(p, owner):
    found = p.methods(owner)
    return found[0] if len(found) == 1 else None


def find_by_string(p, text, name):
    """The single method named `name` whose code pushes the string `text`."""
    if text not in p.abc.strings:
        return None
    hits = []
    for i, m in enumerate(p.abc.methods):
        if m["body"] is None or not (m["owner"] or "").endswith("/" + name):
            continue
        if any(op == "pushstring" and args[0] == text for _, op, args in p.abc.disasm(m["body"])):
            hits.append(i)
    return hits[0] if len(hits) == 1 else None


# ------------------------------------------------------------------ plus buttons
def hide_container(b, button, visible_mn):
    """After the layout container (string index `button`) is fetched, set its `visible` to false."""
    ins = b.instrs
    uses = [i for i, x in enumerate(ins) if x.op == "pushstring" and x.args[0] == button]
    assert len(uses) == 1, f"expected one use of the layout name, found {len(uses)}"
    at = uses[0]
    for j in range(at, len(ins) - 1):
        if ins[j].op == "setlocal" or ins[j].op in ("setlocal1", "setlocal2", "setlocal3"):
            local = ins[j].args[0] if ins[j].op == "setlocal" else int(ins[j].op[-1])
            ins[j + 1:j + 1] = [I("getlocal", local), I("pushfalse"), I("setproperty", visible_mn)]
            return
        if ins[j].op == "coerce" and ins[j + 1].op == "getlex":  # stored nowhere: the value is still on the stack
            ins[j + 1:j + 1] = [I("dup"), I("pushfalse"), I("setproperty", visible_mn)]
            return
    raise ValueError(f"no place to hide {button}")


def patch_no_plus(p):
    run = find_by_string(p, "mana_addition_button", "run")
    if run is None:
        return False
    b = p.body(run)
    visible = next(i.args[0] for i in b.instrs if i.op == "getproperty" and p.abc.mn(i.args[0]) == "visible")
    for name in ("mana_addition_button", "virtual_money_addtion_button", "stamina_addition_button"):
        assert name in p.abc.strings, name
        hide_container(b, p.abc.strings.index(name), visible)
    b.max_stack = max(b.max_stack, 8)
    return True


# ------------------------------------------------------------------ tall screens
TOP_MARGIN, BOTTOM_MARGIN = 115.0, 89.0   # design pixels the game reserves on screens narrower than 0.49
KEEP_BOTTOM = 24                          # a little room above the gesture area, in design pixels


def patch_tall_screen_margins(p):
    """On screens taller than about 20:9 the game's screen-size code (resetScreenSize's helper) reserves
    115 design pixels at the top and 89 at the bottom, white bars meant for iPhone-style notches and home
    indicators. The device's real cutout inset is still added on top of whatever is left, so the margins
    are replaced with 0 at the top and a small gap at the bottom."""
    found = []
    for i, m in enumerate(p.abc.methods):
        if m["body"] is None:
            continue
        ds = [a[0] for _, op, a in p.abc.disasm(m["body"]) if op == "pushdouble"]
        if TOP_MARGIN in ds and BOTTOM_MARGIN in ds and 0.49 in ds:
            found.append(i)
    if not found:
        return False
    assert len(found) == 1, found
    b = p.body(found[0])
    for ins in b.instrs:
        if ins.op == "pushdouble" and p.abc.doubles[ins.args[0]] == TOP_MARGIN:
            ins.op, ins.args = "pushbyte", [0]
        elif ins.op == "pushdouble" and p.abc.doubles[ins.args[0]] == BOTTOM_MARGIN:
            ins.op, ins.args = "pushbyte", [KEEP_BOTTOM]
    return True


# ------------------------------------------------------------------ shop list
def patch_no_package_shop(p):
    """Drop the "Adventurer's Shop" row (ShopTopListItemKind.PackageShop, paid packs) from the Shop tab."""
    hits = []
    for i, m in enumerate(p.abc.methods):
        if m["body"] is None or not (m["owner"] or "").endswith("/createMenuListData"):
            continue
        if any(op == "getproperty" and a[0] == "PackageShop" for _, op, a in p.abc.disasm(m["body"])):
            hits.append(i)
    if not hits:
        return False
    assert len(hits) == 1, hits
    ins = p.body(hits[0]).instrs
    at = next(i for i, x in enumerate(ins) if x.op == "getproperty" and p.abc.mn(x.args[0]) == "PackageShop")
    start = max(i for i in range(at) if ins[i].op == "getlocal1")   # `list.push({kind: ..., content: ..., price: ...})`
    end = next(i for i in range(at, len(ins)) if ins[i].op == "callpropvoid" and p.abc.mn(ins[i].args[0]).endswith(":push"))
    assert all(x.op != "end" and x.target is None for x in ins[start:end + 1]), "unexpected branch in the PackageShop row"
    doomed = {id(x) for x in ins[start:end + 1]}
    assert not any(id(t) in doomed for x in ins for t in ([x.target] if x.target else []) + (x.cases or [])), \
        "a jump targets the PackageShop row"
    assert not any(id(t) in doomed for e in p.body(hits[0]).exceptions for t in e[:3]), "a try range touches the PackageShop row"
    del ins[start:end + 1]
    return True


# ------------------------------------------------------------------ paid-only bead costs
def patch_any_beads_portal(p):
    """getPaymentType (the portal logic's): draw kinds 5 and 7, payment type 2 (paid beads only), become 1 (beads, free
    first). The method is a lookupswitch whose branches each return a constant; the one returning 2 returns 1."""
    hits = [i for i, m in enumerate(p.abc.methods)
            if m["body"] is not None and (m["owner"] or "").endswith(":int/getPaymentType")]
    if not hits:
        return False
    assert len(hits) == 1, hits
    ins = p.body(hits[0]).instrs
    paid = [x for k, x in enumerate(ins) if x.op == "pushbyte" and x.args[0] == 2 and k + 1 < len(ins) and ins[k + 1].op == "returnvalue"]
    assert len(paid) == 1, "getPaymentType: expected one `return 2`"
    paid[0].args = [1]
    return True


def patch_any_beads_ticket(p):
    """The special exchange ticket purchase check (a static method of the bundle's dialog: price minus the paid beads,
    then the shortage flow or the purchase) reads get_virtualMoney (all beads) instead of get_paidVirtualMoney."""
    hits = []
    for i, m in enumerate(p.abc.methods):
        if m["body"] is None:
            continue
        calls = [str(a[0]) for _, op, a in p.abc.disasm(m["body"]) if op == "callproperty"]
        if "get_paidVirtualMoney" in calls and any(c.endswith("get_productPrice") for c in calls) and "/static " in (m["owner"] or ""):
            hits.append(i)
    if not hits:
        return False
    assert len(hits) == 1, hits
    total = p.find_mn("get_virtualMoney")
    assert total is not None, "no get_virtualMoney multiname"
    ins = p.body(hits[0]).instrs
    paid = [x for x in ins if x.op == "callproperty" and p.abc.mn(x.args[0]) == "get_paidVirtualMoney"]
    assert len(paid) == 1, paid
    paid[0].args = [total] + list(paid[0].args[1:])
    return True


def patch_any_beads_bundles(p):
    """The Bundle Marketplace (shop/special_pack_shop, FT-89) prices its bundles in paid beads (TradeCostKind 1): the
    player data's getNumberByTradeCostKind answers get_paidVirtualMoney for that kind, so the client said "You're short"
    and offered the bead shop to a player with only free beads. That branch reads get_virtualMoney (all beads), like
    kind 0; the server takes any beads, free first. The Shop list's "Owned" count on the Bundle Marketplace row
    (createMenuListData, the read after BuySpecialPack) shows all beads too."""
    hits = [i for i, m in enumerate(p.abc.methods) if m["body"] is not None and (m["owner"] or "").endswith("/getNumberByTradeCostKind")]
    if not hits:
        return False
    assert len(hits) == 1, hits
    total = p.find_mn("get_virtualMoney")
    ins = p.body(hits[0]).instrs
    paid = [x for x in ins if x.op in ("findproperty", "callproperty") and p.abc.mn(x.args[0]) == "get_paidVirtualMoney"]
    assert len(paid) == 2, paid
    for x in paid:
        x.args = [total] + list(x.args[1:])

    menus = [i for i, m in enumerate(p.abc.methods) if m["body"] is not None and (m["owner"] or "").endswith("/createMenuListData")
             and any(op == "getproperty" and a[0] == "BuySpecialPack" for _, op, a in p.abc.disasm(m["body"]))]
    assert len(menus) == 1, menus
    ins = p.body(menus[0]).instrs
    row = next(k for k, x in enumerate(ins) if x.op == "getproperty" and p.abc.mn(x.args[0]) == "BuySpecialPack")
    owned = next(x for x in ins[row:] if x.op == "callproperty" and p.abc.mn(x.args[0]) == "get_paidVirtualMoney")
    owned.args = [total] + list(owned.args[1:])

    # the bundle product (a shop product subclass) sets isPaidOnly = true in its constructor, which makes canBuy check
    # the paid beads and the purchase dialog show them only; false, as every other shop product has it
    ctors = []
    for i, m in enumerate(p.abc.methods):
        if m["body"] is None or not (m["owner"] or "").endswith("/<init>"):
            continue
        ops = list(p.abc.disasm(m["body"]))
        if any(ops[k][1] == "pushtrue" and ops[k + 1][1] == "initproperty" and str(ops[k + 1][2][0]).endswith("isPaidOnly")
               for k in range(len(ops) - 1)):
            ctors.append(i)
    assert len(ctors) == 1, ctors
    ins = p.body(ctors[0]).instrs
    flag = [k for k in range(len(ins) - 1) if ins[k].op == "pushtrue" and ins[k + 1].op == "initproperty"
            and p.abc.mn(ins[k + 1].args[0]).endswith("isPaidOnly")]
    assert len(flag) == 1, flag
    ins[flag[0]].op = "pushfalse"
    return True


def patch_any_beads_portal_dialog(p):
    """The portal draw confirmation dialog's cost (GachaDrawCostKind.VirtualMoney(free, freeCost, paid, paidCost,
    isPaidOnly), built by a static method of the dialog): draw kinds 5 and 7 have their own branch, which passes a free
    cost of 0 and isPaidOnly = true, so the dialog shows only the paid beads, "before" and "after". That branch gets the
    regular branch's arguments instead: the free cost from getCostOfFreeVirtualMoney (free first, since any-beads-portal
    makes their payment type 1) and isPaidOnly = false, so the dialog shows both kinds of beads like a regular pull."""
    hits = []
    for i, m in enumerate(p.abc.methods):
        if m["body"] is None or "/static " not in (m["owner"] or ""):
            continue
        calls = [str(a[0]) for _, op, a in p.abc.disasm(m["body"]) if op == "callproperty" and a]
        if any(c.endswith("getCostOfFreeVirtualMoney") for c in calls) and any(c.endswith("get_onceTicketItemId") for c in calls):
            hits.append(i)
    if not hits:
        return False
    assert len(hits) == 1, hits
    b = p.body(hits[0])
    ins = b.instrs

    def call(x, name, argc):
        return x.op == "callproperty" and p.abc.mn(x.args[0]).endswith(name) and x.args[1] == argc
    free_cost = next(x for x in ins if call(x, "getCostOfFreeVirtualMoney", 2))
    paid_only = [k for k in range(1, len(ins)) if ins[k - 1].op == "pushtrue" and call(ins[k], "VirtualMoney", 5)]
    assert len(paid_only) == 1, "expected one VirtualMoney(..., true)"
    k = paid_only[0]
    # VirtualMoney(player.get_freeVirtualMoney(), 0, player.get_paidVirtualMoney(), paidCost, true)
    zero = ins[k - 6]
    assert zero.op == "pushbyte" and zero.args == [0] and call(ins[k - 8], "get_freeVirtualMoney", 0), \
        [x.op for x in ins[k - 9:k + 1]]
    ins[k - 1].op = "pushfalse"
    # 0 becomes this.getCostOfFreeVirtualMoney(player, kind), as the regular branch computes it (same locals)
    zero.op, zero.args = "getlocal1", []
    ins[k - 5:k - 5] = [I("getlocal2"), I("getlocal3"), I("callproperty", *free_cost.args), I("convert_i")]
    b.max_stack += 3
    return True


def patch_any_beads_ticket_dialog(p):
    """The ticket bundle purchase dialog (Scouting and Dream Armament seasons, the Start Dash bundle) shows the bead
    balance as "Paid", before and after, from the price helper with isPaidOnly = true. Since any-beads-ticket checks the
    purchase against all beads, the row shows all of them, titled "Owned" (possession) like the shop's buy dialog."""
    init = find_by_string(p, "special_exchange_ticket_buy_dialog_character_caution", "<init>")
    if init is None:
        return False
    ins = p.body(init).instrs
    paid = p.abc.strings.index("paid") if "paid" in p.abc.strings else None
    titles = [x for x in ins if x.op == "pushstring" and x.args[0] == paid]
    assert len(titles) == 1, f"expected one \"paid\" title, found {len(titles)}"
    flags = [k for k in range(len(ins) - 3)
             if ins[k].op == "pushtrue" and ins[k + 1].op.startswith("getlocal")
             and ins[k + 2].op == "getproperty" and p.abc.mn(ins[k + 2].args[0]) == "playerLogic"
             and ins[k + 3].op == "callproperty" and ins[k + 3].args[1] == 3]
    assert len(flags) == 1, f"expected one balance call with isPaidOnly = true, found {len(flags)}"
    ins[flags[0]].op = "pushfalse"
    titles[0].args = [p.string("possession")]
    return True


# ------------------------------------------------------------------ lock events and boss battles
LOCKED_IN_TUTORIAL = ("event", "boss_battle")   # game system ids (getUnlockIdForSceneKind)


def patch_tutorial_locks(p):
    """Events and Boss Battles show a padlock during the tutorial but still open: changeSceneWithDetail
    only runs its game-system unlock check when !isDuringTutorial() (so the tutorial's own scripted
    navigation isn't blocked), and the padlock icon is drawn from the same flag. Run the check during
    the tutorial too, for these two systems only; it then reports "locked" like the icon does."""
    hits = []
    for i, m in enumerate(p.abc.methods):
        if m["body"] is None or not (m["owner"] or "").endswith("/changeSceneWithDetail"):
            continue
        names = [a[0] for _, op, a in p.abc.disasm(m["body"]) if op == "callproperty" and a]
        if "resolveChangeSceneNextKind" in names and "isDuringTutorial" in names:
            hits.append(i)
    if not hits:
        return False
    assert len(hits) == 1, hits
    b = p.body(hits[0])
    ins = b.instrs
    at = next(i for i, x in enumerate(ins) if x.op == "callproperty" and p.abc.mn(x.args[0]) == "isDuringTutorial")
    assert [x.op for x in ins[at + 1:at + 4]] == ["convert_b", "not", "iffalse"], [x.op for x in ins[at + 1:at + 4]]
    join = ins[at + 3]

    def first(op, name):
        return next(x for x in ins if x.op == op and p.abc.mn(x.args[0]) == name)
    manager = first("findproperty", "gameSystemUnlockManager").args[0]
    resolve = first("callproperty", "resolveChangeSceneNextKind").args[0]
    option = first("coerce", "haxe.ds:Option").args[0]
    index, params = first("getproperty", "index").args[0], first("getproperty", "params").args[0]
    item = next(x for x in ins if x.op == "getproperty" and p.abc.mn(x.args[0]) == "<ML>").args[0]
    next_local, id_local = b.local_count, b.local_count + 1       # two locals the method doesn't use
    no, yes = I("pushfalse"), I("pushtrue")
    check = [I("dup"), I("iftrue", target=join), I("pop"),
             # next = gameSystemUnlockManager.resolveChangeSceneNextKind(scene)
             I("findproperty", manager), I("getproperty", manager), I("getlocal1"), I("callproperty", resolve, 1),
             I("coerce", option), I("setlocal", next_local),
             I("getlocal", next_local), I("getproperty", index), I("pushbyte", 0), I("ifne", target=no),   # not Some(id)
             I("getlocal", next_local), I("getproperty", params), I("pushbyte", 0), I("getproperty", item),
             I("setlocal", id_local)]
    for system in LOCKED_IN_TUTORIAL:
        check += [I("getlocal", id_local), I("pushstring", p.string(system)), I("ifstricteq", target=yes)]
    check += [no, I("jump", target=join), yes]
    ins[at + 3:at + 3] = check
    b.local_count = id_local + 1
    b.max_stack = max(b.max_stack, 6)
    return True


def patch_tutorial_lock_status(p):
    """While the tutorial runs, GameSystemUnlockStatus is "locked" for every system with a generic Japanese-only
    message ("unlocked under specific conditions"). For Events and Boss Battles use the real check instead (the
    game's unlock table), so the padlock and the message say what actually unlocks them."""
    hits = []
    for i, m in enumerate(p.abc.methods):
        if m["body"] is None or not (m["owner"] or "").endswith("/getGameSystemUnlockStatus"):
            continue
        names = [a[0] for _, op, a in p.abc.disasm(m["body"]) if op in ("callproperty", "findproperty") and a]
        if "isDuringTutorial" in names and "getGameSystemUnlockRepository" in names:
            hits.append(i)
    if not hits:
        return False
    assert len(hits) == 1, hits
    ins = p.body(hits[0]).instrs
    at = next(i for i, x in enumerate(ins) if x.op == "callproperty" and p.abc.mn(x.args[0]) == "isDuringTutorial")
    assert [x.op for x in ins[at + 1:at + 3]] == ["convert_b", "iffalse"], [x.op for x in ins[at + 1:at + 3]]
    join = ins[at + 2]
    other, real = I("pushtrue"), I("pushfalse")
    check = [I("dup"), I("iffalse", target=join), I("pop")]      # not in the tutorial: nothing to change
    for system in LOCKED_IN_TUTORIAL:                           # a system that gets the real check: not "in tutorial"
        check += [I("getlocal1"), I("pushstring", p.string(system)), I("ifstricteq", target=real)]
    check += [other, I("jump", target=join), real]
    ins[at + 2:at + 2] = check
    p.body(hits[0]).max_stack = max(p.body(hits[0]).max_stack, 6)
    return True


def patch_medium_images(p):
    """get_imageScale (the screen-size helper) returns ImageScale.Small below 1440 px of screen height. The
    CDN serves medium images only, so both branches return Medium."""
    hits = [i for i, m in enumerate(p.abc.methods)
            if m["body"] is not None and (m["owner"] or "").endswith(":int/get_imageScale")]
    if not hits:
        return False
    assert len(hits) == 1, hits
    ins = p.body(hits[0]).instrs
    small = [x for x in ins if x.op == "getproperty" and p.abc.mn(x.args[0]) == "Small"]
    medium = next(x for x in ins if x.op == "getproperty" and p.abc.mn(x.args[0]) == "Medium")
    assert len(small) == 1, small
    small[0].args = list(medium.args)
    return True


SEARCH_ID_MIN_LENGTH = 12   # the client's minimum: Kakao player IDs had 12 digits ("984521158255")


def patch_search_id_length(p):
    """Search Players (UserSearchTopScene.update, every frame) enables its Search button only when the typed ID has at
    least 12 characters, the length of a Kakao player ID. The ID the game shows ("Your ID" on the Following/Followers
    screen, kakaoInfo.playerId) is Reflipped's account number, a few digits long, so the button never enabled. Any
    typed ID enables it now, as searchInputTextChanged already does; the server answers an unknown ID with "Player
    not found"."""
    hits = []
    for i, m in enumerate(p.abc.methods):
        if m["body"] is None or not (m["owner"] or "").endswith(":int/update"):
            continue
        code = list(p.abc.disasm(m["body"]))
        names = [str(a[0]) for _, op, a in code if op in ("getproperty", "callpropvoid") and a]
        if "searchInputText" in names and "setVisualEnabled" in names \
                and any(op == "pushbyte" and a[0] == SEARCH_ID_MIN_LENGTH for _, op, a in code):
            hits.append(i)
    if not hits:
        return False
    assert len(hits) == 1, hits
    ins = p.body(hits[0]).instrs
    # enabled = 12 <= searchInputText.text.length: pushbyte 12, findproperty, getproperty searchInputText, getproperty
    # text, getproperty length, lessequals
    at = [k for k in range(len(ins) - 5)
          if ins[k].op == "pushbyte" and ins[k].args[0] == SEARCH_ID_MIN_LENGTH
          and ins[k + 2].op == "getproperty" and p.abc.mn(ins[k + 2].args[0]) == "searchInputText"
          and ins[k + 4].op == "getproperty" and p.abc.mn(ins[k + 4].args[0]) == "length"
          and ins[k + 5].op == "lessequals"]
    assert len(at) == 1, f"expected one `12 <= searchInputText.text.length`, found {len(at)}"
    ins[at[0]].args = [1]
    return True


def patch_trace_missing_files(p):
    """Diagnostics only (REFLIPPED_TRACE_ASSETS=<server url>, any build): request
    <url>/fnf?f=<name><ext>&p=<resolved paths>&e=<File.exists now>&c=<fileExistsSync, which caches>
    for every asset file the game fails to open, so Reflipped's request log names the files "insufficient
    data" is about and shows whether they are missing on disk (e=false) or only cached as missing
    (e=true, c=false). (trace() output only reaches an attached fdb, never logcat.)"""
    names = ("/notifyFileNotFoundError", "/readAssetFileFailureHandler")   # the two FileNotFound dispatchers
    hits = [i for i, m in enumerate(p.abc.methods)
            if m["body"] is not None and (m["owner"] or "").endswith(names)]
    if not hits:
        return False
    assert len(hits) == len(names), hits
    loader, request = p.qname("flash.net", "URLLoader"), p.qname("flash.net", "URLRequest")
    file = p.qname("flash.filesystem", "File")
    resolve, cached = p.find_mn("resolveFiles"), p.find_mn("fileExistsSync")
    exists, join, pop = p.qname("", "exists"), p.qname("", "join"), p.qname("", "pop")
    base = os.environ["REFLIPPED_TRACE_ASSETS"].rstrip("/") + "/fnf?f="

    def first_path():   # this.resolveFiles(name, ext).pop(): the last candidate (there is one asset dir)
        return [I("getlocal0"), I("getlocal1"), I("getlocal2"), I("callproperty", resolve, 2), I("callproperty", pop, 0)]

    for hit in hits:
        b = p.body(hit)
        b.instrs[0:0] = [
            I("findpropstrict", loader), I("findpropstrict", request),
            I("pushstring", p.string(base)), I("getlocal1"), I("add"), I("getlocal2"), I("add"),
            I("pushstring", p.string("&p=")), I("add"),
            I("getlocal0"), I("getlocal1"), I("getlocal2"), I("callproperty", resolve, 2), I("callproperty", join, 0), I("add"),
            I("pushstring", p.string("&e=")), I("add"),
            I("findpropstrict", file), *first_path(), I("constructprop", file, 1), I("getproperty", exists), I("add"),
            I("pushstring", p.string("&c=")), I("add"),
            I("getlocal0"), *first_path(), I("callproperty", cached, 1), I("add"),
            I("constructprop", request, 1), I("constructprop", loader, 1), I("pop")]
        b.max_stack = max(b.max_stack, 12)
    return True


def patch_ready_seconds(p):
    """Opt-in (REFLIPPED_READY_SECONDS=<seconds>, any build): the co-op lobby's ready counter (resetCount) sets the
    next forced-ready time to now + 60000 ms; this makes it now + <seconds> * 1000. The warnings at 30, 10 and 5 s
    before it still show."""
    seconds = int(os.environ["REFLIPPED_READY_SECONDS"])
    if not 1 <= seconds <= 32767:
        sys.exit("patch_game: REFLIPPED_READY_SECONDS must be 1..32767")
    found = [i for i, m in enumerate(p.abc.methods)
             if m["body"] is not None and (m["owner"] or "").endswith("/resetCount")
             and any(op == "pushint" and a[0] == 60000 for _, op, a in p.abc.disasm(m["body"]))]
    if not found:
        return False
    assert len(found) == 1, found
    # every code block is offered every patch, so this can only be checked once the target is found
    if 1000 not in p.abc.ints:
        sys.exit("patch_game: no 1000 in the int pool, so the ready-seconds patch can't build its multiplier")
    thousand = p.abc.ints.index(1000)
    b = p.body(found[0])
    # exactly one 60000 in the method, or the patch would only half work
    hits = [k for k, ins in enumerate(b.instrs) if ins.op == "pushint" and p.abc.ints[ins.args[0]] == 60000]
    assert len(hits) == 1, hits
    # seconds * 1000 as an int, like the pushint it replaces; one push becomes two, so the stack peaks one deeper
    b.instrs[hits[0]:hits[0] + 1] = [I("pushshort", seconds), I("pushint", thousand), I("multiply_i")]
    b.max_stack += 1
    return True


OPTIONAL = {}
if os.environ.get("REFLIPPED_TRACE_ASSETS"):
    OPTIONAL["trace-missing-files"] = patch_trace_missing_files
if os.environ.get("REFLIPPED_READY_SECONDS"):
    OPTIONAL["ready-seconds"] = patch_ready_seconds

PATCHES = {"shell-ui": patch_shell_ui, "no-plus": patch_no_plus, "tall-screen": patch_tall_screen_margins,
           "no-package-shop": patch_no_package_shop,
           "any-beads-portal": patch_any_beads_portal,
           "any-beads-ticket": patch_any_beads_ticket,
           "any-beads-bundles": patch_any_beads_bundles,
           "any-beads-portal-dialog": patch_any_beads_portal_dialog,
           "any-beads-ticket-dialog": patch_any_beads_ticket_dialog,
           "medium-images": patch_medium_images,
           "search-id-length": patch_search_id_length,
           "tutorial-locks": patch_tutorial_locks,
           "tutorial-lock-status": patch_tutorial_lock_status}


def patch_swf(data: bytes) -> bytes:
    swf = sp.Swf(data)
    done = set()
    for idx, block in swf.abc_blocks():
        p = sp.AbcPatch(block)
        changed = False
        for name, fn in {**PATCHES, **OPTIONAL}.items():
            if fn(p):
                assert name not in done, f"patch {name} matched twice"
                done.add(name)
                changed = True
        if changed:
            swf.set_abc(idx, p.build())
    missing = set(PATCHES) - done
    missing |= set(OPTIONAL) - done
    if missing:
        sys.exit(f"patch_game: no target for {sorted(missing)}: is this World Flipper 0.0.81?")
    return swf.build()


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    path = sys.argv[1]
    with open(path, "rb") as f:
        data = f.read()
    out = patch_swf(data)
    with open(path, "wb") as f:
        f.write(out)
    print(f"patched {path}: {', '.join({**PATCHES, **OPTIONAL})}")


if __name__ == "__main__":
    main()
