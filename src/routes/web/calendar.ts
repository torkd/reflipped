import { eventCalendarPage } from "./eventCalendarPage";
import { scheduledContentEnabled } from "../../lib/eventSchedule";
// The admin Calendar page (FT-5): the event calendar's state, its rotation of windows, and the events in the master
// data to build it from. Changes go to `POST /api/server/calendar/*` (src/routes/web_api/server.ts).

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CalendarWindow, EARLIEST_CLOCK_YEAR, GAME_DAY_MS, LATEST_CLOCK_YEAR, MAX_CALENDAR_WINDOWS, MAX_WINDOW_LABEL_LENGTH, windowBounds } from "../../lib/calendar";
import { contentGapIn, contentRange, contentWarning, ContentEvent, eventsIn, eventWindow, listEvents, portalsIn } from "../../lib/eventCalendar";
import { ClockStatus, getCalendarWindows, getClockStatus } from "../../lib/serverClock";
import { query, string } from "../schemas";
import { CALENDAR_MODE_MESSAGES, clockModeText, contentWarningText, durationText, formatUtcMinutes, warningNoticeHtml } from "./clockText";
import { escapeHtml, noticeHtml, renderPage } from "./layout";
import { goToForm } from "./calendarGoTo";

// Fixed notice texts for `?error=` / `?message=` (SEC-10); the codes come from changeRotation() and the mode route.
const errorNotices = new Map([
    ["invalid_from", `Nothing was changed: the first day is not a valid date from ${EARLIEST_CLOCK_YEAR} to ${LATEST_CLOCK_YEAR}.`],
    ["invalid_to", `Nothing was changed: the last day is not a valid date from ${EARLIEST_CLOCK_YEAR} to ${LATEST_CLOCK_YEAR}.`],
    ["window_reversed", "Nothing was changed: the last day is before the first day."],
    ["invalid_label", "Nothing was changed: the name is too long or has control characters."],
    ["unknown_event", "Nothing was changed: that event isn't in the master data."],
    ["too_many_windows", `Nothing was changed: the calendar holds at most ${MAX_CALENDAR_WINDOWS} windows.`],
    ["no_portal", "Nothing was changed: no summoning portal is open on some of those days, and the game fails with C8601 when it shows the portals. Pick days between the first and the last portal (see the hint below)."],
    ["unknown_window", "Nothing was changed: that window no longer exists."],
    ["window_at_end", "Nothing was changed: that window is already at that end of the rotation."],
    ["empty_calendar", "The calendar has no windows: add one first."],
    ["event_not_in_playlist", "Nothing was changed: that event isn't in the Manual playlist. Add it to the playlist first."],
    ["invalid_day", "Nothing was changed: that day isn't part of the event. Pick a day from 1 (the opening) to the event's last day."]
])
const messageNotices = new Map([
    ["window_added", "Window added at the end of the rotation."],
    ["window_removed", "Window removed."],
    ["window_moved", "Window moved."],
    ["calendar_default", "The rotation is back to the default window."],
    ...CALENDAR_MODE_MESSAGES,
    ["event_jump", "The server clock is at the event's opening and runs on from there; the event calendar is off until you turn it on again. Players see it after returning to the title."],
    ["event_day_jump", "The server clock is at that day of the event and runs on from there; the event calendar is off until you turn it on again. Players see it after returning to the title."]
])
// with event scheduling on (the modern Calendar page)
const scheduleMessageNotices = new Map([
    ["playlist_saved", "Manual playlist saved: a new run starts."],
    ["event_jump", "The event timeline is at the event's opening: a new run starts, with its own missions, scores, leaderboards and rewards. Players see it after returning to the title."],
    ["event_day_jump", "The event timeline is at that day of the event. If the event was already running, its run carries on with the progress made so far; otherwise a new run starts. Players see it after returning to the title."]
])

function dayCount(window: CalendarWindow): number {
    const bounds = windowBounds(window)
    return Math.round((bounds.end - bounds.start) / GAME_DAY_MS)
}

/** Chips naming the first portals of a stretch of time, and how many more there are. */
function portalChips(start: number, end: number): string {
    // several portals share a name ("Spotlight Portal"): each name once
    const names = [...new Set(portalsIn(start, end).map(portal => portal.name))]
    const shown = names.slice(0, 3).map(name => `<span class="chip">${escapeHtml(name)}</span>`).join("")
    return shown + (names.length > 3 ? `<span class="chip">+${names.length - 3} more</span>` : "")
}

/** A chip when some time in [start, end) has no portal open; `id` lets a control point at it. */
function gapChip(start: number, end: number, id = ""): string {
    const gap = contentGapIn(start, end)
    return gap === null ? "" : `<span class="chip-warning"${id ? ` id="${escapeHtml(id)}"` : ""}>no portal from ${escapeHtml(formatUtcMinutes(new Date(gap)))} UTC</span>`
}

