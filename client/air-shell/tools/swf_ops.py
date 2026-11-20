#!/usr/bin/env python3
"""The patch op list of an "import" build: how the app turns the player's game SWF into the patched one.

    python3 -I swf_ops.py make <original.swf> <patched.swf> <out.ops>   # write the op list, print its statistics
    python3 -I swf_ops.py apply <original.swf> <in.ops> <out.swf>      # apply one (writes an uncompressed SWF)
    python3 -I swf_ops.py stats <in.ops>

An import build (build.py --content import) ships no game content: the app copies the game SWF out of the player's own
game app and applies this op list to it (java/.../content/OpPatch.java does what `apply` does). Both sides work on the
uncompressed SWF ("FWS"), because zlib output differs between implementations while inflating doesn't.

Format, all integers little-endian:
    "RFLPOPS1"
    u32 input size, u32 output size              (uncompressed SWFs)
    32 bytes sha256(input), 32 bytes sha256(output)
    zlib(ops)
where ops is a sequence of
    0x00 varint offset, varint length            COPY length bytes from the input at offset
    0x01 varint length, bytes                    INSERT these bytes
(varint: unsigned LEB128). The input hash doubles as the "is this version 0.0.81?" check, the output hash checks the
result, and the app checks the output hash again before every launch.

The op list holds only offsets, lengths and the bytes our patches add (our strings and AVM2 code, a few count and
length fields), never the game's own bytes: `make` aligns long runs of the input first, then matches each inserted
stretch against the input again, so even short unchanged runs inside changed code are copied rather than carried.
check_own_bytes() (run by `make` and by build.py) refuses an op list whose own bytes are too many, whose longest insert
is too long, or whose inserts contain a piece of the game's SWF.
"""
import difflib
import hashlib
import importlib.util
import os
import struct
import sys
import zlib

_spec = importlib.util.spec_from_file_location("abcr", os.path.join(os.path.dirname(os.path.abspath(__file__)), "abc.py"))
abcr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(abcr)

MAGIC = b"RFLPOPS1"
COPY, INSERT = 0, 1
HEADER = struct.Struct("<8sII32s32s")

NEEDLE = 12          # bytes looked up when realigning after a difference
MIN_RUN = 24         # a realignment must match at least this far
SEARCH_AHEAD = 4096  # how far into the new data a realignment is looked for
WINDOW = 65536       # how far around the current input position
REFINE_MIN = 4       # shortest input run copied out of an inserted stretch
REFINE_CONTEXT = 512


def fws(data: bytes) -> bytes:
    """The uncompressed form of a SWF (FWS, the same header with its version and length)."""
    if data[:3] == b"FWS":
        return bytes(data)
    body = abcr.read_swf(data)
    if len(body) + 8 != struct.unpack_from("<I", data, 4)[0]:
        raise ValueError("SWF length field doesn't match its body")
    return b"FWS" + data[3:8] + body


def _common(old, new, o, n):
    """Length of the common prefix of old[o:] and new[n:]."""
    limit = min(len(old) - o, len(new) - n)
    done, step = 0, 256
    while done < limit:
        end = min(limit, done + step)
        if old[o + done:o + end] == new[n + done:n + end]:
            done = end
            step = min(step * 2, 1 << 20)
            continue
        lo, hi = done, end  # old[o:o+lo] == new[n:n+lo]; differs somewhere before hi
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if old[o + lo:o + mid] == new[n + lo:n + mid]:
                lo = mid
            else:
                hi = mid
        return lo
    return done


def _realign(old, new, o, n):
    """(input position, literal length) where new[n + literal:] lines up with the input again, or None."""
    for j in range(0, min(SEARCH_AHEAD, len(new) - n - NEEDLE + 1)):
        needle = new[n + j:n + j + NEEDLE]
        for start, end in ((o, min(len(old), o + WINDOW)), (max(0, o - WINDOW), o)):
            pos = old.find(needle, start, end + NEEDLE - 1)
            tries = 0
            while pos >= 0 and tries < 8:
                if _common(old, new, pos, n + j) >= MIN_RUN:
                    return pos, j
                tries += 1
                pos = old.find(needle, pos + 1, end + NEEDLE - 1)
    return None


