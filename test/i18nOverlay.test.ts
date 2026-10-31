// Translation overlay build (I18N-3): only the changed cells differ, stale and broken entries are skipped,
// the output is deterministic, and the restore archive keeps the original of every file an overlay ever held.
// Synthetic fixtures only (test/overlayFixtures.ts).

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { CdnIndex, digestPath, masterAssetPath } from "../src/lib/cdnIndex";
import { decodeOrderedMap, walkLeaves } from "../src/lib/orderedmap";
import { getCell } from "../src/i18n/cells";
import { buildOverlay, memberIn, OverlayBuildOptions } from "../src/i18n/overlay";
import {
    CHARACTER_TEXT, characterText, entry, fakePng, IMAGE, IMAGE_FOLDER, ORIGINAL_IMAGE, readZip, SCENARIO, scenario,
    translationSet, UI_STRING, uiString, writeMiniCdn, writeTranslations
} from "./overlayFixtures";

let dir: string
let cdnDir: string
let region: string

before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "reflipped-overlay-"))
    ;({ cdnDir, region } = writeMiniCdn(path.join(dir, "cdn")))
})

after(() => rmSync(dir, { recursive: true, force: true }))

let runs = 0
/** A fresh i18n folder with these files, built into a fresh (or the given) output folder. */
function build(files: Record<string, unknown>, extra: Partial<OverlayBuildOptions> = {}) {
    const i18nDir = path.join(dir, `i18n-${++runs}`)
    writeTranslations(i18nDir, files)
    const outDir = extra.outDir ?? path.join(dir, `out-${runs}`)
    const result = buildOverlay({
        lang: "en", i18nDir, cdn: region, cdnDir, outDir,
        limitsFile: null, glossaryFile: null, ...extra
    })
    return { ...result, outDir, overlay: result.manifest.overlay ? readZip(path.join(result.dir, result.manifest.overlay.file)) : new Map<string, Buffer>() }
}

const uiMember = digestPath(masterAssetPath(UI_STRING))
const charMember = digestPath(masterAssetPath(CHARACTER_TEXT))
const scenarioMember = digestPath(masterAssetPath(SCENARIO))

test("the overlay holds patched copies of only the touched files, under their CDN member names", () => {
    const { manifest, overlay } = build(translationSet())
    assert.deepEqual([...overlay.keys()].sort(), [uiMember, charMember, scenarioMember].sort())
    assert.equal(manifest.report.applied, 5)
    assert.deepEqual(manifest.report.errors, [])
    assert.deepEqual(manifest.entries.map(e => e.table).sort(), [CHARACTER_TEXT, SCENARIO, UI_STRING].sort())
    assert.match(manifest.overlay!.file, /^i18n-en-[0-9a-f]{16}\.zip$/)
    assert.match(manifest.restore!.file, /^restore-[0-9a-f]{16}\.zip$/)

    const ui = decodeOrderedMap(overlay.get(uiMember)!)
    assert.equal(getCell(ui, UI_STRING, "score_attack_title", 2), "Score Attack")
    assert.equal(getCell(ui, UI_STRING, "score_attack_title", 1), "スコアアタック", "the Japanese column stays")
    assert.equal(getCell(ui, UI_STRING, "score_attack_border", 2), "Border ::count::")
    const chars = decodeOrderedMap(overlay.get(charMember)!)
    assert.equal(getCell(chars, CHARACTER_TEXT, "141171", 0), "Taichi Yuhino")
    assert.equal(getCell(chars, CHARACTER_TEXT, "141171", 1), "ユウヒノタイチ", "the reading column stays")
    assert.equal(getCell(chars, CHARACTER_TEXT, "141171", 2), "A new description.")
    const story = decodeOrderedMap(overlay.get(scenarioMember)!)
    assert.equal(getCell(story, SCENARIO, "2", 5), "Hello.\nGoodbye.")
})

test("only the changed rows differ: every other row keeps its original bytes", () => {
    const { overlay } = build(translationSet())
    for (const [member, original, changed] of [[uiMember, uiString(), ["score_attack_title", "score_attack_border"]], [charMember, characterText(), ["141171"]]] as const) {
        const before = new Map([...walkLeaves(decodeOrderedMap(original))].map(l => [l.keys.join("/"), l.leaf.encode()]))
        const afterLeaves = [...walkLeaves(decodeOrderedMap(overlay.get(member)!))]
        assert.equal(afterLeaves.length, before.size)
        for (const { keys, leaf } of afterLeaves) {
            const key = keys.join("/")
            assert.equal(leaf.encode().equals(before.get(key)!), !(changed as readonly string[]).includes(key), `${member} row ${key}`)
        }
    }
})

test("the restore archive holds the original bytes of every overlaid file", () => {
    const { manifest, dir: out } = build(translationSet())
    const restore = readZip(path.join(out, manifest.restore!.file))
    assert.deepEqual([...restore.keys()].sort(), [uiMember, charMember, scenarioMember].sort())
    assert.ok(restore.get(uiMember)!.equals(uiString()))
    assert.ok(restore.get(charMember)!.equals(characterText()))
    assert.ok(restore.get(scenarioMember)!.equals(scenario()))
})

test("the same input gives the same archives, names and manifest", () => {
    const a = build(translationSet())
    const b = build(translationSet())
    assert.equal(a.manifest.overlay!.file, b.manifest.overlay!.file)
    assert.equal(a.manifest.restore!.file, b.manifest.restore!.file)
    for (const file of [a.manifest.overlay!.file, a.manifest.restore!.file, "manifest.json"]) {
        assert.ok(readFileSync(path.join(a.dir, file)).equals(readFileSync(path.join(b.dir, file))), file)
    }
})

