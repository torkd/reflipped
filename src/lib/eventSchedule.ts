/** A persisted, deterministic content timeline. Content dates never change the player's reward day. */
import { AsyncLocalStorage } from "async_hooks";
import { createHash } from "crypto";
import catalog from "../../assets/event_calendar.json";
import { getStoredText, setStoredText } from "../data/serverSettings";
import { GAME_DAY_MS, gameDayOf, gameDayStart, CalendarWindow, checkCalendarWindow, windowBounds } from "./calendar";
import { EventMode, getEventPolicy, setEventPolicy } from "./eventPolicy";

const rawDate = (text: string) => Date.parse(`${text.replace(" ", "T")}+09:00`)
export const SCHEDULE_CATALOG_VERSION = 1
export const eventCatalog = catalog.events.map(event => ({ ...event, startTime: rawDate(event.start), endTime: rawDate(event.end) + 1000 }))
    .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id, "en"))
export const HISTORICAL_START = Math.min(...eventCatalog.map(event => event.startTime))
export const HISTORICAL_END = Math.max(...eventCatalog.map(event => event.endTime))
export const DEFAULT_MANUAL_WINDOWS: readonly CalendarWindow[] = [{ from: "2025-01-03", to: "2025-01-30", label: "January archive period" }]
const contentContext = new AsyncLocalStorage<{ offsetDays: number, now: number, captured?: EventRunContext }>()

export interface EventRunContext {
    occurrenceKey: string
    contentTime: number
    profile: EventMode
    /** the timeline's speed when the context was captured (Accelerated: its speed, else 1); absent in old snapshots */
    rate?: number
}
export interface ManualPeriod extends CalendarWindow { eventId?: string }

export interface EventScheduleView extends EventRunContext {
    sourceEnd: number
    key: string
    cycle: number
    /** the period of the timeline playing (a Manual playlist entry; 0 for the archive) */
    index: number
    sourceStart: number
    targetStart: number
    rate: number
}

/** Frozen legacy fixtures and explicit legacy deployments keep their original clock semantics. */
export function scheduledContentEnabled(): boolean {
    return process.env.EVENT_SCHEDULING?.trim().toLowerCase() !== "off" && process.env.SERVER_CLOCK?.trim().toLowerCase() !== "frozen"
}

export function runOnEventView<T>(offsetDays: number, fn: () => T): T {
    return contentContext.run({ offsetDays, now: Date.now() }, fn)
}

export function setRequestEventView(offsetDays: number): void {
    const context = contentContext.getStore()
    if (context) context.offsetDays = offsetDays
}

export function getManualWindows(): ManualPeriod[] {
    const stored = getStoredText("events.manual_windows")
    if (stored === null) return DEFAULT_MANUAL_WINDOWS.map(window => ({ ...window }))
    const parsed: unknown = JSON.parse(stored)
    if (!Array.isArray(parsed) || parsed.length > 100) throw new RangeError("Invalid manual event rotation")
    return parsed.map(value => {
        const checked = checkCalendarWindow(value?.from, value?.to, value?.label)
        if (typeof checked === "string") throw new RangeError(checked)
        if (value?.eventId !== undefined && !eventCatalog.some(event => event.id === value.eventId)) throw new RangeError("Unknown manual event")
        return { ...checked, ...(value?.eventId ? { eventId: value.eventId as string } : {}) }
    })
}

export function setManualWindows(windows: ManualPeriod[]): void {
    if (windows.length > 100) throw new RangeError("At most 100 event periods")
    const checked = windows.map(value => {
        const result = checkCalendarWindow(value.from, value.to, value.label)
        if (typeof result === "string") throw new RangeError(result)
        const bounds = windowBounds(result)
        if (bounds.start < gameDayStart(gameDayOf(HISTORICAL_START)) || bounds.end > gameDayStart(gameDayOf(HISTORICAL_END - 1)) + GAME_DAY_MS) throw new RangeError("Manual periods must stay within the archived event timeline")
        if (value.eventId !== undefined && !eventCatalog.some(event => event.id === value.eventId)) throw new RangeError("Unknown manual event")
        return { ...result, ...(value.eventId ? { eventId: value.eventId } : {}) }
    })
    setStoredText("events.manual_windows", JSON.stringify(checked))
}

