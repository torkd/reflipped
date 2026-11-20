import { test } from "node:test";
import assert from "node:assert/strict";
import { preserveGlossaryReferences, type GlossaryEntry } from "../src/lib/i18n/glossary";

const entry: GlossaryEntry = { ja: "名前", en: "Name", kind: "character", source: "table#1:1->0", ref: null }
const old = { version: 1, lang: "en", entries: [{ ...entry, ref: "https://example.org/wiki/Name" }] }

test("glossary regeneration keeps references only for the same names, kind and source", () => {
    const inputs: GlossaryEntry[] = [entry, { ...entry, en: "Different" }, { ...entry, ja: "別名" },
        { ...entry, kind: "encyclopedia" }, { ...entry, source: "table#2:1->0" }]
    const result = preserveGlossaryReferences(inputs, old)
    assert.equal(result[0].ref, old.entries[0].ref)
    assert.deepEqual(result.slice(1).map(e => e.ref), [null, null, null, null])
    assert.equal(inputs[0].ref, null)
})

test("malformed or ambiguous previous glossaries do not silently discard references", () => {
    assert.throws(() => preserveGlossaryReferences([entry], { version: 1, lang: "en", entries: [{}] }))
    assert.throws(() => preserveGlossaryReferences([entry], { version: 1, lang: "en", entries: [old.entries[0], { ...old.entries[0], ref: "https://example.org/other" }] }))
    assert.throws(() => preserveGlossaryReferences([entry], { ...old, lang: "ja" }))
})
