import { scheduledContentEnabled } from "./eventSchedule";
// Daily and monthly resets (FT-1). The game's day starts at 05:00 Japan time: its texts say so ("Kaleido Boosts left:
// ::count:: (Resets at 5 am every day.)", `daily_quest_use_boost_point_dialog_message`), and the client keeps the hour
// itself. When its clock (rebuilt from each reply's `servertime`) passes that hour, the client says "The date changed"
// and returns to the title (`change_date_dialog_message`), so the next request is `/load`, which applies the resets.
// Everything runs on the server clock (`getServerDate()`), never the machine's.

import { collectionUpdatesSync, loginDayUpdates, resetDailyMissionsSync, updateMissionsSync } from "./missions";
import { refillRewardPointsSync } from "./rewardPoints";
import { applyTowerDungeonCycleSync } from "./towerDungeon";
import { gameDayOf } from "./calendar";
import { getClockEra } from "./serverClock";
import { getPlayerGachaCampaignListSync, getPlayerGachaInfoListSync, getPlayerResetsSync, getPlayerSync, runInTransactionSync, setPlayerResetsSync, updatePlayerGachaCampaignSync, updatePlayerGachaInfoSync, updatePlayerSync } from "../data/wdfpData";

/**
 * A date's game day ("YYYY-MM-DD") and game month ("YYYY-MM"). The game day starts at 05:00 Japan time (20:00 UTC),
 * like the master tables' periods (src/lib/calendar.ts). Once the event calendar has moved the clock back to dates it
 * already showed, both carry the clock's era ("2025-01-03~1"), so the repeated days and months count as new ones for
 * resets and shop stock; only equality is ever compared, and the month's digits stay at the same place.
 */
export function gameDay(date: Date, era = getClockEra()): { day: string, month: string } {
    const day = gameDayOf(date.getTime())
    const suffix = era > 0 ? `~${era}` : ""
    return { day: day + suffix, month: day.slice(0, 7) + suffix }
}

/** Boost points a day starts with: the captured `/load` and new players have 3 of each. */
export const DAILY_BOOST_POINTS = 3

type ResetStep = (playerId: number, date: Date) => void

/** Kaleido and Boss Boosts start the day at 3; a player who has more (from mail) keeps them. */
function refillBoostPoints(playerId: number) {
    const player = getPlayerSync(playerId)
    if (player === null) return
    updatePlayerSync({
        id: playerId,
        boostPoint: Math.max(player.boostPoint, DAILY_BOOST_POINTS),
        bossBoostPoint: Math.max(player.bossBoostPoint, DAILY_BOOST_POINTS)
    })
}

/** Each portal's once-a-day pull and its daily free campaign pull are open again. */
function reopenDailyGachaPulls(playerId: number) {
    for (const gacha of getPlayerGachaInfoListSync(playerId)) updatePlayerGachaInfoSync(playerId, { gachaId: gacha.gachaId, isDailyFirst: true })
    for (const campaign of getPlayerGachaCampaignListSync(playerId)) updatePlayerGachaCampaignSync(playerId, campaign.gachaId, campaign.campaignId, 1)
}

/**
 * Daily missions start over (FT-2), and the day counts towards the login-days missions. What the player owns is
 * counted too, which catches up the missions of an imported save.
 */
function startMissionDay(playerId: number, date: Date) {
    resetDailyMissionsSync(playerId)
    updateMissionsSync(playerId, date, [...loginDayUpdates(), ...collectionUpdatesSync(playerId)])
}

// Shop stock needs no step: its daily and monthly counts start over by themselves (src/lib/shopLimits.ts).
// Daily challenge points (solo boss challenge attempts, ...) and periodic reward points (FT-4) refill too.
const DAILY_RESETS: ResetStep[] = [refillBoostPoints, reopenDailyGachaPulls, refillRewardPointsSync, startMissionDay]
// Nothing resets on the 1st of a month yet. The Haunt (FT-6) keeps its own cycles, which change at 05:00 Japan time
// on dates its quests give (src/lib/towerDungeon.ts): its step runs at every /load.
const MONTHLY_RESETS: ResetStep[] = []

/**
 * Runs the daily and monthly resets a player hasn't had for `date`'s game day and month. A player with no reset
 * stored gets both. A different day counts, not only a later one, so moving the server clock back also resets.
 */
export function applyResets(playerId: number, date: Date): { daily: boolean, monthly: boolean } {
    return runInTransactionSync(() => {
        const now = gameDay(date)
        const last = getPlayerResetsSync(playerId)
        const daily = last?.day !== now.day
        const monthly = last?.month !== now.month
        if (daily) for (const step of DAILY_RESETS) step(playerId, date)
        if (monthly) for (const step of MONTHLY_RESETS) step(playerId, date)
        if (scheduledContentEnabled() && !daily) refillRewardPointsSync(playerId, date)
        if (daily || monthly) setPlayerResetsSync(playerId, now)
        applyTowerDungeonCycleSync(playerId, date)
        return { daily, monthly }
    })
}
