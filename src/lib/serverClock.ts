import { scheduledContentEnabled, requestProgressionTime } from "./eventSchedule";
// The server clock: what "now" is for the game (every reply's `servertime`, gacha, shop and event periods, resets).
//
// It starts on a fixed date with content and runs in real time from there, either freely or on the event calendar
// (FT-5, src/lib/calendar.ts), which keeps it inside chosen windows of content. A game request can run on a player's
// own clock, the server clock moved by a whole number of days (src/lib/playerClock.ts); `getServerDate()` and
// `getServerTime()` return that clock inside such a request, so no call site needs to know about it.

import { AsyncLocalStorage } from "async_hooks"
import { getStoredText, setStoredText, setStoredTexts } from "../data/serverSettings"
import { advanceCalendar, CalendarPosition, CalendarWindow, checkCalendarWindow, EARLIEST_CLOCK_YEAR, enterCalendar, gameDayOf, isClockYear, LATEST_CLOCK_YEAR, MAX_CALENDAR_WINDOWS, windowBounds, WindowBounds } from "./calendar"

/**
 * The clock the server runs on when no time has been set through the web UI.
 * `SERVER_TIME` is a UTC date ("2025-01-03T12:00:00" or "2025-01-03T12:00"), or "real" for the machine's clock.
 * The default is a moment when the gacha, shops and events in `assets/` are open, since with the real date
 * (past the end of the last event) no summoning portal opens and the client fails with C8601.
 *
 * The clock starts there (or at a time set in the web UI) and then runs in real time. It must run: the client
 * rebuilds its own clock from every reply's `servertime`, so a frozen one pulls the client's clock back on each
 * request and stretches all its timers (co-op invitation polling, recruiting, AI summon; docs/coop-research.md).
 * `SERVER_CLOCK=frozen` keeps the old frozen clock (the tests use it). Stamina regenerates from its own heal time
 * (src/lib/stamina.ts); pooled exp doesn't, and its timestamp is reported as "now". The running clock is stored in
 * the database and carries on after a restart; changing `SERVER_TIME`, or Reset on the admin site, starts it again
 * from the configured time.
 */
export const DEFAULT_SERVER_TIME = "2025-01-03T12:00:00"

/**
 * The rotation the event calendar has until an admin changes it: the default start's game day to the last game day
 * on which a summoning portal is open all day (the last one closes at 2025-01-31 04:59:59 UTC, five hours into game
 * day 2025-01-31). Starting on the default time, the clock wraps from the end of 30 January back to 3 January instead
 * of running out of content after four weeks (test/eventCalendar.test.ts checks these days against the assets).
 */
export const DEFAULT_CALENDAR: readonly CalendarWindow[] = Object.freeze([
    { from: "2025-01-03", to: "2025-01-30", label: "Default: 3 to 30 January 2025" }
])

export function parseServerTime(value: string): Date | null {
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d)(:\d\d)?(\.\d+)?Z?$/.exec(value.trim())
    const date = match ? new Date(`${match[1]}${match[2] ?? ":00"}${match[3] ?? ""}Z`) : null
    return date && !isNaN(date.getTime()) ? date : null
}

function defaultServerTime(): Date | null {
    const configured = process.env.SERVER_TIME?.trim() || DEFAULT_SERVER_TIME
    if (configured.toLowerCase() === "real") return null
    const date = parseServerTime(configured)
    if (!date) throw new Error(`Invalid SERVER_TIME "${configured}": use YYYY-MM-DDTHH:MM[:SS] (UTC) or "real".`)
    if (!isClockYear(date.getTime())) throw new Error(`Invalid SERVER_TIME "${configured}": pick a date from ${EARLIEST_CLOCK_YEAR} to ${LATEST_CLOCK_YEAR}.`)
    return date
}

/** `SERVER_CLOCK=frozen` stops the server clock at the time it was set; anything else lets it run. */
function isClockFrozen(): boolean {
    return process.env.SERVER_CLOCK?.trim().toLowerCase() === "frozen"
}

// ---- the calendar's rotation (admin config) ----

