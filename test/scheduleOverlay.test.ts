import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildOrderedMap, decodeOrderedMap, OrderedMapLeaf, walkLeaves } from "../src/lib/orderedmap";
import { digestPath, masterAssetPath, readArchiveMember, readCentralDirectory } from "../src/lib/cdnIndex";
import { buildScheduleOverlay, formatScheduleMasterDate, parseScheduleMasterDate, rebaseScheduleDateCell, SCHEDULE_MASTER_TABLES } from "../src/lib/scheduleOverlay";
import { writeZip } from "../src/lib/zipWriter";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute } from "./helpers";

const source = Date.parse("2024-01-01T00:00:00Z")
const target = Date.parse("2026-11-01T00:00:00Z")
const projection = { sourceStart: source, targetStart: target, rate: 2 }

test("master dates are strict JST values and date lists preserve optional entries", () => {
    assert.equal(parseScheduleMasterDate("2024-01-01 09:00:00"), source)
    assert.equal(parseScheduleMasterDate("2024-02-30 09:00:00"), null)
    assert.equal(parseScheduleMasterDate("January 1"), null)
    assert.equal(formatScheduleMasterDate(target), "2026-11-01 09:00:00")
    assert.deepEqual(rebaseScheduleDateCell("2024-01-01 09:00:00,(None),2024-01-02 09:00:00", projection), {
        value: "2026-11-01 09:00:00,(None),2026-11-01 21:00:00", dates: 2
    })
    assert.equal(rebaseScheduleDateCell("Available 2024-01-01 09:00:00", projection), null)
    assert.equal(rebaseScheduleDateCell("2024-01-01 09:00:00,invalid", projection), null)
    assert.throws(() => rebaseScheduleDateCell("2024-01-01 09:00:00", { ...projection, rate: 0 }), RangeError)
})

test("schedule overlays retain translated cells and all nested date periods", () => {
    const table = "quest/event/story_event"
    const raw = buildOrderedMap([["nested", buildOrderedMap([["1", [["Original", "2024-01-01 09:00:00", "(None),2024-01-02 09:00:00"]]]])]]).encode()
    const translated = buildOrderedMap([["nested", buildOrderedMap([["1", [["Translated title", "2024-01-01 09:00:00", "(None),2024-01-02 09:00:00"]]]])]]).encode()
    let readRaw = false
    const result = buildScheduleOverlay({
        readMaster() { readRaw = true; return raw },
        readLayerMember(member) { assert.equal(member, digestPath(masterAssetPath(table))); return translated }
    }, projection, [table])
    assert.equal(readRaw, false)
    assert.equal(result.files, 1)
    assert.equal(result.dateCells, 2)
    assert.equal(result.dates, 2)
    // The zip writer is separately shared with CDN overlays; inspect its one stored/deflate member.
    const localSize = result.archive.readUInt32LE(18)
    const start = 30 + result.archive.readUInt16LE(26) + result.archive.readUInt16LE(28)
    const { inflateRawSync } = require("node:zlib") as typeof import("node:zlib")
    const bytes = result.archive.subarray(start, start + localSize)
    const decoded = decodeOrderedMap(result.archive.readUInt16LE(8) === 8 ? inflateRawSync(bytes) : bytes)
    assert.deepEqual([...walkLeaves(decoded)][0].leaf.records[0], [
        "Translated title", "2026-11-01 09:00:00", "(None),2026-11-01 21:00:00"
    ])
    assert.deepEqual(buildScheduleOverlay({ readMaster: () => translated }, projection, [table]).archive, result.archive)
})

test("restoring schedule masters preserves effective layer bytes and missing masters fail closed", () => {
    const bytes = OrderedMapLeaf.fromRecords([["Translated", "2024-01-01 09:00:00"]]).encode()
    const restored = buildScheduleOverlay({ readMaster: () => bytes }, null, ["fixture/date"])
    assert.equal(restored.files, 1)
    assert.equal(restored.dates, 1)
    assert.throws(() => buildScheduleOverlay({ readMaster: () => undefined }, projection, ["missing/table"]), /local CDN/)
})