def _coarse(old, new):
    ops, o, n = [], 0, 0
    while n < len(new):
        run = _common(old, new, o, n) if o < len(old) else 0
        if run:
            ops.append([COPY, o, run])
            o, n = o + run, n + run
            continue
        found = _realign(old, new, o, n)
        if found is None:  # nothing lines up nearby: carry a stretch and look again after it
            take = min(SEARCH_AHEAD, len(new) - n)
            ops.append([INSERT, new[n:n + take]])
            n += take
            continue
        pos, j = found
        if j:
            ops.append([INSERT, new[n:n + j]])
        o, n = pos, n + j
    return ops


def _refine(old, ops):
    """Replace runs inside inserted stretches that also exist in the input near that place with copies."""
    out = []
    for i, op in enumerate(ops):
        if op[0] != INSERT:
            out.append(op)
            continue
        data = op[1]
        before = next((p for p in reversed(ops[:i]) if p[0] == COPY), None)
        after = next((p for p in ops[i + 1:] if p[0] == COPY), None)
        lo = (before[1] + before[2]) if before else 0
        hi = after[1] if after else len(old)
        if hi < lo:
            lo, hi = hi, lo
        if len(data) > 65536:  # far beyond any limit in check_own_bytes: leave it for that check to refuse
            out.append(op)
            continue
        start = max(0, lo - REFINE_CONTEXT)
        end = min(len(old), max(hi, lo) + REFINE_CONTEXT)
        if end - start > 8 * 65536:  # the neighbouring copies are far apart: look next to the one before
            end = min(len(old), lo + len(data) + REFINE_CONTEXT)
        window = old[start:end]
        matcher = difflib.SequenceMatcher(None, window, data, autojunk=False)
        at = 0
        for a, b, size in matcher.get_matching_blocks():
            if size < REFINE_MIN:
                continue
            if b > at:
                out.append([INSERT, data[at:b]])
            out.append([COPY, start + a, size])
            at = b + size
        if at < len(data):
            out.append([INSERT, data[at:]])
    merged = []
    for op in out:
        last = merged[-1] if merged else None
        if last and last[0] == op[0] == INSERT:
            last[1] = last[1] + op[1]
        elif last and last[0] == op[0] == COPY and last[1] + last[2] == op[1]:
            last[2] += op[2]
        else:
            merged.append(list(op))
    return merged


def make_ops(old: bytes, new: bytes):
    return _refine(old, _coarse(old, new))


# What an op list may carry of its own. Our patches add strings, short AVM2 sequences and changed count and length
# fields: about 1 KB in all, the longest run 164 bytes (0.0.81, 2026-11). Raise these only after checking what a new
# patch inserts: a larger value would let a change that shifts bytes around carry game bytes in the op list.
MAX_OWN_BYTES = 3072
MAX_INSERT_BYTES = 384
# No run of the game's own bytes this long may sit in an insert (checked by looking up every PROBE-byte piece
# that starts at a multiple of PROBE, so any copied run of 2 * PROBE - 1 bytes or more is found)
PROBE = 24


def check_own_bytes(old: bytes, ops, max_own=MAX_OWN_BYTES, max_insert=MAX_INSERT_BYTES):
    """Reasons why `ops` (made from `old`) may carry game bytes; empty if it doesn't."""
    st = stats(ops)
    problems = []
    if st["literal_bytes"] > max_own:
        problems.append(f"{st['literal_bytes']} bytes of its own (limit {max_own})")
    if st["longest_insert"] > max_insert:
        problems.append(f"an insert of {st['longest_insert']} bytes (limit {max_insert})")
    for op in ops:
        if op[0] != INSERT:
            continue
        for at in range(0, len(op[1]) - PROBE + 1, PROBE):
            piece = op[1][at:at + PROBE]
            if old.find(piece) >= 0:
                problems.append(f"an insert holds {PROBE} bytes found in the game's SWF ({piece[:12].hex()}...)")
                break
    return problems


