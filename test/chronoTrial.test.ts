// FT-11: Chrono Trials' border rewards. A clear pays each clear-time tier it newly reaches, once, by mail under the
// tier's reason; the finish reply's solo_time_attack_event lists them with the clear time and the previous best.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";
import clearTimeRewards from "../assets/solo_time_attack_clear_time_reward.json";

const apiPrefix = "/latest/api/index.php"
const EXPERT = 21
const SOLO_TIME_ATTACK = 25
const CHRONO = 1001
type Tier = { id: number, seconds: number, reasonId: number, rewards: { kind: number, id?: number, number: number }[] }
const tiers = (clearTimeRewards as Record<string, Record<string, Tier[]>>)["1"]["1"]

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

/** A player with the six Hell Solo Boss Challenges cleared, so Chrono Trials are open. */
async function newPlayer(): Promise<TestPlayer & { playerId: number }> {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date("2025-01-03T12:00:00Z"))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    const loaded = await post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    assert.equal(loaded.statusCode, 200, loaded.body)
    for (const questId of [1002, 1004, 1006, 1008, 1010, 1012]) data.insertPlayerQuestProgressSync(playerId, EXPERT, { questId, finished: true, clearRank: 1 })
    return { ...player, playerId }
}

async function play(player: TestPlayer, elapsedMs: number, accomplished: boolean = true) {
    const started = await post(player, "single_battle_quest/start", {
        quest_id: CHRONO, category: SOLO_TIME_ATTACK, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
    assert.equal(started.statusCode, 200, started.body)
    const response = await post(player, "single_battle_quest/finish", {
        quest_id: CHRONO, category: SOLO_TIME_ATTACK, score: 1000, add_mana: 0, elapsed_time_ms: elapsedMs,
        is_accomplished: accomplished, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
        statistics: {
            clear_phase: 0,
            party: { characters: [null, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] }
        }
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

function borderMail(playerId: number) {
    return data.getPlayerAllMailSync(playerId).filter(mail => mail.reasonId !== undefined && mail.reasonId >= 15001 && mail.reasonId <= 15007)
}

const expected = (fromMs: number, toMs: number | null) => tiers.filter(tier => fromMs <= tier.seconds * 1000 && (toMs === null || toMs > tier.seconds * 1000))

test("each border tier pays once, by mail, as the clear time improves", async () => {
    const player = await newPlayer()

    // 4 min 10 s: every tier from 7 minutes down to 4 min 10 s, the 5-minute title among them
    const first = await play(player, 250_000)
    const firstTiers = expected(250_000, null)
    assert.deepEqual([...first.solo_time_attack_event.reward_ids], firstTiers.map(tier => tier.id))
    assert.equal(first.solo_time_attack_event.elapsed_time_ms, 250_000)
    assert.equal(first.solo_time_attack_event.previous_best_elapsed_time_ms, undefined)
    assert.equal(first.mail_arrived, true)
    assert.equal(borderMail(player.playerId).length, firstTiers.reduce((sum, tier) => sum + tier.rewards.length, 0))
    assert.ok(borderMail(player.playerId).some(mail => mail.type === 13 && mail.typeId === 54530), "the 5-minute title")

    // slower: nothing new
    const slower = await play(player, 400_000)
    assert.deepEqual([...slower.solo_time_attack_event.reward_ids], [])
    assert.equal(slower.solo_time_attack_event.previous_best_elapsed_time_ms, 250_000)

    // under a minute: the rest, 1,000 beads in all over the three clears
    const fastest = await play(player, 59_000)
    assert.deepEqual([...fastest.solo_time_attack_event.reward_ids], expected(59_000, 250_000).map(tier => tier.id))
    const beads = borderMail(player.playerId).filter(mail => mail.type === 4).reduce((sum, mail) => sum + mail.number, 0)
    assert.equal(beads, tiers.reduce((sum, tier) => sum + tier.rewards.filter(reward => reward.kind === 2).reduce((total, reward) => total + reward.number, 0), 0))
    assert.equal(beads, 1000)
})

test("a lost Chrono Trial reaches no tier", async () => {
    const player = await newPlayer()
    const lost = await play(player, 100_000, false)
    assert.deepEqual([...lost.solo_time_attack_event.reward_ids], [])
    assert.deepEqual(borderMail(player.playerId), [])
})
