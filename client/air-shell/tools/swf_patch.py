"""Edit the AVM2 bytecode inside a SWF: the writing counterpart of abc.py.

Used by patch_game.py. What it can do:
  - decode a method body into instructions whose jumps point at other instructions, so code can be
    inserted or replaced without fixing offsets by hand (jumps, lookupswitch and try/catch ranges
    are re-encoded);
  - append strings, namespaces and QNames to an ABC block's constant pools (existing entries are reused);
  - write the modified blocks back into the SWF (zlib-compressed, as the original is).

Nothing else in the ABC refers to byte offsets, so appending to a pool and changing a method body
are the only edits needed. Reference: Adobe "AVM2 Overview".
"""
import importlib.util
import os
import struct
import zlib

_spec = importlib.util.spec_from_file_location("abcr", os.path.join(os.path.dirname(os.path.abspath(__file__)), "abc.py"))
abcr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(abcr)

OPCODES = {name: (op, kinds) for op, (name, kinds) in abcr.OPS.items()}
NS_PACKAGE = 0x16


def enc_u30(v: int) -> bytes:
    out = bytearray()
    v &= 0xFFFFFFFF
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


class Instr:
    """One instruction. `args` are raw operands (pool indices, local numbers, bytes); a jump's
    target is `target`, a lookupswitch has `target` (default) and `cases`."""
    __slots__ = ("op", "args", "target", "cases", "off")

    def __init__(self, name, *args, target=None, cases=None):
        self.op = name
        self.args = list(args)
        self.target = target
        self.cases = cases
        self.off = 0

    def __repr__(self):
        return f"Instr({self.op} {self.args})"

    def size(self):
        if self.op == "end":
            return 0
        kinds = OPCODES[self.op][1]
        if kinds == "X":
            return 1 + 3 + len(enc_u30(len(self.cases) - 1)) + 3 * len(self.cases)
        if kinds == "j":
            return 4
        if kinds == "D":
            return 3 + len(enc_u30(self.args[1])) + len(enc_u30(self.args[3]))
        return 1 + sum(1 if k == "b" else len(enc_u30(a)) for k, a in zip(kinds, self.args))


def decode(code: bytes):
    """Decode a method body into [Instr]; the list ends with a sentinel Instr('end')."""
    r = abcr.Reader(code)
    at = {}
    out = []
    pending = []
    while r.p < len(code):
        off = r.p
        op = r.u8()
        if op not in abcr.OPS:
            raise ValueError(f"unknown opcode {op:#x} at {off}")
        name, kinds = abcr.OPS[op]
        ins = Instr(name)
        ins.off = off
        at[off] = ins
        if kinds == "X":
            default = r.s24()
            n = r.u30()
            cases = [r.s24() for _ in range(n + 1)]
            pending.append((ins, off + default, [off + c for c in cases]))
        elif kinds == "j":
            rel = r.s24()
            pending.append((ins, r.p + rel, None))
        elif kinds == "D":
            ins.args = [r.u8(), r.u30(), r.u8(), r.u30()]
        else:
            for k in kinds:
                ins.args.append(r.u8() if k == "b" else r.u30())
        out.append(ins)
    end = Instr("end")
    end.off = len(code)
    at[len(code)] = end
    for ins, tgt, cases in pending:
        ins.target = at[tgt]
        if cases is not None:
            ins.cases = [at[c] for c in cases]
    out.append(end)
    return out, at


def encode(instrs):
    """Encode [Instr] (ending with the 'end' sentinel) and return the code; each Instr.off is set."""
    off = 0
    for ins in instrs:
        ins.off = off
        off += ins.size()
    out = bytearray()
    for ins in instrs:
        if ins.op == "end":
            break
        op, kinds = OPCODES[ins.op]
        out.append(op)
        if kinds == "X":
            out += struct.pack("<i", ins.target.off - ins.off)[:3]
            out += enc_u30(len(ins.cases) - 1)
            for c in ins.cases:
                out += struct.pack("<i", c.off - ins.off)[:3]
        elif kinds == "j":
            out += struct.pack("<i", ins.target.off - (ins.off + 4))[:3]
        elif kinds == "D":
            out.append(ins.args[0])
            out += enc_u30(ins.args[1])
            out.append(ins.args[2])
            out += enc_u30(ins.args[3])
        else:
            for k, a in zip(kinds, ins.args):
                if k == "b":
                    out.append(a & 0xFF)
                else:
                    out += enc_u30(a)
    assert len(out) == off, (len(out), off)
    return bytes(out)


class Body:
    """A method_body_info, decoded far enough to replace its code."""

    def __init__(self, abc, method):
        d = abc.raw
        start, end = abc.abc.body_spans[method]
        r = abcr.Reader(d)
        r.p = start
        self.method = r.u30()
        self.max_stack, self.local_count, self.init_scope, self.max_scope = r.u30(), r.u30(), r.u30(), r.u30()
        code = r.bytes(r.u30())
        self.instrs, at = decode(code)
        self.exceptions = []
        for _ in range(r.u30()):
            f, t, tg, ty, nm = r.u30(), r.u30(), r.u30(), r.u30(), r.u30()
            self.exceptions.append([at[f], at[t], at[tg], ty, nm])
        self.traits = d[r.p:end]

    def build(self):
        code = encode(self.instrs)
        out = bytearray()
        out += enc_u30(self.method)
        for v in (self.max_stack, self.local_count, self.init_scope, self.max_scope):
            out += enc_u30(v)
        out += enc_u30(len(code)) + code
        out += enc_u30(len(self.exceptions))
        for f, t, tg, ty, nm in self.exceptions:
            out += enc_u30(f.off) + enc_u30(t.off) + enc_u30(tg.off) + enc_u30(ty) + enc_u30(nm)
        out += self.traits
        return bytes(out)


