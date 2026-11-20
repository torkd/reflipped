import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, encodeGameBody, gameHeaders, type TestPlayer } from "./helpers";
import activeAssets from "../assets/active_mission.json";

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let missions: typeof import("../src/lib/missions")
let clock: typeof import("../src/utils")
let db: ReturnType<typeof import("../src/data").default>
const NOW = new Date("2025-01-03T12:00:00Z")

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    missions = await import("../src/lib/missions")
    clock = await import("../src/utils")
    db = (await import("../src/data")).default(0)
    clock.setServerTime(NOW)
})
after(async () => { await cleanup?.() })

async function newPlayer() {
    clock.setServerTime(NOW)
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    return { ...player, id: (await data.getAccountPlayers(session!.accountId))[0] }
}
function fillBox(id: number) {
    db.transaction(() => {
        for (let i = data.getPlayerReceivableMailCountSync(id, NOW); i < 1000; i++) data.insertPlayerMailSync(id, {
            type: 8, typeId: null, number: 1, reasonId: 0, subject: "Filler", description: "",
            createTime: NOW, receiveTime: null, rewardLimitTime: null
        })
    })()
}
function freeSlot(id: number) {
    const mail = data.getPlayerReceivableMailListSync(id, NOW, 0, 1)[0]
    data.setPlayerMailReceivedSync(id, mail.id, NOW)
}
function solo(id: number, amount: number) {
    return missions.updateMissionsSync(id, NOW, [{ pattern: missions.MissionPattern.SINGLE_BATTLE_CLEAR_COUNT, amount, matches: mission => missions.missionMatchesQuest(mission, 1, 1001002) }])
}

test("a reached stage retries delivery without another increment", async () => {
    const { id } = await newPlayer()
    fillBox(id)
    solo(id, 3)
    assert.equal(data.getPlayerMissionsSync(id, 2).find(row => row.missionId === 6)!.clearedStage, 0)
    freeSlot(id)
    const result = missions.updateMissionsSync(id, NOW, [])
    assert.ok(result.missionInfo.some(info => info.mission_category_id === 2 && info.mission_id === 6))
    assert.equal(data.getPlayerMissionsSync(id, 2).find(row => row.missionId === 6)!.progress, 3)
})

test("a full gift box preserves multiple days' earned rewards across resets", async () => {
    const { id } = await newPlayer()
    fillBox(id)
    solo(id, 3)
    missions.resetDailyMissionsSync(id)
    solo(id, 3)
    missions.resetDailyMissionsSync(id)
    assert.equal(data.getPlayerMissionRewardBacklogSync(id).length, 2)
    freeSlot(id)
    missions.updateMissionsSync(id, new Date("2025-02-01T12:00:00Z"), [])
    assert.equal(data.getPlayerMissionRewardBacklogSync(id).length, 1)
    freeSlot(id)
    missions.updateMissionsSync(id, new Date("2025-02-02T12:00:00Z"), [])
    assert.equal(data.getPlayerMissionRewardBacklogSync(id).length, 0)
    assert.equal(missions.updateMissionsSync(id, NOW, []).missionInfo.length, 0)
})

test("reset preserves the all-objectives reward when its prerequisite rewards are also blocked", async () => {
    const { id } = await newPlayer()
    fillBox(id)
    for (const missionId of [6, 7, 8, 9]) {
        const target = missions.getMission(2, missionId)!.stages[0].target
        data.setPlayerMissionSync(id, 2, { missionId, progress: target, clearedStage: 0 })
    }
    missions.resetDailyMissionsSync(id)
    assert.deepEqual(data.getPlayerMissionRewardBacklogSync(id).map(row => row.missionId).sort((a, b) => a - b), [6, 7, 8, 9, 10])
})

test("enable deadlines include their entire last second and display tails do not earn progress", () => {
    const mission: import("../src/lib/missions").Mission = {
        pattern: 0, startDate: "2025-01-01 00:00:00", endDate: "2025-01-03 13:00:00",
        showEndDate: "2025-01-05 00:00:00", stages: []
    }
    assert.equal(missions.isMissionOpen(mission, new Date("2025-01-03T04:00:00.999Z")), true)
    assert.equal(missions.isMissionOpen(mission, new Date("2025-01-03T04:00:01Z")), false)
    assert.equal(missions.isMissionVisible(mission, new Date("2025-01-04T00:00:00Z")), true)
})

