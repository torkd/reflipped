import getDatabase, { Database } from "../data";
import { contentDate, isContentPeriodOpen, isContentPeriodOpenOnRealDay, scheduledContentEnabled } from "./eventSchedule";
// Daily challenge points and periodic reward points (FT-4): per-player counters the client keeps for daily-limited
// content, sent as mail types 14 and 15 and refilled at the daily reset.
//
// - A daily challenge point (`quest/event/daily_challenge_point`, `user_daily_challenge_point_list`) is the attempts
//   left at a solo boss challenge (id 1), Nostalgia Trials (251), Chrono Trial (5001) or an event quest. The client
//   counts `point` plus the `additional_point` of each listed campaign that is open, and receives mail only while that
//   total plus the mail stays within `max_challenge_point`. Quests with attempts spend them (FT-7, FT-30,
//   src/lib/questAttempts.ts).
// - A periodic reward point (`reward/periodic_reward_point`, `user_periodic_reward_point_list`) is the special rewards
//   left at a hard multi (co-op) boss. The client has no cap for them; the server uses `max_reward_point`.
//
// The client never refills either; its texts say they reset or grow at 5 am (the game day, src/lib/resets.ts). Column
// meanings and the evidence are in docs/routes/mail_index.md.

import dailyChallengePoints from "../../assets/daily_challenge_point.json";
import periodicRewardPoints from "../../assets/periodic_reward_point.json";
import { DailyChallengePointListEntry, PlayerPeriodicRewardPoint } from "../data/types";
import { getPlayerDailyChallengePointListSync, getPlayerPeriodicRewardPointsSync, runInTransactionSync, setPlayerDailyChallengePointCampaignSync, setPlayerDailyChallengePointSync, setPlayerPeriodicRewardPointSync } from "../data/wdfpData";
import { masterDate } from "../utils";
import { GAME_DAY_MS, gameDayOf, gameDayStart } from "./calendar";

interface Period {
    start: string
    end: string | null
}

interface DailyChallengePoint extends Period {
    /** max_challenge_point: the most a player can hold */
    max: number
    /** max_display_challenge_point: what the day starts with (the captured new-player list holds exactly these) */
    daily: number
    /** is_recovery: whether it refills each day ("left today") or not ("left") */
    recovers: boolean
    name: string
}

interface DailyChallengePointCampaign extends Period {
    point_id: number
    additional: number
}

interface PeriodicRewardPoint extends Period {
    /** max_reward_point */
    max: number
    /** recovery_point: added each cycle */
    recovery: number
    /** recovery_cycle: 0 is daily ("More added at 5 am daily"), the only cycle the client knows */
    cycle: number
    name: string
}

const challengePoints = dailyChallengePoints.points as Record<string, DailyChallengePoint>
const challengePointCampaigns = dailyChallengePoints.campaigns as Record<string, DailyChallengePointCampaign>
const rewardPoints = periodicRewardPoints as Record<string, PeriodicRewardPoint>

const DAILY_CYCLE = 0

/** Whether a master period (Japan time) holds a date; a missing end is open-ended. */
function isOpen(period: Period, date: Date): boolean {
    return isContentPeriodOpen(masterDate(period.start).getTime(), period.end === null ? undefined : masterDate(period.end).getTime(), date)
}

/** Whether a master period is open at any time during `date`'s game day. */
function isOpenOnGameDay(period: Period, date: Date): boolean {
    if (scheduledContentEnabled()) return isContentPeriodOpenOnRealDay(masterDate(period.start).getTime(), period.end === null ? undefined : masterDate(period.end).getTime(), date)
    const dayStart = gameDayStart(gameDayOf(contentDate(date).getTime()))
    return masterDate(period.start).getTime() < dayStart + GAME_DAY_MS && (period.end === null || masterDate(period.end).getTime() >= dayStart)
}

export function getDailyChallengePoint(pointId: number): DailyChallengePoint | null {
    return challengePoints[String(pointId)] ?? null
}

export function getPeriodicRewardPoint(pointId: number): PeriodicRewardPoint | null {
    return rewardPoints[String(pointId)] ?? null
}

/** The admin mail picker's lists. */
export function rewardPointCatalog(): { dailyChallengePoints: { id: number, name: string }[], periodicRewardPoints: { id: number, name: string }[] } {
    const list = (table: Record<string, { name: string }>) => Object.entries(table).map(([id, point]) => ({ id: Number(id), name: point.name }))
    return { dailyChallengePoints: list(challengePoints), periodicRewardPoints: list(rewardPoints) }
}

/** What the client counts for a daily challenge point: its point plus the extra of each listed campaign that is open. */
export function dailyChallengePointTotal(entry: DailyChallengePointListEntry | undefined, pointId: number, date: Date): number {
    if (entry === undefined) return 0
    let total = entry.point
    for (const campaign of entry.campaignList) {
        const master = challengePointCampaigns[String(campaign.campaignId)]
        if (master !== undefined && master.point_id === pointId && isOpen(master, date)) total += campaign.additionalPoint
    }
    return total
}

