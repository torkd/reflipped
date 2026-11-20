// FT-2: collect item event missions (mission category 4): the missions of the treasure hunts and promo mission
// events (`collect_item_event`). They count like event missions while their period holds, the event's screen lists
// them with `{category: 4, event_id}`, and `/load` lists their cleared stages in `cleared_collect_item_event_mission_list`.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const STORY_EVENT_SINGLE = 10
const COLLECT_ITEM_EVENT = 4
const MISSION_REWARD_REASON = 60
// promo mission event 10014: 2023-11-26 14:00 to 2023-12-11 20:59 Japan time
const EVENT = 10014
const DURING_EVENT = "2023-12-01T12:00:00Z"
const AFTER_EVENT = "2025-01-03T12:00:00Z"
// event 10014, round 1: "Clear 5 solo battles" (50,000 pooled exp)
const SOLO_CLEARS = 2025

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let missions: typeof import("../src/lib/missions")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    missions = await import("../src/lib/missions")
})

afterEach(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
})

after(async () => {
    await cleanup()
})

async function setClock(date: string) {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(date))
}

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

async function load(player: TestPlayer) {
    return await post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
}

async function newPlayer(date: string): Promise<TestPlayer & { playerId: number }> {
    await setClock(date)
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    await load(player)
    return { ...player, playerId }
}

const emptyParty = { characters: [null, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] }

async function clearBattle(player: TestPlayer) {
    const questId = 100002007
    await post(player, "single_battle_quest/start", {
        quest_id: questId, category: STORY_EVENT_SINGLE, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
    return await post(player, "single_battle_quest/finish", {
        quest_id: questId, category: STORY_EVENT_SINGLE, score: 1000, add_mana: 0, elapsed_time_ms: 700000,
        is_accomplished: true, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
        statistics: { clear_phase: 0, party: emptyParty, max_combo_count: 5, zones: [{}] }
    })
}

type ProgressEntry = { mission_category: number, mission_id: number, progress_value: number, stage: number }

async function eventMissions(player: TestPlayer, categoryList: Record<string, number>[]) {
    const reply = await post(player, "mission/get_mission_progress", { api_count: 1, category_list: categoryList })
    return reply.mission_progress_list as ProgressEntry[]
}

test("the converter keeps each mission's event and round", () => {
    const mission = missions.getMission(missions.MissionCategory.COLLECT_ITEM_EVENT, SOLO_CLEARS)!
    assert.equal(mission.eventId, EVENT)
    assert.equal(mission.round, 1)
    assert.equal(mission.pattern, 12)
    assert.deepEqual(mission.stages, [{ target: 5, rewards: [{ kind: 5, amount: 50000 }] }])
    // a treasure hunt's mission counts its event item
    const kaleidoDrops = missions.getMission(missions.MissionCategory.COLLECT_ITEM_EVENT, 1500)!
    assert.equal(kaleidoDrops.eventId, 1)
    assert.equal(kaleidoDrops.itemId, 80001)
})

test("an event's screen lists only that event's missions, and only while it shows", async () => {
    const player = await newPlayer(DURING_EVENT)
    const list = await eventMissions(player, [{ category: COLLECT_ITEM_EVENT, event_id: EVENT }])
    assert.equal(list.length, 24)
    assert.ok(list.every(entry => entry.mission_category === COLLECT_ITEM_EVENT))
    assert.deepEqual(list.find(entry => entry.mission_id === SOLO_CLEARS), { mission_category: COLLECT_ITEM_EVENT, mission_id: SOLO_CLEARS, progress_value: 0, stage: 1 })
    // no event named, or another event: nothing of this one
    assert.deepEqual(await eventMissions(player, [{ category: COLLECT_ITEM_EVENT }]), [])
    assert.deepEqual(await eventMissions(player, [{ category: COLLECT_ITEM_EVENT, event_id: 10013 }]), [])
    // the regular mission screen doesn't list them
    assert.ok(!(await eventMissions(player, [{ category: 2 }, { category: 1 }, { category: 3 }])).some(entry => entry.mission_category === COLLECT_ITEM_EVENT))

    await setClock(AFTER_EVENT)
    assert.deepEqual(await eventMissions(player, [{ category: COLLECT_ITEM_EVENT, event_id: EVENT }]), [])
})

test("battle clears during the event clear its missions, mail the rewards and reach /load", async () => {
    const player = await newPlayer(DURING_EVENT)
    assert.deepEqual((await load(player)).cleared_collect_item_event_mission_list, [], "nothing cleared yet: an empty list, as captured")

    let last: Record<string, unknown> = {}
    for (let clear = 0; clear < 5; clear++) last = await clearBattle(player)
    const cleared = (last.mission_info as { mission_category_id: number, mission_id: number, mission_reward_id: number }[])
        .filter(info => info.mission_category_id === COLLECT_ITEM_EVENT)
    assert.deepEqual(cleared, [{ mission_category_id: COLLECT_ITEM_EVENT, mission_id: SOLO_CLEARS, mission_reward_id: SOLO_CLEARS * 1000 + 1 }])
    assert.equal(last.mail_arrived, true)

    const mail = (await post(player, "mail/index", { api_count: 1, current_page: 1 })).mail as { number: number, reason_id: number }[]
    assert.ok(mail.some(entry => entry.reason_id === MISSION_REWARD_REASON && entry.number === 50000), "50,000 pooled exp")

    const entry = (await eventMissions(player, [{ category: COLLECT_ITEM_EVENT, event_id: EVENT }])).find(entry => entry.mission_id === SOLO_CLEARS)
    assert.deepEqual(entry, { mission_category: COLLECT_ITEM_EVENT, mission_id: SOLO_CLEARS, progress_value: 5, stage: 1 })
    assert.deepEqual((await load(player)).cleared_collect_item_event_mission_list, { [SOLO_CLEARS]: 1 })
})

test("outside the event's period nothing counts", async () => {
    const player = await newPlayer(AFTER_EVENT)
    for (let clear = 0; clear < 5; clear++) await clearBattle(player)
    assert.deepEqual(data.getPlayerMissionsSync(player.playerId, COLLECT_ITEM_EVENT), [])
    assert.deepEqual((await load(player)).cleared_collect_item_event_mission_list, [])
})

test("\"Clear all Round 3 missions\" follows the round's missions", async () => {
    const player = await newPlayer(DURING_EVENT)
    // round 3: stamina used (2041), co-op clears (2042), a zone statistic (2043), a skill chain (2044); 2045 counts them
    const result = missions.updateMissionsSync(player.playerId, new Date(DURING_EVENT), [
        { pattern: 36, amount: 200 },
        { pattern: 14, amount: 30 },
        { pattern: 26, amount: 100 },
        { pattern: 29, value: 9 }
    ])
    const cleared = result.missionInfo.filter(info => info.mission_category_id === COLLECT_ITEM_EVENT).map(info => info.mission_id)
    for (const missionId of [2041, 2042, 2043, 2044, 2045]) assert.ok(cleared.includes(missionId), `mission ${missionId}`)
    assert.ok(!cleared.includes(2046), "\"Clear all missions\" waits for the other rounds")
})