test("future Step Up tasks count, but their claim waits for earlier phase objectives, not rewards", async () => {
    const { id } = await newPlayer()
    data.setPlayerActiveMissionProgressSync(id, 12030, 40)
    data.setPlayerActiveMissionStageSync(id, 12030, 1, false)
    assert.equal(missions.receiveActiveMissionsSync(id, [{ missionId: 12030, stages: [1] }], NOW)!.activeMissions.length, 0)
    for (const [missionId, mission] of Object.entries(activeAssets)) {
        if (mission.phase === 1) data.setPlayerActiveMissionProgressSync(id, Number(missionId), mission.stages.at(-1)!.target)
    }
    const result = missions.receiveActiveMissionsSync(id, [{ missionId: 12030, stages: [1, 1] }], NOW)!
    assert.equal(result.activeMissions.length, 1)
    assert.equal(result.activeMissions[0].stages.length, 1)
})

test("client interaction reports retain batched counts and ignore forged server patterns", async () => {
    const { id } = await newPlayer()
    const update = missions.clientReportedUpdate("home_tap_town_character_count", 8)!
    assert.equal("amount" in update && update.amount, 8)
    assert.equal(missions.clientReportedUpdate("single_battle_clear_count", 10000), null)
    const result = missions.updateMissionsSync(id, NOW, [update])
    assert.ok(result.missionInfo.length > 0)
    assert.equal(missions.clientReportedUpdate("twitter_check", Infinity), null)
})

test("unit mission levels use the exact EXP curve for each rarity", () => {
    for (const [rarity, threshold] of [[3, 125223], [4, 139190], [5, 153988]]) {
        assert.equal(missions.characterLevel(threshold - 1, rarity), 79)
        assert.equal(missions.characterLevel(threshold, rarity), 80)
    }
    assert.equal(missions.characterLevel(125223, 5) < 80, true)
})

test("boss missions use authoritative difficulty ranks, including nonstandard quest suffixes", async () => {
    for (const [missionId, correctQuest] of [[12090, 1002001], [13080, 1002002], [14040, 1002003]]) {
        const { id } = await newPlayer()
        const mission = activeAssets[String(missionId) as keyof typeof activeAssets]
        assert.equal(missions.missionMatchesQuest(mission, 2, correctQuest), true)
        assert.equal(missions.missionMatchesQuest(mission, 2, 1002004), false)
        assert.equal(missions.missionMatchesQuest(mission, 1, 1002001), false)
        const clear = (questId: number) => missions.updateMissionsSync(id, NOW, missions.battleClearUpdates(id, {
            category: 2, questId, multi: null, clearRank: 5, clearTimeMs: 10000,
            score: 0, fieldMana: 0, statistics: {}
        }, 1))
        clear(1002004)
        assert.equal(data.getPlayerActiveMissionsSync(id)[String(missionId)]?.progress ?? 0, 0)
        clear(correctQuest)
        assert.equal(data.getPlayerActiveMissionsSync(id)[String(missionId)].progress, 1)
    }
    assert.equal(missions.missionMatchesQuest(activeAssets["14040"], 2, 1006004), true)
    assert.equal(missions.missionMatchesQuest(activeAssets["14040"], 2, 1006003), false)
    assert.equal(missions.missionMatchesQuest(activeAssets["14040"], 2, 99999999), false)
})

test("resource acquisition counts granted deltas, filters item ids and never recounts inventory", async () => {
    const { id } = await newPlayer()
    data.givePlayerItemSync(id, 100000, 200)
    const before = missions.missionResourcesSync(id)
    data.givePlayerItemSync(id, 100000, 3)
    data.givePlayerItemSync(id, 101, 10)
    data.updatePlayerSync({ id, freeMana: data.getPlayerSync(id)!.freeMana + 100 })
    missions.updateMissionsSync(id, NOW, missions.resourceMissionUpdatesSync(id, before))
    assert.equal(data.getPlayerMissionsSync(id, 1).find(row => row.missionId === 66)!.progress, 3)
    assert.equal(data.getPlayerMissionsSync(id, 1).find(row => row.missionId === 40)!.progress, 100)
    missions.updateMissionsSync(id, NOW, missions.collectionUpdatesSync(id))
    assert.equal(data.getPlayerMissionsSync(id, 1).find(row => row.missionId === 66)!.progress, 3)
})

