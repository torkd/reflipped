// ADM-4: when the automatic event posts go live. The modes with a set schedule (Classic, Accelerated and Manual) play
// the archive's events on the real clock (`src/lib/eventSchedule.ts`: the timeline's anchor, speed and periods), so
// every event has a projected real opening. Its post goes live at the daily reset (the start of a game day, 05:00
// Japan time) seven days before the game day the event opens on: an event opening on 17 December appears at the
// reset that starts 10 December. Time Travel has no schedule, and an event whose opening is past is never announced.

import { scheduledContentEnabled, timelineRate, timelineWindows } from "./eventSchedule";
import { getEventPolicy } from "./eventPolicy";
import { gameDayOf, gameDayStart, GAME_DAY_MS } from "./calendar";

/** Days before the opening's game day that a post goes live. */
export const NEWS_LEAD_DAYS = 7

/** Anything announced ahead: a calendar event, a portal or a boost campaign. Times are the master's, in ms. */
export interface Announceable {
    /** unique among everything announced, e.g. "event:advent_event/12", "portal:185" */
    id: string
    startTime: number
    endTime: number
}

export interface UpcomingEvent<T extends Announceable = Announceable> {
    event: T
    /** projected real opening and closing, ms */
    opens: number
    closes: number
    /** the timeline cycle it falls in (the archive repeats), part of the post's key */
    cycle: number
    /** when its post goes live, ms */
    due: number
}

/** Whether the current event mode has a set schedule (Classic, Accelerated, Manual). */
export function newsModeHasSchedule(): boolean {
    return scheduledContentEnabled() && getEventPolicy().mode !== "time-travel"
}

/** The daily reset a post for an event opening at `opens` (real ms) goes live at. */
export function newsDueTime(opens: number): number {
    return gameDayStart(gameDayOf(opens)) - NEWS_LEAD_DAYS * GAME_DAY_MS
}

/** The key one event run's post is published under: once per event and timeline cycle. */
export function newsAutoKey(event: { id: string }, cycle: number): string {
    return `${event.id}:${cycle}`
}

/**
 * The events whose post is due at `now` (ms) and that haven't opened yet: their projected opening is ahead, and its
 * announcement time has come. Empty in a mode without a set schedule.
 */
export function eventsToAnnounce<T extends Announceable>(now: number, items: readonly T[]): UpcomingEvent<T>[] {
    if (!newsModeHasSchedule()) return []
    const policy = getEventPolicy()
    const windows = timelineWindows(policy)
    const rate = timelineRate(policy)
    const total = windows.reduce((sum, window) => sum + window.end - window.start, 0)
    const currentCycle = Math.floor(Math.max(0, now - policy.anchor) * rate / total)
    const found: UpcomingEvent<T>[] = []
    for (const cycle of [currentCycle, currentCycle + 1]) {
        let prior = 0
        for (const window of windows) {
            for (const event of items) {
                if (event.startTime < window.start || event.startTime >= window.end) continue
                const opens = Math.floor(policy.anchor + (cycle * total + prior + event.startTime - window.start) / rate)
                if (opens <= now) continue
                const due = newsDueTime(opens)
                if (due > now) continue
                found.push({ event, opens, closes: opens + Math.floor((event.endTime - event.startTime) / rate), cycle, due })
            }
            prior += window.end - window.start
        }
    }
    return found.sort((a, b) => a.opens - b.opens || a.event.id.localeCompare(b.event.id, "en"))
}