/** Pure arithmetic: offline time is walked once; no timer jobs or random choices are involved. */
export function resolveTimeline(windows: readonly { start: number, end: number }[], anchor: number, now: number, rate: number) {
    if (!windows.length || windows.some(w => !Number.isSafeInteger(w.start) || !Number.isSafeInteger(w.end) || w.end <= w.start)
        || !Number.isFinite(now) || !Number.isSafeInteger(anchor) || !Number.isFinite(rate) || rate <= 0)
        throw new RangeError("Invalid event timeline")
    const total = windows.reduce((sum, w) => sum + w.end - w.start, 0)
    const elapsed = Math.max(0, now - anchor) * rate
    const cycle = Math.floor(elapsed / total)
    let within = elapsed - cycle * total
    let prior = 0
    for (let index = 0; index < windows.length; index++) {
        const w = windows[index]
        const length = w.end - w.start
        if (within < length) return {
            cycle, index, contentTime: w.start + within,
            sourceStart: w.start, targetStart: anchor + (cycle * total + prior) / rate
        }
        within -= length
        prior += length
    }
    throw new RangeError("Event timeline overflow")
}

/** The source periods the timeline plays in turn: the Manual playlist's, or the whole archive. */
export function timelineWindows(policy = getEventPolicy()): { start: number, end: number }[] {
    const manual = policy.mode === "manual" ? getManualWindows().map(window => {
        const event = eventCatalog.find(event => event.id === window.eventId)
        return event ? { start: event.startTime, end: event.endTime } : windowBounds(window)
    }) : []
    return policy.mode === "manual" && manual.length ? manual : [{ start: HISTORICAL_START, end: HISTORICAL_END }]
}

export const timelineRate = (policy = getEventPolicy()) => policy.mode === "accelerated" ? policy.acceleration : 1

/**
 * The anchor that puts the shared timeline on a source moment now: the first period holding it (in Manual mode, a
 * playlist entry; otherwise the archive). Null when no period holds it (an event missing from the Manual playlist).
 */
export function anchorForContentTime(sourceTime: number, now = Date.now(), policy = getEventPolicy(), cycle = 0): number | null {
    const windows = timelineWindows(policy)
    const total = windows.reduce((sum, window) => sum + window.end - window.start, 0)
    let prior = 0
    for (const window of windows) {
        if (window.start <= sourceTime && sourceTime < window.end) {
            // floored, so the content time lands on the moment or just after it, never before the event opens
            return Math.floor(now - (cycle * total + prior + sourceTime - window.start) / timelineRate(policy))
        }
        prior += window.end - window.start
    }
    return null
}

/** How many days "Go to" can pick in an event: its first day, then one per 24 hours until it closes. */
export function eventDayCount(event: { startTime: number, endTime: number }): number {
    return Math.max(1, Math.ceil((event.endTime - event.startTime) / GAME_DAY_MS))
}

export type EventJumpResult = "ok" | "unknown_event" | "invalid_day" | "event_not_in_playlist"

/**
 * The admin calendar's "Go to": moves the shared timeline to an event's opening, or with `day` > 1 to the same time of
 * day that many days later (day 2 is 24 hours after the opening), for every player not on a personal period (those
 * keep their offset). Going to the opening starts a new run (`rotationId`), like a playlist edit, so the event starts
 * fresh: its missions, Limited login bonuses and records (scores, leaderboards, raid kills, rewards received;
 * `EVENT_RUN_TABLES` in src/data/wdfpData.ts) are kept per run. A later day of the event that is open on the timeline
 * now carries on its run (same `rotationId` and cycle), so the content its later days unlock can be tested on the
 * progress made so far; a later day of any other event starts a new run too. Clients see it after returning to the
 * title.
 */
export function jumpToEventSync(eventId: string, now = Date.now(), day = 1): EventJumpResult {
    const event = eventCatalog.find(event => event.id === eventId)
    if (event === undefined) return "unknown_event"
    if (!Number.isSafeInteger(day) || day < 1 || day > eventDayCount(event)) return "invalid_day"
    const target = event.startTime + (day - 1) * GAME_DAY_MS
    const policy = getEventPolicy()
    if (day > 1) {
        const view = getEventScheduleView(now, 0)
        if (event.startTime <= view.contentTime && view.contentTime < event.endTime) {
            const anchor = anchorForContentTime(target, now, policy, view.cycle)
            if (anchor !== null && resolveTimeline(timelineWindows(policy), anchor, now, timelineRate(policy)).index === view.index) {
                setEventPolicy({ ...policy, anchor })
                return "ok"
            }
        }
    }
    const anchor = anchorForContentTime(target, now, policy)
    if (anchor === null) return "event_not_in_playlist"
    setEventPolicy({ ...policy, anchor, rotationId: now })
    return "ok"
}

