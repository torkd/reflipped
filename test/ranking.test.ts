// FT-33: ranking event rewards. Every ranking battle, won or lost, may improve the player's record; the rank is the
// share of this server's players in the event with a better record; the rank band's rewards are mailed once during
// the results announcement (status 1, then 2; 3 without a record; result code 5109 outside it).
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";
import rankingRewards from "../assets/ranking_event_ranking_reward.json";

const apiPrefix = "/latest/api/index.php"
const RANKING = 11
// Trial by Light: battles 2022-06-28 to 07-07, results announced 07-10 14:00 to 07-17 14:00 (Japan time)
const EVENT = 2
const QUEST = 2001
const DURING = "2022-07-01T03:00:00Z"
const RESULTS = "2022-07-12T03:00:00Z"
type Band = { id: number, share: number, reasonId: number, rewards: unknown[] }
const bands = (rankingRewards as Record<string, Band[]>)[String(EVENT)]

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    // every test starts with an empty leaderboard
    const { default: getDatabase, Database } = await import("../src/data/index")
    getDatabase(Database.WDFP_DATA).prepare(`DELETE FROM players_ranking_records`).run()
})

afterEach(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
    const { default: getDatabase, Database } = await import("../src/data/index")
    getDatabase(Database.WDFP_DATA).prepare(`DELETE FROM players_ranking_records`).run()
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
    await setClock(DURING)
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    return { ...player, playerId }
}

async function battle(player: TestPlayer, accomplished: boolean, elapsedMs: number, score: number) {
    await setClock(DURING)
    const started = await post(player, "single_battle_quest/start", {
        quest_id: QUEST, category: RANKING, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
    assert.equal(started.statusCode, 200, started.body)
    const response = await post(player, "single_battle_quest/finish", {
        quest_id: QUEST, category: RANKING, score, add_mana: 0, elapsed_time_ms: elapsedMs,
        is_accomplished: accomplished, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
        statistics: {
            clear_phase: accomplished ? 4 : 2,
            party: { characters: [{ id: 111001 }, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] }
        }
    })
    assert.equal(response.statusCode, 200, response.body)
}

async function summary(player: TestPlayer) {
    const response = await post(player, "ranking_event/get_summary", { ranking_event_id: EVENT, quest_kind: 8 })
    assert.equal(response.statusCode, 200, response.body)
    return JSON.parse(JSON.stringify(decodeGameBody(response.body).data))
}

async function receive(player: TestPlayer) {
    await setClock(RESULTS)
    const response = await post(player, "ranking_event/receive_reward", { ranking_event_id: EVENT, api_count: 3 })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body)
}

test("a lost battle counts, and a full clear beats it; the faster clear is kept", async () => {
    const player = await newPlayer()
    assert.equal((await summary(player)).rank_percentage, 100, "no record yet")

    await battle(player, false, 300_000, 5000)
    assert.deepEqual((await summary(player)).best_record, { elapsed_time_ms: 300_000, is_accomplished: false, score: 5000 })
    await battle(player, true, 200_000, 3000)
    await battle(player, true, 250_000, 9000)
    await battle(player, false, 100_000, 99_999)
    const best = await summary(player)
    assert.deepEqual(best.best_record, { elapsed_time_ms: 200_000, is_accomplished: true, score: 3000 })
    assert.equal(best.leader_character_id, 111001)
    assert.equal(best.rank_percentage, 0.01, "alone on the server: the top (never 0, FT-78)")
})

test("the rank is the share of the server's players with a better record", async () => {
    const fast = await newPlayer(), middle = await newPlayer(), slow = await newPlayer()
    await battle(fast, true, 100_000, 1000)
    await battle(middle, true, 200_000, 1000)
    await battle(slow, false, 300_000, 1000)

    assert.equal((await summary(fast)).rank_percentage, 0.01)
    assert.equal(Math.round((await summary(middle)).rank_percentage), 33)
    const last = await summary(slow)
    assert.equal(Math.round(last.rank_percentage), 67)
    // the next band up: its worst place holds the middle player's record
    assert.deepEqual(last.rank_border_top, { elapsed_time_ms: 200_000, is_accomplished: true, score: 1000 })
    assert.equal((await summary(fast)).rank_border_top, null, "nothing above the top band")
})

test("the band's rewards are mailed once during the results announcement", async () => {
    const top = await newPlayer(), other = await newPlayer(), absent = await newPlayer()
    await battle(top, true, 100_000, 1000)
    await battle(other, true, 200_000, 1000)

    // during the battles: out of the receivable period
    await setClock(DURING)
    const early = await post(top, "ranking_event/receive_reward", { ranking_event_id: EVENT, api_count: 3 })
    assert.equal(decodeGameBody(early.body).data_headers.result_code, 5109)

    const received = await receive(top)
    assert.equal(received.data.status, 1)
    assert.equal(received.data.rank_percentage, 0.01)
    const topMail = data.getPlayerAllMailSync(top.playerId).filter(mail => mail.reasonId === bands[0].reasonId)
    assert.equal(topMail.length, bands[0].rewards.length, "the S+ band's rewards")

    assert.equal((await receive(top)).data.status, 2, "received before")
    assert.equal(data.getPlayerAllMailSync(top.playerId).filter(mail => mail.reasonId === bands[0].reasonId).length, bands[0].rewards.length)

    // 50 % of the server is better: the band covering 50 %
    const second = await receive(other)
    assert.equal(second.data.status, 1)
    const band = bands.find(candidate => 50 <= candidate.share * 100)!
    assert.equal(data.getPlayerAllMailSync(other.playerId).filter(mail => mail.reasonId === band.reasonId).length, band.rewards.length)

    const none = await receive(absent)
    assert.equal(none.data.status, 3)
})
