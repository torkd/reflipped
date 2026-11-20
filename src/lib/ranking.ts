import { boardHiddenPlayers } from "./anticheat";
// Ranking events (FT-33, "Speed Run" time attacks, `RANKING_EVENT_SINGLE`): each battle, won or lost (worldflipper.wiki
// .gg, "Speed Run (TA) Event": "Battles that time out or end in a wipe still count toward your best score and clear
// time"), updates the player's best record in the event: a full clear beats any partial run, the faster full clear
// wins (then the higher score), and of partial runs the higher score wins (then the faster).
//
// The player's rank is their place among this server's players with a record in the event: `rank_percentage` is the
// share of them with a better record (0 to 100; the client turns it into the rank letter), so a player alone on a
// server is at the top. The rank bands (`quest/event/ranking_event_ranking_reward`: S+ top 3 %, S 6 %, A 10 %, B 20 %,
// C 30 %, D 40 %, E 60 %, F 80 %, G 100 %) pay once, by mail under the band's reason ("Rewards for obtaining an S+
// rank in ..."), when the player opens the event during its results announcement (`ranking_event/receive_reward`,
// between the end of the results calculation and the end of the announcement, `quest/event/ranking_event`).

import rankingEvents from "../../assets/ranking_event.json";
import rankingRewards from "../../assets/ranking_event_ranking_reward.json";
import { getPlayerRankingRecordSync, getRankingRecordsSync, RankingRecord, setPlayerRankingRecordSync } from "../data/wdfpData";
import { masterDate } from "../utils";
import { BorderTier, mailBorderRewardsSync } from "./borderRewards";
import { isContentPeriodOpen } from "./eventSchedule";

type RankBand = BorderTier & { share: number }

const events = rankingEvents as Record<string, { start: string, battleEnd: string, resultsStart: string, resultsEnd: string }>
const bandsByEvent = rankingRewards as Record<string, RankBand[]>

/** The client's result code for a reward request outside the results announcement (OutOfReceivablePeriod). */
export const RANKING_OUT_OF_RECEIVABLE_PERIOD = 5109

/** A ranking quest's event: its id is `event id * 1000 + quest number`. */
export function rankingEventId(questId: number): number {
    return Math.floor(questId / 1000)
}

type Record_ = Pick<RankingRecord, "accomplished" | "elapsedTimeMs" | "score">

/** Negative when `a` is the better record, positive when `b` is, 0 for a tie. */
export function compareRankingRecords(a: Record_, b: Record_): number {
    if (a.accomplished !== b.accomplished) return a.accomplished ? -1 : 1
    if (a.accomplished) return a.elapsedTimeMs - b.elapsedTimeMs || b.score - a.score
    return b.score - a.score || a.elapsedTimeMs - b.elapsedTimeMs
}

/** Records a battle's result if it beats the player's best in the event. */
export function recordRankingBattleSync(playerId: number, eventId: number, battle: Record_ & { leaderCharacterId: number }) {
    const current = getPlayerRankingRecordSync(playerId, eventId)
    if (current !== null && compareRankingRecords(current, battle) <= 0) return
    setPlayerRankingRecordSync(playerId, eventId, { ...battle, rewarded: current?.rewarded ?? false })
}

/** The event's records, best first; developer-mode and restricted players' left out (SEC-18), so they don't move anyone's band. */
function leaderboard(eventId: number) {
    const left = boardHiddenPlayers()
    return getRankingRecordsSync(eventId).filter(record => !left.has(record.playerId)).sort(compareRankingRecords)
}

/**
 * The lowest `rank_percentage` sent (FT-78): the client can't take 0. Its rank-reward dialog
 * (RankingEventResultDialog, opened by `receive_reward`'s status 1 and after a new best record) animates the rank
 * table up to the player's percentage: the table height is 1 when the percentage is 0 (`(border - p) / border` of
 * the top band), so the rank it draws comes to ceil(0) = 0, and RankingEventRankingTableView.drawRankDataDetail
 * reads `ranks[rank - 1]`, undefined, which ends in Error #1009 (shown as F1009). Above 0 it lands on rank 1. The
 * client shows the percentage with one decimal, so the top player still reads "0.0 %", as on the original servers,
 * where the first of thousands was a small share above 0.
 */