export function getEventScheduleView(now = contentContext.getStore()?.now ?? Date.now(), offsetDays = contentContext.getStore()?.offsetDays ?? 0): EventScheduleView {
    const policy = getEventPolicy()
    const windows = timelineWindows(policy)
    const rate = timelineRate(policy)
    const position = resolveTimeline(windows, policy.anchor, now, rate)
    const offset = offsetDays * GAME_DAY_MS
    const fingerprint = createHash("sha256").update(JSON.stringify([SCHEDULE_CATALOG_VERSION, policy.mode, policy.anchor, rate, windows])).digest("hex").slice(0, 16)
    const occurrenceKey = `v${SCHEDULE_CATALOG_VERSION}:${policy.rotationId ?? policy.anchor}:${position.cycle}:${position.index}`
    const key = `${fingerprint}:${occurrenceKey}:${offsetDays}`
    return { ...position, profile: policy.mode, occurrenceKey, key, rate, sourceEnd: windows[position.index].end + offset,
        contentTime: position.contentTime + offset, sourceStart: position.sourceStart + offset }
}

export function captureEventContext(): EventRunContext {
    const captured = contentContext.getStore()?.captured
    if (captured) return { ...captured }
    const view = getEventScheduleView()
    return { occurrenceKey: view.occurrenceKey, contentTime: view.contentTime, profile: view.profile, rate: view.rate }
}

/**
 * How many times faster than the original the playing run goes (FT-32): the speed a captured battle or room started
 * at, else the timeline's (Accelerated: its speed; Classic, Time Travel and Manual: 1; 1 with scheduling off).
 */
export function currentRunSpeed(): number {
    if (!scheduledContentEnabled()) return 1
    const captured = contentContext.getStore()?.captured
    return captured ? captured.rate ?? 1 : getEventScheduleView().rate
}

/** The date used only for master-data availability. Receipt/reset dates retain real advancing time. */
export function contentDate(realDate: Date): Date {
    const captured = contentContext.getStore()?.captured
    if (scheduledContentEnabled() && captured) return new Date(captured.contentTime)
    return scheduledContentEnabled() ? new Date(getEventScheduleView(realDate.getTime()).contentTime) : realDate
}

export function scheduledMasterTime(sourceTime: number, view = getEventScheduleView()): number {
    // Master dates have whole-second precision; the client overlay uses the same quantization.
    return Math.floor((view.targetStart + (sourceTime - view.sourceStart) / view.rate) / 1000) * 1000
}

/** Match the projected client period at its exact second, including the master's final second. */
export function isContentPeriodOpen(start: number | undefined, end: number | undefined, date: Date, inclusiveEnd = true): boolean {
    const enabled = scheduledContentEnabled()
    const captured = enabled ? contentContext.getStore()?.captured : undefined
    if (!enabled || captured) {
        const time = captured?.contentTime ?? date.getTime()
        return (start === undefined || start <= time) && (end === undefined || (inclusiveEnd ? (captured ? time < end + 1000 : time <= end) : time < end))
    }
    const view = getEventScheduleView(date.getTime())
    const time = date.getTime()
    return (start === undefined || time >= scheduledMasterTime(start, view))
        && (end === undefined || time < scheduledMasterTime(end, view) + (inclusiveEnd ? 1000 : 0))
}

/** Availability during a real reset day, even when acceleration or a playlist crosses windows. */
export function isContentPeriodOpenOnRealDay(start: number, end: number | undefined, date: Date): boolean {
    const from = gameDayStart(gameDayOf(date.getTime()))
    const until = from + GAME_DAY_MS
    let cursor = from
    // A complete round covers every possible source window; at most 100 entries plus the
    // initial partial entry are needed, even for a very short repeating manual playlist.
    for (let visited = 0; cursor < until && visited <= 100; visited++) {
        const view = getEventScheduleView(cursor)
        const segmentEnd = Math.min(until, view.targetStart + (view.sourceEnd - view.sourceStart) / view.rate)
        const opens = scheduledMasterTime(start, view)
        const closes = end === undefined ? Infinity : scheduledMasterTime(end, view) + 1000
        if (opens < segmentEnd && closes > cursor) return true
        cursor = Math.max(cursor + 1, segmentEnd)
    }
    return false
}

/** A room pins only event availability and its run identity, never the real reward day. */
export function runOnCapturedEventContext<T>(captured: EventRunContext, fn: () => T): T {
    const current = contentContext.getStore()
    return contentContext.run({ offsetDays: current?.offsetDays ?? 0, now: current?.now ?? Date.now(), captured }, fn)
}

export function requestProgressionTime(): number | undefined {
    return contentContext.getStore()?.now
}

export function currentEventOccurrenceKey(): string {
    return captureEventContext().occurrenceKey
}
