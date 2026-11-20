import { getAccountFromPlayerIdSync, runInTransactionSync } from "../data/wdfpData";
import { recordTravelChangeSync, travelCooldownRemainingSync } from "../data/accountClocks";
import { getEventPolicy } from "./eventPolicy";
import { scheduledContentEnabled, HISTORICAL_START, HISTORICAL_END } from "./eventSchedule";
// Moving one player's clock to a game day (FT-5, src/lib/playerClock.ts), as the admin player page and, when allowed,
// the player's own portal page (ACC-8) do it.
import { GAME_DAY_MS, gameDayStart } from "./calendar";
import { contentGapIn } from "./eventCalendar";
import { clockOffsetDaysFor, getPlayerClockSync, MAX_CLOCK_OFFSET_DAYS, setPlayerClockSync } from "./playerClock";
import { getGlobalServerDate } from "./serverClock";
import type { User } from "../data/users";

export type PlayerDayResult = "clock-set" | "no-player" | "clock-invalid" | "clock-out-of-range" | "clock-no-portal" | "clock-cooldown"

/**
 * Puts the player on a game day ("YYYY-MM-DD") at the server clock's time of day. A day with no summoning portal open
 * at that time is refused unless `force`: the client fails with C8601 there.
 */
export function setPlayerDaySync(playerId: number, date: string, force = false, admin = false): PlayerDayResult {
    if (getPlayerClockSync(playerId) === null) return "no-player"
    const dayStart = gameDayStart(date)
    if (isNaN(dayStart)) return "clock-invalid"
    const offsetDays = clockOffsetDaysFor(new Date(dayStart))
    if (Math.abs(offsetDays) > MAX_CLOCK_OFFSET_DAYS) return "clock-out-of-range"
    const playerNow = getGlobalServerDate().getTime() + offsetDays * GAME_DAY_MS
    if (scheduledContentEnabled() && (dayStart < HISTORICAL_START - GAME_DAY_MS || dayStart >= HISTORICAL_END)) return "clock-out-of-range"
    if (!scheduledContentEnabled() && !force && contentGapIn(playerNow, playerNow + 1) !== null) return "clock-no-portal"
    return runInTransactionSync(() => {
        const account = getAccountFromPlayerIdSync(playerId)!
        if (scheduledContentEnabled() && !admin && getPlayerClockSync(playerId)?.offsetDays !== offsetDays) {
            if (travelCooldownRemainingSync(account.id) > 0) return "clock-cooldown"
            recordTravelChangeSync(account.id)
        }
        setPlayerClockSync(playerId, new Date(dayStart), admin ? "admin" : "player")
        return "clock-set"
    })
}

/** Whether every portal user may move their own player's clock: `PORTAL_TIME_TRAVEL=all`. Off by default. */
export function timeTravelForEveryone(): boolean {
    return process.env.PORTAL_TIME_TRAVEL?.trim().toLowerCase() === "all"
}

/** Whether this user may move their own player's clock on the portal: an admin turned it on for them, or for everyone. */
export function timeTravelAllowed(user: User): boolean {
    if (scheduledContentEnabled()) return user.role === "admin" ? getEventPolicy().adminTimeTravel : getEventPolicy().mode === "time-travel"
    return timeTravelForEveryone() || user.timeTravel
}
