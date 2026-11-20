import { after, before, describe, test } from "node:test";
import { spawnSync } from "child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import type { FastifyInstance } from "fastify";
import { digestPath, masterAssetPath } from "../src/lib/cdnIndex";
import { buildOrderedMap, decodeOrderedMap } from "../src/lib/orderedmap";
import { writeZip } from "../src/lib/zipWriter";
import { getCell, srcHash } from "../src/i18n/cells";
import { buildOverlay } from "../src/i18n/overlay";
import { checkTranslation, placeholdersOf } from "../src/lib/i18n/checker";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";
import { readZip } from "./overlayFixtures";

// FIX-6: the melt completion text ("… has been melted down. You have obtained N Wrightpieces.") showed the copies
// melted, not the Wrightpieces gained. The client fills the text's ::mana:: with its Wrightpiece count after the reply
// minus before (EquipmentSellResultDialog), and the server's totals are right; the original English text of
// `equipment_list_sold_complete_message` used ::number:: (the copies) where every other language uses ::mana::. The
// translation overlay fixes the text, checking its placeholders against another column (`placeholdersFrom`).

const UI_STRING = "string/ui_string"
const ROW = "melt_message"
// made-up rows: column 1 has the right placeholders, column 2 (the shipped one) a slip
const RIGHT = "::name:: x::number:: melted, ::mana:: gained"
const SLIP = "::name:: x::number:: melted, ::number:: gained"
const FIXED = "::name:: x::number:: melted, ::mana:: gained."

describe("the checker's placeholderSource", () => {
    test("without it, a text that fixes the source's placeholders is refused", () => {
        const rules = checkTranslation(SLIP, FIXED).filter(i => i.severity === "error").map(i => i.message)
        assert.ok(rules.some(m => /::mana:: is not in the source/.test(m)))
    })

    test("with it, placeholders are compared with the other text, and a slip there is still caught", () => {
        assert.deepEqual(checkTranslation(SLIP, FIXED, { placeholderSource: RIGHT }).filter(i => i.severity === "error"), [])
        const lost = checkTranslation(SLIP, "::name:: melted, ::mana:: gained.", { placeholderSource: RIGHT })
        assert.ok(lost.some(i => i.severity === "error" && /::number:: is missing/.test(i.message)))
    })

    test("conditional blocks follow the same text", () => {
        const source = "::if a::x::end::"
        assert.ok(checkTranslation(source, "y", { placeholderSource: "y" }).every(i => i.severity !== "error"))
        assert.ok(checkTranslation(source, "y").some(i => i.rule === "conditional"))
    })
})

