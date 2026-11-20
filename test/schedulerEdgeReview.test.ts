import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody } from "./helpers";

let game: FastifyInstance, admin: FastifyInstance, cleanup: () => Promise<void>
before(async () => { const server = await createTestServer(); game = server.fastify; admin = server.admin; cleanup = server.cleanup })
after(async () => { await cleanup() })

async function player() {
    const p = await createTestPlayer(game)
    const data = await import("../src/data/wdfpData")
    const session = (await data.getSession(String(p.viewerId)))!
    return { ...p, id: (await data.getAccountPlayers(session.accountId))[0] }
}

test("solo completion retains its starting event occurrence across a playlist replacement", async () => {
    const p = await player()
    const data = await import("../src/data/wdfpData")
    const { setEventPolicy } = await import("../src/lib/eventPolicy")
    const { setManualWindows } = await import("../src/lib/eventSchedule")
    const { updateMissionsSync } = await import("../src/lib/missions")
    const previousClock = process.env.SERVER_CLOCK
    process.env.SERVER_CLOCK = "running"
    try {
        setManualWindows([{ from: "2021-07-30", to: "2021-07-30", label: "Starting period" }])
        setEventPolicy({ version: 1, mode: "manual", anchor: Date.now(), rotationId: 101, acceleration: 2, adminTimeTravel: false })
        data.setPlayerMissionSync(p.id, 3, { missionId: 1200, progress: 19, clearedStage: 0 })
        updateMissionsSync(p.id, new Date(), [])
        const request = (route: string, body: Record<string, unknown>) => game.inject({ method: "POST",
            url: `/latest/api/index.php/single_battle_quest/${route}`,
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeGameBody({ viewer_id: p.viewerId, api_count: 1, quest_id: 1001002, category: 1, party_id: 1, ...body }) })
        const start = await request("start", { use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false })
        assert.equal(start.statusCode, 200, start.body)
        setManualWindows([{ from: "2025-01-03", to: "2025-01-03", label: "Replacement period" }])
        setEventPolicy({ version: 1, mode: "manual", anchor: Date.now(), rotationId: 102, acceleration: 2, adminTimeTravel: false })
        const finish = await request("finish", { score: 0, elapsed_time_ms: 10000, add_mana: 0, is_accomplished: true,
            statistics: { party: { characters: [], unison_characters: [] }, zones: [{ use_dash_count: 1 }] } })
        assert.equal(finish.statusCode, 200, finish.body)
        assert.equal(decodeGameBody(finish.body).data_headers.result_code, 1)
        const originalMission = data.getPlayerMissionsSync(p.id, 3).find(row => row.missionId === 1200)
        assert.equal(originalMission?.progress, 20)
        assert.equal(originalMission?.clearedStage, 1)
    } finally { process.env.SERVER_CLOCK = previousClock }
})

test("a save upload cannot commit after Automatic is enabled while multipart parsing waits", async () => {
    const p = await player()
    const { buildAdminServer } = await import("../src/app")
    const { setRewardPolicy } = await import("../src/lib/rewardPolicy")
    const data = await import("../src/data/wdfpData")
    setRewardPolicy({ management: "managed" })
    const save = (await admin.inject({ method: "GET", url: `/api/player/save?id=${p.id}` })).json()
    save.user_info.name = "Forbidden late upload"
    const original = data.getPlayerSync(p.id)!.name
    let reached!: () => void, resume!: () => void
    const parsing = new Promise<void>(resolve => { reached = resolve })
    const gate = new Promise<void>(resolve => { resume = resolve })
    const racing = buildAdminServer({ adminAuth: false })
    racing.addHook("preHandler", async request => {
        if (request.url !== `/api/player/save?id=${p.id}`) return
        const readFile = request.file.bind(request)
        request.file = (async (...args: Parameters<typeof readFile>) => {
            reached()
            await gate
            return readFile(...args)
        }) as typeof request.file
    })
    await racing.ready()
    try {
        const boundary = "review-upload-boundary"
        const upload = racing.inject({ method: "POST", url: `/api/player/save?id=${p.id}`,
            headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
            payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="save.json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(save)}\r\n--${boundary}--\r\n`
        }).then(response => response)
        await parsing
        setRewardPolicy({ management: "automatic", multiplierOverride: null })
        resume()
        const response = await upload
        assert.equal(response.statusCode, 403, response.body)
        assert.equal(data.getPlayerSync(p.id)!.name, original)
    } finally {
        resume()
        setRewardPolicy({ management: "managed" })
        await racing.close()
    }
})

test("legacy availability ignores a captured scheduled room date when scheduling is disabled", async () => {
    const { runOnCapturedEventContext, isContentPeriodOpen } = await import("../src/lib/eventSchedule")
    const original = process.env.EVENT_SCHEDULING
    process.env.EVENT_SCHEDULING = "off"
    try {
        const real = new Date("2025-01-03T12:00:00Z")
        const room = { occurrenceKey: "old-room", contentTime: Date.parse("2021-07-30T12:00:00Z"), profile: "classic" as const }
        assert.equal(runOnCapturedEventContext(room, () => isContentPeriodOpen(
            Date.parse("2025-01-01T00:00:00Z"), Date.parse("2025-01-31T00:00:00Z"), real)), true)
    } finally {
        if (original === undefined) delete process.env.EVENT_SCHEDULING
        else process.env.EVENT_SCHEDULING = original
    }
})

