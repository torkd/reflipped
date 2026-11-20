import { anchorForContentTime, eventCatalog, eventDayCount, getEventScheduleView, getManualWindows, scheduledContentEnabled, scheduledMasterTime } from "../../lib/eventSchedule";
import { BalanceLanding, balanceLandings } from "../../lib/balanceChanges";
import { GAME_DAY_MS } from "../../lib/calendar";
import { getEventPolicy } from "../../lib/eventPolicy";
import { getRewardPolicy, rewardPercent } from "../../lib/rewardPolicy";
import { getGlobalServerDate } from "../../lib/serverClock";
import { escapeHtml, renderPage } from "./layout";
import { EVENT_MODE_NAMES } from "./eventSettings";
import { gameDayOf } from "../../lib/calendar";
import { goToForm } from "./calendarGoTo";

export function eventCalendarPage(query = "", notice = ""): string {
    const policy = getEventPolicy()
    const now = getGlobalServerDate()
    const view = getEventScheduleView(now.getTime(), 0)
    const date = (time: number) => new Date(time).toISOString().slice(0, 16).replace("T", " ")
    // "Go to": the shared timeline jumps to the event's opening or a later day of it (in Manual mode, only to an event
    // of the playlist)
    const goTo = (event: typeof eventCatalog[number]) => anchorForContentTime(event.startTime, now.getTime(), policy) === null ? ""
        : goToForm(event.id, event.name, eventDayCount(event))
    const row = (event: typeof eventCatalog[number], add = false) => `<div class="setting-row"><div class="setting-text"><span class="setting-label">${escapeHtml(event.name)}</span><p class="card-text">${escapeHtml(event.kind.replace(/_/g, " "))} · ${date(scheduledMasterTime(event.startTime, view))} to ${date(scheduledMasterTime(event.endTime, view))} UTC</p></div>${goTo(event)}${add ? `<form method="post" action="/api/server/calendar/windows"><input type="hidden" name="action" value="event" /><input type="hidden" name="event" value="${escapeHtml(event.id)}" /><button class="btn-outline" type="submit">Add to Manual playlist</button></form>` : ""}</div>`
    const active = eventCatalog.filter(event => event.startTime <= view.contentTime && view.contentTime < event.endTime)
    const next = eventCatalog.filter(event => event.startTime > view.contentTime && event.startTime < view.sourceEnd).slice(0, 5)
    const windows = getManualWindows()
    const manual = policy.mode !== "manual" ? "" : `<section class="settings-group"><div class="settings-group-header"><h2 class="card-title">Manual playlist</h2><p class="card-text">Periods run in this order, then repeat. An event entry starts at its original opening time. Editing the playlist starts a new run. Add events below. The initial playlist covers the January archive period; replace it with events from the catalog.</p></div>${windows.map((window, index) => `<div class="setting-row"><div class="setting-text"><span class="setting-label">${escapeHtml(window.label)}</span><p class="card-text">${escapeHtml(window.from)} to ${escapeHtml(window.to)}</p></div>${index > 0 ? `<form method="post" action="/api/server/calendar/windows"><input type="hidden" name="action" value="up" /><input type="hidden" name="index" value="${index}" /><button class="btn-outline" aria-label="Move up" type="submit">↑</button></form>` : ""}${index < windows.length - 1 ? `<form method="post" action="/api/server/calendar/windows"><input type="hidden" name="action" value="down" /><input type="hidden" name="index" value="${index}" /><button class="btn-outline" aria-label="Move down" type="submit">↓</button></form>` : ""}<form method="post" action="/api/server/calendar/windows"><input type="hidden" name="action" value="remove" /><input type="hidden" name="index" value="${index}" /><button class="btn-outline" type="submit">Remove</button></form></div>`).join("")}</section>`
    // balance (FT-47): what lands on the shared timeline, and when (src/lib/balanceChanges.ts)
    const balanceTime = scheduledContentEnabled() ? view.contentTime : Infinity
    const landings = balanceLandings()
    const landed = landings.filter(l => l.time <= balanceTime).length
    const landingRow = (l: BalanceLanding) => {
        const event = l.event === null ? undefined : eventCatalog.find(e => e.id === l.event)
        // "Go to" day N lands at the event's opening plus N - 1 days: the first one at or after the landing (a landing is at
        // the start of a game day, 05:00 Japan time, before most events open)
        const day = event ? Math.min(eventDayCount(event), Math.max(1, Math.ceil((l.time - event.startTime) / GAME_DAY_MS) + 1)) : 1
        const where = event ? ` · ${escapeHtml(event.name)}, day ${day}` : ""
        const done = l.time <= balanceTime
        return `<div class="setting-row"><div class="setting-text"><span class="setting-label">${escapeHtml(l.label)}</span><p class="card-text">${done ? "Landed" : "Lands"} on the archive's ${gameDayOf(l.time)}${where}</p></div>${event && anchorForContentTime(event.startTime, now.getTime(), policy) !== null ? goToForm(event.id, event.name, eventDayCount(event), day) : ""}</div>`
    }
    const comingBalance = landings.filter(l => l.time > balanceTime).slice(0, 3)
    const balance = `<section class="settings-group"><div class="settings-group-header"><h2 class="card-title">Balance changes</h2><p class="card-text">Second mana boards and unit and armament buffs arrive on the shared timeline when they did in the original game; a player's own Time Travel doesn't change them, and going back hides them again. ${landed} of ${landings.length} have landed${balanceTime === Infinity ? " (event scheduling is off: every change is in)" : ""}.</p></div>${comingBalance.map(landingRow).join("") || '<div class="setting-row"><p class="card-text">Every balance change has landed.</p></div>'}<details><summary class="setting-row card-text">All ${landings.length} balance changes</summary>${landings.map(landingRow).join("")}</details></section>`
    return renderPage("event-calendar", "Calendar", "calendar", {
        balance,
        notice, mode: EVENT_MODE_NAMES[policy.mode], time: date(now.getTime()), rewards: `${rewardPercent(getRewardPolicy().multiplier)}%`,
        summary: `The real clock keeps advancing. Current content period: ${gameDayOf(view.contentTime)}. Daily resets are independent of travel and event speed.`,
        active: active.map(event => row(event)).join("") || '<div class="setting-row"><p class="card-text">No event is active in this period. The base summoning portal remains available.</p></div>',
        next: next.map(event => row(event)).join("") || `<div class="setting-row"><p class="card-text">${policy.mode === "manual" ? "See the Manual playlist for the next period." : "The rotation returns to the beginning after this period."}</p></div>`,
        manual, query: escapeHtml(query), catalogOpen: query ? " open" : "", catalog: eventCatalog.filter(event => `${event.name} ${event.kind}`.toLowerCase().includes(query.toLowerCase())).map(event => row(event, policy.mode === "manual")).join("")
    })
}