/** One of the small forms that change the rotation. */
function windowsForm(action: string, fields: Record<string, string>, button: string, buttonClass = "btn-outline", ariaLabel = ""): string {
    const hidden = Object.entries({ action, ...fields })
        .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`).join("")
    const label = ariaLabel ? ` aria-label="${escapeHtml(ariaLabel)}"` : ""
    return `<form method="post" action="/api/server/calendar/windows">${hidden}<button type="submit" class="${buttonClass}"${label}>${escapeHtml(button)}</button></form>`
}

function windowRow(window: CalendarWindow, index: number, count: number, status: ClockStatus): string {
    const bounds = windowBounds(window)
    const days = dayCount(window)
    const current = status.window?.index === index
    const events = eventsIn(bounds.start, bounds.end)
    const eventChip = events.length === 0 ? "" : `<span class="chip">${events.length} ${events.length === 1 ? "event" : "events"}</span>`
    const name = `${index + 1}. ${window.label}`
    return `
                    <div class="setting-row">
                        <div class="setting-text">
                            <div class="flex items-center gap-2 flex-wrap">
                                <span class="setting-label">${escapeHtml(name)}</span>
                                ${current ? `<span class="badge-on">now</span>` : ""}
                            </div>
                            <p class="card-text">Game days ${escapeHtml(window.from)} to ${escapeHtml(window.to)} (${days} ${days === 1 ? "day" : "days"}): from ${formatUtcMinutes(new Date(bounds.start))} to ${formatUtcMinutes(new Date(bounds.end))} UTC.</p>
                            <div class="setting-meta">${gapChip(bounds.start, bounds.end)}${eventChip}${portalChips(bounds.start, bounds.end)}</div>
                        </div>
                        <div class="flex gap-2 shrink-0">
                            ${index > 0 ? windowsForm("up", { index: String(index) }, "↑", "btn-outline", `Move up: ${name}`) : ""}
                            ${index < count - 1 ? windowsForm("down", { index: String(index) }, "↓", "btn-outline", `Move down: ${name}`) : ""}
                            ${windowsForm("remove", { index: String(index) }, "Remove", "btn-outline", `Remove: ${name}`)}
                        </div>
                    </div>`
}

function rotationHtml(status: ClockStatus): string {
    const windows = getCalendarWindows()
    const rows = windows.length === 0
        ? `
                    <div class="setting-row"><p class="card-text">No windows: the calendar can't run until one is added. Add an event below, a range of days here, or restore the default.</p></div>`
        : windows.map((window, index) => windowRow(window, index, windows.length, status)).join("\n")
    return `${rows}
                    <div class="setting-row">
                        <form method="post" action="/api/server/calendar/windows" class="flex flex-col gap-3 flex-1">
                            <input type="hidden" name="action" value="add" />
                            <span class="setting-label">Add a range of days</span>
                            <div class="flex gap-3 flex-wrap items-end">
                                <label class="flex flex-col gap-1 text-sm text-on-surface-variant" for="window-label">Name (optional)
                                    <input id="window-label" name="label" type="text" maxlength="${MAX_WINDOW_LABEL_LENGTH}" class="input" />
                                </label>
                                <label class="flex flex-col gap-1 text-sm text-on-surface-variant" for="window-from">First game day
                                    <input id="window-from" name="from" type="date" required class="input" />
                                </label>
                                <label class="flex flex-col gap-1 text-sm text-on-surface-variant" for="window-to">Last game day
                                    <input id="window-to" name="to" type="date" required class="input" />
                                </label>
                                <button type="submit" form="restore-default" class="btn-outline">Restore default</button>
                                <button type="submit" class="btn-primary">Add window</button>
                            </div>
                        </form>
                        <form id="restore-default" method="post" action="/api/server/calendar/windows"><input type="hidden" name="action" value="default" /></form>
                    </div>`
}

/** Whether an event's game days can go into the rotation: a portal is open on all of them. */
function canAdd(event: ContentEvent): boolean {
    const bounds = windowBounds(eventWindow(event))
    return contentGapIn(bounds.start, bounds.end) === null
}

