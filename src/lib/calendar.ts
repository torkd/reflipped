// Game days and the event calendar's rotation (FT-5), as pure functions of time; src/lib/serverClock.ts keeps the
// state. A calendar is an ordered list of windows, each a range of whole game days. In calendar mode the server clock
// runs 1:1 inside the current window; when it reaches the window's end it carries on at the next window's start, and
// after the last window at the first. Windows are whole game days, so every switch happens at 05:00 Japan time
// (20:00 UTC), when the client's own day changes and it returns to the title anyway (src/lib/resets.ts), and the time
// of day runs on unbroken.

/** One game day in milliseconds. */
export const GAME_DAY_MS = 24 * 60 * 60 * 1000

/**
 * The game day starts at 05:00 Japan time (20:00 UTC), like the master tables' periods ("… 05:00:00"), so a date's
 * game day is the UTC date four hours later.
 */
const GAME_DAY_OFFSET_MS = 4 * 60 * 60 * 1000

/** The game day ("YYYY-MM-DD") a time (ms) falls in. */
export function gameDayOf(time: number): string {
    return new Date(time + GAME_DAY_OFFSET_MS).toISOString().slice(0, 10)
}

/** When a game day ("YYYY-MM-DD") starts, in ms: 20:00 UTC on the day before. NaN for an invalid day. */
export function gameDayStart(day: string): number {
    if (!/^\d{4}-\d\d-\d\d$/.test(day)) return NaN
    const midnight = Date.parse(`${day}T00:00:00Z`)
    // Date.parse rolls "2025-02-30" over to March; a day that doesn't round-trip is invalid
    if (isNaN(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day) return NaN
    return midnight - GAME_DAY_OFFSET_MS
}

/** How far into its game day a time is, in ms. */
export function timeIntoGameDay(time: number): number {
    return time - gameDayStart(gameDayOf(time))
}

/** A window of the rotation: game days `from` to `to`, both included ("YYYY-MM-DD"), and a name for the admin site. */
export interface CalendarWindow {
    from: string
    to: string
    label: string
}

/** A window as times: from `start` (included) to `end` (excluded), in ms. */
export interface WindowBounds {
    start: number
    end: number
}

/**
 * The years the server clock can be set in, by hand, by `SERVER_TIME` or as calendar windows. The content lies in
 * 2018 to 2025; the range keeps every clock, a player's too (at most `MAX_CLOCK_OFFSET_DAYS` away), within the dates
 * a save file holds (src/data/saveSchema.ts), so a player's own export always imports.
 */
export const EARLIEST_CLOCK_YEAR = 2000
export const LATEST_CLOCK_YEAR = 2100

/** Whether a time (ms) lies in a year the server clock can be set in. */
export function isClockYear(time: number): boolean {
    const year = new Date(time).getUTCFullYear()
    return year >= EARLIEST_CLOCK_YEAR && year <= LATEST_CLOCK_YEAR
}

/** At most this many windows, and labels up to this length: the admin page lists them all. */
export const MAX_CALENDAR_WINDOWS = 100
export const MAX_WINDOW_LABEL_LENGTH = 100

export function windowBounds(window: CalendarWindow): WindowBounds {
    return { start: gameDayStart(window.from), end: gameDayStart(window.to) + GAME_DAY_MS }
}

/**
 * Checks a window: real days in the clock's years, `to` not before `from` (a window is at least one game day, so none
 * is empty or shorter than a day), a label without control characters. Returns the window cleaned up, or why it is
 * refused.
 */
export function checkCalendarWindow(from: unknown, to: unknown, label: unknown): CalendarWindow | string {
    const isDay = (day: unknown): day is string => typeof day === "string" && !isNaN(gameDayStart(day)) && isClockYear(Date.parse(`${day}T00:00:00Z`))
    if (!isDay(from)) return "invalid_from"
    if (!isDay(to)) return "invalid_to"
    if (to < from) return "window_reversed"
    const text = typeof label === "string" ? label.trim() : ""
    if (text.length > MAX_WINDOW_LABEL_LENGTH || /[\u0000-\u001f\u007f]/.test(text)) return "invalid_label"
    return { from, to, label: text || (from === to ? from : `${from} to ${to}`) }
}

/** Where the clock is in a calendar: window `index`, at server time `time` (ms), in `era` (see `advanceCalendar`). */
export interface CalendarPosition {
    index: number
    time: number
    era: number
}

/**
 * Moves a position on by `elapsed` ms of real time. Past a window's end the clock carries on at the next window's
 * start with the same overshoot, so the time of day runs on. Each move to an earlier time (a wrap, or an unsorted or
 * overlapping next window) starts a new era: the dates repeat, and the era tells them apart (`gameDay()` in
 * src/lib/resets.ts), so daily and monthly resets and shop stock start over as if the days were new.
 */
export function advanceCalendar(bounds: readonly WindowBounds[], position: CalendarPosition, elapsed: number): CalendarPosition {
    const count = bounds.length
    let { index, era } = position
    let time = position.time + elapsed
    if (count === 0 || index < 0 || index >= count || time < bounds[index].end) return { index, time, era }

    // a server that was off for a long time skips whole rounds at once: each is as long as all windows together and
    // goes back the same number of times, from wherever it starts
    const round = bounds.reduce((total, window) => total + (window.end - window.start), 0)
    const backwardsPerRound = bounds.filter((window, i) => bounds[(i + 1) % count].start < window.end).length
    const overshoot = time - bounds[index].end
    const rounds = Math.floor(overshoot / round)
    time -= rounds * round
    era += rounds * backwardsPerRound

    while (time >= bounds[index].end) {
        const next = (index + 1) % count
        if (bounds[next].start < bounds[index].end) era++
        time = bounds[next].start + (time - bounds[index].end)
        index = next
    }
    return { index, time, era }
}

/**
 * Where a clock at `time` enters a calendar: inside the window that holds it (`preferred` first, so a change to other
 * windows keeps the current one when it can), otherwise at the first window's first day, at the same time of day.
 */
export function enterCalendar(bounds: readonly WindowBounds[], time: number, preferred = -1): { index: number, time: number } {
    const holds = (i: number) => bounds[i] !== undefined && bounds[i].start <= time && time < bounds[i].end
    if (holds(preferred)) return { index: preferred, time }
    const index = bounds.findIndex((_, i) => holds(i))
    if (index >= 0) return { index, time }
    return { index: 0, time: bounds[0].start + timeIntoGameDay(time) }
}