/** server_settings key of the rotation; absent means `DEFAULT_CALENDAR` */
const CALENDAR_KEY = "clock.calendar"

let rotation: { windows: CalendarWindow[], bounds: WindowBounds[] } | undefined = undefined

function useRotation(windows: CalendarWindow[]) {
    rotation = { windows, bounds: windows.map(windowBounds) }
    return rotation
}

/** The stored rotation, without windows that no longer pass the checks (the stored text is never trusted blindly). */
function loadRotation(): CalendarWindow[] {
    const stored = getStoredText(CALENDAR_KEY)
    if (stored === null) return DEFAULT_CALENDAR.map(window => ({ ...window }))
    try {
        const parsed = JSON.parse(stored)?.windows
        if (!Array.isArray(parsed)) return []
        return parsed.slice(0, MAX_CALENDAR_WINDOWS)
            .map(window => checkCalendarWindow(window?.from, window?.to, window?.label))
            .filter((window): window is CalendarWindow => typeof window !== "string")
    } catch {
        return []
    }
}

function currentRotation() {
    return rotation ?? useRotation(loadRotation())
}

// ---- the clock's anchor and era (state) ----

interface ClockAnchor {
    /** the server date the clock was set to */
    date: Date
    /** the machine time (ms) when that happened */
    setAt: number
    /** the rotation window the clock runs in, or null when it runs freely */
    window: number | null
}

/** server_settings key of the running clock's anchor, so a restart carries on instead of jumping back */
const CLOCK_ANCHOR_KEY = "clock.anchor"
/** server_settings key of the era: how often the clock has moved back to an earlier game day (see `getClockEra`) */
const CLOCK_ERA_KEY = "clock.era"
/** the start stored with the anchor when the clock follows the machine's (`SERVER_TIME=real`) */
const REAL_START = "real"

// The server clock (null: the machine's clock). Loaded on first use, since the database may not be open yet.
let serverClock: ClockAnchor | null | undefined = undefined
let clockEra: number | undefined = undefined
/** the machine time of the clock's latest read, to notice the machine's clock going back */
let lastReadAt = -Infinity

/** A clock started at `date`: on the calendar if `date` lies in one of its windows, otherwise running freely. */
function startedAt(date: Date, now: number): ClockAnchor {
    const { bounds } = currentRotation()
    const window = bounds.findIndex(window => window.start <= date.getTime() && date.getTime() < window.end)
    return { date, setAt: now, window: window >= 0 ? window : null }
}

/** Where a clock anchored at `anchor` stands at machine time `now`, and how many eras its walk through the calendar
 * starts on the way. Machine time before the anchor's counts as none: the clock never runs back with the machine's. */
function positionAt(anchor: ClockAnchor, now: number): CalendarPosition {
    const elapsed = Math.max(0, now - anchor.setAt)
    if (anchor.window === null) return { index: -1, time: anchor.date.getTime() + elapsed, era: 0 }
    return advanceCalendar(currentRotation().bounds, { index: anchor.window, time: anchor.date.getTime(), era: 0 }, elapsed)
}

/** The stored anchor (null when there is none or it is unreadable) and the start it was stored with. */
function storedClock(): { anchor: ClockAnchor, start: unknown } | null {
    try {
        const stored = JSON.parse(getStoredText(CLOCK_ANCHOR_KEY) ?? "null")
        const date = new Date(stored?.date)
        if (isNaN(date.getTime()) || !Number.isFinite(stored?.setAt)) return null
        // a stored window that the rotation no longer has (or a broken one) runs freely from the anchor
        const window = Number.isSafeInteger(stored.window) && stored.window >= 0 && stored.window < currentRotation().windows.length ? stored.window as number : null
        return { anchor: { date, setAt: stored.setAt, window }, start: stored.start }
    } catch {
        return null
    }
}

/**
 * The running clock survives a restart: its anchor is stored with the configured start (`SERVER_TIME`), and reused
 * while that start is unchanged. Rewinding the clock on every restart would pull the game's clocks back again. An
 * anchor stored before the calendar existed has no window and keeps running freely. A changed start begins the clock
 * again there, in a new era if that is an earlier game day than the stored clock would show now (its anchor plus the
 * time since, through the calendar's switches, whose wraps count too). `SERVER_TIME=real` stores the machine's clock
 * as its anchor, so leaving it for an earlier date starts an era as well.
 */