test("reused co-op rooms capture current reward policy per round and retain in-flight amounts", async () => {
    const p = await player()
    const { createRoom, startRound, openRound, deleteRoom } = await import("../src/lib/coop/rooms")
    const { getRewardPolicy, setRewardPolicy } = await import("../src/lib/rewardPolicy")
    const { getQuestFromCategorySync } = await import("../src/lib/assets")
    const room = createRoom(p.viewerId, 1001001, 2)
    setRewardPolicy({ management: "managed", multiplierOverride: 10 })
    room.eventContext = Object.freeze({ occurrenceKey: "pinned-room", contentTime: Date.parse("2021-07-30T12:00:00Z"),
        profile: "classic", rewardMultiplier: 10 })
    const request = (route: string, body: Record<string, unknown>) => game.inject({ method: "POST",
        url: `/latest/api/index.php/multi_battle_quest/${route}`, headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeGameBody({ viewer_id: p.viewerId, api_count: 1, room_number: room.roomNumber, quest_id: 1001001,
            category: 2, party_id: 1, ...body }) })
    const start = () => request("start", { play_id: "ROUND", use_boost_point: false, use_boss_boost_point: false,
        is_auto_start_mode: false, mate_player_ids: [] })
    const finish = () => request("finish", { score: 0, elapsed_time_ms: 10000, add_mana: 0, is_accomplished: true,
        statistics: { party: { characters: [], unison_characters: [] } } })
    try {
        startRound(room, [p.viewerId])
        const first = room.eventContext!
        assert.equal((await start()).statusCode, 200)
        setRewardPolicy({ management: "automatic", multiplierOverride: null })
        startRound(room, [p.viewerId])
        assert.equal(room.eventContext, first, "a repeated in-flight start cannot refresh an existing round's policy")
        const fixed = getRewardPolicy().multiplier
        const firstFinish = await finish()
        assert.equal(firstFinish.statusCode, 200, firstFinish.body)
        const quest = getQuestFromCategorySync(2, 1001001) as import("../src/lib/types").BattleQuest
        assert.equal(decodeGameBody(firstFinish.body).data.rewards.reward_mana, quest.manaReward * 10)
        openRound(room)
        startRound(room, [p.viewerId])
        assert.equal(room.eventContext!.rewardMultiplier, fixed)
        assert.equal(room.eventContext!.contentTime, first.contentTime)
        assert.equal(room.eventContext!.occurrenceKey, first.occurrenceKey)
        assert.equal(room.eventContext!.profile, first.profile)
        assert.equal(first.rewardMultiplier, 10, "the previous round's object remains unchanged")
        assert.ok(Object.isFrozen(room.eventContext))
        assert.equal((await start()).statusCode, 200)
        setRewardPolicy({ management: "managed", multiplierOverride: 7 })
        const secondFinish = await finish()
        assert.equal(secondFinish.statusCode, 200, secondFinish.body)
        assert.equal(decodeGameBody(secondFinish.body).data.rewards.reward_mana, Math.floor(quest.manaReward * fixed))
    } finally {
        setRewardPolicy({ management: "managed", multiplierOverride: 1 })
        deleteRoom(room.roomNumber)
    }
})

test("save replacement retains spent point-day claims without blocking the next real day", async () => {
    const p = await player()
    const data = await import("../src/data/wdfpData")
    const { getClientSerializedData, deserializePlayerData } = await import("../src/data/utils")
    const { setEventPolicy } = await import("../src/lib/eventPolicy")
    const { setManualWindows } = await import("../src/lib/eventSchedule")
    const { refillRewardPointsSync } = await import("../src/lib/rewardPoints")
    const oldClock = process.env.SERVER_CLOCK
    process.env.SERVER_CLOCK = "running"
    try {
        setManualWindows([{ from: "2021-08-23", to: "2021-08-23", label: "Point-active period" }])
        setEventPolicy({ version: 1, mode: "manual", anchor: Date.now(), rotationId: 103, acceleration: 2, adminTimeTravel: false })
        const now = new Date()
        refillRewardPointsSync(p.id, now)
        assert.equal(data.getPlayerDailyChallengePointListSync(p.id).find(row => row.id === 2)?.point, 1)
        data.setPlayerDailyChallengePointSync(p.id, 2, 0)
        const ledger = data.getPlayerProgressRecordsSync(p.id).players_point_reset_days
        const save = getClientSerializedData(p.id, { serializeSaveData: true })!
        data.replacePlayerDataSync(deserializePlayerData(p.id, save))
        assert.deepEqual(data.getPlayerProgressRecordsSync(p.id).players_point_reset_days, ledger)
        refillRewardPointsSync(p.id, now)
        assert.equal(data.getPlayerDailyChallengePointListSync(p.id).find(row => row.id === 2)?.point, 0)
        refillRewardPointsSync(p.id, new Date(now.getTime() + 86400000))
        assert.equal(data.getPlayerDailyChallengePointListSync(p.id).find(row => row.id === 2)?.point, 1)
    } finally { process.env.SERVER_CLOCK = oldClock }
})
