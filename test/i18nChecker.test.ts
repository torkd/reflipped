import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { checkTranslation, directivesOf, placeholdersOf, unbalancedTags } from "../src/lib/i18n/checker"
import { conflicts, dedupe, isUsableEnglish, minePairs, PAIR_SPECS } from "../src/lib/i18n/glossary"
import { columnLimits, percentile } from "../src/lib/i18n/stats"
import { hasKana, hasKanji, masterRows, sha256 } from "../src/lib/i18n/text"

const rules = (source: string, text: string, options = {}) =>
    checkTranslation(source, text, options).map((i) => `${i.severity}:${i.rule}`)

describe("i18n checker", () => {
    it("accepts a clean translation", () => {
        assert.deepEqual(rules("::name::に::count::ダメージ", "::count:: damage to ::name::"), [])
    })

    it("compares placeholders as a multiset", () => {
        assert.deepEqual(rules("::a:: ::b::", "::a:: only"), ["error:placeholder"])
        assert.deepEqual(rules("::a::", "::a:: ::a::"), ["error:placeholder"])
        assert.deepEqual(rules("::a::", "::c::"), ["error:placeholder", "error:placeholder"])
        assert.deepEqual(placeholdersOf("::if x::a::end:: ::y::"), ["::y::"])
    })

    it("checks conditional blocks", () => {
        const src = "::if once::一度::else::毎回::end::"
        assert.deepEqual(rules(src, "::if once::once::else::each time::end::"), [])
        assert.deepEqual(rules(src, "::if once::once::else::each time"), ["error:conditional", "error:conditional"])
        assert.ok(rules(src, "once::end::").includes("error:conditional"))
        assert.deepEqual(directivesOf("::if (a >= 0)::x::end::"), ["::if(a>=0)::", "::end::"])
        assert.ok(rules(src, "::if other::once::else::each time::end::").includes("error:conditional"))
    })

    it("checks tag balance and markup", () => {
        assert.deepEqual(unbalancedTags("<font color='#fff'>a</font>"), [])
        assert.deepEqual(unbalancedTags("<font color='#fff'>a"), ["<font>"])
        assert.deepEqual(unbalancedTags("a</font>"), ["</font>"])
        assert.deepEqual(unbalancedTags("a<br/>b<icon id='x'>"), [])
        const src = "<font color='#EA354C'>強い</font>"
        assert.deepEqual(rules(src, "<font color='#ea354c'>Strong</font>"), [])
        assert.ok(rules(src, "Strong").includes("error:tags"))
        assert.ok(rules(src, "<font color='#ea354c'>Strong").includes("error:tags"))
        assert.ok(rules("a<br/>b", "a b").includes("warning:br"))
        assert.ok(rules("a&nbsp;b", "a b").includes("warning:nbsp"))
    })

    it("flags kanji as errors and kana as warnings", () => {
        assert.deepEqual(rules("攻撃", "Attack 攻撃"), ["error:kanji"])
        assert.deepEqual(rules("ヒビキ", "Hibiki ヒビキ"), ["warning:kana"])
        assert.deepEqual(rules("ヒビキ", "Hibiki ヒビキ", { allowKana: true }), [])
        assert.ok(hasKanji("々") && !hasKanji("ヒビキー") && hasKana("ー") && hasKana("・"))
    })

    it("rejects an empty translation", () => {
        assert.deepEqual(rules("攻撃", "  "), ["error:empty"])
    })

    it("applies the scenario line rules", () => {
        const line = "x".repeat(30)
        assert.deepEqual(rules("あ", [line, line, line].join("\n"), { kind: "scenario" }), [])
        assert.ok(rules("あ", [line, line, line, line].join("\n"), { kind: "scenario" }).includes("error:lines"))
        assert.ok(rules("あ", "x".repeat(36), { kind: "scenario" }).includes("warning:line-length"))
        assert.ok(!rules("あ", "x".repeat(36)).includes("warning:line-length"))
        assert.ok(!rules("あ", "<font color='#fff'>" + "x".repeat(35) + "</font>", { kind: "scenario" }).includes("warning:line-length"))
    })

    it("warns above the length limit", () => {
        assert.deepEqual(rules("あ", "x".repeat(10), { maxLength: 10 }), [])
        assert.deepEqual(rules("あ", "x".repeat(11), { maxLength: 10 }), ["warning:length"])
    })

    it("warns when a glossary term is not carried over", () => {
        const glossary = [{ ja: "ヒビキ", en: "Hibiki" }]
        assert.deepEqual(rules("ヒビキの技", "Hibiki's skill", { glossary }), [])
        assert.deepEqual(rules("ヒビキの技", "Hebiki's skill", { glossary }), ["warning:glossary"])
        assert.deepEqual(rules("別の技", "Skill", { glossary }), [])
    })
})

