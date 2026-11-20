// Score reward groups pay out as the original game's did: the fixed items are one weighted lottery (field5, in 1/1000),
// a hit drops that entry's own count (not the whole group, and not ten times its count), and the rare pool slots roll
// their rarity once and pick from their pool by its rarity weights. The groups below are the ones in the captured
// finish replies (docs/routes/{single,multi}_battle_quest_finish.md).
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { createTestPlayer, createTestServer } from "./helpers";
import scoreRewards from "../assets/score_reward.json";
import rareScoreRewards from "../assets/rare_score_reward.json";

let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let quest: typeof import("../src/lib/quest")
let playerId: number
const saved: { rolls?: number, random?: () => number } = {}

before(async () => {
    const server = await createTestServer()
    cleanup = server.cleanup
    const account = await createTestPlayer(server.fastify)
    data = await import("../src/data/wdfpData")
    quest = await import("../src/lib/quest")
    const session = await data.getSession(String(account.viewerId))
    playerId = (await data.getAccountPlayers(session!.accountId))[0]
    saved.rolls = quest.scoreRewardDrops.rolls
    saved.random = quest.scoreRewardDrops.random
})
afterEach(() => {
    quest.scoreRewardDrops.rolls = saved.rolls!
    quest.scoreRewardDrops.random = saved.random!
})
after(async () => { await cleanup?.() })

const group = (id: number) => (scoreRewards as unknown as Record<string, any[]>)[String(id)]
const sequence = (values: number[]) => { let next = 0; return () => values[next++ % values.length] }
/** A small deterministic generator, so the distribution test never flakes. */
function seeded(seed: number) {
    let state = seed >>> 0
    return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32 }
}

test("a hit drops the entry's own count at its own position, in the weights' proportions", () => {
    // 11000209: five fixed entries of the same item, counts 30 to 50, weights 105/90/100/70/35 (40 % of a draw hits)
    const entries = group(11000209).filter(entry => entry.type === 0)
    const weights = entries.map(entry => entry.field5)
    assert.deepEqual(weights, [105, 90, 100, 70, 35])
    quest.scoreRewardDrops.rolls = 4000
    quest.scoreRewardDrops.random = seeded(7)
    const result = quest.givePlayerScoreRewardsSync(playerId, 11000209, entries)
    const hits = new Map<number, number>()
    for (const drop of result.drop_score_reward_ids) {
        assert.equal(drop.group_id, 11000209)
        assert.equal(drop.number, entries[drop.index - 1].count, "the entry's count, ×1")
        hits.set(drop.index, (hits.get(drop.index) ?? 0) + 1)
    }
    entries.forEach((entry, position) => {
        const expected = 4000 * entry.field5 / 1000
        const actual = hits.get(position + 1) ?? 0
        assert.ok(Math.abs(actual - expected) < 0.2 * expected + 15, `entry ${position + 1}: ${actual} hits, ${expected} expected`)
    })
    const total = result.drop_score_reward_ids.length
    assert.ok(total > 1400 && total < 1800, `about 40 % of 4000 draws hit, got ${total}`)
})

test("a draw past the weights drops nothing", () => {
    const entries = group(11000209).filter(entry => entry.type === 0)
    quest.scoreRewardDrops.rolls = 10
    quest.scoreRewardDrops.random = () => 0.5   // the weights end at 400 of 1000
    const result = quest.givePlayerScoreRewardsSync(playerId, 11000209, entries)
    assert.deepEqual(result.drop_score_reward_ids, [])
    assert.deepEqual(result.user_info, { free_mana: 0, free_vmoney: 0, exp_pool: 0 })
})

test("a certain entry pays its count on every draw, with no ten-fold on top", () => {
    // 30001: one mana entry, count 2, weight 1000
    const before = data.getPlayerSync(playerId)!.freeMana
    const result = quest.givePlayerScoreRewardsSync(playerId, 30001, group(30001))
    assert.equal(result.drop_score_reward_ids.length, quest.scoreRewardDrops.rolls)
    assert.ok(result.drop_score_reward_ids.every(drop => drop.index === 1 && drop.number === 2))
    assert.equal(data.getPlayerSync(playerId)!.freeMana - before, 2 * quest.scoreRewardDrops.rolls)
})

