// FT-2: collect item event drops. While a treasure hunt runs, a cleared quest it names drops the event's item: one draw
// from every additional reward group whose lowest enemy level the quest reaches, named in `drop_additional_reward_ids`.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const DAILY_WEEK_EVENT = 6
// "Lv 50" of the first Labyrinth: enemy level 50
const QUEST = 1005
// treasure hunt 1 (2021-10-18 to 10-31, Japan time): Kaleidoscope Drops (80001); its daily quests drop from the groups
// of enemy levels 0, 20, 30, 40 and 50 (100, 200, 240, 290 and 350 drops)
const DURING_EVENT = "2021-10-20T03:00:00Z"
const AFTER_EVENT = "2021-11-20T03:00:00Z"
const DROP_ITEM = 80001
const GROUPS = [200007, 200006, 200005, 200004, 200003]
const OBTAIN_50 = 1500

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

async function clear(date: string, accomplished = true) {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(date))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    await post(player, "single_battle_quest/start", {
        quest_id: QUEST, category: DAILY_WEEK_EVENT, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
    const finished = await post(player, "single_battle_quest/finish", {
        quest_id: QUEST, category: DAILY_WEEK_EVENT, score: 1000, add_mana: 0, elapsed_time_ms: 100_000,
        is_accomplished: accomplished, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
        statistics: { party: { characters: [null, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] } }
    })
    return { playerId, finished }
}

test("a clear during the treasure hunt drops the event's item from every tier it reaches", async () => {
    const { playerId, finished } = await clear(DURING_EVENT)
    const drops = finished.drop_additional_reward_ids as { group_id: number, index: number, number: number }[]
    assert.deepEqual(drops.map(drop => drop.group_id).sort(), [...GROUPS].sort())
    assert.ok(drops.every(drop => drop.index === 1))
    const total = drops.reduce((sum, drop) => sum + drop.number, 0)
    assert.equal(total, 100 + 200 + 240 + 290 + 350)
    assert.equal(data.getPlayerItemSync(playerId, DROP_ITEM), total)
    assert.equal(finished.item_list[DROP_ITEM], total)

    // "Obtain at least 50 Kaleidoscope Drops" moves with them
    const missions = data.getPlayerMissionsSync(playerId, 4)
    const mission = missions.find(entry => entry.missionId === OBTAIN_50)
    assert.ok(mission !== undefined && (mission.clearedStage ?? 0) >= 1, "mission 1500 cleared")
})

test("nothing drops outside the event", async () => {
    const { playerId, finished } = await clear(AFTER_EVENT)
    assert.deepEqual(finished.drop_additional_reward_ids, [])
    assert.equal(data.getPlayerItemSync(playerId, DROP_ITEM) ?? 0, 0)
})

test("the drop groups follow the quest's enemy level", async () => {
    const { collectItemDropGroups } = await import("../src/lib/collectItemDrops")
    const date = new Date(DURING_EVENT)
    assert.deepEqual(collectItemDropGroups(DAILY_WEEK_EVENT, 1001, 10, date), [200007], "Lv 10: the lowest tier only")
    assert.deepEqual(collectItemDropGroups(DAILY_WEEK_EVENT, 1005, 50, date), GROUPS)
    assert.deepEqual(collectItemDropGroups(DAILY_WEEK_EVENT, 1005, undefined, date), [])
    // character quests aren't named
    assert.deepEqual(collectItemDropGroups(3, 1001001, 50, date), [])
})
