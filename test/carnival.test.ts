// FT-11: the Hanifolk Carnival. carnival_event/index and get_party serve the event's party sets (copied from the normal
// parties at first) and the bosses' records; a clear scores the difficulty's base plus a millisecond-per-point time
// bonus, keeps each boss's best with its party (a new party starts it over, a unit locked by another boss voids it),
// and the total of the bests pays each total score reward once, by mail.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";
import totalScoreRewards from "../assets/carnival_event_total_score_reward.json";

const apiPrefix = "/latest/api/index.php"
const CARNIVAL = 22
// event 1's Godly quests: Flashfire (boss 1), Wavesurge (2), Swiftgale (3); 2,650,000 base, 15-minute limit
const GODLY = [1003, 1006, 1009]
const BASE = 2_650_000
const LIMIT_MS = 900_000
const tiers = (totalScoreRewards as Record<string, { id: number, score: number, rewards: unknown[] }[]>)["1"]

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

async function clear(player: TestPlayer, questId: number, elapsedMs: number, units: number[]) {
    const started = await post(player, "single_battle_quest/start", {
        quest_id: questId, category: CARNIVAL, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
    assert.equal(started.statusCode, 200, started.body)
    const response = await post(player, "single_battle_quest/finish", {
        quest_id: questId, category: CARNIVAL, score: 1000, add_mana: 0, elapsed_time_ms: elapsedMs,
        is_accomplished: true, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
        statistics: {
            clear_phase: 0,
            party: {
                characters: units.map(id => ({ id })), unison_characters: [null, null, null],
                equipments: [null, null, null], ability_soul_ids: [null, null, null]
            }
        }
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data.carnival_event
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value))

test("index and get_party serve the event's party sets and the bosses' records", async () => {
    const player = await newPlayer()
    const index = await post(player, "carnival_event/index", { event_id: 1 })
    assert.equal(index.statusCode, 200, index.body)
    const first = decodeGameBody(index.body).data
    assert.deepEqual(plain(first.records), [])
    assert.ok(first.user_party_group_list.length > 0, "a copy of the normal party groups")
    assert.ok(first.user_party_group_list[0].party_list.length > 0)
    // the copy is saved under the Carnival's category, apart from the normal parties
    assert.ok(Object.keys(data.getPlayerPartyGroupListSync(player.playerId, 2 as never)).length > 0)

    await clear(player, GODLY[0], 90_000, [111001, 111002, 111003])
    const party = await post(player, "carnival_event/get_party", {})
    assert.deepEqual(plain(decodeGameBody(party.body).data.user_party_group_list), plain(first.user_party_group_list))
    const records = decodeGameBody((await post(player, "carnival_event/index", { event_id: 1 })).body).data.records
    assert.deepEqual(plain(records), [{
        folder_id: 1, best_score: BASE + LIMIT_MS - 90_000, previous_score: BASE + LIMIT_MS - 90_000,
        previous_character_ids: [111001, 111002, 111003], previous_unison_character_ids: [null, null, null]
    }])
})

test("a clear scores the base plus the time left, and the total pays each threshold once", async () => {
    const player = await newPlayer()
    const first = await clear(player, GODLY[0], 90_000, [111001, 111002, 111003])
    assert.deepEqual(plain(first.score), { difficulty_bonus: BASE, time_bonus: LIMIT_MS - 90_000 })
    assert.equal(first.is_record_valid, true)
    assert.equal(first.leader_character_id, 111001)
    assert.equal(first.previous_total_best_score, 0)

    await clear(player, GODLY[1], 90_000, [112001, 112002, 112003])
    const third = await clear(player, GODLY[2], 90_000, [113001, 113002, 113003])
    const total = 3 * (BASE + LIMIT_MS - 90_000)
    assert.equal(third.previous_total_best_score, 2 * (BASE + LIMIT_MS - 90_000))
    const reached = tiers.filter(tier => tier.score <= total).map(tier => tier.id)
    assert.ok(reached.length > 0)
    const mails = data.getPlayerAllMailSync(player.playerId).filter(mail => mail.subject === "Hanifolk Carnival" || (mail.reasonId === 20001 || mail.reasonId === 20002))
    assert.equal(mails.length, tiers.filter(tier => tier.score <= total).reduce((sum, tier) => sum + tier.rewards.length, 0))

    // a new party on boss 1 starts its record over (lower), and climbing back pays nothing twice
    const reset = await clear(player, GODLY[0], 600_000, [114001, 114002, 114003])
    assert.equal(reset.is_record_valid, true)
    assert.deepEqual(plain(reset.reward_ids), [])
    const again = await clear(player, GODLY[0], 90_000, [114001, 114002, 114003])
    assert.deepEqual(plain(again.reward_ids), [])
})

test("a unit another boss's record holds voids the clear", async () => {
    const player = await newPlayer()
    await clear(player, GODLY[0], 90_000, [111001, 111002, 111003])
    const reused = await clear(player, GODLY[1], 90_000, [112001, 111002, 112003])
    assert.equal(reused.is_record_valid, false)
    assert.deepEqual(plain(reused.reward_ids), [])
    const records = decodeGameBody((await post(player, "carnival_event/index", { event_id: 1 })).body).data.records
    assert.deepEqual(plain(records).map((record: { folder_id: number }) => record.folder_id), [1])
})