function eventRow(event: ContentEvent, index: number): string {
    const window = eventWindow(event)
    const bounds = windowBounds(window)
    const days = dayCount(window)
    const label = `Add to the rotation: ${event.name}, ${window.from}`
    const goToLabel = `Go to: ${event.name}, ${window.from}`
    // a disabled button keeps its name, and points at the chip that says why
    const gapId = `event-gap-${index}`
    return `
                    <div class="setting-row">
                        <div class="setting-text">
                            <span class="setting-label">${escapeHtml(event.name)}</span>
                            <p class="card-text">${escapeHtml(event.kind)} · ${formatUtcMinutes(event.start)} to ${formatUtcMinutes(event.end)} UTC · game days ${escapeHtml(window.from)} to ${escapeHtml(window.to)} (${days} ${days === 1 ? "day" : "days"})</p>
                            <div class="setting-meta">${gapChip(bounds.start, bounds.end, gapId)}${portalChips(bounds.start, bounds.end)}</div>
                        </div>
                        <div class="flex gap-2 shrink-0">
                            ${canAdd(event)
                                ? goToForm(event.id, `${event.name}, ${window.from}`, Math.max(1, Math.ceil((event.end.getTime() + 1000 - event.start.getTime()) / GAME_DAY_MS)))
                                    + windowsForm("event", { event: event.id }, "Add", "btn-outline", label)
                                : `<button type="button" class="btn-outline" disabled aria-label="${escapeHtml(goToLabel)}" aria-describedby="${gapId}">Go to</button><button type="button" class="btn-outline" disabled aria-label="${escapeHtml(label)}" aria-describedby="${gapId}">Add</button>`}
                        </div>
                    </div>`
}

/** The events, newest first: those that can be added, then those with a day without a portal. */
function eventsHtml(): string {
    const events = [...listEvents()].reverse()
    const addable = events.filter(canAdd)
    const blocked = events.filter(event => !canAdd(event))
    const blockedHeader = blocked.length === 0 ? "" : `
                    <div class="setting-row"><p class="card-text">These can't be added: on some of their days no summoning portal is open (${blocked.length} ${blocked.length === 1 ? "event" : "events"}).</p></div>`
    return [...addable.map((event, index) => eventRow(event, index)), blockedHeader, ...blocked.map((event, index) => eventRow(event, addable.length + index))].join("\n")
}

function modeHtml(status: ClockStatus): string {
    const running = status.mode === "calendar"
    const detail = status.window === null
        ? (status.mode === "real" ? "The clock follows the machine's date (SERVER_TIME=real). Turning the calendar on moves it onto the calendar until the server restarts; after a restart it follows the machine's date again." : "The clock runs on freely.")
        : `Window ${status.window.index + 1} (${status.window.window.label}) until ${formatUtcMinutes(status.window.end)} UTC${status.frozen ? "" : `, in ${durationText(status.window.end.getTime() - status.date.getTime())}`}.`
    return `
                <form class="card" method="post" action="/api/server/calendar/mode">
                    <input type="hidden" name="mode" value="${running ? "off" : "on"}" />
                    <div class="card-header">
                        <div class="flex flex-col gap-1">
                            <h2 class="card-title">Event calendar</h2>
                            <p class="card-text">On the calendar the server clock runs in real time inside the current window. At the end of the window's last game day (20:00 UTC, when the game's own day changes and it goes back to the title) it moves on to the next window's first day at the same time of day; after the last window it starts over at the first. Players' own clocks move with it, the same number of days away. Turning it on starts in the window that holds the current date, or at the first window's first day.</p>
                            <p class="card-text">${escapeHtml(detail)}</p>
                        </div>
                        <span class="${running ? "badge-on" : "badge-off"}">${running ? "On" : "Off"}</span>
                    </div>
                    <div class="flex gap-3">
                        <button type="submit" class="${running ? "btn-outline" : "btn-primary"}">${running ? "Turn off" : "Turn on"}</button>
                    </div>
                </form>`
}

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/", { schema: query({ error: string, message: string, q: { type: "string", maxLength: 100 } }) }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { error, message } = request.query as { error?: string, message?: string }
        if (scheduledContentEnabled()) return reply.type("text/html; charset=utf-8")
            .send(eventCalendarPage((request.query as { q?: string }).q ?? "", noticeHtml({ errors: errorNotices, messages: scheduleMessageNotices }, error, message)))
        const status = getClockStatus()
        const warning = contentWarning()
        const html = renderPage("calendar", "Calendar", "calendar", {
            notice: noticeHtml({ errors: errorNotices, messages: messageNotices }, error, message) + (warning === null ? "" : warningNoticeHtml(contentWarningText(warning, "The server clock", status.frozen))),
            clockMode: escapeHtml(clockModeText(status)),
            serverTime: formatUtcMinutes(status.date),
            nextSwitch: status.window === null ? "—" : formatUtcMinutes(status.window.end),
            contentStart: formatUtcMinutes(new Date(contentRange().start)),
            contentEnd: formatUtcMinutes(new Date(contentRange().end)),
            mode: modeHtml(status),
            rotation: rotationHtml(status),
            events: eventsHtml()
        })
        reply.header("content-type", "text/html; charset=utf-8")
        reply.send(html)
    })
}

export default routes;