describe("the overlay build's placeholdersFrom", () => {
    let dir: string
    let cdnDir: string
    let region: string
    let runs = 0

    before(() => {
        dir = mkdtempSync(path.join(os.tmpdir(), "reflipped-fix6-"))
        cdnDir = path.join(dir, "cdn")
        region = path.join(cdnDir, "en")
        const common = path.join(region, "archive-common-full")
        mkdirSync(common, { recursive: true })
        writeFileSync(path.join(common, "asset-2.1.0-1-00000001.zip"), writeZip([
            { name: digestPath(masterAssetPath(UI_STRING)), data: buildOrderedMap([[ROW, [[ROW, RIGHT, SLIP, "", ""]]]]).encode() }
        ]))
    })

    after(() => rmSync(dir, { recursive: true, force: true }))

    function build(entry: Record<string, unknown>) {
        const i18nDir = path.join(dir, `i18n-${++runs}`)
        mkdirSync(path.join(i18nDir, "en", "master"), { recursive: true })
        writeFileSync(path.join(i18nDir, "columns.json"), JSON.stringify({ version: 1, tables: { [UI_STRING]: { translate: [2], reading: [] } } }))
        writeFileSync(path.join(i18nDir, "en", "master", "string__ui_string.json"), JSON.stringify({ [ROW]: { "2": entry } }))
        return buildOverlay({ lang: "en", i18nDir, cdn: region, cdnDir, outDir: path.join(dir, `out-${runs}`), limitsFile: null, glossaryFile: null, dryRun: true })
    }

    const base = { srcHash: srcHash(SLIP), text: FIXED, status: "machine" }

    test("an entry fixing a placeholder slip ships when it names the column with the right placeholders", () => {
        const { manifest } = build({ ...base, placeholdersFrom: 1 })
        assert.deepEqual(manifest.report.errors, [])
        assert.equal(manifest.report.applied, 1)
    })

    test("it's refused without placeholdersFrom, or when the column isn't in the row", () => {
        assert.ok(build(base).manifest.report.errors.some(e => /placeholder/.test(e.reason)))
        assert.ok(build({ ...base, placeholdersFrom: 9 }).manifest.report.errors.some(e => /placeholdersFrom/.test(e.reason)))
        assert.ok(build({ ...base, placeholdersFrom: "1" }).manifest.report.errors.some(e => /placeholdersFrom/.test(e.reason)))
    })

    test("it still catches a dropped or misspelled placeholder, and refuses a value that isn't a column", () => {
        for (const text of ["::name:: melted, ::mana:: gained.", "::name:: x::number:: melted, ::manna:: gained."]) {
            const { manifest } = build({ ...base, text, placeholdersFrom: 1 })
            assert.equal(manifest.report.applied, 0)
            assert.ok(manifest.report.errors.some(e => /placeholder/.test(e.reason)), text)
        }
        for (const placeholdersFrom of [null, -1, 1.5, 9]) {
            const { manifest } = build({ ...base, placeholdersFrom })
            assert.equal(manifest.report.applied, 0, String(placeholdersFrom))
            assert.ok(manifest.report.errors.some(e => /placeholdersFrom/.test(e.reason)), String(placeholdersFrom))
        }
    })

    test("the shipped text is the fixed one", () => {
        const i18nDir = path.join(dir, `i18n-${++runs}`)
        mkdirSync(path.join(i18nDir, "en", "master"), { recursive: true })
        writeFileSync(path.join(i18nDir, "columns.json"), JSON.stringify({ version: 1, tables: { [UI_STRING]: { translate: [2], reading: [] } } }))
        writeFileSync(path.join(i18nDir, "en", "master", "string__ui_string.json"), JSON.stringify({ [ROW]: { "2": { ...base, placeholdersFrom: 1 } } }))
        const result = buildOverlay({ lang: "en", i18nDir, cdn: region, cdnDir, outDir: path.join(dir, `out-${runs}`), limitsFile: null, glossaryFile: null })
        assert.ok(result.manifest.overlay)
        const overlay = readZip(path.join(result.dir, result.manifest.overlay!.file))
        const table = decodeOrderedMap(overlay.get(digestPath(masterAssetPath(UI_STRING)))!)
        assert.equal(getCell(table, UI_STRING, ROW, 2), FIXED)
    })
})

describe("npm run i18n:check with placeholdersFrom", () => {
    let dir: string
    before(() => {
        dir = mkdtempSync(path.join(os.tmpdir(), "reflipped-fix6-cli-"))
        mkdirSync(path.join(dir, "dump", "string"), { recursive: true })
        writeFileSync(path.join(dir, "dump", "string", "ui_string.json"), JSON.stringify({ [ROW]: [RIGHT, "", SLIP] }))
    })
    after(() => rmSync(dir, { recursive: true, force: true }))

    // the checker's exit code and output for one entry of the made-up row
    function check(entry: Record<string, unknown>) {
        const entries = path.join(dir, "entries")
        mkdirSync(entries, { recursive: true })
        writeFileSync(path.join(entries, "string__ui_string.json"), JSON.stringify({ [ROW]: { "2": { srcHash: srcHash(SLIP), status: "machine", ...entry } } }))
        const result = spawnSync(process.execPath, ["--import", "tsx", "src/lib/i18n/cli.ts", "check", "--dir", entries, "--master", path.join(dir, "dump"), "--quiet"],
            { cwd: path.join(__dirname, ".."), encoding: "utf8" })
        return { code: result.status, out: result.stdout + result.stderr }
    }

    test("the right text passes only with placeholdersFrom", () => {
        assert.equal(check({ text: FIXED }).code, 1)
        const ok = check({ text: FIXED, placeholdersFrom: 0 })
        assert.equal(ok.code, 0, ok.out)
    })

    test("a dropped placeholder still fails", () => {
        const bad = check({ text: "::name:: melted, ::mana:: gained.", placeholdersFrom: 0 })
        assert.equal(bad.code, 1)
        assert.match(bad.out, /::number:: is missing/)
    })

    test("a column that isn't in the row fails instead of skipping the placeholder check", () => {
        for (const placeholdersFrom of [7, -1, "0", null]) {
            const bad = check({ text: FIXED, placeholdersFrom })
            assert.equal(bad.code, 1, String(placeholdersFrom))
            assert.match(bad.out, /placeholdersFrom is not a column/)
        }
    })
})

