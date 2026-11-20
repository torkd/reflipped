import { getEventPolicy } from "./eventPolicy";
import { scheduledContentEnabled, getEventScheduleView, runOnEventView, setRequestEventView } from "./eventSchedule";
// Per-player clocks (FT-5): a player can live on another date than the server clock, to visit a past event without
// moving the clock for everyone. The client takes "now" from every reply's `servertime` and works out which events,
// portals and shops are open itself, so a player's clock is the only way to show them another event.
//
// A player's clock is the server clock moved by a whole number of game days, stored per account (`account_clocks`).
// Whole days keep the time of day everyone shares: the player's day still changes at 20:00 UTC with everyone else's,
// so calendar switches (src/lib/calendar.ts) and the client's own "date changed" return to the title happen together,
// and two players in one co-op room differ by days only, never by hours. The clock runs with the server clock: it
// follows the calendar's switches and an admin's changes, always the same number of days away.
//
// Every game request runs on its player's clock: the hook below wraps the rest of the request in
// `runOnClock()` (an AsyncLocalStorage), so `getServerDate()` and `getServerTime()` everywhere in it see the
// player's clock, while other requests and the co-op socket server keep the server clock (a timer started inside the
// request inherits its clock; see `runOnClock()`). Session expiry, rate limits and co-op timers use the machine's
// clock (`Date.now()`) and are not affected at all.

import { FastifyInstance, FastifyRequest } from "fastify";
import { AccountClock, getAccountClockSync, getViewerClockSync, SERVER_CLOCK, setAccountClockSync } from "../data/accountClocks";
import { getAccountFromPlayerIdSync } from "../data/wdfpData";
import { GAME_DAY_MS, gameDayOf, gameDayStart } from "./calendar";
import { parseViewerId } from "./gameAuth";
import { clockHasEras, getGlobalServerDate, RequestClock, runOnClock, setRequestClock } from "./serverClock";

/**
 * A player's clock is at most this many days from the server clock: about 27 years, past all content either way, and
 * close enough that a clock behind a server clock set in 2000 (`EARLIEST_CLOCK_YEAR`) stays after 1970, where the
 * save file's dates and server times start.
 */
export const MAX_CLOCK_OFFSET_DAYS = 10000

export interface PlayerClock {
    /** days from the server clock; 0 follows it */
    offsetDays: number
    /** the player's "now" */
    date: Date
}

/**
 * The game API's clock hook: after the game auth preHandler, the rest of each request runs on its player's clock.
 * Routes that skip game auth still name their viewer in `viewer_id` when they have one (`asset/*`,
 * `tool/get_header_response`, `/load`); they get that player's clock too, because the client compares the game day of
 * every reply with the last one and returns to the title when it changes: title requests on the server clock and
 * `/load` on the player's would send it back to the title over and over. That `viewer_id` isn't authenticated, but it
 * only picks the clock a reply shows. Requests without a viewer (`tool/signup`, a first launch) use the server clock.
 */
export function registerPlayerClock(api: FastifyInstance) {
    api.addHook("preHandler", (request, _reply, done) => {
        const clock = requestAccountClock(request)
        runOnEventView(effectiveContentOffset(clock), () => runOnClock(requestClockOf(clock), done))
    })
}

function requestAccountClock(request: FastifyRequest): AccountClock {
    if (request.viewer) return getAccountClockSync(request.viewer.accountId)
    const viewerId = parseViewerId((request.body as { viewer_id?: unknown } | undefined)?.viewer_id)
    return viewerId === null ? SERVER_CLOCK : getViewerClockSync(viewerId)
}

/** The clock a request of an account runs on. */
export function requestClockOf(clock: AccountClock): RequestClock {
    if (scheduledContentEnabled()) return { offsetMs: 0, era: 0 }
    return { offsetMs: clock.offsetDays * GAME_DAY_MS, era: clock.era }
}

/** Puts the rest of the current game request on the account's clock: for `/load`, which authenticates by zat. */
export function followAccountClock(accountId: number) {
    const clock = getAccountClockSync(accountId)
    setRequestClock(requestClockOf(clock))
    setRequestEventView(effectiveContentOffset(clock))
}

function clockOf(offsetDays: number): PlayerClock {
    if (scheduledContentEnabled()) return { offsetDays, date: new Date(getEventScheduleView(Date.now(), offsetDays).contentTime) }
    return { offsetDays, date: new Date(getGlobalServerDate().getTime() + offsetDays * GAME_DAY_MS) }
}

/** The player's clock, or null if there is no such player. */
export function getPlayerClockSync(playerId: number): PlayerClock | null {
    const account = getAccountFromPlayerIdSync(playerId)
    return account === null ? null : clockOf(effectiveContentOffset(getAccountClockSync(account.id)))
}

/** How many days a player's clock would be from the server clock to be on `date`'s game day. */
export function clockOffsetDaysFor(date: Date): number {
    const now = scheduledContentEnabled() ? getEventScheduleView(Date.now(), 0).contentTime : getGlobalServerDate().getTime()
    const today = gameDayStart(gameDayOf(now))
    return Math.round((gameDayStart(gameDayOf(date.getTime())) - today) / GAME_DAY_MS)
}

/**
 * Puts the player on `date`'s game day, at the server clock's time of day, from now on; `null` makes the player
 * follow the server clock again. The client sees the new date in the next reply: a different game day sends it back
 * to the title, and the following `/load` runs the day's resets on the new clock. A move back to earlier days starts
 * an era of the player's own (see `getClockEra()` in src/lib/serverClock.ts), so days and months the player already
 * played count as new ones for resets and shop stock, as after a calendar wrap. Returns the new clock, or null if
 * there is no such player. Throws a RangeError past `MAX_CLOCK_OFFSET_DAYS`. Whether content is open on that day is
 * for the caller to check (`contentGapIn()` in src/lib/eventCalendar.ts).
 */
export function setPlayerClockSync(playerId: number, date: Date | null, source: "player" | "admin" = "player"): PlayerClock | null {
    const account = getAccountFromPlayerIdSync(playerId)
    if (account === null) return null
    const offsetDays = date === null ? 0 : clockOffsetDaysFor(date)
    if (!Number.isSafeInteger(offsetDays) || Math.abs(offsetDays) > MAX_CLOCK_OFFSET_DAYS)
        throw new RangeError(`A player's clock can be at most ${MAX_CLOCK_OFFSET_DAYS} days from the server clock.`)
    const current = getAccountClockSync(account.id)
    const era = scheduledContentEnabled() ? 0 : current.era + (clockHasEras() && offsetDays < current.offsetDays ? 1 : 0)
    setAccountClockSync(account.id, { offsetDays, era, source })
    return clockOf(offsetDays)
}

/**
 * Runs `fn` on the player's clock, for work done for a player outside their own requests (the admin site acting on a
 * player, such as sending mail, so its dates are the player's).
 */
export function runOnPlayerClockSync<T>(playerId: number, fn: () => T): T {
    const account = getAccountFromPlayerIdSync(playerId)
    const clock = account === null ? SERVER_CLOCK : getAccountClockSync(account.id)
    return runOnEventView(effectiveContentOffset(clock), () => runOnClock(requestClockOf(clock), fn))
}

/** Policy changes immediately suspend saved personal views without changing reward/reset history. */
export function effectiveContentOffset(clock: AccountClock): number {
    if (!scheduledContentEnabled()) return clock.offsetDays
    const policy = getEventPolicy()
    const allowed = clock.source === "admin" ? policy.adminTimeTravel : policy.mode === "time-travel"
    return allowed ? clock.offsetDays : 0
}
