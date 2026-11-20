// Every co-op battle earns at the boss multiplier, whatever category its quest reports: the event co-op quests (advent,
// "Ilco Opus") are not in the boss categories, which let the general multiplier through on a real device (2026-11-01).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestServer, readCapturedRoute } from "./helpers";
import { gameRequest as coopRequest, newViewer } from "./coopHelpers";

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let policy: typeof import("../src/lib/rewardPolicy")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    policy = await import("../src/lib/rewardPolicy")
})
after(async () => { policy.setRewardPolicy({ management: "managed", multiplierOverride: null, bossMultiplierOverride: null }); await cleanup() })

const gameRequest = (route: string, body: Record<string, unknown>) => coopRequest(fastify, route, body)

test("a co-op battle in an event quest earns at the boss multiplier, a solo one of the same quest at the general one", async () => {
    // advent event quest 1002 ("Ilco Opus Inter."): mana 80, pool exp 112, rank points 27
    const { getQuestFromCategorySync } = await import("../src/lib/assets")
    const quest = getQuestFromCategorySync(7, 1002) as import("../src/lib/types").BattleQuest
    assert.equal(quest.manaReward, 80)
    policy.setRewardPolicy({ management: "managed", multiplierOverride: 2, bossMultiplierOverride: 5 })
    const rooms = await import("../src/lib/coop/rooms")
    const capturedFinish = readCapturedRoute("multi_battle_quest_finish")

    for (const category of [7, 8]) {
        const viewerId = await newViewer(fastify)
        const created = await gameRequest("multi_battle_quest/create_room", { viewer_id: viewerId, quest_id: 1002, party_id: 11, category })
        const roomNumber = created.data.room_number
        rooms.startRound(rooms.getRoom(String(roomNumber))!, [viewerId])
        await gameRequest("multi_battle_quest/start", { viewer_id: viewerId, quest_id: 1002, category, party_id: 11, room_number: roomNumber,
            play_id: `BOSS${category}`, use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: true, mate_player_ids: [] })
        const finished = await gameRequest("multi_battle_quest/finish", { ...capturedFinish.requestBody, viewer_id: viewerId, quest_id: 1002, category })
        assert.equal(finished.data.rewards.reward_mana, quest.manaReward * 5, `co-op category ${category}`)
        assert.equal(finished.data.rewards.reward_pool_exp, quest.poolExpReward * 5, `co-op category ${category}`)
    }

    // the same quest played alone is a plain event quest: the general multiplier
    const solo = await newViewer(fastify)
    await gameRequest("single_battle_quest/start", { viewer_id: solo, quest_id: 1002, category: 7, party_id: 1, use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, play_id: "SOLO" })
    const soloFinish = await gameRequest("single_battle_quest/finish", { ...readCapturedRoute("single_battle_quest_finish").requestBody, viewer_id: solo, quest_id: 1002, category: 7 })
    assert.equal(soloFinish.data.rewards.reward_mana, quest.manaReward * 2)
})
