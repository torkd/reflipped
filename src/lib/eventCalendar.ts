import { scheduledContentEnabled } from "./eventSchedule";
// What the event calendar works with (FT-5): the events in the master data and their periods
// (`assets/event_calendar.json`, from scripts/converter.py), the portals open in a window, and whether a clock stays
// on dates where a summoning portal is open. Without an open portal the client fails with C8601 when it shows the
// portals and a new player can't finish the tutorial, so that is what "content" means here. The portal periods in
// `assets/gacha.json` leave no gap from 2018-10-03 to 2025-01-31, but nothing here relies on that.

import calendarData from "../../assets/event_calendar.json";
import gachas from "../../assets/gacha.json";
import { Gachas } from "./types";
import { masterDate } from "../utils";
import { advanceCalendar, CalendarWindow, checkCalendarWindow, gameDayOf, GAME_DAY_MS, MAX_CALENDAR_WINDOWS, windowBounds, WindowBounds } from "./calendar";
import { getCalendarWindows, getClockStatus, getGlobalServerDate, setCalendarWindows } from "./serverClock";

/** How far ahead the admin site warns that a clock leaves the content. */
const CONTENT_WARNING_DAYS = 7

/** The master tables the events come from, as the admin site names them. */
const EVENT_KINDS: Record<string, string> = {
    story_event: "Story event",
    world_story_event: "World story",
    advent_event: "Boss event",
    carnival_event: "Carnival",
    hard_multi_event: "Co-op boss",
    raid_event: "Raid",
    ranking_event: "Time trial",
    rush_event: "Gauntlet"
}

export interface ContentEvent {
    /** "<table>/<id>": ids repeat across the tables */
    id: string
    kind: string
    name: string
    start: Date
    end: Date
}

let events: ContentEvent[] | undefined = undefined

/** Every event with a period, by start. */
export function listEvents(): ContentEvent[] {
    events ??= calendarData.events.map(event => ({
        id: event.id,
        kind: EVENT_KINDS[event.kind] ?? event.kind,
        name: event.name,
        start: masterDate(event.start),
        end: masterDate(event.end)
    }))
    return events
}

export function getEvent(id: string): ContentEvent | null {
    return listEvents().find(event => event.id === id) ?? null
}

/** A window of the event's game days, from the day it starts to the day it ends. */
export function eventWindow(event: ContentEvent): CalendarWindow {
    return { from: gameDayOf(event.start.getTime()), to: gameDayOf(event.end.getTime()), label: event.name }
}

/** The events whose period overlaps [start, end) (ms). */
export function eventsIn(start: number, end: number): ContentEvent[] {
    return listEvents().filter(event => event.start.getTime() < end && event.end.getTime() >= start)
}

/** A portal's period as times; its end date is the last second it is open, so it closes a second later. */
function portalPeriod(gacha: { startDate: string, endDate: string }): WindowBounds {
    return { start: masterDate(gacha.startDate).getTime(), end: masterDate(gacha.endDate).getTime() + 1000 }
}

/** The portals open at some time in [start, end) (ms), by id, with their names. */
export function portalsIn(start: number, end: number): { id: string, name: string }[] {
    const names = calendarData.portals as Record<string, string>
    return Object.entries(gachas as Gachas)
        .filter(([, gacha]) => { const period = portalPeriod(gacha); return period.start < end && period.end > start })
        .map(([id]) => ({ id, name: names[id] ?? `Portal ${id}` }))
}

let coverage: WindowBounds[] | undefined = undefined

/** The stretches of time in which at least one portal is open, merged and in order. */
function portalCoverage(): WindowBounds[] {
    if (coverage) return coverage
    const periods = Object.values(gachas as Gachas).map(portalPeriod).sort((a, b) => a.start - b.start)
    const merged: WindowBounds[] = []
    for (const period of periods) {
        const last = merged[merged.length - 1]
        if (last !== undefined && period.start <= last.end) last.end = Math.max(last.end, period.end)
        else merged.push({ ...period })
    }
    coverage = merged
    return merged
}

/** The first time in [start, end) (ms) at which no portal is open, or null when one is open throughout. */
export function contentGapIn(start: number, end: number): number | null {
    let time = start
    for (const stretch of portalCoverage()) {
        if (time >= end) return null
        if (stretch.end <= time) continue
        if (stretch.start > time) return time
        time = stretch.end
    }
    return time < end ? time : null
}

