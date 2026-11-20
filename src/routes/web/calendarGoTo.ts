import { escapeHtml } from "./layout";

/**
 * The Calendar pages' "Go to" form for one event: a day of the event (1 = its opening, the default; each further day
 * is 24 hours later) and the button. Posts to `/api/server/calendar/jump`.
 */
export function goToForm(eventId: string, eventName: string, days: number, selectedDay = 1): string {
    const name = escapeHtml(eventName)
    const day = days > 1
        ? `<div class="unit-input"><button type="button" class="stepper-btn" data-step="-1" aria-label="Decrease day of ${name}">−</button><label class="unit-value"><input name="day" type="number" min="1" max="${days}" step="1" value="${Math.min(Math.max(1, Math.floor(selectedDay)), days)}" inputmode="numeric" required aria-label="Day of ${name} to go to, 1 to ${days}" /><span class="unit">day</span></label><button type="button" class="stepper-btn" data-step="1" aria-label="Increase day of ${name}">+</button></div>`
        : ""
    return `<form method="post" action="/api/server/calendar/jump" class="flex gap-2 items-center"><input type="hidden" name="event" value="${escapeHtml(eventId)}" />${day}<button class="btn-outline" type="submit" aria-label="Go to: ${name}">Go to</button></form>`
}
