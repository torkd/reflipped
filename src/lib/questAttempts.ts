// Quests with attempts (FT-7, FT-30): a daily challenge point (src/lib/rewardPoints.ts) limits how often a quest can
// be played. The client shows what is left and greys the quest out at none; this refuses a start without an attempt
// and spends one, and the reply carries `user_daily_challenge_point_list`, which the client's common response handler
// applies from any reply.
//
// - Solo Boss Challenges and Nostalgia Trials (`EXPERT_SINGLE_EVENT`): the event's point
//   (`assets/expert_single_event.json`), spent by a clear ("Clear count decreases upon successful clears").
// - World story and story event quests with their own point (`challengePointId`, column 128: per-boss Solo Boss
//   Challenges, one a day; anniversary and event quests, one in all), spent by a clear ("Each quest has separate
//   attempt counts which decrease upon successful clears").
// - Chrono Trials (`SOLO_TIME_ATTACK_EVENT`): the event's point (`assets/solo_time_attack_event.json`, 10 a day),
//   spent when the battle starts and not given back on a time-out or game over (worldflipper.wiki.gg, "Chrono Trials
//   Event"). Every Chrono Trial finishes with its result, lost or not.

import expertSingleEvents from "../../assets/expert_single_event.json";
import soloTimeAttackEvents from "../../assets/solo_time_attack_event.json";
import systemUnlockConditions from "../../assets/game_system_unlock_condition.json";
import { DailyChallengePointListEntry } from "../data/types";
import { getPlayerSingleQuestProgressSync, getPlayerSync } from "../data/wdfpData";
import { getQuestFromCategorySync, playerRankSync } from "./assets";
import { dailyChallengePointTotal, getPlayerDailyChallengePointSync, spendDailyChallengePointSync } from "./rewardPoints";
import { QuestCategory } from "./types";

type Events = Record<string, { challengePointId: number }>

/** When a quest's attempt is spent. */
export type AttemptSpentOn = "start" | "clear"

export interface QuestAttempt {
    pointId: number
    spentOn: AttemptSpentOn
}

/** The quest categories of the client's QuestReferenceIdKind codes that quest conditions use. */
export const QUEST_REFERENCE_CATEGORIES: Record<number, QuestCategory> = {
    0: QuestCategory.MAIN,
    1: QuestCategory.EX,
    2: QuestCategory.BOSS_BATTLE,
    9: QuestCategory.WORLD_STORY_EVENT,
    7: QuestCategory.CHALLENGE_DUNGEON_EVENT,
    10: QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE,
    12: QuestCategory.EXPERT_SINGLE_EVENT
}

/** QuestReferenceIdKind 6, an advent (Descension) boss: cleared solo or in co-op, stored under either category. The
 * co-op boss events' unlocks name one (FT-23, `hard_multi_*`: the event's Descension boss on Godly). */
const ADVENT_REFERENCE_KIND = 6

/** Whether the player has cleared a quest named by a QuestReferenceIdKind code; an unknown code counts as cleared. */
export function referencedQuestClearedSync(playerId: number, kind: number, questId: number): boolean {
    if (kind === ADVENT_REFERENCE_KIND) {
        return [QuestCategory.ADVENT_EVENT_SINGLE, QuestCategory.ADVENT_EVENT_MULTI]
            .some(category => getPlayerSingleQuestProgressSync(playerId, category, questId)?.finished === true)
    }
    const category = QUEST_REFERENCE_CATEGORIES[kind]
    return category === undefined || getPlayerSingleQuestProgressSync(playerId, category, questId)?.finished === true
}

/** The attempts a quest spends, or null for a quest without any. */
export function questAttempt(category: QuestCategory, questId: number): QuestAttempt | null {
    const quest = getQuestFromCategorySync(category, questId)
    if (quest === null || !("rankPointReward" in quest)) return null
    switch (category) {
        case QuestCategory.EXPERT_SINGLE_EVENT: {
            const pointId = (expertSingleEvents as Events)[String(quest.eventId)]?.challengePointId
            return pointId === undefined ? null : { pointId, spentOn: "clear" }
        }
        case QuestCategory.SOLO_TIME_ATTACK_EVENT: {
            const pointId = (soloTimeAttackEvents as Events)[String(quest.eventId)]?.challengePointId
            return pointId === undefined ? null : { pointId, spentOn: "start" }
        }
        case QuestCategory.WORLD_STORY_EVENT:
        case QuestCategory.STORY_EVENT_SINGLE:
            return quest.challengePointId === undefined ? null : { pointId: quest.challengePointId, spentOn: "clear" }
        default:
            return null
    }
}

/** "No attempts left." when a quest with attempts has none, else null. */
export function questAttemptRefusal(playerId: number, category: QuestCategory, questId: number, date: Date): string | null {
    const attempt = questAttempt(category, questId)
    if (attempt === null) return null
    return dailyChallengePointTotal(getPlayerDailyChallengePointSync(playerId, attempt.pointId), attempt.pointId, date) > 0 ? null : "No attempts left."
}

/**
 * Spends a quest's attempt if this is when it is spent (`moment`); the entry to send back, or null when the quest
 * spends none now or none was left.
 */
export function spendQuestAttemptSync(playerId: number, category: QuestCategory, questId: number, moment: AttemptSpentOn, date: Date): DailyChallengePointListEntry | null {
    const attempt = questAttempt(category, questId)
    if (attempt === null || attempt.spentOn !== moment) return null
    return spendDailyChallengePointSync(playerId, attempt.pointId, date)
}

/**
 * Why a game system (`assets/game_system_unlock_condition.json`, keyed like `game_system_unlock`) is still locked for
 * the player, or null when every condition holds (or the system has none).
 */
export function systemUnlockRefusal(playerId: number, system: string): string | null {
    const conditions = (systemUnlockConditions as Record<string, { clearedQuest?: { kind: number, questId: number }, playerRank?: number }[]>)[system] ?? []
    const rank = playerRankSync(getPlayerSync(playerId)?.rankPoint ?? 0)
    for (const condition of conditions) {
        if (condition.playerRank !== undefined && rank < condition.playerRank) return `Needs rank ${condition.playerRank}.`
        const quest = condition.clearedQuest
        if (quest !== undefined && !referencedQuestClearedSync(playerId, quest.kind, quest.questId)) return `Needs quest ${quest.questId} cleared first.`
    }
    return null
}
