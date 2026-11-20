// Co-Op Challenge seasons (FT-34, the client's boss battle multi pickups: `quest/boss_battle/boss_battle_multi_pickup_event`
// and its `_schedule`, converted into `assets/boss_battle_multi_pickup.json`). A season puts one boss battle stage at a time
// in the spotlight; a co-op battle against it gives the season's rate (1.5, 2 or 3) times the Boss Coins, exp and mana:
// "When you defeat the featured boss in a multiplayer battle during the spotlight period, you'll earn x::rate:: the Boss
// Coins, EXP, and mana!" (ui_string `boss_battle_multi_pickup_description_message`; the wiki's Co-Op Challenge page says
// the same). The client only shows the rate, so the server pays it. Solo battles get nothing extra.
//
// The schedule also has an additional score reward column (`getAdditionalRewardKeyByBossBattleMultiPickupByParam` lists
// it as extra drops), but it is empty in every global row, so a spotlight adds no drops.

import pickups from "../../assets/boss_battle_multi_pickup.json";
import { masterDate } from "../utils";
import { isContentPeriodOpen } from "./eventSchedule";
import { rangeCovers } from "./questRanges";
import type { RewardBoosts } from "./rewardCampaigns";
import { QuestCategory } from "./types";

interface Spotlight {
    chapterId: number
    stageNodeId: number
    start: string
    end: string
}

interface Season {
    rate: number
    start: string
    end: string
    spotlights: Spotlight[]
}

const data = pickups as { bossCoinItemIds: number[], seasons: Record<string, Season> }

const bossCoins = new Set(data.bossCoinItemIds)

/** QuestRangeReferenceIdKind 2: a boss battle range (chapter, stage node, quest). */
const BOSS_BATTLE_RANGE = 2

const open = (start: string, end: string, date: Date) =>
    isContentPeriodOpen(masterDate(start).getTime(), masterDate(end).getTime(), date)

/** Whether an item is a Boss Coin (Denarius; item/item category 6). */
export function isBossCoinItem(itemId: number): boolean {
    return bossCoins.has(itemId)
}

/**
 * The Co-Op Challenge rate for a boss battle quest at a date: the highest rate of the open seasons whose open spotlight
 * is on the quest's stage, or 1. Periods are projected like every event's when event scheduling is on.
 */
export function coopChallengeRate(category: QuestCategory, questId: number, date: Date): number {
    if (category !== QuestCategory.BOSS_BATTLE) return 1
    let rate = 1
    for (const season of Object.values(data.seasons)) {
        if (season.rate <= rate || !open(season.start, season.end, date)) continue
        const covered = season.spotlights.some(spotlight => open(spotlight.start, spotlight.end, date)
            && rangeCovers(BOSS_BATTLE_RANGE, [[spotlight.chapterId], [spotlight.stageNodeId], null], category, questId))
        if (covered) rate = season.rate
    }
    return rate
}

/**
 * A co-op battle's boosts with the Co-Op Challenge rate on top: exp and mana take the higher of the two, Boss Coins get
 * their own rate (other drops keep the campaigns' item rate), as overlapping reward campaigns don't stack either.
 */
export function withCoopChallenge(boosts: RewardBoosts, rate: number): RewardBoosts {
    if (rate <= 1) return boosts
    return {
        ...boosts,
        exp: Math.max(boosts.exp, rate),
        mana: Math.max(boosts.mana, rate),
        bossCoin: Math.max(boosts.bossCoin ?? 1, rate)
    }
}

/** The rate an item drop is boosted by: the item rate, or the Boss Coin rate for a Boss Coin if that is higher. */
export function itemBoost(boosts: RewardBoosts, itemId: number): number {
    return boosts.bossCoin !== undefined && isBossCoinItem(itemId) ? Math.max(boosts.item, boosts.bossCoin) : boosts.item
}
