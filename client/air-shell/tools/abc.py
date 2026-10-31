"""Minimal SWF / AVM2 (ABC) reader: constant pool, classes, method bodies, disassembly.

Only what the ANE scanner needs. Reference: Adobe "AVM2 Overview" (abc file format).
"""
import lzma
import struct
import zlib


def read_swf(data: bytes) -> bytes:
    """Return the uncompressed SWF body (everything after the 8-byte header)."""
    sig = data[:3]
    if sig == b"FWS":
        return data[8:]
    if sig == b"CWS":
        return zlib.decompress(data[8:])
    if sig == b"ZWS":
        props = data[12:17]
        filt = lzma._decode_filter_properties(lzma.FILTER_LZMA1, props)
        return lzma.LZMADecompressor(lzma.FORMAT_RAW, filters=[filt]).decompress(data[17:])
    raise ValueError("not a SWF")


def abc_blocks(swf: bytes):
    """Yield (name, abc_bytes) for every DoABC / DoABC2 tag."""
    body = read_swf(swf)
    nbits = body[0] >> 3
    pos = (5 + 4 * nbits + 7) // 8 + 4  # RECT, frame rate, frame count
    while pos < len(body):
        code_len = struct.unpack_from("<H", body, pos)[0]
        pos += 2
        code, length = code_len >> 6, code_len & 0x3F
        if length == 0x3F:
            length = struct.unpack_from("<I", body, pos)[0]
            pos += 4
        tag = body[pos:pos + length]
        pos += length
        if code == 82:  # DoABC2: flags u32, name string, abc
            end = tag.index(b"\0", 4)
            yield tag[4:end].decode("utf-8", "replace"), tag[end + 1:]
        elif code == 72:  # DoABC
            yield "", tag
        elif code == 0:
            break


class Reader:
    def __init__(self, data: bytes):
        self.d = data
        self.p = 0

    def u8(self):
        v = self.d[self.p]
        self.p += 1
        return v

    def u16(self):
        v = struct.unpack_from("<H", self.d, self.p)[0]
        self.p += 2
        return v

    def s24(self):
        b = self.d[self.p:self.p + 3]
        self.p += 3
        v = b[0] | (b[1] << 8) | (b[2] << 16)
        return v - (1 << 24) if v & 0x800000 else v

    def u30(self):
        result = shift = 0
        for _ in range(5):
            b = self.u8()
            result |= (b & 0x7F) << shift
            if not b & 0x80:
                break
            shift += 7
        return result

    def s32(self):
        v = self.u30() & 0xFFFFFFFF
        return v - (1 << 32) if v & 0x80000000 else v

    def d64(self):
        v = struct.unpack_from("<d", self.d, self.p)[0]
        self.p += 8
        return v

    def bytes(self, n):
        v = self.d[self.p:self.p + n]
        self.p += n
        return v