def _varint(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def encode(old: bytes, new: bytes, ops) -> bytes:
    stream = bytearray()
    for op in ops:
        if op[0] == COPY:
            stream += bytes([COPY]) + _varint(op[1]) + _varint(op[2])
        else:
            stream += bytes([INSERT]) + _varint(len(op[1])) + op[1]
    return HEADER.pack(MAGIC, len(old), len(new), hashlib.sha256(old).digest(), hashlib.sha256(new).digest()) \
        + zlib.compress(bytes(stream), 9)


def decode(data: bytes):
    """(input size, output size, input sha256, output sha256, ops)."""
    magic, in_size, out_size, in_hash, out_hash = HEADER.unpack_from(data)
    if magic != MAGIC:
        raise ValueError("not an op list")
    stream = zlib.decompress(data[HEADER.size:])
    ops, pos = [], 0

    def varint():
        nonlocal pos
        value = shift = 0
        while True:
            byte = stream[pos]
            pos += 1
            value |= (byte & 0x7F) << shift
            shift += 7
            if byte < 0x80:
                return value

    while pos < len(stream):
        kind = stream[pos]
        pos += 1
        if kind == COPY:
            offset = varint()
            ops.append([COPY, offset, varint()])
        elif kind == INSERT:
            size = varint()
            ops.append([INSERT, stream[pos:pos + size]])
            pos += size
        else:
            raise ValueError(f"unknown op {kind}")
    return in_size, out_size, in_hash, out_hash, ops


def apply(old: bytes, data: bytes) -> bytes:
    in_size, out_size, in_hash, out_hash, ops = decode(data)
    if len(old) != in_size or hashlib.sha256(old).digest() != in_hash:
        raise ValueError("the input isn't the SWF this op list was made for")
    out = bytearray()
    for op in ops:
        if op[0] == COPY:
            if op[1] + op[2] > len(old):
                raise ValueError("copy past the end of the input")
            out += old[op[1]:op[1] + op[2]]
        else:
            out += op[1]
    if len(out) != out_size or hashlib.sha256(out).digest() != out_hash:
        raise ValueError("the result doesn't match the op list's output hash")
    return bytes(out)


def stats(ops):
    inserts = [op[1] for op in ops if op[0] == INSERT]
    return dict(ops=len(ops), copies=len(ops) - len(inserts), inserts=len(inserts),
                literal_bytes=sum(len(x) for x in inserts), longest_insert=max((len(x) for x in inserts), default=0))


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "make" and len(args) == 3:
        with open(args[0], "rb") as f:
            old = fws(f.read())
        with open(args[1], "rb") as f:
            new = fws(f.read())
        ops = make_ops(old, new)
        data = encode(old, new, ops)
        if apply(old, data) != new:
            sys.exit("swf_ops: the op list doesn't reproduce the patched SWF")
        problems = check_own_bytes(old, ops)
        if problems:
            sys.exit("swf_ops: the op list may carry game bytes: " + "; ".join(problems))
        with open(args[2], "wb") as f:
            f.write(data)
        print(f"wrote {args[2]} ({len(data)} B): {stats(ops)}")
    elif cmd == "apply" and len(args) == 3:
        with open(args[0], "rb") as f:
            old = fws(f.read())
        with open(args[1], "rb") as f:
            new = apply(old, f.read())
        with open(args[2], "wb") as f:
            f.write(new)
        print(f"wrote {args[2]} ({len(new)} B)")
    elif cmd == "stats" and len(args) == 1:
        with open(args[0], "rb") as f:
            print(stats(decode(f.read())[4]))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
