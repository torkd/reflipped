import gamePages from "./gamePages";
import { scheduledContentEnabled } from "../../lib/eventSchedule";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import playerRoutePlugin from "./player"
import userRoutePlugin from "./user"
import anticheatRoutePlugin from "./anticheat"
import { getServerDate } from "../../utils";
import { getAllPlayersSync } from "../../data/wdfpData";
import { escapeHtml, fillTemplate, noticeHtml, readPage, renderPage } from "./layout";
import settingsRoutePlugin from "./settings";
import calendarRoutePlugin from "./calendar";
import newsRoutePlugin from "./news";
import { ClockStatus, getCalendarWindows, getClockStatus } from "../../lib/serverClock";
import { contentWarning } from "../../lib/eventCalendar";
import { CALENDAR_MODE_MESSAGES, clockModeText, contentWarningText, durationText, formatUtcMinutes, warningNoticeHtml } from "./clockText";
import { query, string } from "../schemas";
import { serverVersionText } from "../../lib/serverVersion";


// Fixed notice texts for the dashboard's `?error=` / `?message=` codes (SEC-10).
const errorNotices = new Map([
    ["empty_calendar", "The event calendar has no windows: add one on the Calendar page first."]
])
const messageNotices = new Map(CALENDAR_MODE_MESSAGES)

/** Where the clock is on the calendar, or how it runs otherwise: one sentence under the clock card. */
function clockDetailText(status: ClockStatus): string {
    if (status.mode === "real") return "It follows the machine's date (SERVER_TIME=real); a time set here lasts until the server restarts."
    if (status.window === null) return "It runs on freely: nothing brings it back when the content ends. The Calendar page can keep it inside chosen dates."
    const windows = getCalendarWindows().length
    const switchText = status.frozen ? "" : ` It moves on at ${formatUtcMinutes(status.window.end)} UTC (in ${durationText(status.window.end.getTime() - status.date.getTime())}).`
    return `It runs on the event calendar, in window ${status.window.index + 1} of ${windows} (${status.window.window.label}).${switchText}`
}

/** The warning when the server clock has no portal open now or soon, with the one-click fix when there is one. */
function dashboardWarningHtml(status: ClockStatus): string {
    if (scheduledContentEnabled()) return ""
    const warning = contentWarning()
    if (warning === null) return ""
    const text = contentWarningText(warning, "The server clock", status.frozen)
    if (status.mode !== "calendar" && getCalendarWindows().length > 0) return warningNoticeHtml(text, `
                <form method="post" action="/api/server/calendar/mode" class="shrink-0">
                    <input type="hidden" name="mode" value="on" />
                    <input type="hidden" name="back" value="dashboard" />
                    <button type="submit" class="btn-primary">Run on the event calendar</button>
                </form>`)
    return warningNoticeHtml(text, `<a href="/calendar" class="btn-outline shrink-0">Open the calendar</a>`)
}

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/", { schema: query({ error: string, message: string }) }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { error, message } = request.query as { error?: string, message?: string }
        const status = getClockStatus()
        const currentServerTime = status.date.toISOString().replace(/\.\d\d\dZ/, "")
        const html = renderPage(scheduledContentEnabled() ? "event-dashboard" : "index", "Dashboard", "dashboard", {
            notice: noticeHtml({ errors: errorNotices, messages: messageNotices }, error, message) + dashboardWarningHtml(status),
            currentServerTime,
            currentServerTimeText: formatUtcMinutes(status.date),
            clockMode: escapeHtml(clockModeText(status)),
            clockDetail: escapeHtml(clockDetailText(status)),
            playerCount: String(getAllPlayersSync(0, Number.MAX_SAFE_INTEGER).length),
            serverVersion: escapeHtml(serverVersionText())
        })
        reply.header("content-type", "text/html; charset=utf-8")
        reply.send(html)
    })

    fastify.get("/credits", async (_: FastifyRequest, reply: FastifyReply) => {
        reply.header("content-type", "text/html; charset=utf-8")
        reply.send(renderPage("credits", "Credits", "credits"))
    })

    fastify.register(playerRoutePlugin, { prefix: "/player" })
    fastify.register(userRoutePlugin, { prefix: "/user" })
    fastify.register(anticheatRoutePlugin, { prefix: "/security" })
    // the page's first address (SEC-18 phase 2), kept for bookmarks
    fastify.get("/anticheat", async (request: FastifyRequest, reply: FastifyReply) => {
        const query = request.url.indexOf("?")
        return reply.redirect(`/security${query === -1 ? "" : request.url.slice(query)}`)
    })
    fastify.register(settingsRoutePlugin, { prefix: "/settings" })
    fastify.register(calendarRoutePlugin, { prefix: "/calendar" })
    fastify.register(newsRoutePlugin, { prefix: "/news" })
}

// served by the public game server, not the admin one
export const newsWebPlugin = async (fastify: FastifyInstance) => {
    fastify.register(gamePages, { prefix: "/game" })
}

export default routes;
