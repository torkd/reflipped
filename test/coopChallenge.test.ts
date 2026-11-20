// FT-34: Co-Op Challenge seasons (boss battle multi pickups). Season 1 (2021-08-27 14:00 to 09-28 04:59:59, Japan time,
// rate 1.5) puts Arch Accursed (boss battle stage 12, quests 1012xxx) in the spotlight until 08-28 23:59:59, then
// Regitare (stage 3, quests 1003xxx) on 08-29. A co-op battle against the spotlight's boss pays 1.5 times the Boss Coins,
// exp and mana; a solo one doesn't.
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const BOSS_BATTLE = 2
const MAIN = 1
const ARCH_ACCURSED = 1012001
const REGITARE = 1003001
// UTC; Japan time is 9 hours ahead
const ARCH_SPOTLIGHT = "2021-08-28T03:00:00Z"
const ARCH_SPOTLIGHT_LAST_SECOND = "2021-08-28T14:59:59Z"
const REGITARE_SPOTLIGHT = "2021-08-28T15:00:00Z"
const NO_SEASON = "2021-10-01T03:00:00Z"
const SEASON_8 = "2022-08-30T03:00:00Z" // rate 3

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let pickup: typeof import("../src/lib/bossBattlePickup")
let setServerTime: typeof import("../src/utils").setServerTime

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    pickup = await import("../src/lib/bossBattlePickup")
    setServerTime = (await import("../src/utils")).setServerTime
})

afterEach(() => setServerTime(null))

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

/** Clears Arch Accursed at a date, solo or as a co-op battle (the co-op start marks the player's quest as co-op). */
async function clearArchAccursed(date: string, coop: boolean) {
    setServerTime(new Date(date))
    const player = await createTestPlayer(fastify)
    await post(player, "single_battle_quest/start", {
        quest_id: ARCH_ACCURSED, category: BOSS_BATTLE, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
    if (coop) {
        const { markActiveQuestCoop } = await import("../src/routes/api/singleBattleQuest")
        markActiveQuestCoop(data.getViewerPlayerIdSync(player.viewerId)!, true)
    }
    return await post(player, "single_battle_quest/finish", {
        quest_id: ARCH_ACCURSED, category: BOSS_BATTLE, score: 1000, add_mana: 0, elapsed_time_ms: 600_000,
        is_accomplished: true, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
        statistics: { clear_phase: 0, party: { characters: [{ id: 1 }, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] } }
    })
}

describe("the spotlight's rate", () => {
    test("covers the spotlight's boss stage during its period, to its last second", () => {
        const at = (date: string) => new Date(date)
        assert.equal(pickup.coopChallengeRate(BOSS_BATTLE, ARCH_ACCURSED, at(ARCH_SPOTLIGHT)), 1.5)
        assert.equal(pickup.coopChallengeRate(BOSS_BATTLE, ARCH_ACCURSED + 3, at(ARCH_SPOTLIGHT)), 1.5, "every difficulty of the stage")
        assert.equal(pickup.coopChallengeRate(BOSS_BATTLE, ARCH_ACCURSED, at(ARCH_SPOTLIGHT_LAST_SECOND)), 1.5)
        assert.equal(pickup.coopChallengeRate(BOSS_BATTLE, REGITARE, at(ARCH_SPOTLIGHT)), 1, "another boss in the same season")
        // the next spotlight: Regitare from 08-29 00:00 Japan time
        assert.equal(pickup.coopChallengeRate(BOSS_BATTLE, ARCH_ACCURSED, at(REGITARE_SPOTLIGHT)), 1)
        assert.equal(pickup.coopChallengeRate(BOSS_BATTLE, REGITARE, at(REGITARE_SPOTLIGHT)), 1.5)
        assert.equal(pickup.coopChallengeRate(BOSS_BATTLE, ARCH_ACCURSED, at(NO_SEASON)), 1)
        // a main quest with the same id shape isn't a boss battle
        assert.equal(pickup.coopChallengeRate(MAIN, ARCH_ACCURSED, at(ARCH_SPOTLIGHT)), 1)
    })

    test("is the season's own rate", () => {
        const at = new Date(SEASON_8)
        const rates = [1003001, 1009001, 1010001, 1012001, 1014001, 1016001, 1020001].map(questId => pickup.coopChallengeRate(BOSS_BATTLE, questId, at))
        assert.ok(rates.includes(3), `season 8's spotlight pays 3 (rates: ${rates})`)
    })

    test("raises Boss Coins, exp and mana, not other drops", async () => {
        const { NO_BOOSTS } = await import("../src/lib/rewardCampaigns")
        const boosts = pickup.withCoopChallenge({ item: 1.2, exp: 2, mana: 1 }, 1.5)
        assert.deepEqual(boosts, { item: 1.2, exp: 2, mana: 1.5, bossCoin: 1.5 }, "the higher rate of each kind")
        assert.equal(pickup.itemBoost(boosts, 40110), 1.5, "a Boss Coin")
        assert.equal(pickup.itemBoost(boosts, 1), 1.2, "another item keeps the campaigns' rate")
        assert.equal(pickup.withCoopChallenge(NO_BOOSTS, 1), NO_BOOSTS)
        assert.equal(pickup.isBossCoinItem(40000), true)
        assert.equal(pickup.isBossCoinItem(1), false)
    })
})

describe("a boss battle finish", () => {
    test("in co-op during the spotlight pays 1.5 times the mana and pooled exp", async () => {
        const plain = await clearArchAccursed(NO_SEASON, true)
        const boosted = await clearArchAccursed(ARCH_SPOTLIGHT, true)
        assert.ok(plain.rewards.reward_mana > 0)
        // rounded down, as every earned amount (scaleEarnedAmount)
        assert.equal(boosted.rewards.reward_mana, Math.floor(plain.rewards.reward_mana * 1.5))
        assert.equal(boosted.rewards.reward_pool_exp, Math.floor(plain.rewards.reward_pool_exp * 1.5))
    })

    test("solo during the spotlight pays the usual amounts", async () => {
        const plain = await clearArchAccursed(NO_SEASON, false)
        const solo = await clearArchAccursed(ARCH_SPOTLIGHT, false)
        assert.equal(solo.rewards.reward_mana, plain.rewards.reward_mana)
        assert.equal(solo.rewards.reward_pool_exp, plain.rewards.reward_pool_exp)
    })

    test("Boss Coin drops are multiplied, other drops aren't", async () => {
        const { givePlayerScoreRewardsSync } = await import("../src/lib/quest")
        const { RewardType, ScoreRewardType } = await import("../src/lib/types")
        const player = await createTestPlayer(fastify)
        const playerId = data.getViewerPlayerIdSync(player.viewerId)!
        const coin = [{ type: ScoreRewardType.ITEM, reward_type: RewardType.ITEM, id: 40110, count: 4, rarity: 1000 }] as any
        const material = [{ type: ScoreRewardType.ITEM, reward_type: RewardType.ITEM, id: 1, count: 4, rarity: 1000 }] as any
        const boosts = pickup.withCoopChallenge({ item: 1, exp: 1, mana: 1 }, 2)
        assert.equal(givePlayerScoreRewardsSync(playerId, 1, coin, false, undefined, 1, 1, boosts).drop_score_reward_ids[0].number, 8)
        assert.equal(givePlayerScoreRewardsSync(playerId, 1, material, false, undefined, 1, 1, boosts).drop_score_reward_ids[0].number, 4)
    })
})