test("client final banner keeps its opening and extends only its closing", () => {
    const row = Array(45).fill("") as string[]
    row[1] = "Translated Spotlight Portal"
    row[29] = "2024-12-31 14:00:00"
    row[30] = "2025-01-07 13:59:59"
    const bytes = buildOrderedMap([["185", [row]]]).encode()
    const result = buildScheduleOverlay({ readMaster: () => bytes }, projection, ["gacha/gacha"])
    assert.equal(result.files, 1)
    const compressedSize = result.archive.readUInt32LE(18)
    const offset = 30 + result.archive.readUInt16LE(26) + result.archive.readUInt16LE(28)
    const { inflateRawSync } = require("node:zlib") as typeof import("node:zlib")
    const compressed = result.archive.subarray(offset, offset + compressedSize)
    const master = decodeOrderedMap(result.archive.readUInt16LE(8) === 8 ? inflateRawSync(compressed) : compressed)
    const actual = [...walkLeaves(master)][0].leaf.records[0]
    assert.equal(actual[29], rebaseScheduleDateCell(row[29], projection)!.value)
    assert.ok(parseScheduleMasterDate(actual[29])! > target, "future units stay unavailable in early periods")
    assert.equal(actual[30], "2199-12-31 23:59:59")
    // A plain restore must remove this explicit scheduling override as well.
    assert.notDeepEqual(result.archive, buildScheduleOverlay({ readMaster: () => bytes }, null, ["gacha/gacha"]).archive)
})

test("boss quests of rerun bosses open at the boss's first spotlight and stay open, other bosses keep their windows", () => {
    const row = (start: string, end: string) => { const r = Array(10).fill("") as string[]; r[5] = start; r[6] = end; return r }
    // Jade Queen (node 34: first spotlit 2024-02-29), Arch Guardian (32: its window covers its season), Viento Solas (1: permanent)
    const bytes = buildOrderedMap([["1", buildOrderedMap([
        ["34", buildOrderedMap([["1", [row("2024-05-28 14:00:00", "2024-07-25 14:59:59")]]])],
        ["32", buildOrderedMap([["1", [row("2023-09-27 14:00:00", "2023-10-10 20:59:59")]]])],
        ["1", buildOrderedMap([["1", [row("2001-08-28 00:00:00", "(None)")]]])]
    ])]]).encode()
    const result = buildScheduleOverlay({ readMaster: () => bytes }, projection, ["quest/boss_battle_quest"])
    const compressedSize = result.archive.readUInt32LE(18)
    const offset = 30 + result.archive.readUInt16LE(26) + result.archive.readUInt16LE(28)
    const { inflateRawSync } = require("node:zlib") as typeof import("node:zlib")
    const compressed = result.archive.subarray(offset, offset + compressedSize)
    const master = decodeOrderedMap(result.archive.readUInt16LE(8) === 8 ? inflateRawSync(compressed) : compressed)
    const byNode = new Map([...walkLeaves(master)].map(({ keys, leaf }) => [keys[1], leaf.records[0]]))
    const projected = (text: string) => rebaseScheduleDateCell(text, projection)!.value
    // the Queen opens at 2024-02-29 14:00 (JST) and has no end
    assert.equal(byNode.get("34")![5], projected("2024-02-29 14:00:00"))
    assert.equal(byNode.get("34")![6], "(None)")
    // a boss whose window covers its seasons, and a permanent one, only get the usual projection
    assert.equal(byNode.get("32")![5], projected("2023-09-27 14:00:00"))
    assert.equal(byNode.get("32")![6], projected("2023-10-10 20:59:59"))
    assert.equal(byNode.get("1")![6], "(None)")
    // restoring puts the master's own window back
    assert.notDeepEqual(result.archive, buildScheduleOverlay({ readMaster: () => bytes }, null, ["quest/boss_battle_quest"]).archive)
})

