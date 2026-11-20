// FT-37: reward boost campaigns. While a campaign is open, the quests in its range pay more of one kind of reward: here
// Material Gathering Season (2023-09-27 to 10-10, Japan time), which boosts the Kaleidoscope dailies' drops and the
// exp/mana dailies' exp and mana by 1.5, and the Necropolis Depths' drops.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const DAILY_EXP_MANA = 14
const DAILY_WEEK = 6
const CHALLENGE_DUNGEON = 13
const MAIN = 1
const QUEST = 1001
// inside and outside Material Gathering Season (UTC; the season starts at 14:00 Japan time on 27 September)
const IN_SEASON = "2023-10-01T03:00:00Z"
const OUT_OF_SEASON = "2023-11-01T03:00:00Z"

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let campaigns: typeof import("../src/lib/rewardCampaigns")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    campaigns = await import("../src/lib/rewardCampaigns")
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

async function clearAt(date: string) {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(date))
    const player = await createTestPlayer(fastify)
    await post(player, "single_battle_quest/start", {
        quest_id: QUEST, category: DAILY_EXP_MANA, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
    return await post(player, "single_battle_quest/finish", {
        quest_id: QUEST, category: DAILY_EXP_MANA, score: 1000, add_mana: 0, elapsed_time_ms: 60_000,
        is_accomplished: true, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
        statistics: { clear_phase: 0, party: { characters: [{ id: 1 }, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] } }
    })
}

test("the open campaigns' boosts follow their quest ranges and periods", () => {
    const at = (date: string) => new Date(date)
    assert.deepEqual(campaigns.rewardBoostsFor(DAILY_EXP_MANA, QUEST, at(IN_SEASON)), { item: 1, exp: 1.5, mana: 1.5 })
    assert.deepEqual(campaigns.rewardBoostsFor(DAILY_WEEK, 1001, at(IN_SEASON)), { item: 1.5, exp: 1, mana: 1 })
    // the Necropolis: the Depths (quests 1002-1019) only, not Door to the Depths or the Treasure Zone
    assert.equal(campaigns.rewardBoostsFor(CHALLENGE_DUNGEON, 1002, at(IN_SEASON)).item, 1.5)
    assert.equal(campaigns.rewardBoostsFor(CHALLENGE_DUNGEON, 1001, at(IN_SEASON)).item, 1)
    assert.equal(campaigns.rewardBoostsFor(CHALLENGE_DUNGEON, 2001, at(IN_SEASON)).item, 1)
    assert.deepEqual(campaigns.rewardBoostsFor(MAIN, 1001002, at(IN_SEASON)), campaigns.NO_BOOSTS)
    assert.deepEqual(campaigns.rewardBoostsFor(DAILY_EXP_MANA, QUEST, at(OUT_OF_SEASON)), campaigns.NO_BOOSTS)
})

test("a boosted quest pays its mana and pooled exp at the campaign's rate", async () => {
    const plain = await clearAt(OUT_OF_SEASON)
    const boosted = await clearAt(IN_SEASON)
    assert.equal(plain.rewards.reward_mana, 300)
    assert.equal(plain.rewards.reward_pool_exp, 300)
    assert.equal(boosted.rewards.reward_mana, 450)
    assert.equal(boosted.rewards.reward_pool_exp, 450)
})

test("score drops of the boosted kind are multiplied, the others aren't", async () => {
    const { givePlayerScoreRewardsSync } = await import("../src/lib/quest")
    const { RewardType, ScoreRewardType } = await import("../src/lib/types")
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(OUT_OF_SEASON))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    const group = [
        { type: ScoreRewardType.ITEM, reward_type: RewardType.ITEM, id: 1, count: 4, rarity: 1000 },
    ] as any
    const plain = givePlayerScoreRewardsSync(playerId, 1, group, false, undefined, 1, 1)
    const boosted = givePlayerScoreRewardsSync(playerId, 1, group, false, undefined, 1, 1, { item: 2, exp: 1, mana: 1 })
    const manaOnly = givePlayerScoreRewardsSync(playerId, 1, group, false, undefined, 1, 1, { item: 1, exp: 1, mana: 2 })
    assert.equal(plain.drop_score_reward_ids[0].number, 4)
    assert.equal(boosted.drop_score_reward_ids[0].number, 8)
    assert.equal(manaOnly.drop_score_reward_ids[0].number, 4)
})

test("a fraction of a boosted drop is paid by chance", async () => {
    const { boostedCount, scoreRewardDrops } = await import("../src/lib/quest")
    const random = scoreRewardDrops.random
    try {
        scoreRewardDrops.random = () => 0.4
        assert.equal(boostedCount(1, 1.5), 2, "below the fraction (0.5): one more")
        scoreRewardDrops.random = () => 0.6
        assert.equal(boostedCount(1, 1.5), 1)
        assert.equal(boostedCount(3, 2), 6, "a whole rate needs no chance")
        assert.equal(boostedCount(5, 1), 5)
    } finally {
        scoreRewardDrops.random = random
    }
})
