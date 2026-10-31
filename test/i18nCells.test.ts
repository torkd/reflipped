// Translation cell addressing and patching (I18N-1): row key paths, srcHash, Japanese detection,
// patchTable. Synthetic fixtures only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import { deflateSync, inflateSync } from "zlib";
import { buildOrderedMap, decodeOrderedMap, OrderedMapBranch, OrderedMapLeaf } from "../src/lib/orderedmap";
import { getCell, hasJapanese, hasOnlyCjkPunctuation, patchTable, srcHash, tableCells } from "../src/i18n/cells";

const TABLE = "test/table"
const SCENARIO = "story/test_quest/test_001/scenario"

function table(): Buffer {
    return buildOrderedMap([
        ["1001", [["Name", "ナマエ", "説明です、はい"]]],
        ["1002", [["Other", "", "English text"]]],
        ["2000004", buildOrderedMap([["1", [["名前", "x"]]], ["2", [["二", "y"]]]])],
        ["speech", [["0", "2", "", "一行目", "home/a"], ["0", "2", "", "二行目", "home/b"]]],
        ["bgm/event/some_path", [["slashed key", "日本"]]]
    ]).encode()
}

function scenario(): Buffer {
    return buildOrderedMap([[SCENARIO, buildOrderedMap([
        ["1", [["22", "", ""]]],
        ["2", [["0", "", "", "", "speaker_a", "こんにちは\\nさようなら"]]]
    ])]]).encode()
}

test("srcHash is sha256 of the cell's UTF-8 text", () => {
    assert.equal(srcHash("名前"), "sha256:" + createHash("sha256").update(Buffer.from("名前", "utf8")).digest("hex"))
})

test("Japanese detection: kana and kanji, punctuation apart", () => {
    for (const t of ["ひらがな", "カタカナ", "漢字", "まで10 dy. left", "々", "ｶﾀｶﾅ"]) assert.equal(hasJapanese(t), true, t)
    for (const t of ["English", "・::description::", "ー", "【::a::】", "（x）", "、", "", "Ünïcödé", "한국어", "ชิ้นส่วน"]) {
        assert.equal(hasJapanese(t), false, t)
    }
    assert.equal(hasOnlyCjkPunctuation("・::description::"), true)
    assert.equal(hasOnlyCjkPunctuation("ーー"), true)
    assert.equal(hasOnlyCjkPunctuation("English"), false)
    assert.equal(hasOnlyCjkPunctuation("ダメージ"), false)
})

test("row key paths join keys with / and count columns over the leaf's records", () => {
    const cells = [...tableCells(decodeOrderedMap(table()), TABLE)]
    const at = (row: string, col: number) => cells.find(c => c.row === row && c.col === col)?.text
    assert.equal(at("1001", 2), "説明です、はい")
    assert.equal(at("2000004/1", 0), "名前")
    assert.equal(at("2000004/2", 0), "二")
    // two records of five cells: the second voice line is col 8
    assert.equal(at("speech", 3), "一行目")
    assert.equal(at("speech", 8), "二行目")
    assert.equal(cells.find(c => c.row === "speech" && c.col === 8)?.indexInRecord, 3)
    assert.equal(at("bgm/event/some_path", 1), "日本")
})

test("a scenario's root wrapper is left out of its row keys", () => {
    const cells = [...tableCells(decodeOrderedMap(scenario()), SCENARIO)]
    assert.deepEqual([...new Set(cells.map(c => c.row))], ["1", "2"])
    assert.equal(cells.find(c => c.row === "2" && c.col === 5)?.text, "こんにちは\\nさようなら")
})

test("colliding row key paths are refused", () => {
    const data = buildOrderedMap([["a/b", [["x"]]], ["a", buildOrderedMap([["b", [["y"]]]])]]).encode()
    assert.throws(() => [...tableCells(decodeOrderedMap(data), TABLE)], /two rows/)
})

test("patchTable applies matching patches and keeps every other row's bytes", () => {
    const data = table()
    const root = decodeOrderedMap(data) as OrderedMapBranch
    const result = patchTable(data, TABLE, [
        { row: "1001", col: 2, text: "A description, \"quoted\"\nover two lines", srcHash: srcHash("説明です、はい") },
        { row: "2000004/1", col: 0, text: "Name" },
        { row: "speech", col: 8, text: "Second line" },
        { row: "bgm/event/some_path", col: 1, text: "Japan" },
        { row: "1002", col: 2, text: "stale", srcHash: srcHash("old text") },
        { row: "9999", col: 0, text: "missing row" },
        { row: "1001", col: 7, text: "missing column" },
        { row: "2000004", col: 0, text: "a map, not a row" }
    ])
    assert.equal(result.applied.length, 4)
    assert.deepEqual(result.stale.map(p => [p.row, p.current]), [["1002", "English text"]])
    assert.deepEqual(result.missing.map(p => p.row), ["9999", "1001", "2000004"])

    const patched = decodeOrderedMap(result.data)
    assert.equal(getCell(patched, TABLE, "1001", 2), "A description, \"quoted\"\nover two lines")
    assert.equal(getCell(patched, TABLE, "1001", 1), "ナマエ")
    assert.equal(getCell(patched, TABLE, "2000004/1", 0), "Name")
    assert.equal(getCell(patched, TABLE, "speech", 3), "一行目")
    assert.equal(getCell(patched, TABLE, "speech", 8), "Second line")
    assert.equal(getCell(patched, TABLE, "bgm/event/some_path", 1), "Japan")
    // the untouched row keeps its compressed bytes
    const blob = (n: OrderedMapBranch, key: string) => (n.get(key) as OrderedMapLeaf).encode()
    assert.ok(blob(patched as OrderedMapBranch, "1002").equals(blob(root, "1002")))
    const inner = (n: OrderedMapBranch) => ((n.get("2000004") as OrderedMapBranch).get("2") as OrderedMapLeaf).encode()
    assert.ok(inner(patched as OrderedMapBranch).equals(inner(root)))
})

test("patchTable checks srcHash against the original cell and returns the input when nothing applies", () => {
    const data = table()
    const none = patchTable(data, TABLE, [{ row: "1001", col: 2, text: "x", srcHash: srcHash("not it") }])
    assert.equal(none.data, data)
    const twice = patchTable(data, TABLE, [
        { row: "1001", col: 0, text: "First", srcHash: srcHash("Name") },
        { row: "1001", col: 0, text: "Second", srcHash: srcHash("Name") }
    ])
    assert.equal(twice.applied.length, 2)
    assert.equal(getCell(decodeOrderedMap(twice.data), TABLE, "1001", 0), "Second")
})

test("patching a scenario line and a plain CSV table", () => {
    const s = patchTable(scenario(), SCENARIO, [{ row: "2", col: 5, text: "Hello\nGoodbye" }])
    assert.equal(s.applied.length, 1)
    assert.equal(getCell(decodeOrderedMap(s.data), SCENARIO, "2", 5), "Hello\nGoodbye")
    const csv = deflateSync(Buffer.from("Fire ,火\nWater ,水"), { level: 9 })
    const c = patchTable(csv, "string/plain", [{ row: "", col: 1, text: "fire" }, { row: "", col: 3, text: "water" }])
    assert.equal(inflateSync(c.data).toString(), "Fire ,fire\nWater ,water")
})
