// FT-33 device test 2026-11-16: a Score Scramble battle whose party is wiped out ends with single_battle_quest/abort
// (the game's quest-failure exit), not with finish. It is in history/score_attack_event_battle as retired, with its
// damage and no score; the best score and the score borders stay as they were.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const SCORE_ATTACK = 27
const QUEST = 1001

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
        characters: [{ id: 111001 }, { id: 111003 }, null], unison_characters: [{ id: 111005 }, null, null],
        equipments: [{ id: 5040022 }, null, null], ability_soul_ids: [null, null, null]
    },
    zones: [{ damage_deal_total: 15344, playthrough_frame: 1200 }]
}

async function start(player: TestPlayer) {
    await post(player, "single_battle_quest/start", {
        quest_id: QUEST, category: SCORE_ATTACK, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
}

test("a wiped-out Score Scramble battle (abort) is in the history as retired, with its damage and no score", async () => {
    const player = await newPlayer()

    // a scored battle first, then a wipe
    await start(player)
    await post(player, "single_battle_quest/finish", {
        quest_id: QUEST, category: SCORE_ATTACK, score: 2_000_000, add_mana: 0, elapsed_time_ms: 90_000,
        is_accomplished: true, is_restored: false, continue_count: 0, api_count: 2, play_id: "test", statistics
    })
    const mails = data.getPlayerAllMailSync(player.playerId).filter(mail => mail.reasonId === 16001).length
    assert.ok(mails > 0, "the scored battle passed a border")

    await start(player)
    await post(player, "single_battle_quest/abort", { quest_id: QUEST, category: SCORE_ATTACK, finish_kind: 1, api_count: 3, play_id: "test", statistics })

    const history = (await post(player, "history/score_attack_event_battle", { event_id: 1 })).history
    assert.equal(history.length, 2)
    assert.equal(history[0].score, null, "no score for a retired battle")
    assert.equal(history[0].finish_kind, 1)
    assert.equal(history[0].clear_rank, null)
    assert.equal(history[0].total_damage, 15344)
    assert.equal(history[0].elapsed_time_ms, 20_000, "from the battle's frames")
    assert.equal(history[0].character_id_1, 111001)
    assert.equal(history[0].unison_character_id_1, 111005)
    assert.equal(history[0].equipment1_id, 5040022)
    assert.equal(history[1].score, 2_000_000)

    assert.equal(data.getPlayerScoreAttackBestSync(player.playerId, QUEST), 2_000_000, "the best score stays")
    assert.equal(data.getPlayerAllMailSync(player.playerId).filter(mail => mail.reasonId === 16001).length, mails, "no border pays")
})

test("an abort of another mode adds nothing to the Score Scramble history", async () => {
    const player = await newPlayer()
    await post(player, "single_battle_quest/start", {
        quest_id: 1001002, category: 1, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
    await post(player, "single_battle_quest/abort", { quest_id: 1001002, category: 1, finish_kind: 1, api_count: 2, play_id: "test", statistics })
    assert.equal((await post(player, "history/score_attack_event_battle", { event_id: 1 })).history.length, 0)
})