test("rare pool slots roll their rarity once and pick by the pool's weights", () => {
    // 2126: counts 25 / 26 / 27 of item 1 with rarities 0.2 / 0.5 / 0.3 (index 1, 2, 3)
    const pool = (rareScoreRewards as unknown as Record<string, { rarity: number, count: number }[]>)["2126"]
    assert.deepEqual(pool.map(reward => reward.rarity), [0.2, 0.5, 0.3])
    const slot = [{ name: "", type: 1, id: 2126, rarity: 0.5 }] as any[]
    // hit (0.4 < 0.5), then 0.1 / 0.3 / 0.69 / 0.71 / 0.99 of the pool's weights (0.2 and 0.7 are the edges)
    for (const [point, index] of [[0.1, 1], [0.3, 2], [0.69, 2], [0.71, 3], [0.99, 3]] as const) {
        quest.scoreRewardDrops.random = sequence([0.4, point])
        const result = quest.givePlayerScoreRewardsSync(playerId, 1, slot)
        assert.deepEqual(result.drop_rare_reward_ids.map(drop => [drop.group_id, drop.index, drop.number]),
            [[2126, index, pool[index - 1].count]], `point ${point}`)
    }
    // a miss (0.5 is not below 0.5) drops nothing and leaves the pool alone
    quest.scoreRewardDrops.random = sequence([0.5, 0.1])
    assert.deepEqual(quest.givePlayerScoreRewardsSync(playerId, 1, slot).drop_rare_reward_ids, [])
})

test("a group of rarity 1 rare slots drops once per slot, as the captured quest 2006 reply did", () => {
    const slots = group(2106)
    assert.equal(slots.length, 15)
    const result = quest.givePlayerScoreRewardsSync(playerId, 2106, slots)
    assert.equal(result.drop_rare_reward_ids.length, 15)
    assert.equal(result.drop_score_reward_ids.length, 0)
    const perPool = new Map<number, number>()
    for (const drop of result.drop_rare_reward_ids) perPool.set(drop.group_id, (perPool.get(drop.group_id) ?? 0) + 1)
    assert.deepEqual([...perPool].sort(), [[2126, 4], [2127, 4], [2128, 3], [2129, 1], [2130, 1], [2131, 2]])
})

test("the boost point doubles each hit's count and the multiplier scales it once", () => {
    quest.scoreRewardDrops.rolls = 1
    quest.scoreRewardDrops.random = () => 0
    const before = data.getPlayerSync(playerId)!.freeMana
    const result = quest.givePlayerScoreRewardsSync(playerId, 30001, group(30001), true, undefined, 3)
    assert.deepEqual(result.drop_score_reward_ids.map(drop => drop.number), [12])   // 2 × 2 (boost) × 3
    assert.equal(data.getPlayerSync(playerId)!.freeMana - before, 12)
})

test("each quest draws as often as its master row says", async () => {
    const { getQuestFromCategorySync } = await import("../src/lib/assets")
    const { QuestCategory } = await import("../src/lib/types")
    const battleQuest = (category: number, id: number) => getQuestFromCategorySync(category, id) as import("../src/lib/types").BattleQuest
    // the column before the score reward group: 18 for the captured boss, 5 and 10 for two story event quests
    const boss = battleQuest(QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE, 500009002)
    assert.equal(boss.scoreRewardGroupId, 11000209)
    assert.equal(boss.scoreRewardRolls, 18)
    assert.equal(battleQuest(QuestCategory.STORY_EVENT_SINGLE, 100002007).scoreRewardRolls, 5)
    assert.equal(battleQuest(QuestCategory.STORY_EVENT_SINGLE, 200004001).scoreRewardRolls, 10)
    // the draws follow it: every draw hits the first entry (weights start at 105 of 1000)
    quest.scoreRewardDrops.random = () => 0
    const result = quest.givePlayerScoreRewardsSync(playerId, boss.scoreRewardGroupId, boss.scoreRewardGroup, false, undefined, undefined, boss.scoreRewardRolls)
    assert.equal(result.drop_score_reward_ids.length, 18)
    assert.ok(result.drop_score_reward_ids.every(drop => drop.index === 1 && drop.number === 30))
})
