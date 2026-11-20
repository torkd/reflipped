import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";
import { buildOrderedMap, decodeOrderedMap, walkLeaves } from "../src/lib/orderedmap";
import { digestPath, masterAssetPath, readArchiveMember, readCentralDirectory } from "../src/lib/cdnIndex";
import { writeZip } from "../src/lib/zipWriter";
import { SCHEDULE_MASTER_TABLES } from "../src/lib/scheduleOverlay";
import type { AssetArchive } from "../src/lib/assetLayers";

let fastify: FastifyInstance
let cleanup: () => Promise<void>
before(async () => { ({ fastify, cleanup } = await createTestServer()) })
after(async () => { await cleanup?.() })

test("replacing a layer at the same path uses its new ZIP member index and preserves prior immutable URLs", async () => {
    const { scheduleArchive, resetScheduleAssetCache, scheduleArchivePath } = await import("../src/lib/scheduleAssets")
    resetScheduleAssetCache()
    const fixture = buildOrderedMap([["fixture", [["Original", "2024-01-01 09:00:00", "2024-01-02 09:00:00"]]]]).encode()
    const folder = path.join(process.env.CDN_DIR!, "en", "archive-common-full")
    mkdirSync(folder, { recursive: true })
    writeFileSync(path.join(folder, "asset-2.1.0-1-aabbccdd.zip"), writeZip(SCHEDULE_MASTER_TABLES.map(table => ({
        name: digestPath(masterAssetPath(table)), data: fixture
    }))))
    const mods = path.join(process.env.CDN_DIR!, "mods")
    mkdirSync(mods, { recursive: true })
    const master = digestPath(masterAssetPath("quest/event/story_event"))
    const file = path.join(mods, "editable-translation.zip")
    const writeLayer = (name: string, changedLayout: boolean): AssetArchive => {
        const data = writeZip([
            ...(changedLayout ? [{ name: "000-before-master", data: Buffer.alloc(8192, 42) }] : []),
            { name: master, data: buildOrderedMap([["fixture", [[name, "2024-01-01 09:00:00", "2024-01-02 09:00:00"]]]]).encode() }
        ])
        writeFileSync(file, data)
        return { location: "{$cdnAddress}/mods/editable-translation.zip", size: data.length,
            sha256: createHash("sha256").update(data).digest("base64") }
    }
    const title = (archive: AssetArchive): string => {
        const local = scheduleArchivePath(archive.location.split("/").at(-1)!)!
        const member = readCentralDirectory(local).find(entry => entry.name === master)!
        return [...walkLeaves(decodeOrderedMap(readArchiveMember(local, member)))][0].leaf.records[0][0]
    }
    const view = { identity: "layer-replacement-contract", projection: {
        sourceStart: Date.parse("2024-01-01T00:00:00Z"), targetStart: Date.parse("2026-11-01T00:00:00Z"),
        rate: 1, contentTime: Date.parse("2024-01-01T00:00:00Z")
    } }
    const build = (layer: AssetArchive) => scheduleArchive(view, "en", [layer], process.env.CDN_DIR!, process.env.CDN_OVERLAY_DIR!, "http://api.example")
    const original = build(writeLayer("Original translation", false))
    assert.equal(title(original), "Original translation")
    const updated = build(writeLayer("Updated translation", true))
    assert.equal(title(updated), "Updated translation")
    assert.notEqual(updated.location, original.location)
    assert.equal(title(original), "Original translation", "already advertised archives remain immutable")
})

test("a co-op abort preserves the round when its inner request fails", async () => {
    const { createTestPlayer, encodeGameBody, gameHeaders } = await import("./helpers")
    const rooms = await import("../src/lib/coop/rooms")
    const player = await createTestPlayer(fastify)
    const room = rooms.createRoom(player.viewerId, 1001001, 2)
    rooms.startRound(room, [player.viewerId])
    const request = (route: string, body: object = {}) => fastify.inject({ method: "POST", url: `/latest/api/index.php/multi_battle_quest/${route}`,
        headers: gameHeaders(player.udid), payload: encodeGameBody({ viewer_id: player.viewerId, api_count: 1, category: 2,
            quest_id: 1001001, room_number: room.roomNumber, party_id: 1, use_boost_point: false,
            use_boss_boost_point: false, is_auto_start_mode: false, ...body }) })
    const inject = fastify.inject
    try {
        const started = await request("start")
        assert.equal(started.statusCode, 200, started.body)
        let innerAborts = 0
        // Fail the server's inner request (for example a transient auth/store error) after the outer request has
        // authenticated. The public co-op abort must preserve and propagate that failure, rather than claim success.
        fastify.inject = ((...args: any[]) => {
            if (args[0]?.url?.endsWith("/single_battle_quest/abort")) {
                innerAborts++
                return Promise.resolve({ statusCode: 503, body: JSON.stringify({ error: "Service Unavailable" }) })
            }
            return (inject as (...args: any[]) => any).apply(fastify, args)
        }) as typeof fastify.inject
        const aborted = await request("abort")
        assert.equal(innerAborts, 1)
        assert.equal(aborted.statusCode, 503, aborted.body)
        assert.deepEqual(room.roundEndedViewerIds, [])
        fastify.inject = inject
        assert.equal((await request("abort")).statusCode, 200)
        assert.deepEqual(room.roundEndedViewerIds, [player.viewerId])
    } finally {
        fastify.inject = inject
        rooms.deleteRoom(room.roomNumber)
    }
})

