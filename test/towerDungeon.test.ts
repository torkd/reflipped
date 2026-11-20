// FT-6: the Haunt. Each monthly cycle has its own ten quests (three floors each); a cleared floor can't be played
// again in its cycle; at a new cycle's first /load a player who cleared floors 16-18 starts on floor 16 with the
// rewards of floors 1-15 mailed, and /load sends the reset dialog once (`tower_dungeon_list`).
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";
import towerQuests from "../assets/tower_dungeon_event_quest.json";
import scoreRewards from "../assets/score_reward.json";
import rareScoreRewards from "../assets/rare_score_reward.json";
import rewardElementMap from "../assets/reward_element_map.json";

const apiPrefix = "/latest/api/index.php"
const TOWER = 20
// cycle 1341 runs from 2024-12-21 05:00 to 2025-01-20 05:00 Japan time, then cycle 1351
const IN_1341 = "2025-01-03T12:00:00Z"
const START_1351 = "2025-01-19T20:00:00Z"

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
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

async function newPlayer(date: string): Promise<TestPlayer & { playerId: number }> {
    await setClock(date)
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    await load(player, date)
    return { ...player, playerId }
}

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    return await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
}

async function load(player: TestPlayer, date: string) {
    await setClock(date)
    const response = await post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

async function start(player: TestPlayer, questId: number) {
    return await post(player, "single_battle_quest/start", {
        quest_id: questId, category: TOWER, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
}

async function finish(player: TestPlayer, questId: number) {
    const response = await post(player, "single_battle_quest/finish", {
        quest_id: questId, category: TOWER, score: 1000, add_mana: 0, elapsed_time_ms: 120000,
        is_accomplished: true, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
        statistics: {
            clear_phase: 0,
            party: { characters: [null, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] }
        }
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

function clear(playerId: number, questIds: number[]) {
    for (const questId of questIds) data.insertPlayerQuestProgressSync(playerId, TOWER, { questId, finished: true, clearRank: 1 })
}

function cleared(playerId: number, questId: number): boolean {
    return data.getPlayerSingleQuestProgressSync(playerId, TOWER, questId)?.finished === true
}

function range(first: number, count: number): number[] {
    return Array.from({ length: count }, (_, index) => first + index)
}

function hauntMail(playerId: number) {
    return data.getPlayerAllMailSync(playerId).filter(mail => mail.subject === "The Haunt")
}

test("the cycles follow the quests' periods", async () => {
    const { towerCycleAt } = await import("../src/lib/towerDungeon")
    assert.equal(towerCycleAt(new Date("2022-05-01T00:00:00Z")), null)
    // the global schedule: the 6th at 05:00 Japan time
    assert.equal(towerCycleAt(new Date("2024-03-05T19:59:59Z"))?.id, 1211)
    assert.equal(towerCycleAt(new Date("2024-03-05T20:00:00Z"))?.id, 1221)
    // where the global and Japanese schedules overlap, the later-starting cycle
    assert.equal(towerCycleAt(new Date("2024-09-25T00:00:00Z"))?.id, 1311)
    // the Japanese schedule, and a last cycle without an end
    assert.equal(towerCycleAt(new Date("2025-01-19T19:59:59Z"))?.id, 1341)
    assert.equal(towerCycleAt(new Date(START_1351))?.id, 1351)
    assert.equal(towerCycleAt(new Date("2030-01-01T00:00:00Z"))?.id, 1471)
    assert.equal(towerCycleAt(new Date(IN_1341))?.month, 12)
})

test("a floor starts once its floors below are cleared, and only once a cycle", async () => {
    const player = await newPlayer(IN_1341)
    // another cycle's quest, and a floor above an uncleared one
    assert.equal((await start(player, 1351)).statusCode, 400)
    assert.equal((await start(player, 1342)).statusCode, 400)

    const element = (towerQuests as Record<string, { enemyElement: number }>)["1341"].enemyElement
    const orbId = (rewardElementMap as Record<string, Record<string, Record<string, number>>>)["1"]["1"][String(element)]
    const orbsBefore = data.getPlayerItemSync(player.playerId, orbId) ?? 0

    assert.equal((await start(player, 1341)).statusCode, 200)
    const result = await finish(player, 1341)
    assert.ok(cleared(player.playerId, 1341))
    // the floor's element reward pays the orb of its enemy element (rare group 721100: rarity 1, 60)
    assert.equal(data.getPlayerItemSync(player.playerId, orbId), orbsBefore + 60)
    assert.equal(result.item_list[String(orbId)], orbsBefore + 60)

    // cleared: not again in this cycle
    assert.equal((await start(player, 1341)).statusCode, 400)
    assert.equal((await start(player, 1342)).statusCode, 200)
})

test("reaching floor 18 carries floors 1-15 into the next cycle, with their rewards mailed", async () => {
    const player = await newPlayer(IN_1341)
    clear(player.playerId, range(1341, 6))

    const loaded = await load(player, START_1351)
    assert.deepEqual(loaded.tower_dungeon_list, [{ event_id: 1, reset_month: 12, reset_status: 1 }])
    for (const questId of range(1351, 5)) assert.ok(cleared(player.playerId, questId), `${questId} cleared`)
    assert.ok(!cleared(player.playerId, 1356))
    assert.equal((await start(player, 1356)).statusCode, 200)

    // the floors' drops: all from guaranteed rare pools of one reward each, summed by kind
    const expected = new Map<string, number>()
    for (const questId of range(1351, 5)) {
        const quest = (towerQuests as Record<string, { scoreRewardGroup: number, enemyElement: number }>)[String(questId)]
        for (const pool of (scoreRewards as unknown as Record<string, { type: number, id: number, rarity: number }[]>)[String(quest.scoreRewardGroup)]) {
            assert.equal(pool.type, 1)
            assert.equal(pool.rarity, 1)
            const [reward] = (rareScoreRewards as unknown as Record<string, { type: number, id?: number, count: number }[]>)[String(pool.id)]
            const key = reward.type === 6 ? `1:${(rewardElementMap as Record<string, Record<string, Record<string, number>>>)["1"][String(reward.id)][String(quest.enemyElement)]}`
                : reward.type === 3 ? "4:" : reward.type === 4 ? "8:" : `?${reward.type}`
            expected.set(key, (expected.get(key) ?? 0) + reward.count)
        }
    }
    const mailed = new Map(hauntMail(player.playerId).map(mail => [`${mail.type}:${mail.typeId ?? ""}`, mail.number]))
    assert.deepEqual(mailed, expected)

    // the dialog is sent once
    assert.deepEqual((await load(player, "2025-01-20T01:00:00Z")).tower_dungeon_list, [])
})

test("a player short of floor 18 starts the next cycle from the bottom", async () => {
    const player = await newPlayer(IN_1341)
    clear(player.playerId, range(1341, 5))

    const loaded = await load(player, START_1351)
    assert.deepEqual(loaded.tower_dungeon_list, [{ event_id: 1, reset_month: 12, reset_status: 2 }])
    assert.ok(!cleared(player.playerId, 1351))
    assert.deepEqual(hauntMail(player.playerId), [])
})

test("only players who played the cycle that ended get the dialog", async () => {
    const player = await newPlayer(IN_1341)
    assert.deepEqual((await load(player, START_1351)).tower_dungeon_list, [])
})

test("a skipped cycle breaks the carryover", async () => {
    const player = await newPlayer(IN_1341)
    clear(player.playerId, range(1341, 6))
    // cycle 1361 starts on 2025-02-20 at 05:00 Japan time; 1351 was never seen
    const loaded = await load(player, "2025-02-20T00:00:00Z")
    assert.deepEqual(loaded.tower_dungeon_list, [{ event_id: 1, reset_month: 12, reset_status: 2 }])
    assert.ok(!cleared(player.playerId, 1361))
})

test("a cycle shown again starts over", async () => {
    const player = await newPlayer(START_1351)
    // clears left from an earlier pass over cycle 1341 (the clock moved back to it)
    clear(player.playerId, range(1341, 3))
    await load(player, IN_1341)
    for (const questId of range(1341, 3)) assert.ok(!cleared(player.playerId, questId), `${questId} not cleared`)
    assert.equal((await start(player, 1341)).statusCode, 200)
})
