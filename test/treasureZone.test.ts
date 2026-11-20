// FT-8: the Treasure Zone. Its quests (challenge dungeon 2001-2006) open after main quest 1-8-4 and take a Golden
// Skull (item 500000), used up only by a clear; quests that take an item once (world story 400001102) need it only
// until their first clear. The Trading Post sells 10 skulls a month for 2,000 Wrightpieces each.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const MAIN = 1
const CHALLENGE_DUNGEON = 13
const WORLD_STORY_EVENT = 18
const GENERAL_SHOP = 8
const TREASURE_ZONE_DARK = 2001
const SKULL = 500000
const WRIGHTPIECE = 100000
// the Trading Post's monthly skull product, from May 2024
const SKULL_PRODUCT = 230013
// a world story quest unlocked by item 60001, taken on its first clear only
const ONCE_QUEST = 400001102
const ONCE_ITEM = 60001

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

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    return await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
}

async function newPlayer(): Promise<TestPlayer & { playerId: number }> {
    await setClock("2025-01-03T12:00:00Z")
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    const loaded = await post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    assert.equal(loaded.statusCode, 200, loaded.body)
    return { ...player, playerId }
}

function start(player: TestPlayer, category: number, questId: number) {
    return post(player, "single_battle_quest/start", {
        quest_id: questId, category, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
}

async function finish(player: TestPlayer, category: number, questId: number) {
    const response = await post(player, "single_battle_quest/finish", {
        quest_id: questId, category, score: 1000, add_mana: 0, elapsed_time_ms: 2_000_000,
        is_accomplished: true, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
        statistics: {
            clear_phase: 0,
            party: { characters: [null, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] }
        }
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

function items(playerId: number, itemId: number): number {
    return data.getPlayerItemSync(playerId, itemId) ?? 0
}

test("the Treasure Zone opens after main quest 1-8-4 and takes a Golden Skull per clear", async () => {
    const player = await newPlayer()
    data.givePlayerItemSync(player.playerId, SKULL, 1)
    assert.equal((await start(player, CHALLENGE_DUNGEON, TREASURE_ZONE_DARK)).statusCode, 400, "1-8-4 not cleared")

    data.insertPlayerQuestProgressSync(player.playerId, MAIN, { questId: 1008004, finished: true, clearRank: 1 })
    assert.equal((await start(player, CHALLENGE_DUNGEON, TREASURE_ZONE_DARK)).statusCode, 200)
    // given up: the skull stays
    assert.equal((await post(player, "single_battle_quest/abort", { quest_id: TREASURE_ZONE_DARK, category: CHALLENGE_DUNGEON, play_id: "test", api_count: 2, finish_kind: 0, statistics: {} })).statusCode, 200)
    assert.equal(items(player.playerId, SKULL), 1)

    assert.equal((await start(player, CHALLENGE_DUNGEON, TREASURE_ZONE_DARK)).statusCode, 200)
    const cleared = await finish(player, CHALLENGE_DUNGEON, TREASURE_ZONE_DARK)
    assert.equal(items(player.playerId, SKULL), 0)
    assert.equal(cleared.item_list[String(SKULL)], 0)

    // every clear takes one: without a skull the quest can't start again
    assert.equal((await start(player, CHALLENGE_DUNGEON, TREASURE_ZONE_DARK)).statusCode, 400)
})

test("an item that unlocks a quest is taken by its first clear only", async () => {
    const player = await newPlayer()
    assert.equal((await start(player, WORLD_STORY_EVENT, ONCE_QUEST)).statusCode, 400)

    data.givePlayerItemSync(player.playerId, ONCE_ITEM, 1)
    assert.equal((await start(player, WORLD_STORY_EVENT, ONCE_QUEST)).statusCode, 200)
    await finish(player, WORLD_STORY_EVENT, ONCE_QUEST)
    assert.equal(items(player.playerId, ONCE_ITEM), 0)

    assert.equal((await start(player, WORLD_STORY_EVENT, ONCE_QUEST)).statusCode, 200)
    await finish(player, WORLD_STORY_EVENT, ONCE_QUEST)
    assert.equal(items(player.playerId, ONCE_ITEM), 0)
})

test("the Trading Post sells 10 Golden Skulls a month", async () => {
    const player = await newPlayer()
    data.givePlayerItemSync(player.playerId, WRIGHTPIECE, 2000 * 12)
    const buy = (count: number) => post(player, "shop/buy", { shop_type: GENERAL_SHOP, shop_item_id: SKULL_PRODUCT, number: count, api_count: 3 })

    assert.equal((await buy(10)).statusCode, 200)
    assert.equal(items(player.playerId, SKULL), 10)
    assert.equal(items(player.playerId, WRIGHTPIECE), 2000 * 2)
    assert.notEqual((await buy(1)).statusCode, 200, "the month's 10 are sold")

    // 05:00 on 1 February in Japan: the stock is back
    await setClock("2025-01-31T20:00:00Z")
    assert.equal((await buy(1)).statusCode, 200)
    assert.equal(items(player.playerId, SKULL), 11)
})