test("an old save cannot erase progress, reopen a claim, discard pending rewards or rerun today's login", async () => {
    const { id } = await newPlayer()
    const exported = await admin.inject({ method: "GET", url: `/api/player/save?id=${id}` })
    assert.equal(exported.statusCode, 200)
    data.setPlayerResetsSync(id, { day: "2025-01-03", month: "2025-01" })
    data.setPlayerActiveMissionProgressSync(id, 11090, 1)
    data.setPlayerActiveMissionStageSync(id, 11090, 1, true)
    solo(id, 1)
    data.insertPlayerMissionRewardBacklogSync(id, 2, 6, 1)
    const boundary = "mission-hardening-save"
    const imported = await admin.inject({
        method: "POST", url: `/api/player/save?id=${id}`,
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: `--${boundary}\r\nContent-Disposition: form-data; name="save-data"; filename="save.json"\r\nContent-Type: application/json\r\n\r\n${exported.body}\r\n--${boundary}--\r\n`
    })
    assert.equal(imported.statusCode, 302)
    assert.equal(imported.headers.location, `/player/${id}?message=save-imported`)
    assert.equal((data.getPlayerActiveMissionsSync(id)["11090"].stages as Record<string, boolean>)["1"], true)
    assert.equal(data.getPlayerMissionsSync(id, 1).find(row => row.missionId === 6)!.progress, 1)
    assert.equal(data.getPlayerMissionRewardBacklogSync(id).length, 1)
    assert.equal(data.getPlayerResetsSync(id)?.day, "2025-01-03")
})

async function battleRequest(player: TestPlayer, route: string, multi = false, extra: Record<string, unknown> = {}) {
    return fastify.inject({ method: "POST", url: `/latest/api/index.php/${multi ? "multi" : "single"}_battle_quest/${route}`,
        headers: gameHeaders(player.udid), payload: encodeGameBody({ viewer_id: player.viewerId, api_count: 1,
            quest_id: 1001002, category: 1, party_id: 1, use_boost_point: false, use_boss_boost_point: false,
            is_auto_start_mode: false, score: 100, elapsed_time_ms: 10000, add_mana: 0, is_accomplished: true,
            statistics: { party: { characters: [{ id: 1 }], unison_characters: [] } }, ...extra }) })
}

for (const multi of [false, true]) test(`failed ${multi ? "co-op" : "solo"} mission delivery rolls back and leaves a retryable battle`, async () => {
    const player = await newPlayer()
    const rooms = await import("../src/lib/coop/rooms")
    const room = multi ? rooms.createRoom(player.viewerId, 1001002, 1) : null
    if (room) rooms.startRound(room, [player.viewerId])
    const extra = room ? { room_number: room.roomNumber } : {}
    assert.equal((await battleRequest(player, "start", multi, extra)).statusCode, 200)
    data.setPlayerMissionSync(player.id, 2, { missionId: 6, progress: 2, clearedStage: 0 })
    // The mana-acquisition mission reaches its first reward on the co-op clear.
    if (multi) data.setPlayerMissionSync(player.id, 1, { missionId: 40, progress: 9999, clearedStage: 0 })
    db.exec(`CREATE TEMP TRIGGER mission_hardening_failure BEFORE INSERT ON players_mail WHEN NEW.player_id = ${player.id} BEGIN SELECT RAISE(ABORT, 'forced delivery failure'); END`)
    try {
        assert.equal((await battleRequest(player, "finish", multi)).statusCode, 500)
    } finally { db.exec("DROP TRIGGER mission_hardening_failure") }
    assert.equal(data.getPlayerMissionsSync(player.id, 2).find(row => row.missionId === 6)!.progress, 2)
    if (room) assert.deepEqual(room.roundEndedViewerIds, [])
    assert.equal((await battleRequest(player, "finish", multi)).statusCode, 200)
    if (room) {
        assert.deepEqual(room.roundEndedViewerIds, [player.viewerId])
        rooms.deleteRoom(room.roomNumber)
    }
})

