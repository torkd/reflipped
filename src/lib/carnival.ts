// Hanifolk Carnival (FT-11, `CARNIVAL_EVENT`): three bosses (the event's folders) of three difficulties each, each
// boss fought with its own party set (party category 2, src/lib/eventParties.ts), and no unit in two bosses' parties.
//
// A clear scores the difficulty's base (`difficultyScore`: 200,000 / 2,000,000 / 2,650,000) plus a time bonus of one
// point per millisecond left of the battle's time limit (`timeLimitMs`: 30, 20, 15 minutes). The client only shows
// the two parts (`score.difficulty_bonus`, `score.time_bonus`); the community's notes (wasuku.gamewiki.jp, "ハニワカ
// ーニバル（闇）": base 200,000 / 2,000,000 / 2,650,000 + time bonus, "about 3.5 million" for a 1:30 Godly clear and
// "about 3.4 million" a little over two minutes) and the reward thresholds (S+ 9,745,000 for three bosses) fit that
// rate; the exact rounding of the original is unknown.
//
// Each boss keeps its best score with the party that set it; a clear with a different party starts the record over
// (the client warns "Scores will be reset if you change parties or party members in use"), and a party with a unit
// another boss's record holds doesn't count ("At least one unit in your party has already cleared another Hanifolk
// Carnival quest"). A lost battle doesn't count either ("Score was unable to be saved"). The total of the bosses' best
// scores pays the event's total score rewards (`carnival_event_total_score_reward`), each once, by mail.

import totalScoreRewards from "../../assets/carnival_event_total_score_reward.json";
import { CarnivalRecord, getPlayerCarnivalPaidTotalSync, getPlayerCarnivalRecordsSync, setPlayerCarnivalPaidTotalSync, setPlayerCarnivalRecordSync } from "../data/wdfpData";
import { BorderTier, mailBorderRewardsSync } from "./borderRewards";
import { BattleQuest } from "./types";

type TotalScoreTier = BorderTier & { score: number }

const tiersByEvent = totalScoreRewards as Record<string, TotalScoreTier[]>

/** A Carnival quest's event: its id is `event id * 1000 + quest number`. */
export function carnivalEventId(questId: number): number {
    return Math.floor(questId / 1000)
}

/** A clear's score: the difficulty's base and the time bonus. */
export function carnivalScore(quest: Pick<BattleQuest, "difficultyScore" | "timeLimitMs">, elapsedMs: number): { difficultyBonus: number, timeBonus: number } {
    return {
        difficultyBonus: quest.difficultyScore ?? 0,
        timeBonus: Math.max(0, Math.floor((quest.timeLimitMs ?? 0) - elapsedMs))
    }
}

/** The total of a player's best scores over an event's bosses. */
function totalBest(records: CarnivalRecord[]): number {
    return records.reduce((sum, record) => sum + record.bestScore, 0)
}

const sameUnits = (a: (number | null)[], b: (number | null)[]) =>
    JSON.stringify(a.filter(id => id !== null).sort()) === JSON.stringify(b.filter(id => id !== null).sort())

export interface CarnivalFinish {
    questId: number
    quest: Pick<BattleQuest, "difficultyScore" | "timeLimitMs" | "folderId">
    accomplished: boolean
    elapsedMs: number
    characterIds: (number | null)[]
    unisonCharacterIds: (number | null)[]
}

/**
 * A Carnival battle's finish: updates the boss's record if the battle counts, mails the total score rewards newly
 * reached and builds the reply's `carnival_event`.
 */
export function finishCarnivalSync(playerId: number, finish: CarnivalFinish): { reply: Record<string, unknown>, mailArrived: boolean } {
    const eventId = carnivalEventId(finish.questId)
    const folderId = finish.quest.folderId ?? 0
    const records = getPlayerCarnivalRecordsSync(playerId, eventId)
    const previousTotal = totalBest(records)
    const score = carnivalScore(finish.quest, finish.elapsedMs)
    const total = score.difficultyBonus + score.timeBonus

    const units = [...finish.characterIds, ...finish.unisonCharacterIds].filter((id): id is number => id !== null)
    const lockedElsewhere = records.some(record => record.folderId !== folderId
        && [...record.characterIds, ...record.unisonCharacterIds].some(id => id !== null && units.includes(id)))
    const valid = finish.accomplished && !lockedElsewhere

    let tiers: TotalScoreTier[] = []
    if (valid) {
        const current = records.find(record => record.folderId === folderId)
        const sameParty = current !== undefined && sameUnits(current.characterIds, finish.characterIds) && sameUnits(current.unisonCharacterIds, finish.unisonCharacterIds)
        const record: CarnivalRecord = {
            folderId,
            bestScore: sameParty ? Math.max(current!.bestScore, total) : total,
            previousScore: total,
            characterIds: finish.characterIds,
            unisonCharacterIds: finish.unisonCharacterIds
        }
        setPlayerCarnivalRecordSync(playerId, eventId, record)
        const newTotal = totalBest([...records.filter(other => other.folderId !== folderId), record])
        // each threshold pays once: past the highest total already paid, not the current one (a party change can lower it)
        const paid = getPlayerCarnivalPaidTotalSync(playerId, eventId)
        tiers = (tiersByEvent[String(eventId)] ?? []).filter(tier => newTotal >= tier.score && paid < tier.score)
        if (newTotal > paid) setPlayerCarnivalPaidTotalSync(playerId, eventId, newTotal)
    }
    const mailArrived = mailBorderRewardsSync(playerId, tiers, "Hanifolk Carnival")

    return {
        reply: {
            "is_record_valid": valid,
            "leader_character_id": finish.characterIds.find((id): id is number => id !== null) ?? 0,
            "new_degree_ids": [],
            "previous_total_best_score": previousTotal,
            "reward_ids": tiers.map(tier => tier.id),
            "score": { "difficulty_bonus": score.difficultyBonus, "time_bonus": score.timeBonus }
        },
        mailArrived
    }
}

/** `carnival_event/index`'s records: each boss's best and last score with the party that set them. */
export function carnivalRecordsReply(playerId: number, eventId: number): Record<string, unknown>[] {
    return getPlayerCarnivalRecordsSync(playerId, eventId).map(record => ({
        "folder_id": record.folderId,
        "best_score": record.bestScore,
        "previous_score": record.previousScore,
        "previous_character_ids": record.characterIds,
        "previous_unison_character_ids": record.unisonCharacterIds
    }))
}