describe("i18n glossary miner", () => {
    const text = PAIR_SPECS.find((s) => s.table === "character/character_text")!
    const ui = PAIR_SPECS.find((s) => s.table === "string/ui_string")!
    const row = (cols: Record<number, string>) => Array.from({ length: 20 }, (_, i) => cols[i] ?? "")

    it("pairs reading and name from nested or flat tables, skipping unusable English", () => {
        const table = {
            "1": row({ 0: "Alk", 1: "アルク" }),
            "2": row({ 0: "ランメイ", 1: "ランメイ" }),
            "3": row({ 0: "", 1: "シロ" }),
            "4": row({ 0: "None", 1: "なし" }),
            "5": row({ 0: "Alk", 1: "アルク" }),
            "6": row({ 0: "Alk", 1: "Alk" }),
        }
        const pairs = minePairs(table, text)
        assert.deepEqual(pairs.map((p) => [p.ja, p.en, p.source]), [
            ["アルク", "Alk", "character/character_text#1:1->0"],
            ["アルク", "Alk", "character/character_text#5:1->0"],
        ])
        assert.equal(dedupe(pairs).length, 1)
        assert.deepEqual(minePairs({ "9": { "1": row({ 16: "Stella", 17: "ステラ" }) } }, PAIR_SPECS[1]).map((p) => p.source), [
            "encyclopedia/encyclopedia#9/1:17->16",
        ])
    })

    it("takes the English column of ui_string and skips Japanese, long and multi-line rows", () => {
        const table = {
            a: row({ 0: "決定", 2: "OK" }),
            b: row({ 0: "決定", 2: "決定する" }),
            c: row({ 0: "決定\n二行", 2: "Two lines" }),
            d: row({ 0: "あ".repeat(41), 2: "Long" }),
            e: row({ 0: "OK", 2: "OK" }),
        }
        assert.deepEqual(minePairs(table, ui).map((p) => p.source), ["string/ui_string#a:0->2"])
    })

    it("recognises placeholders and finds conflicting renderings", () => {
        assert.equal(isUsableEnglish("", "あ"), false)
        assert.equal(isUsableEnglish("----", "あ"), false)
        assert.equal(isUsableEnglish("(None)", "あ"), false)
        assert.equal(isUsableEnglish("Shield", "盾"), true)
        const entries = [
            { ja: "盾", en: "Shield", kind: "ui_string" as const, source: "a", ref: null },
            { ja: "盾", en: "Guard", kind: "ui_string" as const, source: "b", ref: null },
            { ja: "剣", en: "Sword", kind: "ui_string" as const, source: "c", ref: null },
        ]
        assert.deepEqual([...conflicts(entries)], [["盾", ["Shield", "Guard"]]])
    })
})

describe("i18n stats and helpers", () => {
    it("computes the 95th percentile of English lengths per column", () => {
        assert.equal(percentile([], 95), 0)
        assert.equal(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95)
        const rows = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i), ["x".repeat(i + 1), "あ"]]))
        rows["99"] = ["日本語", "あ"]
        assert.deepEqual(columnLimits(rows, [0, 1], 95, 20), { "0": 19 })
    })

    it("walks nested tables and hashes text", () => {
        const rows = [...masterRows({ a: { b: ["1", "2"] }, c: ["3"] })]
        assert.deepEqual(rows.map((r) => [r.keyPath, r.cells]), [[["a", "b"], ["1", "2"]], [["c"], ["3"]]])
        assert.match(sha256("x"), /^sha256:[0-9a-f]{64}$/)
    })
})