function loadClock(): ClockAnchor | null {
    const start = defaultServerTime()
    if (isClockFrozen()) return start === null ? null : startedAt(start, Date.now())
    const now = Date.now()
    const stored = storedClock()
    if (stored !== null && start !== null && stored.start === start.toISOString()) return stored.anchor
    const anchor = start === null ? null : startedAt(start, now)
    if (stored !== null) {
        const shown = positionAt(stored.anchor, now)
        if (shown.era > 0) bumpEra(shown.era)
        if (movesBack(shown.time, anchor?.date.getTime() ?? now)) bumpEra()
    }
    return saveClock(anchor)
}

/**
 * Makes `anchor` the clock (null: the machine's clock) and stores it together with the era, in one write. That keeps
 * the stored pair consistent even when the write happens inside a request's transaction that rolls back (an
 * `atomicHandler` route answering 4xx, where a read of the clock walked over a window's end): the rollback undoes
 * both, and the stored older pair walks to the same date and era again, since the walk depends only on the anchor,
 * the rotation and the time. Memory keeps the newer pair, and the next write stores it whole; storing the era alone
 * could leave the anchor ahead of it, and an era lost that way would give used-up days again.
 */
function saveClock<T extends ClockAnchor | null>(anchor: T): T {
    serverClock = anchor
    if (!isClockFrozen()) {
        // the machine's clock is stored as an anchor at its own time, so a restart on another start can tell where it was
        const stored = anchor ?? { date: new Date(Date.now()), setAt: Date.now(), window: null }
        setStoredTexts([
            [CLOCK_ERA_KEY, String(currentEra())],
            [CLOCK_ANCHOR_KEY, JSON.stringify({ date: stored.date.toISOString(), setAt: stored.setAt, start: defaultServerTime()?.toISOString() ?? REAL_START, window: stored.window })]
        ])
    }
    return anchor
}

function currentEra(): number {
    if (clockEra === undefined) {
        const stored = Number(getStoredText(CLOCK_ERA_KEY))
        clockEra = Number.isSafeInteger(stored) && stored > 0 ? stored : 0
    }
    return clockEra
}

/** Starts `by` new eras; `saveClock()` stores them with the anchor. */
function bumpEra(by = 1) {
    clockEra = currentEra() + by
}

/** Whether clocks have eras: a frozen one (`SERVER_CLOCK=frozen`, the tests) has none (see `getClockEra`). */
export function clockHasEras(): boolean {
    return !isClockFrozen()
}

/** Whether a clock moved from `from` to `to` (ms) goes back to an earlier game day, in a new era. */
function movesBack(from: number, to: number): boolean {
    return clockHasEras() && gameDayOf(to) < gameDayOf(from)
}

/**
 * Moves the clock to `anchor` (null: the machine's clock), for a change from the admin site or the calendar's
 * settings. A move back to an earlier game day than the clock showed (`shown`, read before anything changed) starts a
 * new era, whatever made it: a date set by hand, Reset, turning the calendar on, a change to its windows.
 */
function moveClock(anchor: ClockAnchor | null, shown = getGlobalServerDate()) {
    if (movesBack(shown.getTime(), anchor?.date.getTime() ?? Date.now())) bumpEra()
    saveClock(anchor)
}

