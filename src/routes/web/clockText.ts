// Texts the admin pages show about clocks (FT-5): the dashboard, the Calendar page and the player page.
import { ClockStatus } from "../../lib/serverClock";
import { ContentWarning } from "../../lib/eventCalendar";
import { escapeHtml } from "./layout";

/** The notices of `POST /api/server/calendar/mode`, which returns to the Calendar page or the dashboard. */
export const CALENDAR_MODE_MESSAGES: readonly [string, string][] = [
    ["calendar_on", "The clock now runs on the event calendar."],
    ["calendar_off", "The event calendar is off: the clock runs on freely from here."]
]

/** "2025-01-03 12:00", in UTC. */
export function formatUtcMinutes(date: Date): string {
    return date.toISOString().replace("T", " ").slice(0, 16)
}

/** "3 days 4 h", "5 h", "under an hour". */
export function durationText(ms: number): string {
    const hours = Math.floor(ms / 3600000)
    const days = Math.floor(hours / 24)
    if (days > 0) return `${days} ${days === 1 ? "day" : "days"}${hours % 24 > 0 ? ` ${hours % 24} h` : ""}`
    return hours > 0 ? `${hours} h` : "under an hour"
}

/** How the server clock runs, in a few words. */
export function clockModeText(status: ClockStatus): string {
    const frozen = status.frozen ? " (frozen)" : ""
    if (status.mode === "real") return "Real date"
    if (status.mode === "free") return `Runs freely${frozen}`
    return `Event calendar${frozen}`
}

/**
 * The warning that a clock has, or soon has, no summoning portal: the client then fails with C8601 when it shows
 * the portals, and new players can't finish the tutorial. `whose` names the clock ("The server clock"); a `frozen`
 * clock (`SERVER_CLOCK=frozen`) doesn't get anywhere by itself.
 */
export function contentWarningText(warning: ContentWarning, whose: string, frozen = false): string {
    const date = `${formatUtcMinutes(warning.clockDate)} UTC`
    if (warning.kind === "outside") return `${whose} is on a date with no summoning portal open (${date}): the game fails with C8601 when it shows the portals, and new players can't finish the tutorial.`
    if (frozen) return `${whose} is frozen ${durationText(warning.inMs)} before a date with no summoning portal open (${date}): once it runs again and gets there, the game fails with C8601 when it shows the portals, and new players can't finish the tutorial.`
    return `${whose} reaches a date with no summoning portal open in ${durationText(warning.inMs)} (${date}): the game then fails with C8601 when it shows the portals, and new players can't finish the tutorial.`
}

/** A warning notice with an optional action after the text (a form or a link, already HTML). */
export function warningNoticeHtml(text: string, action = ""): string {
    return `<div class="notice-error flex flex-col gap-3 md:flex-row md:items-center md:justify-between"><span>${escapeHtml(text)}</span>${action}</div>`
}
