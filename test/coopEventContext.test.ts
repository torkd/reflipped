import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody } from "./helpers";
import { newViewer } from "./coopHelpers";

let fastify: FastifyInstance
let cleanup: () => Promise<void>
before(async () => { ({ fastify, cleanup } = await createTestServer()) })
after(async () => { await cleanup() })

async function request(route: string, body: Record<string, unknown>) {
    return fastify.inject({ method: "POST", url: `/latest/api/index.php/${route}`,
        headers: { "content-type": "application/x-www-form-urlencoded" }, payload: encodeGameBody(body) })
}

test("co-op start binds the signed player and quest to the room, and preserves its event snapshot", async () => {
    const { getRoom } = await import("../src/lib/coop/rooms")
    const { getEventPolicy, setEventPolicy } = await import("../src/lib/eventPolicy")
    const host = await newViewer(fastify), guest = await newViewer(fastify), outsider = await newViewer(fastify)
    const create = await request("multi_battle_quest/create_room", { viewer_id: host, quest_id: 1001001, category: 2, party_id: 1 })
    assert.equal(create.statusCode, 200)
    const number = decodeGameBody(create.body).data.room_number as string
    const room = getRoom(number)!
    const original = { ...room.eventContext! }
    assert.ok(Object.isFrozen(room.eventContext))
    const policy = getEventPolicy()
    setEventPolicy({ ...policy, mode: "accelerated" })
    assert.deepEqual(room.eventContext, original, "changing server policy does not alter an existing room")
    const start = (viewer: number, quest = 1001001, roomNumber = number) => request("multi_battle_quest/start", {
        viewer_id: viewer, room_number: roomNumber, quest_id: quest, category: 2, party_id: 1, play_id: "TEST",
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, mate_player_ids: []
    })
    assert.equal((await start(outsider)).statusCode, 400)
    assert.equal((await start(host, 1001002)).statusCode, 400)
    assert.equal((await start(host, 1001001, "000000")).statusCode, 400)
    assert.equal(room.inBattle, false)
    const selected = await request("multi_battle_quest/select_room", { viewer_id: guest, room_number: number, category: 2,
        quest_id: 1001001, party_id: 1, accepted_type: 1 })
    assert.equal(selected.statusCode, 200)
    assert.equal((await start(guest)).statusCode, 200)
    assert.equal(room.inBattle, true)
    assert.deepEqual(room.eventContext, original)
})

test("failed underlying quest start does not start or admit a battle", async () => {
    const { getRoom } = await import("../src/lib/coop/rooms")
    const host = await newViewer(fastify)
    const create = await request("multi_battle_quest/create_room", { viewer_id: host, quest_id: 999999999, category: 2, party_id: 1 })
    assert.equal(create.statusCode, 200)
    const number = decodeGameBody(create.body).data.room_number as string
    const response = await request("multi_battle_quest/start", { viewer_id: host, room_number: number, quest_id: 999999999,
        category: 2, party_id: 1, play_id: "BAD", use_boost_point: false, use_boss_boost_point: false,
        is_auto_start_mode: false, mate_player_ids: [] })
    assert.equal(response.statusCode, 400)
    assert.equal(getRoom(number)?.inBattle, false)
    assert.equal(getRoom(number)?.battleAdmissions.size, 0)
})