/** The server clock's current date (for everyone, no player's offset), or null when it follows the machine's clock. */
function currentGlobalClock(): Date | null {
    // Modern schedules rebase content; the progression clock always advances normally.
    if (scheduledContentEnabled()) {
        const now = Math.max(requestProgressionTime() ?? Date.now(), Number.isFinite(lastReadAt) ? lastReadAt : 0)
        lastReadAt = now
        return new Date(now)
    }
    if (serverClock === undefined) serverClock = loadClock()
    if (serverClock === null) return null
    if (isClockFrozen()) return serverClock.date
    const now = Date.now()
    const latest = Math.max(lastReadAt, serverClock.setAt)
    lastReadAt = now
    if (now < latest) {
        // The machine's clock went back (a VM restored, an NTP fix): carry on from where the clock last stood rather
        // than going back with it, out of its window or to a game day already shown in this era.
        const held = positionAt(serverClock, latest)
        if (held.era > 0) bumpEra(held.era)
        saveClock({ date: new Date(held.time), setAt: now, window: serverClock.window === null ? null : held.index })
        return new Date(held.time)
    }
    if (serverClock.window === null) return new Date(serverClock.date.getTime() + now - serverClock.setAt)

    const moved = positionAt(serverClock, now)
    if (moved.index !== serverClock.window || moved.era > 0) {
        // the clock reached a window's end: anchor it in its new window, so later reads don't repeat the walk and a
        // restart finds the position and the era
        if (moved.era > 0) bumpEra(moved.era)
        saveClock({ date: new Date(moved.time), setAt: now, window: moved.index })
    }
    return new Date(moved.time)
}

// ---- per-request clocks (players' offsets) ----

export interface RequestClock {
    /** how far the request's clock is from the server clock, in ms */
    offsetMs: number
    /** eras of its own, added to the server clock's (a player's clock moved back, src/lib/playerClock.ts) */
    era: number
}

const requestClock = new AsyncLocalStorage<RequestClock>()

/**
 * Runs `fn` (and everything it starts, awaited or not) on a clock `offsetMs` away from the server clock. The store
 * belongs to this call only: other requests, the co-op socket server's own events and timers started outside a
 * request keep the server clock. A callback or timer created inside the call inherits the store (AsyncLocalStorage
 * follows the async context), so it runs on the request's clock even after the request ended. The one timer a game
 * request starts, the co-op fill timer armed by `share_room` (src/lib/coop/recruitment.ts), does run on the host's
 * clock that way, but it and the companions it adds read only the machine's clock (`Date.now()`), never this one.
 */
export function runOnClock<T>(clock: RequestClock, fn: () => T): T {
    return requestClock.run({ ...clock }, fn)
}

/** Moves the clock of the `runOnClock` call this runs in; false outside one. */
export function setRequestClock(clock: RequestClock): boolean {
    const store = requestClock.getStore()
    if (store === undefined) return false
    store.offsetMs = clock.offsetMs
    store.era = clock.era
    return true
}

/** The clock of the current call: the server clock moved by the request's offset, or null for the machine's clock. */
function currentServerClock(): Date | null {
    const global = currentGlobalClock()
    if (scheduledContentEnabled()) return global
    const offset = requestClock.getStore()?.offsetMs ?? 0
    if (offset === 0) return global
    return new Date((global?.getTime() ?? Date.now()) + offset)
}

/**
 * Returns the current server time as a unix epoch.
 *
 * @param date An optional recorded date. Modern schedules preserve it; without one, use progression time.
 *   Historical-clock compatibility mode retains its previous clock-override behavior.
 * @returns The unix epoch.
 */
export function getServerTime(
    date?: Date
): number {
    if (scheduledContentEnabled()) return Math.floor((date ?? getServerDate()).getTime() / 1000)
    return Math.floor((currentServerClock() ?? date ?? new Date()).getTime() / 1000)
}

/**
 * Gets the current server time as a Date: the player's clock inside a game request of a player who has one
 * (src/lib/playerClock.ts), otherwise the server clock.
 *
 * @returns The current server time as a date.
 */
export function getServerDate(): Date {
    return currentServerClock() ?? new Date()
}

/** The server clock for everyone, whatever clock the current request runs on. */
export function getGlobalServerDate(): Date {
    return currentGlobalClock() ?? new Date()
}

/**
 * How often the clock has moved back to an earlier game day (0 until it first does): at a calendar wrap, and when a
 * date set by hand, Reset, turning the calendar on or a change to its windows moves it back. Inside a request on a
 * player's clock, the player's own era is added (how often their clock was moved back): both only grow, so the sum
 * grows with either and a player never sees an earlier game day under the same key twice. Game days include it
 * (src/lib/resets.ts), so a repeated date is a new day for resets and shop stock. A frozen clock (`SERVER_CLOCK=frozen`,
 * the tests) has none: it is set by hand all the time and keeps the behaviour from before eras.
 */
