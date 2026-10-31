#!/usr/bin/env python3
"""Extract the TypePacker type schema embedded in the World Flipper SWF.

The game serialises its socket messages (co-op, lounge) and local saves with TypePacker (Haxe).
Its full type table is compiled into `TypePackerResource2.resolveMap*` as plain constructor calls
and map inserts. This tool *executes* those methods with a tiny stack interpreter, so it recovers
every type exactly: enum variants with their indices and parameter types, class and anonymous
structure fields, collections, maps, abstracts and primitives.

Usage:
  python3 -I schema.py <apk|swf> --json out.json            full schema as JSON
  python3 -I schema.py <apk|swf> --show <type> [--depth N]   readable tree of one type
  python3 -I schema.py <apk|swf> --find <text>               type names containing <text>
  python3 -I schema.py <apk|swf> --protocol out.md           Markdown spec of the socket protocol

Wire format reminder (TypePacker JsonPacker): objects are JSON objects; enums are JSON arrays,
`[variantIndex, arg...]` when useEnumIndex is on (socket handshake) or `["Variant", arg...]`.
"""
import argparse
import importlib.util
import json
import os
import re
import sys
import zipfile

_spec = importlib.util.spec_from_file_location("abcr", os.path.join(os.path.dirname(os.path.abspath(__file__)), "abc.py"))
abcr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(abcr)

RESOURCE = "TypePackerResource2"
KINDS = {"ABSTRACT", "ANONYMOUS", "CLASS", "COLLECTION", "DYNAMIC_ACCESS", "ENUM", "MAP", "PRIMITIVE"}
# Roots of the realtime socket protocol (docs/coop-research.md).
PROTOCOL_ROOTS = [
    "pinball.online.meeting.message.MeetingRoomHandshakeCommand",
    "pinball.online.battle.message.BattleRoomHandshakeCommand",
    "pinball.online.HandshakeResult",
    "pinball.online.lounge.LoungeHandshakeResult",
    "pinball.online.protocol.ServerErrorMessage",
    "pinball.online.battle.message.BattleServer2Client",
    "pinball.online.battle.message.BattleClient2Server",
    "pinball.online.battle.message.BattleSocketInput",
    "pinball.online.battle.message.BattleSocketCommand",
    "pinball.online.meeting.message.MeetingServer2Client",
    "pinball.online.meeting.message.MeetingClient2Server",
    "pinball.online.room.CooperationRoomSocketInput",
    "pinball.online.MultiBattleCommand",
    "pinball.online.BattleUserCommand",
    "pinball.online.lounge.multiSpecialExchange.MultiSpecialExchangeHandshakeCommand",
    "pinball.online.lounge.multiSpecialExchange.MultiSpecialExchangeClient2Server",
    "pinball.online.lounge.multiSpecialExchange.MultiSpecialExchangeServer2Client",
]


class Ref:
    """A lazily evaluated helper map (callproperty resolveMapN)."""
    def __init__(self, name):
        self.name = name


class Marker:
    """Some receiver/class object we don't care about (getlex X, findproperty X)."""
    def __init__(self, name=""):
        self.name = name


def load_swf(path):
    if path.endswith(".apk"):
        with zipfile.ZipFile(path) as z:
            return z.read("assets/worldflipper_android_release.swf")
    with open(path, "rb") as f:
        return f.read()


