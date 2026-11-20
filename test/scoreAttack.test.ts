// FT-11: Score Scramble. Every battle scores, won or lost: each score border pays once, by mail under reason 16001,
// the finish reply's score_attack_event lists the borders and the party, and history/score_attack_event_battle lists
// the recent battles. Also covers the party slots Chrono Trials send back (`{id}` objects in the finish body).
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";
import borderRewards from "../assets/score_attack_border_reward.json";

const apiPrefix = "/latest/api/index.php"
const SCORE_ATTACK = 27
const EXPERT = 21
const SOLO_TIME_ATTACK = 25
const QUEST = 1001
type Tier = { id: number, score: number, reasonId: number, rewards: { kind: number, id?: number, number: number }[] }
const tiers = (borderRewards as Record<string, Record<string, Tier[]>>)["1"]["1"]

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

async function play(player: TestPlayer, category: number, questId: number, score: number, accomplished: boolean) {
    const started = await post(player, "single_battle_quest/start", {
        quest_id: questId, category, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
    assert.equal(started.statusCode, 200, started.body)
    const response = await post(player, "single_battle_quest/finish", {
        quest_id: questId, category, score, add_mana: 0, elapsed_time_ms: 90_000,
        is_accomplished: accomplished, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
        statistics: {
            clear_phase: 0,
            party: {
                characters: [{ id: 111001 }, null, { id: 111003 }], unison_characters: [{ id: 111002 }, null, null],
                equipments: [null, null, null], ability_soul_ids: [null, null, null]
            },
            zones: [{ damage_deal_total: 1200 }, { damage_deal_total: 300 }]
        }
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

function borderMail(playerId: number) {
    return data.getPlayerAllMailSync(playerId).filter(mail => mail.reasonId === 16001)
}

const passed = (score: number, previous: number | null) => tiers.filter(tier => score >= tier.score && (previous === null || previous < tier.score))

test("each score border pays once, won or lost, and the reply lists them with the party", async () => {
    const player = await newPlayer()
    const first = tiers[2].score + 1
    // a lost battle scores too
    const lost = await play(player, SCORE_ATTACK, QUEST, first, false)
    assert.deepEqual([...lost.score_attack_event.reward_ids], passed(first, null).map(tier => tier.id))
    assert.deepEqual({ ...lost.score_attack_event.main_character_ids }, { "0": 111001, "2": 111003 })
    assert.equal(lost.mail_arrived, true)
    assert.equal(borderMail(player.playerId).length, passed(first, null).reduce((sum, tier) => sum + tier.rewards.length, 0))

    // a lower score: nothing; a higher one: only the borders newly passed
    assert.deepEqual([...(await play(player, SCORE_ATTACK, QUEST, 10, true)).score_attack_event.reward_ids], [])
    const second = tiers[5].score
    assert.deepEqual([...(await play(player, SCORE_ATTACK, QUEST, second, true)).score_attack_event.reward_ids], passed(second, first).map(tier => tier.id))
    const coins = borderMail(player.playerId).reduce((sum, mail) => sum + mail.number, 0)
    assert.equal(coins, passed(second, null).reduce((sum, tier) => sum + tier.rewards.reduce((total, reward) => total + reward.number, 0), 0))
})

test("history/score_attack_event_battle lists the event's battles, the latest first", async () => {
    const player = await newPlayer()
    await play(player, SCORE_ATTACK, QUEST, 500, false)
    await play(player, SCORE_ATTACK, QUEST, 900, true)

    const response = await post(player, "history/score_attack_event_battle", { event_id: 1 })
    assert.equal(response.statusCode, 200, response.body)
    const history = decodeGameBody(response.body).data.history
    assert.equal(history.length, 2)
    assert.equal(history[0].score, 900)
    assert.equal(history[0].finish_kind, 0)
    assert.equal(history[1].finish_kind, 1, "a lost battle shows as retired")
    assert.equal(history[0].category_id, SCORE_ATTACK)
    assert.equal(history[0].quest_id, QUEST)
    assert.equal(history[0].total_damage, 1500)
    assert.equal(history[0].character_id_1, 111001)
    assert.equal(history[0].character_id_2, null)
    assert.equal(history[0].unison_character_id_1, 111002)
    assert.match(history[0].create_time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

    const other = await post(player, "history/score_attack_event_battle", { event_id: 2 })
    assert.deepEqual([...decodeGameBody(other.body).data.history], [])
})

test("Chrono Trials send the party's units, not the finish body's slot objects", async () => {
    const player = await newPlayer()
    for (const questId of [1002, 1004, 1006, 1008, 1010, 1012]) data.insertPlayerQuestProgressSync(player.playerId, EXPERT, { questId, finished: true, clearRank: 1 })
    data.setPlayerDailyChallengePointSync(player.playerId, 5001, 10)
    const result = await play(player, SOLO_TIME_ATTACK, 1001, 0, true)
    assert.deepEqual({ ...result.solo_time_attack_event.main_character_ids }, { "0": 111001, "2": 111003 })
})