test("live asset views announce immutable API-host archives, preserve translations, and switch per-player", async () => {
    const server = await createTestServer()
    const previousClock = process.env.SERVER_CLOCK
    const previousScheduling = process.env.EVENT_SCHEDULING
    const previousScheduleDir = process.env.CDN_SCHEDULE_DIR
    const previousCacheBytes = process.env.SCHEDULE_ASSET_CACHE_BYTES
    try {
        const { scheduleOverlayRoot, scheduleArchive } = await import("../src/lib/scheduleAssets")
        delete process.env.CDN_SCHEDULE_DIR
        assert.equal(scheduleOverlayRoot(), path.join(process.env.DATABASE_DIR!, "schedule-assets"))
        process.env.CDN_SCHEDULE_DIR = path.join(process.env.CDN_DIR!, "generated-schedule")
        assert.throws(() => scheduleArchive({ identity: "empty-cdn", projection }, "en", [], process.env.CDN_DIR!,
            process.env.CDN_OVERLAY_DIR!, "http://api.example"), (error: unknown) => {
            const failure = error as Error & { statusCode?: number }
            return failure.statusCode === 503 && /requires master\/.+local CDN/.test(failure.message)
        })
        const fixture = buildOrderedMap([["fixture", [["Original", "2024-01-01 09:00:00", "2024-01-02 09:00:00"]]]]).encode()
        const folder = path.join(process.env.CDN_DIR!, "en", "archive-common-full")
        mkdirSync(folder, { recursive: true })
        writeFileSync(path.join(folder, "asset-2.1.0-1-aabbccdd.zip"), writeZip(SCHEDULE_MASTER_TABLES.map(table => ({
            name: digestPath(masterAssetPath(table)), data: fixture
        }))))
        const modDir = path.join(process.env.CDN_DIR!, "mods")
        mkdirSync(modDir)
        writeFileSync(path.join(modDir, "translation.zip"), writeZip([{
            name: digestPath(masterAssetPath("quest/event/story_event")),
            data: buildOrderedMap([["fixture", [["Mod title", "2024-01-01 09:00:00", "2024-01-02 09:00:00"]]]]).encode()
        }]))
        const translationDir = path.join(process.env.CDN_OVERLAY_DIR!, "en")
        mkdirSync(translationDir, { recursive: true })
        writeFileSync(path.join(translationDir, "i18n-en-fixture.zip"), writeZip([{
            name: digestPath(masterAssetPath("quest/event/story_event")),
            data: buildOrderedMap([["fixture", [["Translated", "2024-01-01 09:00:00", "2024-01-02 09:00:00"]]]]).encode()
        }]))
        writeFileSync(path.join(translationDir, "manifest.json"), JSON.stringify({ overlay: { file: "i18n-en-fixture.zip" } }))
        const player = await createTestPlayer(server.fastify)
        const { resetAssetLayers, getAssetLayers, availableAssetVersion, allocateAssetViewVersion } = await import("../src/lib/assetLayers")
        const { setEventPolicy } = await import("../src/lib/eventPolicy")
        const { getEventScheduleView, runOnEventView } = await import("../src/lib/eventSchedule")
        const { resetScheduleAssetCache } = await import("../src/lib/scheduleAssets")
        const { getSession } = await import("../src/data/wdfpData")
        const { setAccountClockSync } = await import("../src/data/accountClocks")
        process.env.SERVER_CLOCK = "running"
        process.env.EVENT_SCHEDULING = "on"
        setEventPolicy({ version: 1, mode: "time-travel", anchor: Date.now(), acceleration: 2, adminTimeTravel: false })
        resetAssetLayers()
        resetScheduleAssetCache()
        const headers = { ...gameHeaders(player.udid), host: "api.example:8000", res_ver: "2.1.125" }
        const getPath = async (head = headers) => {
            const response = await server.fastify.inject({ method: "POST", url: "/latest/api/index.php/asset/get_path",
                headers: head, payload: encodeGameBody({ viewer_id: player.viewerId, target_asset_version: "2.1.125" }) })
            assert.equal(response.statusCode, 200, response.body)
            return decodeGameBody(response.body).data
        }
        const paths = await getPath()
        const version = paths.info.target_asset_version
        assert.equal(version, availableAssetVersion())
        assert.equal(availableAssetVersion(), availableAssetVersion())
        const archive = paths.full.archive.at(-1)
        assert.match(archive.location, /^http:\/\/api\.example:8000\/patch\/Live\/2\.0\.0\/schedule\/[0-9a-f]{64}\.zip$/)
        const download = await server.fastify.inject({ method: "GET", url: new URL(archive.location).pathname })
        assert.equal(download.statusCode, 200)
        assert.match(download.headers["cache-control"]!, /immutable/)
        const file = path.join(process.env.CDN_SCHEDULE_DIR!, new URL(archive.location).pathname.split("/").at(-1)!)
        const entry = readCentralDirectory(file).find(member => member.name === digestPath(masterAssetPath("quest/event/story_event")))!
        const record = [...walkLeaves(decodeOrderedMap(readArchiveMember(file, entry)))][0].leaf.records[0]
        assert.equal(record[0], "Translated")
        const view = getEventScheduleView()
        assert.equal(record[1], formatScheduleMasterDate(view.targetStart + (source - view.sourceStart) / view.rate))
        const snapshot = readFileSync(file)
        const session = await getSession(String(player.viewerId))
        assert.ok(session)
        setAccountClockSync(session.accountId, { offsetDays: 5, era: 0 })
        const traveled = await getPath()
        assert.notEqual(traveled.info.target_asset_version, version)
        assert.notEqual(traveled.full.archive.at(-1).location, archive.location)
        assert.deepEqual(readFileSync(file), snapshot)
        assert.equal(traveled.info.target_asset_version, runOnEventView(5, availableAssetVersion))
        // The exact same view stays valid across process cache resets, not just repeat requests.
        resetScheduleAssetCache()
        resetAssetLayers()
        assert.equal((await getPath()).info.target_asset_version, traveled.info.target_asset_version)
        const traveledFile = path.join(process.env.CDN_SCHEDULE_DIR!, new URL(traveled.full.archive.at(-1).location).pathname.split("/").at(-1)!)
        const traveledBytes = readFileSync(traveledFile)
        // An evicted file must invalidate its persisted/in-memory metadata and rebuild identical bytes.
        unlinkSync(traveledFile)
        assert.equal((await getPath()).full.archive.at(-1).location, traveled.full.archive.at(-1).location)
        assert.deepEqual(readFileSync(traveledFile), traveledBytes)
        process.env.SCHEDULE_ASSET_CACHE_BYTES = "1"
        setAccountClockSync(session.accountId, { offsetDays: 6, era: 0 })
        const capacity = await server.fastify.inject({ method: "POST", url: "/latest/api/index.php/asset/get_path", headers,
            payload: encodeGameBody({ viewer_id: player.viewerId, target_asset_version: "2.1.125" }) })
        assert.equal(capacity.statusCode, 503)
        const stillAvailable = await server.fastify.inject({ method: "GET", url: new URL(archive.location).pathname })
        assert.equal(stillAvailable.statusCode, 200)
        delete process.env.SCHEDULE_ASSET_CACHE_BYTES
        setAccountClockSync(session.accountId, { offsetDays: 5, era: 0 })
        const initialHeaders: Record<string, string> = { ...headers }
        delete initialHeaders.res_ver
        const initial = await getPath(initialHeaders as typeof headers)
        assert.equal(initial.info.target_asset_version, traveled.info.target_asset_version)
        assert.equal(initial.diff.at(-1).version, traveled.info.target_asset_version)
        assert.match(initial.diff.at(-1).archive.at(-1).location, /\/schedule\//)
        const recovery = await getPath({ ...headers, res_ver: traveled.info.target_asset_version })
        assert.match(recovery.diff.at(-1).archive.at(-1).location, /\/schedule\//)
        const load = await server.fastify.inject({ method: "POST", url: "/latest/api/index.php/load", headers,
            payload: encodeGameBody({ ...readCapturedRoute("load").requestBody, viewer_id: player.viewerId, access_token: player.zat }) })
        assert.equal(load.statusCode, 200)
        assert.equal(decodeGameBody(load.body).data.available_asset_version, traveled.info.target_asset_version)
        const { getPlayerFromAccountIdSync, getPlayerSync, getPlayerSingleQuestProgressSync } = await import("../src/data/wdfpData")
        const ownedPlayer = getPlayerFromAccountIdSync(session.accountId)!
        const originalComment = getPlayerSync(ownedPlayer.id)!.comment
        const staleWrite = await server.fastify.inject({ method: "POST", url: "/latest/api/index.php/profile/update_comment", headers,
            payload: encodeGameBody({ viewer_id: player.viewerId, api_count: 91, comment: "stale view write" }) })
        assert.equal(staleWrite.statusCode, 200)
        assert.equal(decodeGameBody(staleWrite.body).data_headers.result_code, 214)
        assert.equal(getPlayerSync(ownedPlayer.id)!.comment, originalComment)
        const freshHeaders = { ...headers, res_ver: traveled.info.target_asset_version }
        const freshWrite = await server.fastify.inject({ method: "POST", url: "/latest/api/index.php/profile/update_comment", headers: freshHeaders,
            payload: encodeGameBody({ viewer_id: player.viewerId, api_count: 92, comment: "current view write" }) })
        assert.equal(decodeGameBody(freshWrite.body).data_headers.result_code, 1)
        assert.equal(getPlayerSync(ownedPlayer.id)!.comment, "current view write")
        // Settlements must commit before the client returns to title, even if its view changed mid-battle.
        const story = await server.fastify.inject({ method: "POST", url: "/latest/api/index.php/story_quest/finish", headers,
            payload: encodeGameBody({ viewer_id: player.viewerId, api_count: 93, quest_id: 1001001, category: 1, party_id: 1 }) })
        assert.equal(story.statusCode, 200, story.body)
        assert.equal(decodeGameBody(story.body).data_headers.result_code, 1)
        assert.equal(decodeGameBody(story.body).data_headers.asset_update, true)
        assert.equal(getPlayerSingleQuestProgressSync(ownedPlayer.id, 1, 1001001)?.finished, true)
        const invalidStory = await server.fastify.inject({ method: "POST", url: "/latest/api/index.php/story_quest/finish", headers,
            payload: encodeGameBody({ viewer_id: player.viewerId, api_count: 94, quest_id: -1, category: 1, party_id: 1 }) })
        assert.equal(invalidStory.statusCode, 400)
        // Disabling scheduling sends an effective-original restore, removing prior rebased files.
        process.env.EVENT_SCHEDULING = "off"
        const restored = await getPath()
        assert.notEqual(restored.info.target_asset_version, traveled.info.target_asset_version)
        assert.match(restored.full.archive.at(-1).location, /\/schedule\//)
        const restoreFile = path.join(process.env.CDN_SCHEDULE_DIR!, new URL(restored.full.archive.at(-1).location).pathname.split("/").at(-1)!)
        const restoreEntry = readCentralDirectory(restoreFile).find(member => member.name === digestPath(masterAssetPath("quest/event/story_event")))!
        assert.deepEqual([...walkLeaves(decodeOrderedMap(readArchiveMember(restoreFile, restoreEntry)))][0].leaf.records[0],
            ["Translated", "2024-01-01 09:00:00", "2024-01-02 09:00:00"])
        // A reserved view version cannot be re-used by a later unrelated layer update.
        const reserved = allocateAssetViewVersion("other-view")
        assert.notEqual(reserved, traveled.info.target_asset_version)
        writeFileSync(path.join(modDir, "additional.zip"), writeZip([{ name: "fixture-extra", data: Buffer.from("another mod") }]))
        resetAssetLayers()
        assert.ok(getAssetLayers().version > Number(reserved.split(".").at(-1)))
    } finally {
        process.env.SERVER_CLOCK = previousClock
        if (previousScheduling === undefined) delete process.env.EVENT_SCHEDULING
        else process.env.EVENT_SCHEDULING = previousScheduling
        if (previousScheduleDir === undefined) delete process.env.CDN_SCHEDULE_DIR
        else process.env.CDN_SCHEDULE_DIR = previousScheduleDir
        if (previousCacheBytes === undefined) delete process.env.SCHEDULE_ASSET_CACHE_BYTES
        else process.env.SCHEDULE_ASSET_CACHE_BYTES = previousCacheBytes
        await server.cleanup()
    }
})
