// FT-7: Solo Boss Challenges. A quest starts with an attempt left (daily challenge point 1), at the rank it needs and
// after the quest the game shows it after; a clear spends an attempt and sends the new count, and the first S+ clear
// pays the quest's S+ chest. Their missions (quest kind 14) count.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";
import playerRankPoints from "../assets/player_rank.json";
import clearRewards from "../assets/clear_reward.json";
import expertQuests from "../assets/expert_single_event_quest.json";

const apiPrefix = "/latest/api/index.php"
const EXPERT = 21
const MAIN = 1
const CLOCK = "2025-01-03T12:00:00Z"
// Regitare Godly+ (needs rank 80 and main quest 1-8-2) and its Hell quest (needs 1001)
const GODLY = 1001
const HELL = 1002
const TICKET = 999003

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

async function load(player: TestPlayer) {
    const response = await post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

/** A player at `rank`, with the attempts of the day (the first /load's daily reset) and main quest 1-8-2 cleared. */
async function newPlayer(rank: number, mainCleared: boolean = true): Promise<TestPlayer & { playerId: number }> {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(CLOCK))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    data.updatePlayerSync({ id: playerId, rankPoint: (playerRankPoints as number[])[rank - 1] })
    if (mainCleared) data.insertPlayerQuestProgressSync(playerId, MAIN, { questId: 1008002, finished: true, clearRank: 1 })
    await load(player)
    return { ...player, playerId }
}

function start(player: TestPlayer, questId: number) {
    return post(player, "single_battle_quest/start", {
        quest_id: questId, category: EXPERT, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
}

async function finish(player: TestPlayer, questId: number, elapsedMs: number) {
    const response = await post(player, "single_battle_quest/finish", {
        quest_id: questId, category: EXPERT, score: 1000, add_mana: 0, elapsed_time_ms: elapsedMs,
        is_accomplished: true, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
        statistics: {
            clear_phase: 0,
            party: { characters: [null, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] }
        }
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

/** The attempts entries of a reply, without their campaigns (a new player's default save lists a closed one). */
function plain(value: unknown): unknown {
    return (value as { id: number, point: number }[]).map(entry => ({ id: entry.id, point: entry.point }))
}

function attempts(playerId: number): number | undefined {
    return data.getPlayerDailyChallengePointListSync(playerId).find(entry => entry.id === 1)?.point
}

test("a Solo Boss Challenge needs its rank and the quest before it", async () => {
    const low = await newPlayer(79)
    assert.equal((await start(low, GODLY)).statusCode, 400)

    const noMain = await newPlayer(80, false)
    assert.equal((await start(noMain, GODLY)).statusCode, 400)

    const player = await newPlayer(80)
    assert.equal((await start(player, HELL)).statusCode, 400)
    assert.equal((await start(player, GODLY)).statusCode, 200)
})

test("a clear spends an attempt and sends the count; at none left the quest can't start", async () => {
    const player = await newPlayer(80)
    assert.equal(attempts(player.playerId), 2)

    // a quest given up keeps its attempt
    assert.equal((await start(player, GODLY)).statusCode, 200)
    assert.equal((await post(player, "single_battle_quest/abort", { quest_id: GODLY, category: EXPERT, play_id: "test", api_count: 2, finish_kind: 0, statistics: {} })).statusCode, 200)
    assert.equal(attempts(player.playerId), 2)

    assert.equal((await start(player, GODLY)).statusCode, 200)
    const first = await finish(player, GODLY, 1_000_000)
    assert.deepEqual(plain(first.user_daily_challenge_point_list), [{ id: 1, point: 1 }])

    // the Hell quest opens with its Godly+ cleared, and shares the attempts
    assert.equal((await start(player, HELL)).statusCode, 200)
    assert.deepEqual(plain((await finish(player, HELL, 1_000_000)).user_daily_challenge_point_list), [{ id: 1, point: 0 }])
    assert.equal((await start(player, GODLY)).statusCode, 400)

    // the next game day refills them
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date("2025-01-04T21:00:00Z"))
    await load(player)
    assert.equal(attempts(player.playerId), 2)
    assert.equal((await start(player, GODLY)).statusCode, 200)
})

test("the first S+ clear pays the S+ chest, once", async () => {
    const player = await newPlayer(80)
    const chest = (clearRewards as unknown as Record<string, { type: number, id?: number, count: number }>)[String((expertQuests as Record<string, { sPlusRewardId?: number }>)[String(GODLY)].sPlusRewardId)]
    assert.deepEqual({ type: chest.type, id: chest.id, count: chest.count }, { type: 0, id: TICKET, count: 1 })
    const before = data.getPlayerItemSync(player.playerId, TICKET) ?? 0

    // S+ is within 390 s
    assert.equal((await start(player, GODLY)).statusCode, 200)
    await finish(player, GODLY, 120_000)
    assert.equal(data.getPlayerItemSync(player.playerId, TICKET), before + 1)

    assert.equal((await start(player, GODLY)).statusCode, 200)
    await finish(player, GODLY, 120_000)
    assert.equal(data.getPlayerItemSync(player.playerId, TICKET), before + 1)
})

test("a clear counts for the Solo Boss Challenge titles", async () => {
    const player = await newPlayer(80)
    assert.equal((await start(player, GODLY)).statusCode, 200)
    await finish(player, GODLY, 1_000_000)
    // 57010: clear Regitare (event 1, quest 1) once
    const mission = data.getPlayerMissionsSync(player.playerId, 5).find(entry => entry.missionId === 57010)
    assert.ok(mission !== undefined && (mission.progress > 0 || mission.clearedStage > 0), JSON.stringify(mission))
})