for (const multi of [false, true]) test(`a stale ${multi ? "co-op" : "solo"} continue completes its fixed charge and defers refresh until settlement`, async () => {
    const { createTestPlayer, decodeGameBody, encodeGameBody, gameHeaders } = await import("./helpers")
    const data = await import("../src/data/wdfpData")
    const { getEventPolicy, setEventPolicy } = await import("../src/lib/eventPolicy")
    const { availableAssetVersion } = await import("../src/lib/assetLayers")
    const { hasActiveBattleQuest } = await import("../src/routes/api/singleBattleQuest")
    const rooms = await import("../src/lib/coop/rooms")
    const oldClock = process.env.SERVER_CLOCK
    const oldScheduling = process.env.EVENT_SCHEDULING
    const oldPolicy = getEventPolicy()
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    let roomNumber: string | undefined
    try {
        process.env.SERVER_CLOCK = "running"
        process.env.EVENT_SCHEDULING = "on"
        setEventPolicy({ ...oldPolicy, mode: "classic" })
        const request = (route: string, body: object = {}, version?: string) => {
            const headers = { ...gameHeaders(player.udid) }
            delete headers.res_ver
            if (version !== undefined) headers.res_ver = version
            return fastify.inject({ method: "POST",
                url: `/latest/api/index.php/${multi ? "multi" : "single"}_battle_quest/${route}`, headers,
                payload: encodeGameBody({ viewer_id: player.viewerId, api_count: 1, category: 1, quest_id: 1001002,
                    party_id: 1, ...(roomNumber === undefined ? {} : { room_number: roomNumber }), ...body }) })
        }
        if (multi) {
            const created = await request("create_room")
            assert.equal(created.statusCode, 200, created.body)
            roomNumber = decodeGameBody(created.body).data.room_number
            rooms.startRound(rooms.getRoom(roomNumber!)!, [player.viewerId])
        }
        const start = await request("start", { use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false })
        assert.equal(start.statusCode, 200, start.body)
        assert.equal(hasActiveBattleQuest(playerId, multi), true)
        const oldVersion = availableAssetVersion()
        setEventPolicy({ ...getEventPolicy(), mode: "accelerated" })
        data.updatePlayerSync({ id: playerId, freeVmoney: 100, vmoney: 0 })
        const continued = await request("play_continue", {}, oldVersion)
        assert.equal(continued.statusCode, 200, continued.body)
        const continuedBody = decodeGameBody(continued.body)
        assert.equal(continuedBody.data_headers.result_code, 1)
        assert.equal(continuedBody.data_headers.asset_update, false)
        assert.equal(data.getPlayerSync(playerId)!.freeVmoney, 50)
        assert.equal(hasActiveBattleQuest(playerId, multi), true)
        const finish = await request("finish", { score: 0, elapsed_time_ms: 10000, add_mana: 0, is_accomplished: true,
            statistics: { party: { characters: [{ id: 1 }], unison_characters: [] } } }, oldVersion)
        assert.equal(finish.statusCode, 200, finish.body)
        assert.equal(decodeGameBody(finish.body).data_headers.asset_update, true)
        assert.equal(hasActiveBattleQuest(playerId, multi), false)
        const after = data.getPlayerSync(playerId)!.freeVmoney
        const noBattle = await request("play_continue", {}, oldVersion)
        assert.equal(decodeGameBody(noBattle.body).data_headers.result_code, 214)
        assert.equal(data.getPlayerSync(playerId)!.freeVmoney, after)
    } finally {
        if (roomNumber) rooms.deleteRoom(roomNumber)
        setEventPolicy(oldPolicy)
        if (oldClock === undefined) delete process.env.SERVER_CLOCK; else process.env.SERVER_CLOCK = oldClock
        if (oldScheduling === undefined) delete process.env.EVENT_SCHEDULING; else process.env.EVENT_SCHEDULING = oldScheduling
    }
})