export const MIN_RANK_PERCENTAGE = 0.01

/** The share of the server's players in the event with a better record than `record`, MIN_RANK_PERCENTAGE to 100. */
function percentile(records: Record_[], record: Record_): number {
    const better = records.filter(other => compareRankingRecords(other, record) < 0).length
    return Math.max(MIN_RANK_PERCENTAGE, records.length === 0 ? 0 : 100 * better / records.length)
}

/** The band a percentile falls in: the first whose share covers it. */
function bandOf(eventId: number, rankPercentage: number): RankBand | null {
    return (bandsByEvent[String(eventId)] ?? []).find(band => rankPercentage <= band.share * 100) ?? null
}

const serializeRecord = (record: Record_) => ({
    "elapsed_time_ms": record.elapsedTimeMs,
    "is_accomplished": record.accomplished,
    "score": record.score
})

/** `ranking_event/get_summary`'s data: the best record, the rank and the record the next band up needs. */
export function rankingSummarySync(playerId: number, eventId: number): Record<string, unknown> {
    const record = getPlayerRankingRecordSync(playerId, eventId)
    if (record === null) {
        return {
            "best_record": { "elapsed_time_ms": 0, "is_accomplished": false, "score": 0 },
            "leader_character_evolution_img_level": 1,
            "leader_character_id": 1,
            "rank_border_top": null,
            "rank_percentage": 100
        }
    }
    const records = leaderboard(eventId)
    const rankPercentage = percentile(records, record)
    // the next band up: its worst place still inside it, and the record there
    const bands = bandsByEvent[String(eventId)] ?? []
    const current = bandOf(eventId, rankPercentage)
    const next = current === null ? null : bands[bands.indexOf(current) - 1] ?? null
    const borderIndex = next === null ? -1 : Math.floor(next.share * records.length)
    const border = borderIndex >= 0 && borderIndex < records.length && compareRankingRecords(records[borderIndex], record) < 0 ? records[borderIndex] : null
    return {
        "best_record": serializeRecord(record),
        "leader_character_evolution_img_level": 1,
        "leader_character_id": record.leaderCharacterId,
        "rank_border_top": border === null ? null : serializeRecord(border),
        "rank_percentage": rankPercentage
    }
}

/** Whether a date is in the event's results announcement, when its rewards can be received. */
export function isRankingRewardPeriod(eventId: number, date: Date): boolean {
    const event = events[String(eventId)]
    if (event === undefined) return false
    // projected like every event's period when event scheduling is on (src/lib/eventSchedule.ts)
    const open = (start: string, end: string) => isContentPeriodOpen(masterDate(start).getTime(), masterDate(end).getTime(), date)
    return open(event.resultsStart, event.resultsEnd) && !open(event.resultsStart, event.resultsStart)
}

/**
 * `ranking_event/receive_reward`: the status (1 rewards sent now, 2 received before, 3 no record in the event) and the
 * summary for 1 and 2. The band's rewards are mailed once.
 */
export function receiveRankingRewardSync(playerId: number, eventId: number): { status: number, summary: Record<string, unknown> | null } {
    const record = getPlayerRankingRecordSync(playerId, eventId)
    if (record === null) return { status: 3, summary: null }
    const summary = rankingSummarySync(playerId, eventId)
    if (record.rewarded) return { status: 2, summary }
    const band = bandOf(eventId, Number(summary["rank_percentage"]))
    if (band !== null) mailBorderRewardsSync(playerId, [band], "Rank Rewards")
    setPlayerRankingRecordSync(playerId, eventId, { ...record, rewarded: true })
    return { status: 1, summary }
}