test("stale, below-status, malformed, reading-column and checker-failing entries are skipped and reported", () => {
    const files = translationSet() as Record<string, Record<string, Record<string, unknown>>>
    files["master/string__ui_string.json"] = {
        ...files["master/string__ui_string.json"],
        // source changed since the translation
        ok_button: { "2": entry("OKAY", "Okay") },
        // a kanji left in the text: checker error
        unrelated: { "2": entry("Other", "Other 別") },
        missing_row: { "2": entry("x", "y") }
    }
    files["master/character__character_text.json"]["111001"] = {
        "1": entry("ヒビキ", "Hibiki"), // hidden reading column
        "2": { srcHash: "sha256:00", text: "draft", status: "draft" } // no shipping status
    }
    files["master/string__ui_string.json"]["score_attack_border"] = { "2": entry("ボーダー::count::", "Border") } // placeholder lost
    const { manifest, overlay } = build(files)
    const r = manifest.report
    assert.deepEqual(r.stale.map(s => s.row), ["ok_button"])
    assert.deepEqual(r.missing.map(s => s.row), ["missing_row"])
    assert.equal(r.belowStatus, 1)
    assert.ok(r.errors.some(e => e.row === "unrelated" && /kanji/.test(e.reason)))
    assert.ok(r.errors.some(e => e.row === "111001" && e.col === 1 && /reading/.test(e.reason)))
    assert.ok(r.errors.some(e => e.row === "score_attack_border" && /placeholder/.test(e.reason)))
    const ui = decodeOrderedMap(overlay.get(uiMember)!)
    assert.equal(getCell(ui, UI_STRING, "ok_button", 2), "OK")
    assert.equal(getCell(ui, UI_STRING, "unrelated", 2), "Other")
    assert.equal(getCell(ui, UI_STRING, "score_attack_border", 2), "ボーダー::count::")
    assert.equal(getCell(ui, UI_STRING, "score_attack_title", 2), "Score Attack")
})

test("I18N_MIN_STATUS: a higher floor leaves out machine and reviewed entries", () => {
    const { manifest, overlay } = build(translationSet(), { minStatus: "official" })
    assert.equal(manifest.report.applied, 1)
    assert.equal(manifest.report.belowStatus, 4)
    assert.deepEqual([...overlay.keys()], [charMember])
})

test("dropping entries keeps their originals in the restore archive; old archives are pruned", () => {
    const outDir = path.join(dir, "out-history")
    const first = build(translationSet(), { outDir })
    const onlyUi = { "master/string__ui_string.json": (translationSet() as Record<string, unknown>)["master/string__ui_string.json"] }
    const second = build(onlyUi, { outDir })
    assert.deepEqual([...second.overlay.keys()], [uiMember])
    const restore = readZip(path.join(second.dir, second.manifest.restore!.file))
    assert.deepEqual([...restore.keys()].sort(), [uiMember, charMember, scenarioMember].sort())
    assert.ok(restore.get(charMember)!.equals(characterText()))
    // nothing left to translate: no overlay, the restore archive stays
    const third = build({}, { outDir })
    assert.equal(third.manifest.overlay, null)
    assert.equal(third.manifest.restore!.file, second.manifest.restore!.file)
    // this build's and the previous build's archives are kept, older ones removed
    const names = readdirSync(third.dir).filter(n => n.endsWith(".zip")).sort()
    assert.ok(!names.includes(first.manifest.overlay!.file))
    assert.ok(names.includes(second.manifest.overlay!.file))
    assert.ok(names.includes(third.manifest.restore!.file))
})

test("images.json replaces whole images, checked against the original's hash, magic and size", () => {
    const work = path.join(dir, "image-work")
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work, { recursive: true })
    const replacement = fakePng(600, 420, 2)
    writeFileSync(path.join(work, "banner.asset"), replacement)
    writeFileSync(path.join(work, "wrong-size.asset"), fakePng(300, 210, 2))
    const images = {
        [IMAGE]: { srcHash: "sha256:" + createHash("sha256").update(ORIGINAL_IMAGE).digest("hex"), file: "banner.asset", status: "reviewed", folder: IMAGE_FOLDER },
        "dynamic/home_banner/not_there.png": { srcHash: "sha256:" + "0".repeat(64), file: "banner.asset", status: "reviewed" }
    }
    const { manifest, overlay, dir: out } = build({ "images.json": images }, { imagesDir: work })
    const member = memberIn(IMAGE, IMAGE_FOLDER)
    assert.deepEqual([...overlay.keys()], [member])
    assert.ok(overlay.get(member)!.equals(replacement))
    assert.deepEqual(manifest.entries.map(e => e.kind), ["image"])
    assert.deepEqual(manifest.report.missing.map(m => m.asset), ["dynamic/home_banner/not_there.png"])
    const restore = readZip(path.join(out, manifest.restore!.file))
    assert.ok(restore.get(member)!.equals(ORIGINAL_IMAGE))

    images[IMAGE].file = "wrong-size.asset"
    const bad = build({ "images.json": images }, { imagesDir: work })
    assert.equal(bad.manifest.overlay, null)
    assert.ok(bad.manifest.report.errors.some(e => /size 300x210/.test(e.reason)))
    images[IMAGE].file = "banner.asset"
    const noDir = build({ "images.json": images })
    assert.ok(noDir.manifest.report.errors.some(e => /--images-dir/.test(e.reason)))
})

test("the overlay folder may not be inside the CDN folder", () => {
    assert.throws(() => build(translationSet(), { outDir: path.join(cdnDir, "overlay") }), /must not be inside the CDN/)
    assert.ok(!existsSync(path.join(cdnDir, "overlay")))
})

test("an index built once can be reused", () => {
    const index = CdnIndex.build(region)
    const { manifest } = build(translationSet(), { cdn: index })
    assert.equal(manifest.report.applied, 5)
})