export function getClockEra(): number {
    if (scheduledContentEnabled()) return 0
    currentGlobalClock()
    return currentEra() + (requestClock.getStore()?.era ?? 0)
}

/**
 * Sets the server time; the clock runs on from there, freely (the calendar stops). `null` goes back to the default
 * clock (see `SERVER_TIME`), which runs on the calendar when the default time lies in one of its windows.
 */
export function setServerTime(date: Date | null) {
    if (scheduledContentEnabled()) throw new RangeError("The progression clock follows real time. Use event settings or time travel to choose content.")
    if (date !== null) return moveClock({ date, setAt: Date.now(), window: null })
    const start = defaultServerTime()
    moveClock(start === null ? null : startedAt(start, Date.now()))
}

// ---- the calendar, for the admin site ----

export function getCalendarWindows(): CalendarWindow[] {
    return currentRotation().windows.map(window => ({ ...window }))
}

/**
 * Replaces the rotation (already checked with `checkCalendarWindow`). A running calendar carries on in the window that
 * holds the current date (the current one if it still does), otherwise at the first window's start; an empty rotation
 * stops it, and the clock runs on freely.
 */
export function setCalendarWindows(windows: CalendarWindow[] | null) {
    const now = getGlobalServerDate()
    const running = isCalendarRunning()
    setStoredText(CALENDAR_KEY, windows === null ? null : JSON.stringify({ windows }))
    useRotation(windows === null ? DEFAULT_CALENDAR.map(window => ({ ...window })) : windows.slice(0, MAX_CALENDAR_WINDOWS))
    if (running) enterRotation(now, serverClock?.window ?? -1)
}

function isCalendarRunning(): boolean {
    currentGlobalClock()
    return serverClock != null && serverClock.window !== null
}

/** Puts the clock, at `now` (read before the rotation changed), on the current rotation. */
function enterRotation(now: Date, preferred: number) {
    const { bounds } = currentRotation()
    if (bounds.length === 0) return moveClock({ date: now, setAt: Date.now(), window: null }, now)
    const entered = enterCalendar(bounds, now.getTime(), preferred)
    moveClock({ date: new Date(entered.time), setAt: Date.now(), window: entered.index }, now)
}

/**
 * Runs the clock on the calendar from now: on in the window that holds the current date, or from the first window's
 * first day at the current time of day. False when the rotation is empty.
 */
export function startCalendar(): boolean {
    if (currentRotation().windows.length === 0) return false
    enterRotation(getGlobalServerDate(), -1)
    return true
}

/** Lets the clock run on freely from where it is. */
export function stopCalendar() {
    moveClock({ date: getGlobalServerDate(), setAt: Date.now(), window: null })
}

export interface ClockStatus {
    /** `real`: the machine's clock (`SERVER_TIME=real`); `free`: runs on from a set time; `calendar`: in a window */
    mode: "real" | "free" | "calendar"
    frozen: boolean
    date: Date
    /** the calendar window it runs in */
    window: { index: number, window: CalendarWindow, start: Date, end: Date } | null
    era: number
}

export function getClockStatus(): ClockStatus {
    const date = getGlobalServerDate()
    if (scheduledContentEnabled()) return { mode: "real", frozen: false, date, window: null, era: 0 }
    const anchor = serverClock ?? null
    const index = anchor?.window ?? null
    const { windows, bounds } = currentRotation()
    return {
        mode: anchor === null ? "real" : index === null ? "free" : "calendar",
        frozen: isClockFrozen(),
        date,
        window: index === null ? null : { index, window: { ...windows[index] }, start: new Date(bounds[index].start), end: new Date(bounds[index].end) },
        era: currentEra()
    }
}

/** Forgets the loaded clock and rotation, so the next read loads the stored ones, as after a restart (tests). */
export function reloadServerClock() {
    serverClock = undefined
    rotation = undefined
    clockEra = undefined
    lastReadAt = -Infinity
}
