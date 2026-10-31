// Orderedmap codec (I18N-1): round trip, in-place patching, CSV quoting. Synthetic fixtures only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync, inflateSync } from "zlib";
import {
    buildOrderedMap, decodeOrderedMap, encodeCsv, OrderedMapBranch, OrderedMapLeaf, parseCsv, walkLeaves
} from "../src/lib/orderedmap";

/** Splits an encoded map into its header bytes and value blobs, as stored. */
function split(data: Buffer): { header: Buffer, values: Buffer[] } {
    const size = data.readInt32LE(0)
    const header = data.subarray(4, 4 + size)
    const table = inflateSync(header)
    const count = table.readInt32LE(0)
    const content = data.subarray(4 + size)
    const values: Buffer[] = []
    let start = 0
    for (let i = 0; i < count; i++) {
        const end = table.readInt32LE(8 + i * 8)
        values.push(content.subarray(start, end))
        start = end
    }
    return { header, values }
}

function sample(): Buffer {
    return buildOrderedMap([
        ["10", [["Nimbus", "シロ", "A tiger, with \"quotes\"", ""]]],
        ["20", [["Second", "", "line one\nline two", "x"]]],
        ["30", [["a", "b"], ["c", "d"]]],
        ["nested", buildOrderedMap([
            ["1", [["inner", "値"]]],
            ["2", buildOrderedMap([["deep", [["leaf"]]]])]
        ])],
        ["empty", []]
    ]).encode()
}

test("decode then encode without changes gives the same bytes", () => {
    const data = sample()
    const root = decodeOrderedMap(data)
    assert.equal(root.kind, "map")
    assert.equal(root.changed, false)
    assert.ok(root.encode().equals(data))
    // reading every leaf doesn't mark anything changed
    for (const { leaf } of walkLeaves(root)) void leaf.records
    assert.ok(root.encode().equals(data))
})

test("leaves decode to their records, nested maps recursively", () => {
    const root = decodeOrderedMap(sample()) as OrderedMapBranch
    assert.deepEqual(root.entries.map(e => e.key), ["10", "20", "30", "nested", "empty"])
    assert.deepEqual((root.get("10") as OrderedMapLeaf).records, [["Nimbus", "シロ", "A tiger, with \"quotes\"", ""]])
    assert.deepEqual((root.get("30") as OrderedMapLeaf).records, [["a", "b"], ["c", "d"]])
    assert.deepEqual((root.get("empty") as OrderedMapLeaf).records, [])
    const deep = root.at(["nested", "2", "deep"])
    assert.equal(deep?.kind, "leaf")
    assert.deepEqual((deep as OrderedMapLeaf).records, [["leaf"]])
    assert.deepEqual([...walkLeaves(root)].map(v => v.keys.join("/")), ["10", "20", "30", "nested/1", "nested/2/deep", "empty"])
})

test("a patched row is re-encoded and every other blob stays byte-identical", () => {
    const data = sample()
    const before = split(data)
    const root = decodeOrderedMap(data) as OrderedMapBranch
    const leaf = root.get("20") as OrderedMapLeaf
    assert.equal(leaf.setCell(0, 2, "English, with a \"quote\"\nand a second line"), true)
    const patched = root.encode()
    const after = split(patched)
    assert.equal(after.values.length, before.values.length)
    after.values.forEach((v, i) => {
        if (i === 1) assert.ok(!v.equals(before.values[i]))
        else assert.ok(v.equals(before.values[i]), `value ${i} kept its bytes`)
    })
    const again = decodeOrderedMap(patched) as OrderedMapBranch
    assert.deepEqual((again.get("20") as OrderedMapLeaf).records, [["Second", "", "English, with a \"quote\"\nand a second line", "x"]])
    assert.deepEqual((again.get("10") as OrderedMapLeaf).records, [["Nimbus", "シロ", "A tiger, with \"quotes\"", ""]])
})

test("a nested patch keeps the untouched sibling maps and leaves", () => {
    const data = sample()
    const root = decodeOrderedMap(data) as OrderedMapBranch
    ;(root.at(["nested", "1"]) as OrderedMapLeaf).setCell(0, 1, "value")
    const patched = root.encode()
    const before = split(data), after = split(patched)
    for (const i of [0, 1, 2, 4]) assert.ok(after.values[i].equals(before.values[i]))
    // inside the nested map, the untouched sub-map keeps its bytes
    const nb = split(before.values[3]), na = split(after.values[3])
    assert.ok(na.values[1].equals(nb.values[1]))
    assert.ok(!na.values[0].equals(nb.values[0]))
    assert.deepEqual(((decodeOrderedMap(patched) as OrderedMapBranch).at(["nested", "1"]) as OrderedMapLeaf).records, [["inner", "value"]])
})