test("host event availability does not replace the guest daily mission date", async () => {
    const previousClock = process.env.SERVER_CLOCK
    process.env.SERVER_CLOCK = "real"
    try {
        const { runOnEventView, getEventScheduleView } = await import("../src/lib/eventSchedule")
        const { getMission, updateMissionsSync } = await import("../src/lib/missions")
        const { getPlayerMissionsSync, getSession, getAccountPlayers } = await import("../src/data/wdfpData")
        const player = await createTestPlayer(fastify)
        const session = await getSession(String(player.viewerId))
        const playerId = (await getAccountPlayers(session!.accountId))[0]
        const event = getMission(3, 1200)!, daily = getMission(2, 6)!
        const hostTime = Date.parse("2021-07-30T12:00:00Z")
        const guestTime = Date.parse("2025-01-03T12:00:00Z")
        const offsetDays = Math.round((guestTime - getEventScheduleView().contentTime) / 86400000)
        runOnEventView(offsetDays, () => {
            const occurrenceKey = getEventScheduleView().occurrenceKey
            updateMissionsSync(playerId, new Date(), [
                { pattern: event.pattern, amount: 1, matches: mission => mission === event },
                { pattern: daily.pattern, amount: 1, matches: mission => mission === daily }
            ], { occurrenceKey, contentTime: hostTime, profile: "classic" })
        })
        assert.equal(getPlayerMissionsSync(playerId, 3).find(m => m.missionId === 1200)?.progress, 1)
        assert.equal(getPlayerMissionsSync(playerId, 2).find(m => m.missionId === 6)?.progress, 1)
    } finally {
        if (previousClock === undefined) delete process.env.SERVER_CLOCK
        else process.env.SERVER_CLOCK = previousClock
    }
})

test("captured room event includes the whole final master second", async () => {
    const previousClock = process.env.SERVER_CLOCK
    process.env.SERVER_CLOCK = "real"
    try {
        const { runOnCapturedEventContext, isContentPeriodOpen } = await import("../src/lib/eventSchedule")
        const end = Date.parse("2021-08-12T04:59:59Z")
        for (const [offset, expected] of [[0, true], [999, true], [1000, false]] as const) {
            const context = { occurrenceKey: "host", contentTime: end + offset, profile: "classic" as const }
            assert.equal(runOnCapturedEventContext(context, () => isContentPeriodOpen(undefined, end, new Date())), expected)
        }
    } finally {
        if (previousClock === undefined) delete process.env.SERVER_CLOCK
        else process.env.SERVER_CLOCK = previousClock
    }
})

test("only current round members can start a past event; room selection cannot bypass solo periods", async () => {
    const previous = process.env.QUEST_PERIOD_CHECK
    process.env.QUEST_PERIOD_CHECK = "enforce"
    try {
        const { createRoom, admit, startRound, noteRoundEnded } = await import("../src/lib/coop/rooms")
        const host = await newViewer(fastify), left = await newViewer(fastify), guest = await newViewer(fastify)
        const room = createRoom(host, 100002007, 10)
        admit(room, left); admit(room, guest)
        // A player who selected and left stays in the room's history, but was not in StartBattle.
        startRound(room, [host, guest])
        const body = (viewer_id: number) => ({ viewer_id, room_number: room.roomNumber, quest_id: room.questId,
            category: room.category, party_id: 1, play_id: "ROUND", use_boost_point: false,
            use_boss_boost_point: false, is_auto_start_mode: false, mate_player_ids: [] })
        assert.equal((await request("single_battle_quest/start", body(left))).statusCode, 400)
        assert.equal((await request("single_battle_quest/start", body(guest))).statusCode, 400)
        assert.equal((await request("multi_battle_quest/start", body(left))).statusCode, 400)
        assert.equal((await request("multi_battle_quest/start", body(guest))).statusCode, 200)
        // A reconnect to this same room keeps the signed member's room association and round membership.
        const restore = await request("multi_battle_quest/restore_room", { viewer_id: guest,
            room_number: room.roomNumber, room_sequence: room.roomSequence })
        assert.equal(restore.statusCode, 200)
        assert.equal(decodeGameBody(restore.body).data.raising_state, 1)
        assert.equal((await request("multi_battle_quest/start", body(guest))).statusCode, 200)
        noteRoundEnded(guest)
        assert.equal((await request("multi_battle_quest/start", body(guest))).statusCode, 400, "a completed round cannot be restarted")
    } finally {
        if (previous === undefined) delete process.env.QUEST_PERIOD_CHECK
        else process.env.QUEST_PERIOD_CHECK = previous
    }
})
