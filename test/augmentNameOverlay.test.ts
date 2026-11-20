import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { digestPath, masterAssetPath } from "../src/lib/cdnIndex"
import { buildOrderedMap, decodeOrderedMap } from "../src/lib/orderedmap"
import { writeZip } from "../src/lib/zipWriter"
import { getCell } from "../src/i18n/cells"
import { buildOverlay } from "../src/i18n/overlay"
import { readZip } from "./overlayFixtures"
import enhancements from "../i18n/en/master/equipment_enhancement__equipment_enhancement.json"
import items from "../i18n/en/master/item__item.json"

// Short name cells verified against the original CDN. The actual translation entries and the default status floor are
// used, so this detects missing, stale or filtered names in the built overlay rather than reproducing the translations.
test("the overlay includes augmented armament and Hari Salvor core names", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "reflipped-augment-names-"))
    try {
        const region = path.join(dir, "cdn/en")
        const archiveDir = path.join(region, "archive-common-full")
        const i18nDir = path.join(dir, "i18n")
        mkdirSync(archiveDir, { recursive: true })
        mkdirSync(path.join(i18nDir, "en/master"), { recursive: true })
        const enhancementTable = "equipment_enhancement/equipment_enhancement"
        const itemTable = "item/item"
        const names = [
            ["5020042", "ハルボーマン・改", "Hal Bowman+"],
            ["5090047", "アロランドネモ・改", "Aroland Nemo+"],
            ["5100020", "ハリサルヴァー・改", "Hari Salvor+"],
            ["5100011", "天機銃・無双", "Handgun of Celestial Insight Peerless"],
            ["5010032", "天府剣・無双", "Blade of Celestial Wealth Peerless"],
            ["5030028", "天同槍・無双", "Trident of Celestial Fortune Peerless"],
            ["5040020", "天相弓・無双", "Bow of Celestial Service Peerless"]
        ] as const
        const equipmentData = buildOrderedMap(names.map(([id, source]) => [id, [["", "", source]]])).encode()
        const itemData = buildOrderedMap([["5100020", [["", "ハリサルヴァーのソウル"]]]]).encode()
        writeFileSync(path.join(archiveDir, "asset-2.1.0-1-00000001.zip"), writeZip([
            { name: digestPath(masterAssetPath(enhancementTable)), data: equipmentData },
            { name: digestPath(masterAssetPath(itemTable)), data: itemData }
        ]))
        const entries = Object.fromEntries(names.map(([id]) => [id, { "2": enhancements[id]["2"] }]))
        writeFileSync(path.join(i18nDir, "en/master/equipment_enhancement__equipment_enhancement.json"), JSON.stringify(entries))
        writeFileSync(path.join(i18nDir, "en/master/item__item.json"), JSON.stringify({ "5100020": { "1": items["5100020"]["1"] } }))
        const result = buildOverlay({ lang: "en", i18nDir, cdn: region, cdnDir: path.join(dir, "cdn"), outDir: path.join(dir, "out"), columnsFile: null, limitsFile: null, glossaryFile: null })
        assert.equal(result.manifest.report.applied, 8)
        assert.deepEqual(result.manifest.report.errors, [])
        const zip = readZip(path.join(result.dir, result.manifest.overlay!.file))
        const equipment = decodeOrderedMap(zip.get(digestPath(masterAssetPath(enhancementTable)))!)
        const item = decodeOrderedMap(zip.get(digestPath(masterAssetPath(itemTable)))!)
        for (const [id, , expected] of names) assert.equal(getCell(equipment, enhancementTable, id, 2), expected)
        assert.equal(getCell(item, itemTable, "5100020", 1), "Hari Salvor Core")
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
