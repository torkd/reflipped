// FIX-1: a quest's mana score reward adds to free mana (it used to set free mana to the bead count plus the
// reward), and a mana clear reward is no longer overwritten by the quest finish's own player update.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";
import storyEventSingleQuests from "../assets/story_event_single_quest.json";
import scoreRewards from "../assets/score_reward.json";
import clearRewards from "../assets/clear_reward.json";

const apiPrefix = "/latest/api/index.php"
const STORY_EVENT_SINGLE = 10
const MANA = 4
const EXP = 5

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let player: TestPlayer
let playerId: number
let data: typeof import("../src/data/wdfpData")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    player = await createTestPlayer(fastify)

    // the data layer opens the test database, so import it only after createTestServer()
    data = await import("../src/data/wdfpData")
    const session = await data.getSession(String(player.viewerId))
    playerId = (await data.getAccountPlayers(session!.accountId))[0]
    // distinct balances, so mana built from the bead count shows up
    data.updatePlayerSync({ id: playerId, freeMana: 50000, freeVmoney: 777, expPool: 1000 })
})

after(async () => {
    await cleanup()
})

interface RawQuest { manaReward: number, poolExpReward: number, scoreRewardGroup: number, clearRewardId?: number }

function quest(questId: number): RawQuest {
    return (storyEventSingleQuests as unknown as Record<string, RawQuest>)[String(questId)]
}

/** The total of a score reward group's fixed rewards of one currency, as granted without a boost point (count × 10). */
function scoreRewardTotal(groupId: number, rewardType: number): number {
    const group = (scoreRewards as unknown as Record<string, { type: number, reward_type?: number, count?: number }[]>)[String(groupId)]
    assert.ok(group.every(reward => reward.type === 0), "the group has no random rare pool")
    return group.filter(reward => reward.reward_type === rewardType).reduce((sum, reward) => sum + reward.count! * 10, 0)
}

async function post(route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ viewer_id: player.viewerId, ...body })
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

/** Plays a quest through start and finish with an empty party, slower than every rank time, so it skips the S+ reward. */
async function playQuest(questId: number) {
    await post("single_battle_quest/start", {
        quest_id: questId, category: STORY_EVENT_SINGLE, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
    return await post("single_battle_quest/finish", {
        quest_id: questId, category: STORY_EVENT_SINGLE, score: 1000, add_mana: 0, elapsed_time_ms: 700000,
        is_accomplished: true, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
        statistics: {
            clear_phase: 0,
            party: { characters: [null, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] }
        }
    })
}

test("a mana score reward raises free mana by the reward and leaves beads alone", async () => {
    // 100002007: mana and exp score rewards; its clear reward (beads) is taken on the first run
    const questId = 100002007
    const { manaReward, poolExpReward, scoreRewardGroup } = quest(questId)
    const scoreMana = scoreRewardTotal(scoreRewardGroup, MANA)
    const scoreExp = scoreRewardTotal(scoreRewardGroup, EXP)
    assert.ok(scoreMana > 0 && scoreExp > 0)
    await playQuest(questId)

    const before = data.getPlayerSync(playerId)!
    const result = await playQuest(questId)
    const after = data.getPlayerSync(playerId)!

    assert.equal(after.freeMana, before.freeMana + manaReward + scoreMana)
    assert.equal(after.freeVmoney, before.freeVmoney, "beads unchanged")
    assert.equal(after.expPool, before.expPool + poolExpReward + scoreExp)
    assert.ok(result.drop_score_reward_ids.some((drop: { number: number }) => drop.number === scoreMana))

    // the reply carries the stored balances
    assert.equal(result.user_info.free_mana, after.freeMana)
    assert.equal(result.user_info.free_vmoney, after.freeVmoney)
    assert.equal(result.user_info.exp_pool, after.expPool)
})

test("a mana clear reward is kept along with the score reward", async () => {
    // 200004001: first clear gives mana (clear reward 104), plus a mana score reward
    const questId = 200004001
    const { manaReward, scoreRewardGroup, clearRewardId } = quest(questId)
    const clearReward = (clearRewards as unknown as Record<string, { type: number, count: number }>)[String(clearRewardId)]
    assert.equal(clearReward.type, MANA)
    const scoreMana = scoreRewardTotal(scoreRewardGroup, MANA)

    const before = data.getPlayerSync(playerId)!
    const result = await playQuest(questId)
    const after = data.getPlayerSync(playerId)!

    assert.equal(after.freeMana, before.freeMana + manaReward + clearReward.count + scoreMana)
    assert.equal(after.freeVmoney, before.freeVmoney, "beads unchanged")
    assert.equal(result.user_info.free_mana, after.freeMana)
})
