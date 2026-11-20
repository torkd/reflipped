// Score Scramble (FT-11, `SCORE_ATTACK_EVENT`, 無限演武 in the Japanese master data): the boss has endless HP, and a
// battle that the game finishes (single_battle_quest/finish, won or lost) scores. A wiped-out or given-up battle goes
// through the game's quest-failure exit (single_battle_quest/abort, seen on a device 2026-11-16): it is retired, in the
// history with its damage and no score (the client's history entry takes `score` as optional), and pays nothing.
// Each quest has 60 score borders (`quest/event/score_attack_border_reward`, 1.5 million up to 3.5 billion)
// paying the event's coins (items 40501 and 40502); a battle pays each border its score newly passes, once, by mail
// under reason 16001 ("score border reward"). The finish reply's `score_attack_event` lists those borders
// (`reward_ids`) with the party's units, and `history/score_attack_event_battle` lists the player's recent battles of
// an event. The best score per quest is kept apart from quest progress, which only a clear writes.

import borderRewards from "../../assets/score_attack_border_reward.json";
import { getPlayerScoreAttackBattlesSync, getPlayerScoreAttackBestSync, insertPlayerScoreAttackBattleSync, ScoreAttackBattle, setPlayerScoreAttackBestSync } from "../data/wdfpData";
import { clientSerializeJapanDate } from "../data/utils";
import { BorderTier, mailBorderRewardsSync, mainCharacterIds, partySlotIds } from "./borderRewards";
import { historyPartyFields, historyPartySync } from "./historyParty";
import { QuestCategory } from "./types";

type ScoreTier = BorderTier & { score: number }

const tiersByEvent = borderRewards as Record<string, Record<string, ScoreTier[]>>

/** A finish body's total damage: its zones' `damage_deal_total`, summed (0 for anything else). */
export function totalDamage(statistics: Record<string, unknown>): number {
    const zones = Array.isArray(statistics.zones) ? statistics.zones : []
    let total = 0
    for (const zone of zones) {
        const value = zone !== null && typeof zone === "object" ? (zone as Record<string, unknown>).damage_deal_total : undefined
        if (typeof value === "number" && Number.isFinite(value) && value > 0) total += Math.floor(value)
    }
    return Math.min(total, Number.MAX_SAFE_INTEGER)
}

/** A Score Scramble quest's event: its id is `event id * 1000 + quest number`. */
export function scoreAttackEventId(questId: number): number {
    return Math.floor(questId / 1000)
}

/** The borders a score newly passes, given the best score before (none before the first battle). */
export function newScoreBorders(questId: number, score: number, previousBest: number | null): ScoreTier[] {
    const tiers = tiersByEvent[String(scoreAttackEventId(questId))]?.[String(questId % 1000)] ?? []
    return tiers.filter(tier => score >= tier.score && (previousBest === null || previousBest < tier.score))
}

export interface ScoreAttackFinish {
    questId: number
    accomplished: boolean
    score: number
    elapsedMs: number
    clearRank: number | null
    /** the finish body's statistics: the party and each slot's damage come from them */
    statistics: Record<string, unknown>
    date: Date
}

/**
 * A Score Scramble battle's finish: mails the borders its score newly passes, keeps the best score, records the
 * battle for the history and builds the reply's `score_attack_event`.
 */
export function finishScoreAttackSync(playerId: number, finish: ScoreAttackFinish): { reply: Record<string, unknown>, mailArrived: boolean } {
    const previousBest = getPlayerScoreAttackBestSync(playerId, finish.questId)
    const tiers = newScoreBorders(finish.questId, finish.score, previousBest)
    const mailArrived = mailBorderRewardsSync(playerId, tiers, "Score Scramble")
    if (previousBest === null || finish.score > previousBest) setPlayerScoreAttackBestSync(playerId, finish.questId, finish.score)

    insertPlayerScoreAttackBattleSync(playerId, {
        eventId: scoreAttackEventId(finish.questId),
        questId: finish.questId,
        score: finish.score,
        elapsedTimeMs: finish.elapsedMs,
        clearRank: finish.clearRank,
        finishKind: finish.accomplished ? 0 : 1,
        totalDamage: totalDamage(finish.statistics),
        party: historyPartySync(playerId, finish.statistics),
        createTime: finish.date
    })
    return {
        reply: {
            "main_character_ids": mainCharacterIds(partySlotIds((finish.statistics.party as Record<string, unknown> | undefined)?.characters)),
            "reward_ids": tiers.map(tier => tier.id)
        },
        mailArrived
    }
}

/** A retired Score Scramble battle (an abort): in the history with no score, rank or border; the best score stays. */
export function retireScoreAttackSync(playerId: number, retired: {
    questId: number
    /** the abort's own finish_kind (1 given up) */
    finishKind: number
    elapsedMs: number
    /** the abort body's statistics */
    statistics: Record<string, unknown>
    date: Date
}): void {
    insertPlayerScoreAttackBattleSync(playerId, {
        eventId: scoreAttackEventId(retired.questId),
        questId: retired.questId,
        score: null,
        elapsedTimeMs: retired.elapsedMs,
        clearRank: null,
        finishKind: retired.finishKind,
        totalDamage: totalDamage(retired.statistics),
        party: historyPartySync(playerId, retired.statistics),
        createTime: retired.date
    })
}

/** `history/score_attack_event_battle`'s entries for an event, the latest first. */
export function scoreAttackHistorySync(playerId: number, eventId: number): Record<string, unknown>[] {
    return getPlayerScoreAttackBattlesSync(playerId, eventId).map(battle => {
        const entry: Record<string, unknown> = {
            "category_id": QuestCategory.SCORE_ATTACK_EVENT,
            "quest_id": battle.questId,
            "score": battle.score,
            "elapsed_time_ms": battle.elapsedTimeMs,
            "clear_rank": battle.clearRank,
            "finish_kind": battle.finishKind,
            "total_damage": battle.totalDamage,
            "create_time": clientSerializeJapanDate(battle.createTime)
        }
        Object.assign(entry, historyPartyFields(battle.party))
        return entry
    })
}
