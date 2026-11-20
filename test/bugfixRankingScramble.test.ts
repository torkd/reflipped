// FT-78: the ranking event's rank-reward claim (status 1) opened the client's result dialog, which failed with
// Error #1009 (F1009) when the player's rank_percentage was 0. The dialog animates the rank table up to the player's
// percentage; at 0 the table height reaches 1 and the rank it draws comes to 0, so it reads a rank row that doesn't
// exist. The server now never sends a percentage below MIN_RANK_PERCENTAGE.
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
let ranking: typeof import("../src/lib/ranking")

async function clearBoard() {
    const { default: getDatabase, Database } = await import("../src/data/index")
    getDatabase(Database.WDFP_DATA).prepare(`DELETE FROM players_ranking_records`).run()
}

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    ranking = await import("../src/lib/ranking")
    await clearBoard()
})

afterEach(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
    await clearBoard()
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

async function battle(player: TestPlayer, elapsedMs: number) {
    await setClock(DURING)
    const started = await post(player, "single_battle_quest/start", {
        quest_id: QUEST, category: RANKING, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
    assert.equal(started.statusCode, 200, started.body)
    const response = await post(player, "single_battle_quest/finish", {
        quest_id: QUEST, category: RANKING, score: 1000, add_mana: 0, elapsed_time_ms: elapsedMs,
        is_accomplished: true, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
        statistics: {
            clear_phase: 4,
            party: { characters: [{ id: 111001 }, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] }
        }
    })
    assert.equal(response.statusCode, 200, response.body)
}

/**
 * The rank the client's result dialog draws at the end of its rank-table animation, for a percentage: the rank
 * rating is the first band whose share covers it, the table height is that band's place from the bottom plus the
 * part of the band above the percentage, and the drawn rank is ceil((1 - height) * bands). It must be a real band
 * (1 or more), since the dialog reads `ranks[rank - 1]`.
 */
function drawnRank(rankPercentage: number): number {
    const p = rankPercentage / 100
    const n = bands.length
    let index = bands.findIndex(band => band.share >= p)
    if (index < 0) index = n - 1
    const previous = index > 0 ? bands[index - 1].share : 0
    const height = (1 / n) * (n - index - 1 + (bands[index].share - p) / (bands[index].share - previous))
    return Math.ceil((1 - height) * n)
}

test("the client's dialog draws no rank for 0 % (the F1009), and the top band for the minimum", () => {
    assert.equal(drawnRank(0), 0, "what the client did with 0")
    assert.equal(drawnRank(ranking.MIN_RANK_PERCENTAGE), 1)
    for (const band of bands) assert.ok(drawnRank(band.share * 100) >= 1)
    assert.equal(drawnRank(100), bands.length)
})

test("a player alone on the server is at the top, with a percentage above 0", async () => {
    const player = await newPlayer()
    await battle(player, 200_000)
    const response = await post(player, "ranking_event/get_summary", { ranking_event_id: EVENT, quest_kind: 8 })
    const summary = decodeGameBody(response.body).data
    assert.equal(summary.rank_percentage, ranking.MIN_RANK_PERCENTAGE)
    assert.ok(drawnRank(summary.rank_percentage) >= 1)
})

test("the first rank-rewards claim (status 1) sends a percentage the dialog can draw, and the top band's rewards", async () => {
    const top = await newPlayer(), other = await newPlayer()
    await battle(top, 100_000)
    await battle(other, 200_000)

    await setClock(RESULTS)
    const first = await post(top, "ranking_event/receive_reward", { ranking_event_id: EVENT, api_count: 3 })
    assert.equal(first.statusCode, 200, first.body)
    const reply = decodeGameBody(first.body).data
    assert.equal(reply.status, 1)
    assert.ok(reply.rank_percentage > 0, "never 0")
    assert.equal(drawnRank(reply.rank_percentage), 1, "the S+ row")
    const mails = data.getPlayerAllMailSync(top.playerId).filter(mail => mail.reasonId === bands[0].reasonId)
    assert.equal(mails.length, bands[0].rewards.length, "still the S+ band's rewards")

    const second = decodeGameBody((await post(top, "ranking_event/receive_reward", { ranking_event_id: EVENT, api_count: 4 })).body).data
    assert.equal(second.status, 2)

    // the second player's percentage is unchanged: half the board is ahead
    const behind = decodeGameBody((await post(other, "ranking_event/receive_reward", { ranking_event_id: EVENT, api_count: 3 })).body).data
    assert.equal(behind.status, 1)
    assert.equal(behind.rank_percentage, 50)
})
