#!/usr/bin/env python3
"""List the ANE calls the World Flipper SWF makes: extension IDs, call names, arg counts, events.

Usage: python3 -I ane_calls.py <worldflipper_android_release.swf | game.apk> [--json out.json]

Reads the SWF's bytecode only (no decompiler, no Java). Call and event names that the game
keeps in obfuscated constant classes are resolved from those classes' static initialisers.
Each call site is labelled with the Haxe source file named in the game's own debug strings.
"""
import importlib.util
import json
import os
import sys
import zipfile
from collections import defaultdict

_spec = importlib.util.spec_from_file_location("abcr", os.path.join(os.path.dirname(os.path.abspath(__file__)), "abc.py"))
abcr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(abcr)

SWF_IN_APK = "assets/worldflipper_android_release.swf"
VALUE_OPS = ("pushstring", "pushint", "pushbyte", "pushshort", "pushuint", "pushdouble", "pushtrue", "pushfalse", "pushnull")


def local(name: str) -> str:
    return name.rsplit(":", 1)[-1]


def load_swf(path: str) -> bytes:
    if path.endswith(".apk"):
        with zipfile.ZipFile(path) as z:
            return z.read(SWF_IN_APK)
    with open(path, "rb") as f:
        return f.read()


def resolved_ops(ins, consts):
    """Collapse `getlex C; getproperty F` into a pseudo pushstring when C.F is a known constant."""
    out = []
    i = 0
    while i < len(ins):
        off, op, args = ins[i]
        if op == "getlex" and i + 1 < len(ins) and ins[i + 1][1] == "getproperty":
            fields = consts.get(args[0])
            field = local(ins[i + 1][2][0])
            if fields and field in fields:
                out.append((off, "const", [fields[field]]))
                i += 2
                continue
        out.append((off, op, args))
        i += 1
    return out


def scan(swf: bytes):
    blocks = [abcr.Abc(b) for _, b in abcr.abc_blocks(swf)]
    consts = {}
    for a in blocks:
        for cname, fields in a.static_values().items():
            consts.setdefault(cname, {}).update({local(k): v for k, v in fields.items()})

    contexts = []  # (haxe file / class, extension id, context type)
    calls = defaultdict(lambda: defaultdict(set))  # source -> call name -> {argc}
    listens = defaultdict(set)  # source -> event types registered on contexts
    status_strings = defaultdict(set)  # source -> string constants seen in status handlers
    for a in blocks:
        for m in a.methods:
            if not m["body"]:
                continue
            ins = resolved_ops(list(a.disasm(m["body"])), consts)
            files = [args[0] for _, op, args in ins if op == "pushstring" and isinstance(args[0], str) and args[0].endswith(".hx")]
            owner = m["owner"] or "?"
            source = files[0] if files else owner.split("/")[0]
            for i, (_, op, args) in enumerate(ins):
                if op in ("callproperty", "callpropvoid") and local(args[0]) == "createExtensionContext":
                    vals = [a2[0] if a2 else None for _, o2, a2 in ins[max(0, i - 6):i] if o2 in ("pushstring", "const", "pushnull")]
                    contexts.append({"source": source, "owner": owner, "id": vals[-2] if len(vals) >= 2 else (vals[-1] if vals else None),
                                     "type": vals[-1] if len(vals) >= 2 else None})
                if op in ("callproperty", "callpropvoid") and local(args[0]) == "call":
                    argc = args[1]
                    # receiver is the most recent load of a *context* property; the next value is the call name
                    name = None
                    for j in range(i - 1, max(0, i - 60), -1):
                        o2, a2 = ins[j][1], ins[j][2]
                        if o2 in ("getproperty", "getlex") and "ontext" in local(a2[0]):
                            if j + 1 < i and ins[j + 1][1] in ("pushstring", "const"):
                                name = ins[j + 1][2][0]
                            break
                    calls[source][name if name is not None else f"<dynamic in {local(owner.split('/')[-1])}>"].add(argc - 1)
                if op in ("callpropvoid", "callproperty") and local(args[0]) in ("addEventListener",):
                    prev = [a2[0] for _, o2, a2 in ins[max(0, i - 8):i] if o2 in ("pushstring", "const")]
                    if prev and any("ontext" in local(a2[0]) for _, o2, a2 in ins[max(0, i - 8):i] if o2 in ("getproperty", "getlex")):
                        listens[source].add(str(prev[0]))
            if "status" in owner.lower() or "handler" in owner.lower():
                for _, op, args in ins:
                    if op in ("pushstring", "const") and isinstance(args[0], str) and args[0].isupper():
                        status_strings[source].add(args[0])
    return contexts, calls, listens, status_strings


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    contexts, calls, listens, status = scan(load_swf(sys.argv[1]))
    print("## Extension contexts created by the SWF")
    for c in sorted(contexts, key=lambda c: str(c["id"])):
        print(f"- {c['id']!s:34} type={c['type']!r:6} from {c['source']}")
    print("\n## Calls per source file (name(argc))")
    for source in sorted(calls):
        names = ", ".join(f"{n}({'/'.join(map(str, sorted(a)))})" for n, a in sorted(calls[source].items(), key=lambda kv: str(kv[0])))
        print(f"- {source}: {names}")
    print("\n## Context event listeners")
    for source in sorted(listens):
        print(f"- {source}: {', '.join(sorted(listens[source]))}")
    print("\n## Upper-case constants in status/handler methods")
    for source in sorted(status):
        print(f"- {source}: {', '.join(sorted(status[source]))}")
    if "--json" in sys.argv:
        out = sys.argv[sys.argv.index("--json") + 1]
        with open(out, "w") as f:
            json.dump({"contexts": contexts,
                       "calls": {s: {str(n): sorted(a) for n, a in c.items()} for s, c in calls.items()},
                       "listeners": {s: sorted(v) for s, v in listens.items()},
                       "statusConstants": {s: sorted(v) for s, v in status.items()}}, f, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
