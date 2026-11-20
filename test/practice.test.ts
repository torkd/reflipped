// FT-17: Practice Combat. The Lignoid fights are ordinary single battles (category 15) on assets/practice_quest.json:
// they start without stamina and drop nothing, their clears move the practice missions (regular 56-60 pay an armament,
// title missions 12000-12040 a title for an S+ clear), and every battle, cleared or given up, is listed by
// history/practice_battle, the latest first.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";
import practiceQuests from "../assets/practice_quest.json";

const apiPrefix = "/latest/api/index.php"
const PRACTICE = 15
// the Shield Lignoid (Thunder); missions 56 (armament 200001) and title mission 12040 take any of 1, 11, ... 51
const QUEST = 1
const ARMAMENT = 200001
const TITLE = 12040

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
    return await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
}

async function newPlayer(): Promise<TestPlayer & { playerId: number }> {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date("2025-01-03T12:00:00Z"))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    return { ...player, playerId }
}

const statistics = {
    clear_phase: 0,
    party: {
        characters: [{ id: 111001 }, null, { id: 111003 }], unison_characters: [{ id: 111002 }, null, null],
        equipments: [{ id: 999999 }, null, null], ability_soul_ids: [null, null, null]
    },
    zones: [
        { damage_deal_total: 1500, playthrough_frame: 600, members: [{ origin_damage: 1000 }, { origin_damage: 0 }, { origin_damage: 500 }] },
        { damage_deal_total: 300, playthrough_frame: 300, members: [{ origin_damage: 100 }, { origin_damage: 0 }, { origin_damage: 200 }] }
    ]
}

async function start(player: TestPlayer, questId: number = QUEST) {
    const response = await post(player, "single_battle_quest/start", {
        quest_id: questId, category: PRACTICE, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

async function clear(player: TestPlayer, elapsedMs: number, questId: number = QUEST) {
    await start(player, questId)
    const response = await post(player, "single_battle_quest/finish", {
        quest_id: questId, category: PRACTICE, score: 4321, add_mana: 0, elapsed_time_ms: elapsedMs,
        is_accomplished: true, is_restored: false, continue_count: 0, api_count: 2, play_id: "test", statistics
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

async function history(player: TestPlayer) {
    const response = await post(player, "history/practice_battle", {})
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data.history
}

test("every practice quest is a battle quest without stamina or drops", () => {
    const quests = Object.values(practiceQuests as Record<string, Record<string, unknown>>)
    assert.equal(quests.length, 58)
    for (const quest of quests) {
        assert.equal(quest.staminaCost, 0)
        assert.equal(quest.clearRewardId, undefined)
        assert.equal(quest.scoreRewardGroup, undefined)
        assert.equal(typeof quest.sPlusRankTime, "number")
    }
})

test("a practice battle starts without stamina and its clear is recorded without drops", async () => {
    const player = await newPlayer()
    const before = data.getPlayerSync(player.playerId)!
    const started = await start(player)
    assert.equal(started.user_info.stamina, before.stamina)

    const result = await clear(player, 200_000)
    assert.equal(result.category_id, PRACTICE)
    assert.deepEqual([...result.drop_score_reward_ids], [])
    assert.equal(result.rewards.reward_mana, 0)
    assert.equal(data.getPlayerSingleQuestProgressSync(player.playerId, PRACTICE, QUEST)?.finished, true)
})

test("a practice clear pays the Lignoid's armament mission, and an S+ clear its title", async () => {
    const player = await newPlayer()
    // B rank: the armament only
    await clear(player, 200_000)
    const mail = data.getPlayerAllMailSync(player.playerId).filter(entry => entry.reasonId === 60)
    assert.ok(mail.some(entry => entry.typeId === ARMAMENT), JSON.stringify(mail))
    assert.ok(!data.getPlayerDegreesSync(player.playerId).includes(TITLE))

    // S+ (at most the quest's S+ time): the title, at once
    const sPlus = (practiceQuests as Record<string, { sPlusRankTime: number }>)[String(QUEST)].sPlusRankTime
    await clear(player, sPlus)
    assert.ok(data.getPlayerDegreesSync(player.playerId).includes(TITLE))
})

test("history/practice_battle lists cleared and given-up battles, the latest first", async () => {
    const player = await newPlayer()
    assert.deepEqual([...await history(player)], [])

    await clear(player, 90_000)
    await start(player, 11)
    const aborted = await post(player, "single_battle_quest/abort", {
        quest_id: 11, category: PRACTICE, finish_kind: 1, api_count: 3, play_id: "test", statistics
    })
    assert.equal(aborted.statusCode, 200, aborted.body)

    const entries = await history(player)
    assert.equal(entries.length, 2)
    const [givenUp, cleared] = entries
    assert.equal(givenUp.quest_id, 11)
    assert.equal(givenUp.finish_kind, 1)
    assert.equal(givenUp.score, null)
    assert.equal(givenUp.clear_rank, null)
    assert.equal(givenUp.elapsed_time_ms, 15_000, "900 frames at 60 per second")

    assert.equal(cleared.quest_id, QUEST)
    assert.equal(cleared.category_id, PRACTICE)
    assert.equal(cleared.finish_kind, 0)
    assert.equal(cleared.score, 4321)
    assert.equal(cleared.elapsed_time_ms, 90_000)
    assert.equal(typeof cleared.clear_rank, "number")
    assert.equal(cleared.total_damage, 1800)
    assert.equal(cleared.character_id_1, 111001)
    assert.equal(cleared.character_id_2, null)
    assert.equal(cleared.unison_character_id_1, 111002)
    assert.equal(cleared.character_1_total_damage, 1100)
    assert.equal(cleared.character_2_total_damage, null)
    assert.equal(cleared.character_3_total_damage, 700)
    assert.equal(cleared.equipment1_id, 999999)
    assert.equal(cleared.equipment_level_1, null, "an armament the player doesn't own has no level")
    assert.match(cleared.create_time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
})
