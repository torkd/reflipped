import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { digestPath, masterAssetPath } from "../src/lib/cdnIndex";
import { buildOrderedMap, decodeOrderedMap } from "../src/lib/orderedmap";
import { writeZip } from "../src/lib/zipWriter";
import { buildOverlay } from "../src/i18n/overlay";
import { getCell, srcHash } from "../src/i18n/cells";
import { readZip } from "./overlayFixtures";

const table = "string/ui_string"
const rows = [
    { key: "ability_description_target_total_of_ally_constraint_during", ja: "::constraint::全員", original: "All ::contstraint:: party members", fixed: "All ::constraint:: party members" },
    { key: "active_ability_dialog_inactive_reason_party", ja: "「::trigger::」を満たしていないため発動しません。", original: "Unable to activate (::triger:: is not full)", fixed: "Unable to activate (::trigger:: is not full)" }
]

test("the shipped corrections validate against Japanese and appear in the built overlay", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "reflipped-placeholder-corrections-"))
    try {
        const cdn = path.join(dir, "cdn", "en"), archive = path.join(cdn, "archive-common-full")
        const translations = path.join(dir, "i18n", "en", "master")
        mkdirSync(archive, { recursive: true })
        mkdirSync(translations, { recursive: true })
        writeFileSync(path.join(archive, "asset-2.1.0-1-00000001.zip"), writeZip([{ name: digestPath(masterAssetPath(table)),
            data: buildOrderedMap(rows.map(r => [r.key, [[r.ja, "", r.original]]] as [string, string[][]])).encode() }]))
        writeFileSync(path.join(dir, "i18n", "columns.json"), JSON.stringify({ version: 1, tables: { [table]: { translate: [2], reading: [] } } }))
        const shipped = JSON.parse(readFileSync(path.join("i18n", "en", "master", "string__ui_string.json"), "utf8"))
        const entries: Record<string, unknown> = {}
        for (const row of rows) {
            const entry = shipped[row.key]["2"]
            assert.equal(entry.srcHash, srcHash(row.original))
            assert.equal(entry.text, row.fixed)
            assert.equal(entry.placeholdersFrom, 0)
            entries[row.key] = { "2": entry }
        }
        writeFileSync(path.join(translations, "string__ui_string.json"), JSON.stringify(entries))
        const options = { lang: "en", i18nDir: path.join(dir, "i18n"), cdn, outDir: path.join(dir, "out"), limitsFile: null, glossaryFile: null }
        const built = buildOverlay(options)
        assert.deepEqual(built.manifest.report.errors, [])
        assert.deepEqual(built.manifest.report.stale, [])
        assert.equal(built.manifest.report.applied, 2)
        const bytes = readZip(path.join(built.dir, built.manifest.overlay!.file)).get(digestPath(masterAssetPath(table)))!
        const root = decodeOrderedMap(bytes)
        for (const row of rows) assert.equal(getCell(root, table, row.key, 2), row.fixed)
        for (const row of rows) delete (entries[row.key] as { "2": { placeholdersFrom?: number } })["2"].placeholdersFrom
        writeFileSync(path.join(translations, "string__ui_string.json"), JSON.stringify(entries))
        const refused = buildOverlay({ ...options, outDir: path.join(dir, "bad"), dryRun: true })
        assert.equal(refused.manifest.report.applied, 0)
        for (const row of rows) assert.ok(refused.manifest.report.errors.some(error => error.row === row.key && /placeholder/.test(error.reason)))
    } finally { rmSync(dir, { recursive: true, force: true }) }
})