describe("the repository's entry for the melt text", () => {
    // the original English text, as the 2.1.x master holds it
    const ORIGINAL_EN = "::name:: x::number:: has been melted down. You have obtained ::number:: Wrightpieces."
    const table = JSON.parse(readFileSync(path.join(__dirname, "..", "i18n", "en", "master", "string__ui_string.json"), "utf8"))
    const entry = table.equipment_list_sold_complete_message["2"]

    test("it replaces the original English text and shows the Wrightpieces gained", () => {
        assert.equal(entry.srcHash, srcHash(ORIGINAL_EN))
        assert.deepEqual(placeholdersOf(entry.text).sort(), ["::mana::", "::name::", "::number::"])
        assert.equal(entry.placeholdersFrom, 0, "placeholders checked against the Japanese column, which uses ::mana::")
    })
})

describe("melt replies: the Wrightpiece total the client takes the gain from", () => {
    const apiPrefix = "/latest/api/index.php"
    const WRIGHTPIECE = 100000
    const TWO_STAR = 2010002 // Uninscribed Longsword, 2★: 2 Wrightpieces a copy (the device case)
    let fastify: FastifyInstance
    let cleanup: () => Promise<void>
    let data: typeof import("../src/data/wdfpData")

    before(async () => {
        ({ fastify, cleanup } = await createTestServer())
        data = await import("../src/data/wdfpData")
    })

    after(async () => {
        await cleanup()
    })

    async function signUp(): Promise<TestPlayer & { playerId: number }> {
        const player = await createTestPlayer(fastify)
        return { ...player, playerId: data.getViewerPlayerIdSync(player.viewerId)! }
    }

    async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
        const response = await fastify.inject({
            method: "POST",
            url: `${apiPrefix}/${route}`,
            headers: gameHeaders(player.udid),
            payload: encodeGameBody({ viewer_id: player.viewerId, ...body })
        })
        assert.equal(response.statusCode, 200, response.body)
        return decodeGameBody(response.body)
    }

    function setUp(playerId: number, stack: number) {
        if (data.getPlayerItemSync(playerId, WRIGHTPIECE) === null) data.givePlayerItemSync(playerId, WRIGHTPIECE, 49829)
        else data.updatePlayerItemSync(playerId, WRIGHTPIECE, 49829)
        data.insertPlayerEquipmentSync(playerId, TWO_STAR, { level: 1, enhancementLevel: 0, stack, protection: false })
    }

    test("melting the 2★ armament itself sends 49,831 (+2), not +1", async () => {
        const p = await signUp()
        setUp(p.playerId, 0)
        const body = await post(p, "equipment/sell_equipment", { equipment_list: [{ equipment_id: TWO_STAR }], api_count: 1 })
        assert.equal(body.data.item_list[WRIGHTPIECE], 49831)
    })

    test("melting one duplicate sends +2, and three duplicates +6", async () => {
        const p = await signUp()
        setUp(p.playerId, 4)
        const one = await post(p, "equipment/sell_stack", { equipment_list: [{ equipment_id: TWO_STAR, number: 1 }], api_count: 1 })
        assert.equal(one.data.item_list[WRIGHTPIECE], 49831)
        const three = await post(p, "equipment/sell_stack", { equipment_list: [{ equipment_id: TWO_STAR, number: 3 }], api_count: 2 })
        assert.equal(three.data.item_list[WRIGHTPIECE], 49837)
    })
})
