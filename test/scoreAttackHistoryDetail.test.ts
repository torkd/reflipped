// FT-86: the Score Scramble history detail shows each unit's damage and each armament's level and enhancement, which
// the client reads as character_<n>_total_damage, equipment_level_<n> and enhancement_level_<n>. Each slot's damage is
// its zone members' origin_damage summed over the zones (the members add up to the zone's damage_deal_total).
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const SCORE_ATTACK = 27
const QUEST = 1001
const ARMAMENT = 5040022

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

// two zones; slot 2 is empty, so its member's damage is not reported
const statistics = {
    clear_phase: 0,
    party: {
        characters: [{ id: 111001 }, null, { id: 111003 }], unison_characters: [null, null, null],
        equipments: [{ id: ARMAMENT }, null, null], ability_soul_ids: [null, null, null]
    },
    zones: [
        { damage_deal_total: 1500, playthrough_frame: 600, members: [{ origin_damage: 1000 }, { origin_damage: 0 }, { origin_damage: 500 }] },
        { damage_deal_total: 300, playthrough_frame: 600, members: [{ origin_damage: 200 }, { origin_damage: 0 }, { origin_damage: 100 }] }
    ]
}

async function start(player: TestPlayer) {
    await post(player, "single_battle_quest/start", {
        quest_id: QUEST, category: SCORE_ATTACK, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
}

test("a scored and a retired battle list each unit's damage and the armament's levels", async () => {
    const player = await newPlayer()
    const { givePlayerEquipmentSync } = await import("../src/lib/equipment")
    givePlayerEquipmentSync(player.playerId, ARMAMENT, 1)
    data.updatePlayerEquipmentSync(player.playerId, ARMAMENT, { level: 3, enhancementLevel: 2 })

    await start(player)
    await post(player, "single_battle_quest/finish", {
        quest_id: QUEST, category: SCORE_ATTACK, score: 900, add_mana: 0, elapsed_time_ms: 20_000,
        is_accomplished: true, is_restored: false, continue_count: 0, api_count: 2, play_id: "test", statistics
    })
    await start(player)
    await post(player, "single_battle_quest/abort", { quest_id: QUEST, category: SCORE_ATTACK, finish_kind: 1, api_count: 3, play_id: "test", statistics })

    const history = (await post(player, "history/score_attack_event_battle", { event_id: 1 })).history
    assert.equal(history.length, 2)
    for (const entry of history) {
        assert.equal(entry.total_damage, 1800)
        assert.deepEqual([entry.character_1_total_damage, entry.character_2_total_damage, entry.character_3_total_damage], [1200, null, 600])
        assert.deepEqual([entry.equipment1_id, entry.equipment_level_1, entry.enhancement_level_1], [ARMAMENT, 3, 2])
        assert.deepEqual([entry.equipment_level_2, entry.enhancement_level_2], [null, null])
    }
    assert.equal(history[0].score, null, "the retired one")
    assert.equal(history[1].score, 900)
})

test("a battle recorded before the per-unit fields lists them as null", async () => {
    const player = await newPlayer()
    data.insertPlayerScoreAttackBattleSync(player.playerId, {
        eventId: 1, questId: QUEST, score: 500, elapsedTimeMs: 1000, clearRank: null, finishKind: 0, totalDamage: 77,
        party: { characters: [111001, null, null], unisonCharacters: [null, null, null], equipments: [null, null, null], abilitySouls: [null, null, null] },
        createTime: new Date("2025-01-03T12:00:00Z")
    })
    const [entry] = (await post(player, "history/score_attack_event_battle", { event_id: 1 })).history
    assert.equal(entry.character_id_1, 111001)
    assert.equal(entry.character_1_total_damage, null)
    assert.equal(entry.equipment_level_1, null)
})