/**
 * Spends one attempt of a daily challenge point (FT-7) and returns the entry as it is now, or null when the player has
 * none left (the client's total: the point plus the extras of its open campaigns). The point goes first, then an open
 * campaign's extras; the game's own order is unknown (the client only shows the total).
 */
export function spendDailyChallengePointSync(playerId: number, pointId: number, date: Date): DailyChallengePointListEntry | null {
    const entry = getPlayerDailyChallengePointSync(playerId, pointId)
    if (entry === undefined || dailyChallengePointTotal(entry, pointId, date) <= 0) return null
    if (entry.point > 0) {
        setPlayerDailyChallengePointSync(playerId, pointId, entry.point - 1)
    } else {
        const campaign = entry.campaignList.find(candidate => {
            const master = challengePointCampaigns[String(candidate.campaignId)]
            return candidate.additionalPoint > 0 && master !== undefined && master.point_id === pointId && isOpen(master, date)
        })!
        setPlayerDailyChallengePointCampaignSync(playerId, pointId, campaign.campaignId, campaign.additionalPoint - 1)
    }
    return getPlayerDailyChallengePointSync(playerId, pointId)!
}

/** The player's daily challenge point entry, if they have one. */
export function getPlayerDailyChallengePointSync(playerId: number, pointId: number): DailyChallengePointListEntry | undefined {
    return getPlayerDailyChallengePointListSync(playerId).find(entry => entry.id === pointId)
}

/** The player's periodic reward point, 0 if they have none. */
export function getPlayerPeriodicRewardPointValueSync(playerId: number, pointId: number): number {
    return getPlayerPeriodicRewardPointsSync(playerId).find(entry => entry.id === pointId)?.point ?? 0
}

/** Serializes daily challenge point entries for `user_daily_challenge_point_list`. */
export function serializeDailyChallengePoints(entries: DailyChallengePointListEntry[]): Object[] {
    return entries.map(entry => ({
        "id": entry.id,
        "point": entry.point,
        "campaign_list": entry.campaignList.map(campaign => ({ "campaign_id": campaign.campaignId, "additional_point": campaign.additionalPoint }))
    }))
}

/**
 * The daily reset's step: every daily challenge point that recovers starts the day at its daily amount (a player with
 * more, from mail, keeps it, like boost points), one that doesn't is given its amount once, and every daily periodic
 * reward point grows by its recovery amount up to its cap. That is every point open at some time during the game day: the reset runs at the day's first `/load`,
 * and an event point that opens later that day (events usually open at 14:00 Japan time, nine hours into the game
 * day) would otherwise wait for the next day. Points whose period is over are left as they are. A point the player
 * doesn't have yet is added, so a newly opened event starts with its attempts.
 */
export function refillRewardPointsSync(playerId: number, date: Date): void {
    return runInTransactionSync(() => refillRewardPoints(playerId, date))
}

function refillRewardPoints(playerId: number, date: Date): void {
    const database = getDatabase(Database.WDFP_DATA)
    const day = gameDayOf(date.getTime())
    const reserveDay = (kind: string, id: number): boolean => {
        if (!scheduledContentEnabled()) return true
        const old = database.prepare("SELECT day FROM players_point_reset_days WHERE player_id = ? AND kind = ? AND point_id = ?").get(playerId, kind, id) as { day: string } | undefined
        if (old?.day === day) return false
        database.prepare("INSERT INTO players_point_reset_days(player_id, kind, point_id, day) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, kind, point_id) DO UPDATE SET day = excluded.day").run(playerId, kind, id, day)
        return true
    }
    const owned = new Map(getPlayerDailyChallengePointListSync(playerId).map(entry => [entry.id, entry.point]))
    for (const [id, point] of Object.entries(challengePoints)) {
        // the day is reserved first, so a same-day view change cannot refill points the player has spent since
        if (!isOpenOnGameDay(point, date) || !reserveDay("challenge", Number(id))) continue
        const current = owned.get(Number(id))
        // a point that doesn't recover (an event quest's one attempt, FT-30) is given once, the first day it is open
        if (point.recovers ? (current ?? 0) < point.daily : current === undefined) setPlayerDailyChallengePointSync(playerId, Number(id), point.daily)
    }

    const rewards = new Map(getPlayerPeriodicRewardPointsSync(playerId).map((entry: PlayerPeriodicRewardPoint) => [entry.id, entry.point]))
    for (const [id, point] of Object.entries(rewardPoints)) {
        if (point.cycle !== DAILY_CYCLE || !isOpenOnGameDay(point, date) || !reserveDay("periodic", Number(id))) continue
        const current = rewards.get(Number(id)) ?? 0
        const next = Math.max(current, Math.min(point.max, current + point.recovery))
        if (next !== current || !rewards.has(Number(id))) setPlayerPeriodicRewardPointSync(playerId, Number(id), next)
    }
}