# Opcode -> (mnemonic, operand kinds). Kinds: u30, u8, s24, switch, debug.
OPS = {
    0x01: ("bkpt", ""), 0x02: ("nop", ""), 0x03: ("throw", ""),
    0x04: ("getsuper", "m"), 0x05: ("setsuper", "m"), 0x06: ("dxns", "s"), 0x07: ("dxnslate", ""),
    0x08: ("kill", "u"), 0x09: ("label", ""),
    0x0C: ("ifnlt", "j"), 0x0D: ("ifnle", "j"), 0x0E: ("ifngt", "j"), 0x0F: ("ifnge", "j"),
    0x10: ("jump", "j"), 0x11: ("iftrue", "j"), 0x12: ("iffalse", "j"), 0x13: ("ifeq", "j"),
    0x14: ("ifne", "j"), 0x15: ("iflt", "j"), 0x16: ("ifle", "j"), 0x17: ("ifgt", "j"),
    0x18: ("ifge", "j"), 0x19: ("ifstricteq", "j"), 0x1A: ("ifstrictne", "j"),
    0x1B: ("lookupswitch", "X"), 0x1C: ("pushwith", ""), 0x1D: ("popscope", ""),
    0x1E: ("nextname", ""), 0x1F: ("hasnext", ""), 0x20: ("pushnull", ""), 0x21: ("pushundefined", ""),
    0x23: ("nextvalue", ""), 0x24: ("pushbyte", "b"), 0x25: ("pushshort", "u"), 0x26: ("pushtrue", ""),
    0x27: ("pushfalse", ""), 0x28: ("pushnan", ""), 0x29: ("pop", ""), 0x2A: ("dup", ""), 0x2B: ("swap", ""),
    0x2C: ("pushstring", "s"), 0x2D: ("pushint", "i"), 0x2E: ("pushuint", "U"), 0x2F: ("pushdouble", "d"),
    0x30: ("pushscope", ""), 0x31: ("pushnamespace", "u"), 0x32: ("hasnext2", "uu"),
    0x35: ("li8", ""), 0x36: ("li16", ""), 0x37: ("li32", ""), 0x38: ("lf32", ""), 0x39: ("lf64", ""),
    0x3A: ("si8", ""), 0x3B: ("si16", ""), 0x3C: ("si32", ""), 0x3D: ("sf32", ""), 0x3E: ("sf64", ""),
    0x40: ("newfunction", "u"), 0x41: ("call", "u"), 0x42: ("construct", "u"),
    0x43: ("callmethod", "uu"), 0x44: ("callstatic", "uu"), 0x45: ("callsuper", "mu"),
    0x46: ("callproperty", "mu"), 0x47: ("returnvoid", ""), 0x48: ("returnvalue", ""),
    0x49: ("constructsuper", "u"), 0x4A: ("constructprop", "mu"), 0x4C: ("callproplex", "mu"),
    0x4E: ("callsupervoid", "mu"), 0x4F: ("callpropvoid", "mu"),
    0x50: ("sxi1", ""), 0x51: ("sxi8", ""), 0x52: ("sxi16", ""), 0x53: ("applytype", "u"),
    0x55: ("newobject", "u"), 0x56: ("newarray", "u"), 0x57: ("newactivation", ""),
    0x58: ("newclass", "u"), 0x59: ("getdescendants", "m"), 0x5A: ("newcatch", "u"),
    0x5D: ("findpropstrict", "m"), 0x5E: ("findproperty", "m"), 0x5F: ("finddef", "m"),
    0x60: ("getlex", "m"), 0x61: ("setproperty", "m"), 0x62: ("getlocal", "u"), 0x63: ("setlocal", "u"),
    0x64: ("getglobalscope", ""), 0x65: ("getscopeobject", "u"), 0x66: ("getproperty", "m"),
    0x68: ("initproperty", "m"), 0x6A: ("deleteproperty", "m"), 0x6C: ("getslot", "u"),
    0x6D: ("setslot", "u"), 0x6E: ("getglobalslot", "u"), 0x6F: ("setglobalslot", "u"),
    0x70: ("convert_s", ""), 0x71: ("esc_xelem", ""), 0x72: ("esc_xattr", ""), 0x73: ("convert_i", ""),
    0x74: ("convert_u", ""), 0x75: ("convert_d", ""), 0x76: ("convert_b", ""), 0x77: ("convert_o", ""),
    0x78: ("checkfilter", ""), 0x80: ("coerce", "m"), 0x81: ("coerce_b", ""), 0x82: ("coerce_a", ""),
    0x83: ("coerce_i", ""), 0x84: ("coerce_d", ""), 0x85: ("coerce_s", ""), 0x86: ("astype", "m"),
    0x87: ("astypelate", ""), 0x88: ("coerce_u", ""), 0x89: ("coerce_o", ""),
    0x90: ("negate", ""), 0x91: ("increment", ""), 0x92: ("inclocal", "u"), 0x93: ("decrement", ""),
    0x94: ("declocal", "u"), 0x95: ("typeof", ""), 0x96: ("not", ""), 0x97: ("bitnot", ""),
    0xA0: ("add", ""), 0xA1: ("subtract", ""), 0xA2: ("multiply", ""), 0xA3: ("divide", ""),
    0xA4: ("modulo", ""), 0xA5: ("lshift", ""), 0xA6: ("rshift", ""), 0xA7: ("urshift", ""),
    0xA8: ("bitand", ""), 0xA9: ("bitor", ""), 0xAA: ("bitxor", ""), 0xAB: ("equals", ""),
    0xAC: ("strictequals", ""), 0xAD: ("lessthan", ""), 0xAE: ("lessequals", ""),
    0xAF: ("greaterthan", ""), 0xB0: ("greaterequals", ""), 0xB1: ("instanceof", ""),
    0xB2: ("istype", "m"), 0xB3: ("istypelate", ""), 0xB4: ("in", ""),
    0xC0: ("increment_i", ""), 0xC1: ("decrement_i", ""), 0xC2: ("inclocal_i", "u"),
    0xC3: ("declocal_i", "u"), 0xC4: ("negate_i", ""), 0xC5: ("add_i", ""), 0xC6: ("subtract_i", ""),
    0xC7: ("multiply_i", ""),
    0xD0: ("getlocal0", ""), 0xD1: ("getlocal1", ""), 0xD2: ("getlocal2", ""), 0xD3: ("getlocal3", ""),
    0xD4: ("setlocal0", ""), 0xD5: ("setlocal1", ""), 0xD6: ("setlocal2", ""), 0xD7: ("setlocal3", ""),
    0xEF: ("debug", "D"), 0xF0: ("debugline", "u"), 0xF1: ("debugfile", "s"), 0xF2: ("bkptline", "u"),
    0xF3: ("timestamp", ""),
}


