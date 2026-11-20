// The client's QuestRangeReferenceIdKind: a quest kind code and up to three id lists naming a range of quests (stamina
// campaigns and quests without a stamina refund, FT-25; collect item event drops, FT-2).

import { QuestCategory } from "./types";

/** The id lists of a range; null (the master's "(None)") matches any. */
export type IdLists = (number[] | null)[]

/** The quest categories of the client's QuestRangeReferenceIdKind codes (stamina campaigns, quests without refunds). */
export const RANGE_KIND_CATEGORIES: Record<number, QuestCategory[]> = {
    0: [QuestCategory.MAIN],
    1: [QuestCategory.EX],
    2: [QuestCategory.BOSS_BATTLE],
    3: [QuestCategory.DAILY_WEEK_EVENT],
    4: [QuestCategory.DAILY_EXP_MANA_EVENT],
    5: [QuestCategory.ADVENT_EVENT_SINGLE, QuestCategory.ADVENT_EVENT_MULTI],
    6: [QuestCategory.STORY_EVENT_SINGLE],
    7: [QuestCategory.CHALLENGE_DUNGEON_EVENT],
    8: [QuestCategory.RANKING_EVENT_SINGLE],
    9: [QuestCategory.WORLD_STORY_EVENT],
    10: [QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE],
    11: [QuestCategory.PRACTICE],
    12: [QuestCategory.DAILY_WEEK_EVENT, QuestCategory.DAILY_EXP_MANA_EVENT, QuestCategory.CHALLENGE_DUNGEON_EVENT, QuestCategory.TOWER_DUNGEON_EVENT],
    13: [QuestCategory.TOWER_DUNGEON_EVENT],
    14: [QuestCategory.EXPERT_SINGLE_EVENT],
    15: [QuestCategory.CARNIVAL_EVENT],
    16: [QuestCategory.RAID_EVENT],
    17: [QuestCategory.RUSH_EVENT],
    18: [QuestCategory.SOLO_TIME_ATTACK_EVENT],
    19: [QuestCategory.HARD_MULTI_EVENT],
    20: [QuestCategory.SCORE_ATTACK_EVENT]
}

/** Main, EX and boss quest ids have three levels (`a * 1,000,000 + b * 1,000 + c`), event quests two (event, quest). */
function questIdLevels(category: QuestCategory, questId: number): (number | null)[] {
    if (category === QuestCategory.MAIN || category === QuestCategory.EX || category === QuestCategory.BOSS_BATTLE) {
        return [Math.floor(questId / 1_000_000), Math.floor(questId / 1000) % 1000, questId % 1000]
    }
    return [Math.floor(questId / 1000), null, questId % 1000]
}

/** Whether a QuestRangeReferenceIdKind code and its id lists (null = any) cover a quest. */
export function rangeCovers(kind: number, ids: IdLists, category: QuestCategory, questId: number): boolean {
    if (!(RANGE_KIND_CATEGORIES[kind] ?? []).includes(category)) return false
    const levels = questIdLevels(category, questId)
    return ids.every((list, index) => list === null || levels[index] === null || list.includes(levels[index]!))
}