/** The first and last moments any portal is open, for the admin site's hints. */
export function contentRange(): WindowBounds {
    const stretches = portalCoverage()
    return { start: stretches[0].start, end: stretches[stretches.length - 1].end }
}

export interface ContentWarning {
    /** "outside": no portal is open on the clock now; "leaving": it gets there within `CONTENT_WARNING_DAYS` */
    kind: "outside" | "leaving"
    /** the clock's date when it has no portal */
    clockDate: Date
    /** how long until then, in ms of real time (0 for "outside") */
    inMs: number
}

/**
 * Whether a clock `offsetDays` from the server clock (0: the server clock) is, or within `CONTENT_WARNING_DAYS`
 * will be, on a date with no portal open. It follows the server clock's path: straight on when it runs freely,
 * through the calendar's switches when it runs on the calendar.
 */
export function contentWarning(offsetDays = 0): ContentWarning | null {
    if (scheduledContentEnabled()) return null // The scheduled baseline portal covers every content view.
    const offset = offsetDays * GAME_DAY_MS
    const horizon = CONTENT_WARNING_DAYS * GAME_DAY_MS
    const status = getClockStatus()
    const bounds = status.window === null ? null : getCalendarWindows().map(windowBounds)
    let index = status.window?.index ?? 0
    let serverTime = getGlobalServerDate().getTime()
    let elapsed = 0
    // one stretch of the path at a time: until the window's end (or the horizon), then on at the next window
    while (elapsed < horizon) {
        const stretchEnd = bounds === null ? serverTime + horizon - elapsed : Math.min(bounds[index].end, serverTime + horizon - elapsed)
        const gap = contentGapIn(serverTime + offset, stretchEnd + offset)
        if (gap !== null) {
            const inMs = elapsed + (gap - offset - serverTime)
            return { kind: inMs === 0 ? "outside" : "leaving", clockDate: new Date(gap), inMs }
        }
        elapsed += stretchEnd - serverTime
        if (bounds === null) break
        const next = advanceCalendar(bounds, { index, time: stretchEnd, era: 0 }, 0)
        index = next.index
        serverTime = next.time
    }
    return null
}

/** A change to the rotation from the admin site or `POST /api/server/calendar/windows`. */
export interface RotationChange {
    action: "add" | "event" | "remove" | "up" | "down" | "default"
    /** the window to remove or move (0-based) */
    index?: number | string
    /** the event to add (`ContentEvent.id`) */
    event?: string
    /** a custom window to add */
    from?: string
    to?: string
    label?: string
    /** "1" adds a window even with days on which no portal is open */
    force?: string
}

/**
 * Applies a change to the rotation; a running calendar carries on (see `setCalendarWindows`). Returns a fixed code
 * for the admin page's notice: the change made, or why nothing changed.
 */
export function changeRotation(change: RotationChange): { ok: boolean, code: string } {
    if (change.action === "default") {
        setCalendarWindows(null)
        return { ok: true, code: "calendar_default" }
    }
    const windows = getCalendarWindows()
    if (change.action === "add" || change.action === "event") {
        let window: CalendarWindow | string
        if (change.action === "event") {
            const event = getEvent(String(change.event ?? ""))
            window = event === null ? "unknown_event" : eventWindow(event)
        } else {
            window = checkCalendarWindow(change.from, change.to, change.label)
        }
        if (typeof window === "string") return { ok: false, code: window }
        if (windows.length >= MAX_CALENDAR_WINDOWS) return { ok: false, code: "too_many_windows" }
        const bounds = windowBounds(window)
        if (change.force !== "1" && contentGapIn(bounds.start, bounds.end) !== null) return { ok: false, code: "no_portal" }
        setCalendarWindows([...windows, window])
        return { ok: true, code: "window_added" }
    }

    // a form sends text: only digits name a window (Number("") would be 0, the first one)
    const index = typeof change.index === "string" ? (/^\d{1,3}$/.test(change.index) ? Number(change.index) : NaN) : Number(change.index)
    if (!Number.isInteger(index) || index < 0 || index >= windows.length) return { ok: false, code: "unknown_window" }
    if (change.action === "remove") {
        windows.splice(index, 1)
        setCalendarWindows(windows)
        return { ok: true, code: "window_removed" }
    }
    const other = change.action === "up" ? index - 1 : index + 1
    if (other < 0 || other >= windows.length) return { ok: false, code: "window_at_end" }
    ;[windows[index], windows[other]] = [windows[other], windows[index]]
    setCalendarWindows(windows)
    return { ok: true, code: "window_moved" }
}