for (const multi of [false, true]) test(`a ${multi ? "co-op" : "solo"} COMMIT failure sends 500 and preserves the battle for retry`, async () => {
    const player = await newPlayer()
    const rooms = await import("../src/lib/coop/rooms")
    const room = multi ? rooms.createRoom(player.viewerId, 1001002, 1) : null
    if (room) rooms.startRound(room, [player.viewerId])
    const extra = room ? { room_number: room.roomNumber } : {}
    assert.equal((await battleRequest(player, "start", multi, extra)).statusCode, 200)
    data.setPlayerMissionSync(player.id, 2, { missionId: 6, progress: 2, clearedStage: 0 })
    if (multi) data.setPlayerMissionSync(player.id, 1, { missionId: 40, progress: 9999, clearedStage: 0 })
    db.exec(`CREATE TABLE mission_hardening_deferred_failure (
        parent INTEGER REFERENCES players(id) DEFERRABLE INITIALLY DEFERRED
    )`)
    db.exec(`CREATE TEMP TRIGGER mission_hardening_commit_failure BEFORE INSERT ON players_mail
        WHEN NEW.player_id = ${player.id} BEGIN
            INSERT INTO mission_hardening_deferred_failure (parent) VALUES (-1);
        END`)
    try {
        const failed = await battleRequest(player, "finish", multi)
        assert.equal(failed.statusCode, 500, failed.body)
        assert.equal(data.getPlayerMissionsSync(player.id, 2).find(row => row.missionId === 6)!.progress, 2)
        if (room) assert.deepEqual(room.roundEndedViewerIds, [])
    } finally {
        db.exec("DROP TRIGGER mission_hardening_commit_failure")
        db.exec("DROP TABLE mission_hardening_deferred_failure")
    }
    try {
        assert.equal((await battleRequest(player, "finish", multi)).statusCode, 200)
        if (room) assert.deepEqual(room.roundEndedViewerIds, [player.viewerId])
    } finally { if (room) rooms.deleteRoom(room.roomNumber) }
})

test("atomic replies keep fluent headers, redirects and error rollback while buffering send", async () => {
    const { default: Fastify } = await import("fastify")
    const { atomicHandler } = await import("../src/lib/atomic")
    const app = Fastify()
    const { id } = await newPlayer()
    const beforeMana = data.getPlayerSync(id)!.freeMana
    app.post("/reject", atomicHandler((_request, reply) => {
        data.updatePlayerSync({ id, freeMana: beforeMana + 10 })
        return reply.code(400).header("x-atomic-result", "rejected").send({ rejected: true })
    }))
    app.post("/redirect", atomicHandler((_request, reply) => {
        data.updatePlayerSync({ id, freeMana: beforeMana + 10 })
        return reply.redirect("/done")
    }))
    app.post("/throw-after-send", atomicHandler((_request, reply) => {
        data.updatePlayerSync({ id, freeMana: beforeMana + 20 })
        reply.status(200).type("application/json").send({ committed: true })
        throw new Error("failure after staging success")
    }))
    for (const statusCode of [500, 400]) app.post(`/send-error-${statusCode}`, atomicHandler((_request, reply) => {
        data.updatePlayerSync({ id, name: "must roll back" })
        return reply.send(Object.assign(new Error("error payload"), { statusCode }))
    }))
    try {
        const rejected = await app.inject({ method: "POST", url: "/reject" })
        assert.equal(rejected.statusCode, 400)
        assert.equal(rejected.headers["x-atomic-result"], "rejected")
        assert.deepEqual(rejected.json(), { rejected: true })
        assert.equal(data.getPlayerSync(id)!.freeMana, beforeMana)
        const redirected = await app.inject({ method: "POST", url: "/redirect" })
        assert.equal(redirected.statusCode, 302)
        assert.equal(redirected.headers.location, "/done")
        assert.equal(data.getPlayerSync(id)!.freeMana, beforeMana + 10)
        const failed = await app.inject({ method: "POST", url: "/throw-after-send" })
        assert.equal(failed.statusCode, 500)
        assert.equal(data.getPlayerSync(id)!.freeMana, beforeMana + 10)
        assert.equal(failed.json().committed, undefined)
        const originalName = data.getPlayerSync(id)!.name
        for (const statusCode of [500, 400]) {
            const errorPayload = await app.inject({ method: "POST", url: `/send-error-${statusCode}` })
            assert.equal(errorPayload.statusCode, statusCode)
            assert.equal(data.getPlayerSync(id)!.name, originalName)
        }
    } finally { await app.close() }
})