class Interpreter:
    def __init__(self, swf):
        self.methods = {}
        for _, block in abcr.abc_blocks(swf):
            abc = abcr.Abc(block)
            for m in abc.methods:
                owner = m["owner"] or ""
                if owner.startswith(RESOURCE + "/") and m["body"]:
                    self.methods[owner.split("/", 1)[1]] = list(abc.disasm(m["body"]))
        if not self.methods:
            sys.exit(f"no {RESOURCE} methods found: is this the World Flipper SWF?")
        self.cache = {}

    def call(self, name):
        if name not in self.cache:
            self.cache[name] = None  # recursion guard
            self.cache[name] = self.run(self.methods[name])
        return self.cache[name]

    def run(self, ins):
        stack, locals_ = [], {}
        for _, op, args in ins:
            if op in ("pushstring", "pushbyte", "pushshort", "pushint", "pushuint", "pushdouble"):
                stack.append(args[0])
            elif op == "pushtrue":
                stack.append(True)
            elif op == "pushfalse":
                stack.append(False)
            elif op in ("pushnull", "pushundefined"):
                stack.append(None)
            elif op == "newarray":
                n = args[0]
                items = stack[len(stack) - n:] if n else []
                del stack[len(stack) - n:]
                stack.append(list(items))
            elif op in ("getlex", "findpropstrict", "findproperty"):
                stack.append(Marker(args[0]))
            elif op == "constructprop":
                n = args[1]
                del stack[len(stack) - n:]
                stack.pop()
                stack.append({})  # a new StringMap/IntMap
            elif op in ("callproperty", "callpropvoid"):
                name, n = args[0].rsplit(":", 1)[-1], args[1]
                params = stack[len(stack) - n:] if n else []
                del stack[len(stack) - n:]
                recv = stack.pop()
                if name.startswith("resolveMap"):
                    result = Ref(name)
                elif name in ("resolveEnum", "resolveClass"):
                    result = {"$class": params[0]}
                elif name in KINDS:
                    result = {"kind": name, "args": params}
                elif name == "setReserved":
                    if isinstance(recv, dict):
                        recv[params[0]] = params[1]
                    result = None
                else:
                    result = None
                if op == "callproperty":
                    stack.append(result)
            elif op == "setproperty":
                value, key, obj = stack.pop(), stack.pop(), stack.pop()
                if isinstance(obj, dict):
                    obj[key] = value
            elif op == "getproperty":
                obj = stack.pop()
                # `map.h` is the backing object of a Haxe map: keep the map itself
                stack.append(obj if isinstance(obj, dict) else Marker(args[0]))
            elif op.startswith("setlocal"):
                idx = int(op[8:]) if len(op) > 8 else args[0]
                locals_[idx] = stack.pop()
            elif op.startswith("getlocal"):
                idx = int(op[8:]) if len(op) > 8 else args[0]
                stack.append(locals_.get(idx))
            elif op == "in":
                stack.pop(), stack.pop()
                stack.append(False)
            elif op in ("iffalse", "iftrue"):
                stack.pop()
            elif op == "returnvalue":
                return stack.pop()
            elif op == "pop":
                stack.pop()
            elif op == "dup":
                stack.append(stack[-1])
            # coerce*, convert*, jump, label, pushscope, debug*: no stack effect we care about
        return None

    def resolve(self, value):
        """Replace Refs by their evaluated maps, recursively."""
        if isinstance(value, Ref):
            return self.resolve(self.call(value.name))
        if isinstance(value, dict):
            return {k: self.resolve(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self.resolve(v) for v in value]
        if isinstance(value, Marker):
            return None
        return value


def decode(entry):
    """Turn one raw TypeInformation call into a readable dict."""
    kind, a = entry["kind"], entry["args"]
    if kind == "ENUM":
        # ENUM(name, class, nameToIndex, indexToParamTypes, ?, ?)
        name_to_index = a[2] or {}
        params = a[3] or {}
        variants = []
        for vname, index in sorted(name_to_index.items(), key=lambda kv: kv[1]):
            variants.append({"index": index, "name": vname, "params": params.get(index, params.get(str(index), [])) or []})
        return {"kind": "enum", "name": a[0], "variants": variants}
    if kind == "CLASS":
        # CLASS(name, class, fieldTypes, fieldOrder, ?, ?)
        return {"kind": "class", "name": a[0], "fields": ordered_fields(a[2], a[3])}
    if kind == "ANONYMOUS":
        # ANONYMOUS(fieldTypes, fieldOrder, ?, ?, ?)
        return {"kind": "anonymous", "fields": ordered_fields(a[0], a[1])}
    if kind == "COLLECTION":
        return {"kind": "collection", "element": a[0], "collectionKind": a[1]}
    if kind == "MAP":
        return {"kind": "map", "keyKind": a[0], "value": a[1]}
    if kind == "ABSTRACT":
        return {"kind": "abstract", "underlying": a[0]}
    if kind == "PRIMITIVE":
        return {"kind": "primitive", "nullable": a[0], "primitiveKind": a[1]}
    if kind == "DYNAMIC_ACCESS":
        return {"kind": "dynamicAccess", "value": a[0]}
    return {"kind": kind.lower(), "args": a}


def ordered_fields(types, order):
    types = types or {}
    names = list(order or []) + [k for k in types if k not in (order or [])]
    return [{"name": n, "type": types.get(n)} for n in names]


def extract(swf):
    interp = Interpreter(swf)
    # The method with the most type entries is the full table (resolveMap1989 in 0.0.81).
    best, best_count = None, -1
    for name, ins in interp.methods.items():
        count = sum(1 for _, op, args in ins if op == "callproperty" and args and args[0].rsplit(":", 1)[-1] in KINDS)
        if count > best_count:
            best, best_count = name, count
    table = interp.resolve(interp.call(best))
    if not isinstance(table, dict):
        sys.exit(f"could not evaluate {RESOURCE}/{best}")
    schema = {key: decode(entry) for key, entry in table.items() if isinstance(entry, dict) and "kind" in entry}
    add_strings(schema)
    return schema


def add_strings(schema):
    """Strings are built into TypePacker, so the table has no entry for them.

    The game refers to String by an obfuscated key. Identify it as the type behind
    `UiStringKey` (localised text ids), which is used by fields such as `description`,
    `username` and `oauth_token`, and add explicit entries for it and `Null<String>`.
    """
    probe = schema.get("pinball.master.generated.UiStringKey")
    key = probe.get("underlying") if probe and probe["kind"] == "abstract" else None
    if key and key not in schema:
        schema[key] = {"kind": "primitive", "nullable": False, "primitiveKind": "string", "name": "String"}
    schema.setdefault("Null<String>", {"kind": "primitive", "nullable": True, "primitiveKind": "string", "name": "Null<String>"})


ANON_INLINE_FIELDS = 4  # longer anonymous structures are shown as {…} and expanded separately


def render(schema, key, seen=None):
    """Short type expression for a type key, e.g. Array<Int>, Option<Score>, {a: Int}."""
    if key is None:
        return "?"
    seen = seen or set()
    t = schema.get(key)
    if t is None:
        return key
    k = t["kind"]
    if k == "enum" and t["name"] == "haxe.ds.Option":
        some = next((v for v in t["variants"] if v["name"] == "Some"), None)
        return f"Option<{render(schema, some['params'][0], seen) if some and some['params'] else '?'}>"
    if k in ("enum", "class"):
        return short(t["name"])
    if k == "abstract":
        inner = render(schema, t["underlying"], seen)
        # Named abstracts are typed aliases: show what goes on the wire, e.g. BroadcastCounter:Int
        return inner if looks_obfuscated(key) else f"{short(key)}:{inner}"
    if k == "collection":
        return f"Array<{render(schema, t['element'], seen)}>"
    if k == "map":
        return f"Map<{'String' if t['keyKind'] == 0 else 'Int'}, {render(schema, t['value'], seen)}>"
    if k == "primitive":
        return t.get("name") or (key if not looks_obfuscated(key) else f"primitive{t['primitiveKind']}")
    if k == "anonymous":
        if key in seen or len(t["fields"]) > ANON_INLINE_FIELDS:
            return "{…}"  # expanded as a struct below the line that uses it
        inner = ", ".join(f"{f['name']}: {render(schema, f['type'], seen | {key})}" for f in t["fields"])
        return "{ " + inner + " }"
    return key


def short(name):
    """Drop the package from a type name: pinball.online.ConnectionId -> ConnectionId."""
    return re.sub(r"\b(?:[a-z_][a-zA-Z0-9_]*\.)+(?=[A-Z])", "", name)


def looks_obfuscated(name):
    return bool(re.search(r"[^\x00-\x7f]", name or ""))


def show(schema, key, depth, out, indent="", seen=None):
    seen = set() if seen is None else seen
    t = schema.get(key)
    if t is None:
        out.append(f"{indent}{key}: (not in schema)")
        return
    # Wrappers (Option, Array, Map, aliases) add nothing new: show what they contain instead.
    inner = wrapped(schema, key)
    if inner is not None:
        show(schema, inner, depth, out, indent, seen)
        return
    label = short(t["name"]) if t.get("name") else render(schema, key)
    if key in seen:
        out.append(f"{indent}{label if t['kind'] != 'anonymous' else 'struct'} (see above)")
        return
    seen.add(key)
    k = t["kind"]
    if k == "enum":
        out.append(f"{indent}enum {t['name']}")
        for v in t["variants"]:
            ps = ", ".join(render(schema, p) for p in v["params"])
            out.append(f"{indent}  [{v['index']}] {v['name']}({ps})")
            if depth > 0:
                for p in v["params"]:
                    if is_composite(schema, p):
                        show(schema, p, depth - 1, out, indent + "      ", seen)
    elif k in ("class", "anonymous"):
        out.append(f"{indent}{'class ' + t['name'] if k == 'class' else 'struct'}")
        for f in t["fields"]:
            out.append(f"{indent}  {f['name']}: {render(schema, f['type'])}")
            if depth > 0 and is_composite(schema, f["type"]):
                show(schema, f["type"], depth - 1, out, indent + "      ", seen)
    else:
        out.append(f"{indent}{render(schema, key)}")


def wrapped(schema, key):
    """For Option<T>, Array<T>, Map<_, T> and aliases, the key of T; otherwise None."""
    t = schema.get(key)
    if t is None:
        return None
    if t["kind"] == "enum" and t["name"] == "haxe.ds.Option":
        some = next((v for v in t["variants"] if v["name"] == "Some"), None)
        return some["params"][0] if some and some["params"] else None
    return {"collection": t.get("element"), "map": t.get("value"), "abstract": t.get("underlying")}.get(t["kind"])


def is_composite(schema, key):
    """True if the type has structure worth expanding (an enum, class or struct, possibly wrapped)."""
    for _ in range(16):
        inner = wrapped(schema, key)
        if inner is None:
            break
        key = inner
    t = schema.get(key)
    return bool(t) and t["kind"] in ("enum", "class", "anonymous")


def protocol_markdown(schema):
    lines = ["# Co-op socket protocol: message types (generated)", "",
             "Generated by `client/air-shell/tools/schema.py --protocol` from the game's embedded TypePacker schema.",
             "Do not edit by hand; see `docs/coop-research.md` for transport and method.", "",
             "Wire format: one JSON value per message, terminated by `\\0` (Flash XMLSocket).",
             "Enums are JSON arrays `[variantIndex, arg...]`: every socket (un)serializer uses `useEnumIndex`.",
             "`haxe.ds.Option<T>` is an enum: `Some(v)` = index 0, `None` = index 1.", ""]
    for root in PROTOCOL_ROOTS:
        lines.append(f"## `{root}`")
        lines.append("")
        lines.append("```")
        out = []
        show(schema, root, 6, out)
        lines.extend(out)
        lines.append("```")
        lines.append("")
    return "\n".join(lines)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("input", help="World Flipper APK or SWF")
    p.add_argument("--json", metavar="OUT", help="write the full schema as JSON")
    p.add_argument("--show", metavar="TYPE", help="print one type as a tree")
    p.add_argument("--depth", type=int, default=2)
    p.add_argument("--find", metavar="TEXT", help="list type names containing TEXT")
    p.add_argument("--protocol", metavar="OUT", help="write a Markdown spec of the socket protocol types")
    args = p.parse_args()

    schema = extract(load_swf(args.input))
    kinds = {}
    for t in schema.values():
        kinds[t["kind"]] = kinds.get(t["kind"], 0) + 1
    print(f"{len(schema)} types: " + ", ".join(f"{k} {n}" for k, n in sorted(kinds.items())), file=sys.stderr)

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(schema, f, ensure_ascii=False, indent=1)
    if args.find:
        for key in sorted(schema):
            name = schema[key].get("name") or key
            if args.find.lower() in name.lower():
                print(f"{name}  [{schema[key]['kind']}]" + ("" if name == key else f"  key={key}"))
    if args.show:
        out = []
        show(schema, args.show, args.depth, out)
        print("\n".join(out))
    if args.protocol:
        with open(args.protocol, "w", encoding="utf-8") as f:
            f.write(protocol_markdown(schema))


if __name__ == "__main__":
    main()