test("the header is kept when keys and value lengths don't change", () => {
    const data = buildOrderedMap([["a", [["x"]]], ["b", [["y"]]]]).encode()
    const root = decodeOrderedMap(data) as OrderedMapBranch
    ;(root.get("a") as OrderedMapLeaf).setCell(0, 0, "z") // same compressed length
    const patched = root.encode()
    assert.equal(split(patched).values[0].length, split(data).values[0].length)
    assert.ok(split(patched).header.equals(split(data).header))
    assert.ok(!patched.equals(data))
})

test("setting a cell to its current value changes nothing", () => {
    const data = sample()
    const root = decodeOrderedMap(data) as OrderedMapBranch
    assert.equal((root.get("10") as OrderedMapLeaf).setCell(0, 0, "Nimbus"), false)
    assert.equal(root.changed, false)
    assert.ok(root.encode().equals(data))
    assert.throws(() => (root.get("10") as OrderedMapLeaf).setCell(0, 9, "x"), RangeError)
})

test("a plain zlib CSV table decodes as a root leaf and patches", () => {
    const data = deflateSync(Buffer.from("Fire ,<icon id='red'>\nWater ,<icon id='blue'>"), { level: 9 })
    const root = decodeOrderedMap(data)
    assert.equal(root.kind, "leaf")
    assert.ok(root.encode().equals(data))
    ;(root as OrderedMapLeaf).setCell(1, 0, "Eau")
    assert.equal(inflateSync(root.encode()).toString(), "Fire ,<icon id='red'>\nEau,<icon id='blue'>")
})

test("leaves are compressed with zlib level 9, like the originals", () => {
    const text = "1,some text,more text,more text,more text"
    const leaf = OrderedMapLeaf.fromRecords(parseCsv(text).records)
    assert.ok(leaf.encode().equals(deflateSync(Buffer.from(text), { level: 9 })))
})

test("CSV quoting: commas, quotes, newlines, empty cells", () => {
    const cases: string[][][] = [
        [["plain", "with, comma", "with \"quote\"", "multi\nline", "cr\r\nlf", "", "trailing "]],
        [["", "", ""]],
        [[""]],
        [["\"\""], ["\""], [","]],
        [["a"], [], ["b"]],
        [["日本語、テキスト", "「かぎ」", "::placeholder::"]],
        []
    ]
    for (const records of cases) {
        const text = encodeCsv(records)
        assert.deepEqual(parseCsv(text).records, records, JSON.stringify(text))
    }
    assert.equal(encodeCsv([["a", "b,c", "d\"e", ""]]), 'a,"b,c","d""e",')
    assert.equal(encodeCsv([[""]]), '""')
    assert.equal(encodeCsv([["x"], ["y"]]), "x\ny")
})

test("CSV parsing follows Python's csv.reader", () => {
    assert.deepEqual(parseCsv('a,"b ""q"" c",d').records, [["a", 'b "q" c', "d"]])
    assert.deepEqual(parseCsv('a"b,c').records, [['a"b', "c"]]) // a quote inside an unquoted cell is literal
    assert.deepEqual(parseCsv('"ab"cd,e').records, [["abcd", "e"]])
    assert.deepEqual(parseCsv("a,\nb,").records, [["a", ""], ["b", ""]])
    assert.deepEqual(parseCsv("a\r\nb").records, [["a"], ["b"]])
    assert.deepEqual(parseCsv("").records, [])
    const doc = parseCsv("a,b\n")
    assert.deepEqual(doc.records, [["a", "b"]])
    assert.equal(encodeCsv(doc), "a,b\n") // a final newline survives the round trip
    assert.equal(encodeCsv(parseCsv("a\r\nb")), "a\r\nb")
})

test("a map whose header size reads like a zlib header still decodes as a map", () => {
    // a stored (level 0) header of 365 bytes compresses to 376 = 0x0178, so the file starts with 78 01:
    // a valid zlib header, as the Python decoder would also first try
    const key = "k".repeat(353)
    const table = Buffer.alloc(12)
    table.writeInt32LE(1, 0)
    const value = deflateSync(Buffer.from("cell"), { level: 9 })
    table.writeInt32LE(key.length, 4)
    table.writeInt32LE(value.length, 8)
    const header = deflateSync(Buffer.concat([table, Buffer.from(key)]), { level: 0 })
    assert.equal(header.length, 376)
    const size = Buffer.alloc(4)
    size.writeInt32LE(header.length, 0)
    const data = Buffer.concat([size, header, value])
    assert.deepEqual([...data.subarray(0, 2)], [0x78, 0x01])
    const root = decodeOrderedMap(data) as OrderedMapBranch
    assert.equal(root.kind, "map")
    assert.deepEqual((root.get(key) as OrderedMapLeaf).records, [["cell"]])
    assert.ok(root.encode().equals(data))
})
