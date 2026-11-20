// Practice Combat (FT-17, `PRACTICE`, quest category 15): the Lignoid fights of the menu's Practice Combat. They are
// ordinary single battles (`single_battle_quest/start`, `finish`, `abort`) on `assets/practice_quest.json`, with no
// stamina, drops, clear or S+ reward; their armaments and titles come from missions (regular 56-60: clear each
// Lignoid in any element; titles 12000-12040). Every battle, cleared or given up, goes into the player's practice
// history (`history/practice_battle`, the scene's Battle History button), which the client reads as a list of the
// fields below (the same ones as the Score Scramble history; unknown ones may be null).
//
// Skill previews (`SKILL_PREVIEW`, category 16) need nothing: the client plays them from a replay log and leaves
// through `finishPlayingFromSkillPreview` without any request.

import { getPlayerPracticeBattlesSync, insertPlayerPracticeBattleSync, PracticeBattle } from "../data/wdfpData";
import { clientSerializeJapanDate } from "../data/utils";
import { historyPartyFields, historyPartySync } from "./historyParty";
import { totalDamage } from "./scoreAttack";
import { QuestCategory } from "./types";

/** The battle frame rate: the abort sends no elapsed time, only each zone's `playthrough_frame`. */
const FRAMES_PER_SECOND = 60

/** The longest battle the history records: a client claiming more is bounded (SEC-13). */
const MAX_ELAPSED_MS = 24 * 60 * 60 * 1000

function zonesOf(statistics: Record<string, unknown>): Record<string, unknown>[] {
    const zones = Array.isArray(statistics.zones) ? statistics.zones : []
    return zones.filter((zone): zone is Record<string, unknown> => zone !== null && typeof zone === "object")
}

function nonNegative(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER) : 0
}

/** A given-up battle's length, from its zones' frames (the abort has no `elapsed_time_ms`). */
export function framesElapsedMs(statistics: Record<string, unknown>): number {
    const frames = zonesOf(statistics).reduce((sum, zone) => sum + nonNegative(zone.playthrough_frame), 0)
    return Math.min(Math.round(frames * 1000 / FRAMES_PER_SECOND), MAX_ELAPSED_MS)
}

export interface PracticeFinish {
    questId: number
    /** 0 cleared; an abort's own finish_kind (1 given up) otherwise */
    finishKind: number
    score: number | null
    elapsedMs: number
    clearRank: number | null
    statistics: Record<string, unknown>
    date: Date
}

/** Records a practice battle in the player's history, with the party's armaments as they are now. */
export function recordPracticeBattleSync(playerId: number, finish: PracticeFinish) {
    const battle: PracticeBattle = {
        questId: finish.questId,
        score: finish.score,
        elapsedTimeMs: Math.min(Math.max(0, Math.round(finish.elapsedMs)), MAX_ELAPSED_MS),
        clearRank: finish.clearRank,
        finishKind: finish.finishKind,
        totalDamage: totalDamage(finish.statistics),
        party: historyPartySync(playerId, finish.statistics),
        createTime: finish.date
    }
    insertPlayerPracticeBattleSync(playerId, battle)
}

/** `history/practice_battle`'s entries, the latest first. */
export function practiceHistorySync(playerId: number): Record<string, unknown>[] {
    return getPlayerPracticeBattlesSync(playerId).map(battle => {
        const entry: Record<string, unknown> = {
            "category_id": QuestCategory.PRACTICE,
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
