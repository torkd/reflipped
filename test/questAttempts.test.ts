// FT-30: quests with their own attempts. World story bosses (one a day) and one-off event quests spend theirs on a
// clear; Chrono Trials spend theirs when the battle starts, keep it spent after a loss, and unlock after the six Hell
// Solo Boss Challenges. A quest without an attempt left can't start, and the replies carry the new count.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const STORY_EVENT_SINGLE = 10
const WORLD_STORY_EVENT = 18
const EXPERT = 21
const SOLO_TIME_ATTACK = 25
// Painted Dragon Adv. (point 2: 1 a day, 2021-08-22 to 2022-06-11)
const WORLD_BOSS = 100400015
// Mushroom Madness 2, day 1 (point 62: one attempt, 2022-12-05 14:00 to 2022-12-06 13:59 Japan time)
const EVENT_QUEST = 200007001
const CHRONO = 1001
const CHRONO_POINT = 5001

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

async function load(player: TestPlayer, date: string) {
    await setClock(date)
    const response = await post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    assert.equal(response.statusCode, 200, response.body)
}

async function newPlayer(date: string): Promise<TestPlayer & { playerId: number }> {
    await setClock(date)
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    await load(player, date)
    return { ...player, playerId }
}

function start(player: TestPlayer, category: number, questId: number) {
    return post(player, "single_battle_quest/start", {
        quest_id: questId, category, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
}

async function finish(player: TestPlayer, category: number, questId: number, accomplished: boolean = true) {
    const response = await post(player, "single_battle_quest/finish", {
        quest_id: questId, category, score: 1000, add_mana: 0, elapsed_time_ms: 1_000_000,
        is_accomplished: accomplished, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
        statistics: {
            clear_phase: 0,
            party: { characters: [null, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] }
        }
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

function abort(player: TestPlayer, category: number, questId: number) {
    return post(player, "single_battle_quest/abort", { quest_id: questId, category, play_id: "test", api_count: 2, finish_kind: 0, statistics: {} })
}

function attempts(playerId: number, pointId: number): number | undefined {
    return data.getPlayerDailyChallengePointListSync(playerId).find(entry => entry.id === pointId)?.point
}

/** The ids and points of a reply's attempts list. */
function sent(list: unknown): unknown {
    return (list as { id: number, point: number }[] | undefined)?.map(entry => ({ id: entry.id, point: entry.point }))
}

test("a world story boss's daily attempt is spent by a clear and comes back the next day", async () => {
    const player = await newPlayer("2022-01-10T12:00:00Z")
    assert.equal(attempts(player.playerId, 2), 1)

    // given up: kept
    assert.equal((await start(player, WORLD_STORY_EVENT, WORLD_BOSS)).statusCode, 200)
    assert.equal((await abort(player, WORLD_STORY_EVENT, WORLD_BOSS)).statusCode, 200)
    assert.equal(attempts(player.playerId, 2), 1)

    assert.equal((await start(player, WORLD_STORY_EVENT, WORLD_BOSS)).statusCode, 200)
    assert.deepEqual(sent((await finish(player, WORLD_STORY_EVENT, WORLD_BOSS)).user_daily_challenge_point_list), [{ id: 2, point: 0 }])
    assert.equal((await start(player, WORLD_STORY_EVENT, WORLD_BOSS)).statusCode, 400)

    await load(player, "2022-01-11T21:00:00Z")
    assert.equal(attempts(player.playerId, 2), 1)
    assert.equal((await start(player, WORLD_STORY_EVENT, WORLD_BOSS)).statusCode, 200)
})

test("a one-off event quest's attempt is given once and not refilled", async () => {
    // 15:00 in Japan on 5 December 2022: the point is open
    const player = await newPlayer("2022-12-05T06:00:00Z")
    assert.equal(attempts(player.playerId, 62), 1)

    assert.equal((await start(player, STORY_EVENT_SINGLE, EVENT_QUEST)).statusCode, 200)
    assert.deepEqual(sent((await finish(player, STORY_EVENT_SINGLE, EVENT_QUEST)).user_daily_challenge_point_list), [{ id: 62, point: 0 }])

    // the next game day, still within the point's period: no new attempt
    await load(player, "2022-12-05T21:00:00Z")
    assert.equal(attempts(player.playerId, 62), 0)
    assert.equal((await start(player, STORY_EVENT_SINGLE, EVENT_QUEST)).statusCode, 400)
})

test("a Chrono Trial needs the six Hell Solo Boss Challenges and spends its attempt at the start", async () => {
    const player = await newPlayer("2025-01-03T12:00:00Z")
    assert.equal(attempts(player.playerId, CHRONO_POINT), 10)
    assert.equal((await start(player, SOLO_TIME_ATTACK, CHRONO)).statusCode, 400)

    for (const questId of [1002, 1004, 1006, 1008, 1010]) data.insertPlayerQuestProgressSync(player.playerId, EXPERT, { questId, finished: true, clearRank: 1 })
    assert.equal((await start(player, SOLO_TIME_ATTACK, CHRONO)).statusCode, 400, "one Hell quest left")
    data.insertPlayerQuestProgressSync(player.playerId, EXPERT, { questId: 1012, finished: true, clearRank: 1 })

    const started = await start(player, SOLO_TIME_ATTACK, CHRONO)
    assert.equal(started.statusCode, 200)
    assert.deepEqual(sent(decodeGameBody(started.body).data.user_daily_challenge_point_list), [{ id: CHRONO_POINT, point: 9 }])
    // a loss doesn't give it back, and a finish spends nothing more
    const lost = await finish(player, SOLO_TIME_ATTACK, CHRONO, false)
    assert.equal(lost.user_daily_challenge_point_list, undefined)
    assert.equal(attempts(player.playerId, CHRONO_POINT), 9)

    data.setPlayerDailyChallengePointSync(player.playerId, CHRONO_POINT, 0)
    assert.equal((await start(player, SOLO_TIME_ATTACK, CHRONO)).statusCode, 400)
})

test("quests without attempts start as before", async () => {
    const player = await newPlayer("2025-01-03T12:00:00Z")
    const before = data.getPlayerDailyChallengePointListSync(player.playerId)
    // the first main quest battle
    const started = await start(player, 1, 1001002)
    assert.equal(started.statusCode, 200)
    assert.equal(decodeGameBody(started.body).data.user_daily_challenge_point_list, undefined)
    assert.deepEqual(data.getPlayerDailyChallengePointListSync(player.playerId), before)
})