class AbcPatch:
    """One ABC block: look things up, append constants, replace method bodies, serialise."""

    def __init__(self, block: bytes):
        self.raw = block
        self.abc = abcr.Abc(block)
        self.new_strings = []
        self.new_ns = []
        self.new_mn = []
        self.bodies = {}

    # ---- lookup
    def methods(self, owner):
        """Indexes of methods whose owner is exactly `owner` ("Class/method")."""
        return [i for i, m in enumerate(self.abc.methods) if m["owner"] == owner and m["body"] is not None]

    def body(self, method) -> Body:
        if method not in self.bodies:
            self.bodies[method] = Body(self, method)
        return self.bodies[method]

    # ---- constant pools (append-only)
    def string(self, s: str) -> int:
        strings = self.abc.strings
        for i in range(1, len(strings)):
            if strings[i] == s:
                return i
        if s in self.new_strings:
            return len(strings) + self.new_strings.index(s)
        self.new_strings.append(s)
        return len(strings) + len(self.new_strings) - 1

    def namespace(self, kind: int, name: str) -> int:
        nss = self.abc.namespaces
        for i in range(1, len(nss)):
            if nss[i] == (kind, name):
                return i
        key = (kind, self.string(name))
        if key in self.new_ns:
            return len(nss) + self.new_ns.index(key)
        self.new_ns.append(key)
        return len(nss) + len(self.new_ns) - 1

    def qname(self, package: str, name: str) -> int:
        """Index of the public QName `package`::`name`."""
        ns, nm = self.namespace(NS_PACKAGE, package), self.string(name)
        mns = self.abc.multinames
        for i in range(1, len(mns)):
            if mns[i] == ("Q", ns, nm):
                return i
        key = (ns, nm)
        if key in self.new_mn:
            return len(mns) + self.new_mn.index(key)
        self.new_mn.append(key)
        return len(mns) + len(self.new_mn) - 1

    def find_mn(self, name: str):
        """Index of an existing multiname whose readable name (abc.mn) is `name`."""
        for i in range(1, len(self.abc.multinames)):
            if self.abc.mn(i) == name:
                return i
        raise KeyError(name)

    # ---- output
    def build(self) -> bytes:
        a, d, P = self.abc, self.raw, self.abc.pos
        out = bytearray(d[:P["strings_count"]])
        out += enc_u30(len(a.strings) + len(self.new_strings))
        out += d[P["strings"]:P["namespaces_count"]]
        for s in self.new_strings:
            b = s.encode("utf-8")
            out += enc_u30(len(b)) + b
        out += enc_u30(len(a.namespaces) + len(self.new_ns))
        out += d[P["namespaces"]:P["ns_sets"]]
        for kind, name in self.new_ns:
            out += bytes([kind]) + enc_u30(name)
        out += d[P["ns_sets"]:P["multinames_count"]]
        out += enc_u30(len(a.multinames) + len(self.new_mn))
        out += d[P["multinames"]:P["multinames_end"]]
        for ns, name in self.new_mn:
            out += bytes([0x07]) + enc_u30(ns) + enc_u30(name)
        out += d[P["multinames_end"]:P["bodies_count"]]
        out += enc_u30(len(a.body_spans))
        for m, (start, end) in sorted(a.body_spans.items(), key=lambda kv: kv[1][0]):
            out += self.bodies[m].build() if m in self.bodies else d[start:end]
        out += d[P["end"]:]
        return bytes(out)


class Swf:
    """A (zlib-compressed or plain) SWF split into tags."""

    def __init__(self, data: bytes):
        sig = data[:3]
        if sig not in (b"CWS", b"FWS"):
            raise ValueError("only FWS/CWS files are supported")
        self.version = data[3]
        body = abcr.read_swf(data)
        nbits = body[0] >> 3
        pos = (5 + 4 * nbits + 7) // 8 + 4
        self.header = body[:pos]
        self.tags = []  # [code, payload, long header form]
        while pos < len(body):
            code_len = struct.unpack_from("<H", body, pos)[0]
            pos += 2
            code, length = code_len >> 6, code_len & 0x3F
            long_form = length == 0x3F
            if long_form:
                length = struct.unpack_from("<I", body, pos)[0]
                pos += 4
            self.tags.append([code, body[pos:pos + length], long_form])
            pos += length

    def abc_blocks(self):
        """Yield (tag index, abc bytes) for every DoABC / DoABC2 tag."""
        for i, (code, payload, _) in enumerate(self.tags):
            if code == 82:
                end = payload.index(b"\0", 4)
                yield i, payload[end + 1:]
            elif code == 72:
                yield i, payload

    def set_abc(self, index, abc: bytes):
        code, payload, _ = self.tags[index]
        if code == 82:
            end = payload.index(b"\0", 4)
            self.tags[index][1] = payload[:end + 1] + abc
        else:
            self.tags[index][1] = abc

    def build(self) -> bytes:
        body = bytearray(self.header)
        for code, payload, long_form in self.tags:
            if len(payload) < 0x3F and not long_form:
                body += struct.pack("<H", code << 6 | len(payload))
            else:
                body += struct.pack("<HI", code << 6 | 0x3F, len(payload))
            body += payload
        return b"CWS" + bytes([self.version]) + struct.pack("<I", len(body) + 8) + zlib.compress(bytes(body), 9)
