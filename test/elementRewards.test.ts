// FT-26: element and aether rewards (the client's QuestRewardKind 6 and 7) give the item `reward/reward_element_map`
// picks by their rarity and the quest's enemy element, which the converter derives from the quest's recommended
// element the way the client does. They appear as common score reward entries (reward_type 6) and in rare pools.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createTestPlayer, createTestServer } from "./helpers";
import scoreRewards from "../assets/score_reward.json";
import rareScoreRewards from "../assets/rare_score_reward.json";
import rewardElementMap from "../assets/reward_element_map.json";
import mainQuests from "../assets/main_quest.json";
import exQuests from "../assets/ex_quest.json";
import towerQuests from "../assets/tower_dungeon_event_quest.json";

type Entry = { type: number, reward_type?: number, id: number, count: number, field5?: number }
const groups = scoreRewards as unknown as Record<string, Entry[]>
const rarePools = rareScoreRewards as unknown as Record<string, Entry[]>
const elementMap = rewardElementMap as Record<string, Record<string, Record<string, number>>>

let cleanup: () => Promise<void>
let fastify: Awaited<ReturnType<typeof createTestServer>>["fastify"]

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

function hasElementReward(groupId: number): boolean {
    return (groups[String(groupId)] ?? []).some(entry =>
        (entry.type === 0 && (entry.reward_type === 6 || entry.reward_type === 7))
        || (entry.type === 1 && (rarePools[String(entry.id)] ?? []).some(reward => reward.type === 6 || reward.type === 7)))
}

test("every quest with an element or aether reward has an enemy element", () => {
    let checked = 0
    for (const quests of [mainQuests, exQuests, towerQuests] as unknown as Record<string, { scoreRewardGroup?: number, enemyElement?: number }>[]) {
        for (const [questId, quest] of Object.entries(quests)) {
            if (quest.scoreRewardGroup === undefined || !hasElementReward(quest.scoreRewardGroup)) continue
            checked++
            assert.ok(quest.enemyElement !== undefined && quest.enemyElement >= 0 && quest.enemyElement <= 5, `${questId} has an enemy element`)
        }
    }
    assert.ok(checked > 500)
})

test("an element or aether reward maps to its element's item", async () => {
    const { elementRewardItemId, resolveElementReward } = await import("../src/lib/quest")
    assert.equal(elementRewardItemId(6, 1, 2), elementMap["1"]["1"]["2"])
    assert.equal(elementRewardItemId(7, 4, 5), elementMap["2"]["4"]["5"])
    assert.equal(elementRewardItemId(0, 1, 2), undefined)
    assert.equal(elementRewardItemId(6, 1, undefined), undefined)
    assert.deepEqual(resolveElementReward({ type: 6, id: 3, count: 4 } as never, 0), { type: 0, id: elementMap["1"]["3"]["0"], count: 4 })
})

test("a main quest's common element drops pay its enemy element's orbs", async () => {
    const { getQuestFromCategorySync, getScoreRewardGroup } = await import("../src/lib/assets")
    const { givePlayerScoreRewardsSync } = await import("../src/lib/quest")
    const { QuestCategory } = await import("../src/lib/types")
    const data = await import("../src/data/wdfpData")

    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]

    // 8006002: score reward group 40155, eight common element entries (rarities 1-3) and two rare pools
    const quest = getQuestFromCategorySync(QuestCategory.MAIN, 8006002) as { scoreRewardGroupId: number, enemyElement?: number }
    assert.equal(quest.scoreRewardGroupId, 40155)
    const element = quest.enemyElement!
    assert.notEqual(element, undefined)

    const expected = new Map<number, number>()
    for (const entry of groups["40155"]) {
        if (entry.type !== 0 || entry.reward_type !== 6) continue
        const itemId = elementMap["1"][String(entry.id)][String(element)]
        expected.set(itemId, (expected.get(itemId) ?? 0) + entry.count)
    }
    assert.equal(expected.size, 3)
    const before = new Map([...expected.keys()].map(itemId => [itemId, data.getPlayerItemSync(playerId, itemId) ?? 0]))

    // the common entries are a weighted lottery (src/lib/quest.ts): one draw landing in the middle of each of the eight
    // entries' weights, so each drops once at its own count, and both rare pool slots miss
    const { scoreRewardDrops } = await import("../src/lib/quest")
    const entries = groups["40155"].filter(entry => entry.type === 0)
    let cumulative = 0
    const points = entries.map(entry => { const middle = (cumulative + entry.field5! / 2) / 1000; cumulative += entry.field5!; return middle })
    const savedRandom = scoreRewardDrops.random
    const draws = [...points, 0.99, 0.99]
    scoreRewardDrops.random = () => draws.shift()!
    let result: ReturnType<typeof givePlayerScoreRewardsSync>
    try { result = givePlayerScoreRewardsSync(playerId, 40155, getScoreRewardGroup(40155)!, false, element, undefined, entries.length) }
    finally { scoreRewardDrops.random = savedRandom }
    for (const [itemId, count] of expected) {
        assert.equal(data.getPlayerItemSync(playerId, itemId), before.get(itemId)! + count, `item ${itemId}`)
    }
    // every common entry is reported with what it paid
    const commons = result.drop_score_reward_ids.filter(drop => drop.group_id === 40155)
    assert.equal(commons.length, 8)
    assert.ok(commons.every(drop => drop.number > 0))
})