class Abc:
    def __init__(self, data: bytes):
        r = Reader(data)
        self.pos = {}  # byte offsets of the sections, for tools/swf_patch.py
        r.u16(), r.u16()  # minor, major
        self.ints = [0] + [r.s32() for _ in range(max(r.u30() - 1, 0))]
        self.uints = [0] + [r.u30() for _ in range(max(r.u30() - 1, 0))]
        self.doubles =[float("nan")] + [r.d64() for _ in range(max(r.u30() - 1, 0))]
        self.pos["strings_count"] = r.p
        self.strings = [None]
        n_strings = max(r.u30() - 1, 0)
        self.pos["strings"] = r.p
        for _ in range(n_strings):
            n = r.u30()
            self.strings.append(r.bytes(n).decode("utf-8", "replace"))
        self.pos["namespaces_count"] = r.p
        self.namespaces = [None]
        n_ns = max(r.u30() - 1, 0)
        self.pos["namespaces"] = r.p
        for _ in range(n_ns):
            kind = r.u8()
            self.namespaces.append((kind, self.strings[r.u30()]))
        self.pos["ns_sets"] = r.p
        self.ns_sets = [None]
        for _ in range(max(r.u30() - 1, 0)):
            self.ns_sets.append([r.u30() for _ in range(r.u30())])
        self.pos["multinames_count"] = r.p
        self.multinames = [None]
        n_mn = max(r.u30() - 1, 0)
        self.pos["multinames"] = r.p
        for _ in range(n_mn):
            self.multinames.append(self._multiname(r))
        self.pos["multinames_end"] = r.p
        self.methods = []
        for _ in range(r.u30()):
            pcount = r.u30()
            ret = r.u30()
            params = [r.u30() for _ in range(pcount)]
            name = self.strings[r.u30()]
            flags = r.u8()
            if flags & 0x08:  # HAS_OPTIONAL
                for _ in range(r.u30()):
                    r.u30(), r.u8()
            if flags & 0x80:  # HAS_PARAM_NAMES
                for _ in range(pcount):
                    r.u30()
            self.methods.append({"name": name, "params": params, "ret": ret, "body": None, "owner": None})
        for _ in range(r.u30()):  # metadata
            r.u30()
            n = r.u30()
            for _ in range(2 * n):
                r.u30()
        class_count = r.u30()
        self.instances = []
        for _ in range(class_count):
            name, sup = r.u30(), r.u30()
            flags = r.u8()
            if flags & 0x08:
                r.u30()  # protected ns
            ifaces = [r.u30() for _ in range(r.u30())]
            iinit = r.u30()
            traits = self._traits(r)
            self.instances.append({"name": name, "super": sup, "iinit": iinit, "traits": traits, "ifaces": ifaces})
        self.classes = []
        for _ in range(class_count):
            cinit = r.u30()
            self.classes.append({"cinit": cinit, "traits": self._traits(r)})
        self.scripts = []
        for _ in range(r.u30()):
            sinit = r.u30()
            self.scripts.append({"sinit": sinit, "traits": self._traits(r)})
        self.pos["bodies_count"] = r.p
        n_bodies = r.u30()
        self.pos["bodies"] = r.p
        self.body_spans = {}  # method index -> (start, end) of its method_body_info
        for _ in range(n_bodies):
            start = r.p
            m = r.u30()
            r.u30(), r.u30(), r.u30(), r.u30()  # max_stack, locals, init/max scope
            code = r.bytes(r.u30())
            for _ in range(r.u30()):
                r.u30(), r.u30(), r.u30(), r.u30(), r.u30()
            self._traits(r)
            self.methods[m]["body"] = code
            self.body_spans[m] = (start, r.p)
        self.pos["end"] = r.p
        self._assign_owners()

    def _multiname(self, r):
        kind = r.u8()
        if kind in (0x07, 0x0D):  # QName(A)
            return ("Q", r.u30(), r.u30())
        if kind in (0x0F, 0x10):  # RTQName(A)
            return ("RTQ", None, r.u30())
        if kind in (0x11, 0x12):  # RTQNameL(A)
            return ("RTQL", None, 0)
        if kind in (0x09, 0x0E):  # Multiname(A)
            name = r.u30()
            return ("M", r.u30(), name)
        if kind in (0x1B, 0x1C):  # MultinameL(A)
            return ("ML", r.u30(), 0)
        if kind == 0x1D:  # TypeName
            base = r.u30()
            params = [r.u30() for _ in range(r.u30())]
            return ("T", base, params)
        raise ValueError(f"multiname kind {kind:#x}")

    def _traits(self, r):
        out = []
        for _ in range(r.u30()):
            name = r.u30()
            kind = r.u8()
            k = kind & 0x0F
            if k in (0, 6):  # slot, const
                r.u30()
                r.u30()  # type name
                vindex = r.u30()
                value = None
                if vindex:
                    vkind = r.u8()
                    value = self._const(vkind, vindex)
                out.append(("slot", name, value))
            elif k == 4:  # class
                r.u30()
                out.append(("class", name, r.u30()))
            elif k in (1, 2, 3, 5):  # method/getter/setter/function
                r.u30()
                out.append((["", "method", "getter", "setter", "", "function"][k], name, r.u30()))
            else:
                raise ValueError(f"trait kind {k}")
            if kind & 0x40:  # ATTR_Metadata
                for _ in range(r.u30()):
                    r.u30()
        return out

    def _const(self, vkind, vindex):
        if vkind == 0x01:
            return self.strings[vindex]
        if vkind == 0x03:
            return self.ints[vindex]
        if vkind == 0x04:
            return self.uints[vindex]
        if vkind == 0x06:
            return self.doubles[vindex]
        return {0x0A: False, 0x0B: True, 0x0C: None}.get(vkind)

    def static_values(self):
        """{class name: {field: value}} from const defaults and simple cinit assignments."""
        out = {}
        for idx, inst in enumerate(self.instances):
            cname = self.mn(inst["name"])
            fields = {}
            for kind, name, value in self.classes[idx]["traits"]:
                if kind == "slot" and value is not None:
                    fields[self.mn(name)] = value
            body = self.methods[self.classes[idx]["cinit"]]["body"]
            if body:
                last = None
                for _, op, args in self.disasm(body):
                    if op in ("pushstring", "pushint", "pushbyte", "pushshort", "pushuint", "pushdouble"):
                        last = args[0]
                    elif op in ("initproperty", "setproperty") and last is not None:
                        fields[args[0]] = last
                        last = None
                    elif op not in ("findproperty", "getlocal0", "pushscope", "debugline", "debugfile", "debug"):
                        last = None
            if fields:
                out[cname] = fields
        # Haxe boot code: `getlex Class; push value; initproperty field` in any method
        for m in self.methods:
            if not m["body"]:
                continue
            ins = list(self.disasm(m["body"]))
            for i in range(2, len(ins)):
                op, args = ins[i][1], ins[i][2]
                if op in ("initproperty", "setproperty") and ins[i - 2][1] == "getlex" and ins[i - 1][1] in (
                        "pushstring", "pushint", "pushbyte", "pushshort", "pushuint", "pushdouble"):
                    out.setdefault(ins[i - 2][2][0], {})[args[0]] = ins[i - 1][2][0]
        return out

    def mn(self, i) -> str:
        """Readable name for multiname index i ("pkg.ns::name" for QNames)."""
        if not i:
            return "*"
        m = self.multinames[i]
        if m[0] == "Q":
            ns = self.namespaces[m[1]]
            local = self.strings[m[2]] or ""
            return f"{ns[1]}:{local}" if ns and ns[1] else local
        if m[0] in ("M", "RTQ"):
            return self.strings[m[2]] or ""
        if m[0] == "T":
            return f"{self.mn(m[1])}.<{','.join(self.mn(p) for p in m[2])}>"
        return f"<{m[0]}>"

    def _assign_owners(self):
        for idx, inst in enumerate(self.instances):
            cname = self.mn(inst["name"])
            self.methods[inst["iinit"]]["owner"] = f"{cname}/<init>"
            self.methods[self.classes[idx]["cinit"]]["owner"] = f"{cname}/<cinit>"
            for kind, name, ref in inst["traits"]:
                if kind in ("method", "getter", "setter", "function"):
                    self.methods[ref]["owner"] = f"{cname}/{self.mn(name)}"
            for kind, name, ref in self.classes[idx]["traits"]:
                if kind in ("method", "getter", "setter", "function"):
                    self.methods[ref]["owner"] = f"{cname}/static {self.mn(name)}"
        for s in self.scripts:
            for kind, name, ref in s["traits"]:
                if kind in ("method", "function") and not self.methods[ref]["owner"]:
                    self.methods[ref]["owner"] = f"<script>/{self.mn(name)}"

    def disasm(self, code: bytes):
        """Yield (offset, mnemonic, args) for a method body."""
        r = Reader(code)
        while r.p < len(code):
            off = r.p
            op = r.u8()
            name, kinds = OPS.get(op, (f"op_{op:#x}", ""))
            args = []
            if kinds == "X":
                args.append(r.s24())
                n = r.u30()
                args.extend(r.s24() for _ in range(n + 1))
            elif kinds == "D":
                args = [r.u8(), self.strings[r.u30()], r.u8(), r.u30()]
            else:
                for k in kinds:
                    if k == "b":
                        v = r.u8()
                        args.append(v - 256 if v > 127 else v)
                    elif k == "j":
                        args.append(r.s24())
                    elif k == "s":
                        args.append(self.strings[r.u30()])
                    elif k == "i":
                        args.append(self.ints[r.u30()])
                    elif k == "U":
                        args.append(self.uints[r.u30()])
                    elif k == "d":
                        args.append(self.doubles[r.u30()])
                    elif k == "m":
                        args.append(self.mn(r.u30()))
                    else:
                        args.append(r.u30())
            yield off, name, args
