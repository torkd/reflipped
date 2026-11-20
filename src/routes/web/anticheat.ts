// The admin Cheat review page (SEC-18 phase 2): the anti-cheat mode, the flags the rules raised, and what an admin can do
// about them. The actions are POSTs in src/routes/web_api/anticheat.ts. Flag details come from our own code but are
// escaped like any text; nothing from a request is put in the page.
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
    AnticheatFlag, FlagStatusFilter, getRestrictedPlayerIdsSync, isPlayerRestrictedSync, listAnticheatFlagsSync
} from "../../data/anticheatData";
import { getPlayerSync } from "../../data/wdfpData";
import { getSetting, SETTINGS } from "../../data/serverSettings";
import { ANTICHEAT_MODES, AnticheatMode, anticheatMode } from "../../lib/anticheat";
import { RULE_LEGEND } from "../../lib/anticheatReview";
import { isLocalProfile } from "../../lib/serverProfile";
import { query, string } from "../schemas";
import { formatUtcMinutes } from "./clockText";
import { escapeHtml, noticeHtml, PageNotices, renderPage } from "./layout";

const notices: PageNotices = {
    errors: new Map([
        ["flag_closed", "Nothing was changed: that flag is not open any more."],
        ["unknown_player", "Nothing was changed: that player doesn't exist."],
        ["invalid_setting", "Nothing was saved: the timing tolerance is out of range."]
    ]),
    messages: new Map([
        ["mode_off", "Anti-cheat is off. No flags are recorded and restrictions have no effect."],
        ["mode_log", "Anti-cheat is on in log only mode: flags are recorded, players notice nothing."],
        ["mode_enforce", "Anti-cheat is on in enforce mode: an impossible finish keeps its rewards, but its record stays off shared boards."],
        ["mode_default", "Anti-cheat follows the server's setting again (ANTICHEAT, else log only)."],
        ["settings_saved", "Timing tolerance saved."],
        ["dismissed", "Flag dismissed."],
        ["restricted", "Player restricted: their open flags are closed, their records stay off shared boards and their co-op rooms off the public list. They notice nothing."],
        ["unrestricted", "Restriction lifted. Their new records count again."],
        ["blocked", "Player blocked: restricted, signed out everywhere, and their device can't sign in to this save again."]
    ])
}
/** The notices of the player page's cheat section (the player route renders it, with its own list). */
export const playerPageAnticheatNotices = notices

const SLACK_KEY = "anticheat.wall_clock_slack_seconds"

const MODE_TEXT: Record<AnticheatMode, { title: string, text: string }> = {
    off: { title: "Off", text: "Nothing is checked or recorded, and restrictions have no effect. Use it to switch the whole feature off." },
    log: { title: "Log only", text: "The rules record flags for you to review. Nothing changes for players. This is where a new server starts." },
    enforce: { title: "Enforce", text: "As log only, and a finish that no honest game could send keeps its rewards but its record stays off shared boards (rankings, rush, raids). Restricted players stay off them too." }
}

const FILTERS: { id: FlagStatusFilter, label: string }[] = [
    { id: "open", label: "Open" },
    { id: "dismissed", label: "Dismissed" },
    { id: "all", label: "All" }
]

function ruleTitle(rule: string): string {
    return RULE_LEGEND.find(entry => entry.rule === rule)?.title ?? rule
}

/** The details as short `name value` chips, every part escaped; `excluded` is shown as a badge instead. */
function detailChips(details: Record<string, unknown>): string {
    return Object.entries(details).filter(([key]) => key !== "excluded").slice(0, 24).map(([key, value]) => {
        const text = typeof value === "string" ? value : JSON.stringify(value)
        return `<span class="chip">${escapeHtml(key)}: ${escapeHtml((text ?? "").slice(0, 200))}</span>`
    }).join("")
}

function actionForm(action: string, fields: Record<string, string>, label: string, buttonClass: string, confirm = ""): string {
    const hidden = Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`).join("")
    return `<form method="post" action="/api/anticheat/${action}"${confirm ? ` data-confirm="${escapeHtml(confirm)}"` : ""}>${hidden}<button type="submit" class="${buttonClass}">${escapeHtml(label)}</button></form>`
}

/** The buttons for one player: restrict or lift it, and block. `context` says which page to return to. */
export function playerActionsHtml(playerId: number, context: Record<string, string>): string {
    const fields = { playerId: String(playerId), ...context }
    return `${isPlayerRestrictedSync(playerId)
        ? actionForm("unrestrict", fields, "Lift restriction", "btn-outline")
        : actionForm("restrict", fields, "Restrict", "btn-outline", "Restrict this player? They keep playing, but their records stay off shared boards and their co-op rooms off the public list.")}${
        actionForm("block", fields, "Block", "btn-danger", "Block this player? They are signed out everywhere and their device can't sign in to this save again.")}`
}

/** One flag as a row. `showPlayer` adds the player's name and link (the review page, not the player's own page). */
export function flagRowHtml(flag: AnticheatFlag, showPlayer: boolean, context: Record<string, string>): string {
    const player = showPlayer ? getPlayerSync(flag.playerId) : null
    const who = showPlayer ? ` · <a class="text-primary" href="/player/${flag.playerId}">${escapeHtml(player?.name || `Player ${flag.playerId}`)}</a> (#${flag.playerId})` : ""
    const parts = [
        `${escapeHtml(formatUtcMinutes(flag.created))} UTC`,
        flag.questId !== null ? `quest ${flag.questId}` : "",
        flag.route ? escapeHtml(flag.route) : "",
        flag.reqId ? `request <code>${escapeHtml(flag.reqId)}</code>` : ""
    ].filter(Boolean)
    const excluded = flag.details.excluded === true ? `<span class="badge-on">kept off boards</span>` : ""
    const status = flag.status === "open" ? "" : `<span class="badge-off">${flag.status === "dismissed" ? "dismissed" : "acted on"}</span>`
    const severity = flag.severity === "hard" ? `<span class="chip-warning">hard</span>` : `<span class="chip">${flag.severity === "soft" ? "soft" : "info"}</span>`
    const chips = detailChips(flag.details)
    return `
                <div class="setting-row">
                    <div class="setting-text">
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="setting-label">${escapeHtml(ruleTitle(flag.rule))}</span>${severity}${excluded}${status}
                        </div>
                        <p class="card-text">${parts.join(" · ")}${who}</p>
                        ${chips ? `<div class="setting-meta">${chips}</div>` : ""}
                    </div>
                    <div class="flex gap-2 shrink-0 flex-wrap">
                        ${flag.status === "open" ? actionForm("dismiss", { flagId: String(flag.id), ...context }, "Dismiss", "btn-outline") : ""}
                        ${showPlayer ? playerActionsHtml(flag.playerId, context) : ""}
                    </div>
                </div>`
}

function modeCardHtml(): string {
    if (isLocalProfile()) return `
            <section class="card">
                <div class="card-header"><h2 class="card-title">Mode</h2><span class="badge-off">off</span></div>
                <p class="card-text">Anti-cheat is always off on the server on the phone: its owner runs the server and the database, so nothing there can be judged. Players and the admin are the same person.</p>
            </section>`
    const current = anticheatMode()
    const tiles = ANTICHEAT_MODES.map(mode => `
                <label class="choice-tile">
                    <input type="radio" name="mode" value="${mode}"${mode === current ? " checked" : ""} required />
                    <div class="card-header items-center"><h3 class="card-title">${escapeHtml(MODE_TEXT[mode].title)}</h3>${mode === current ? `<span class="badge-on">current</span>` : ""}</div>
                    <p class="card-text">${escapeHtml(MODE_TEXT[mode].text)}</p>
                </label>`).join("")
    return `
            <form method="post" action="/api/anticheat/mode" class="flex flex-col gap-3">
                <div class="flex flex-col gap-1">
                    <h2 class="card-title">Mode</h2>
                    <p class="card-text">The server judges what it receives: the game on a phone can be modified, so nothing the app says about itself is trusted. Players are never told about a flag or a restriction.</p>
                </div>
                <div class="grid-cards">${tiles}
                </div>
                <div class="action-bar"><button type="submit" class="btn-primary">Save mode</button></div>
            </form>`
}

/** The page's tabs (settings-tabs.js shows one panel at a time; without it both show). */
const TABS = `            <nav class="tabs" role="tablist" aria-label="Security">
                <a class="tab tab-active" role="tab" href="#anticheat" data-tab="anticheat" aria-selected="true">Anti-cheat</a>
                <a class="tab" role="tab" href="#review" data-tab="review" aria-selected="false">Cheat review</a>
            </nav>`

/** The wall-clock slack (anticheat.wall_clock_slack_seconds), the one anti-cheat number the owner may tune. */
function slackCardHtml(): string {
    if (isLocalProfile()) return ""
    const setting = SETTINGS.find(entry => entry.key === SLACK_KEY)!
    const id = "setting-anticheat-slack"
    return `
            <form method="post" action="/api/anticheat/settings" class="flex flex-col gap-3" id="anticheat-settings">
              <div class="settings-group">
                <div class="settings-group-header">
                    <h3 class="card-title">Timing tolerance</h3>
                    <p class="card-text">The checks on clear times compare them with the real time between a battle's start and its finish. This adds room for slow connections.</p>
                </div>
                <div class="setting-row">
                    <div class="setting-text">
                        <label for="${id}" class="setting-label">${escapeHtml(setting.label)}</label>
                        <p class="card-text">${escapeHtml(setting.description)}</p>
                        <div class="setting-meta">
                            <span class="chip">${setting.min}–${setting.max} ${setting.unit}</span>
                            <span class="chip">default ${setting.defaultValue()} ${setting.unit}</span>
                        </div>
                    </div>
                    <div class="unit-input">
                        <button type="button" class="stepper-btn" data-step="-1" aria-label="${escapeHtml(`Decrease: ${setting.label}`)}">−</button>
                        <label class="unit-value" for="${id}">
                            <input id="${id}" name="${SLACK_KEY}" type="number" min="${setting.min}" max="${setting.max}" step="1" value="${getSetting(SLACK_KEY)}" inputmode="numeric" required />
                            <span class="unit">${setting.unit}</span>
                        </label>
                        <button type="button" class="stepper-btn" data-step="1" aria-label="${escapeHtml(`Increase: ${setting.label}`)}">+</button>
                    </div>
                </div>
              </div>
                <div class="action-bar"><button type="submit" class="btn-primary">Save</button></div>
            </form>`
}

function filterLinks(status: FlagStatusFilter, playerId: number | null): string {
    const player = playerId === null ? "" : `&player=${playerId}`
    return FILTERS.map(filter => `<a href="/security?status=${filter.id}${player}#review" class="${filter.id === status ? "btn-primary" : "btn-outline"}"${filter.id === status ? ' aria-current="true"' : ""}>${filter.label}</a>`).join("")
}

function restrictedCardHtml(): string {
    const ids = getRestrictedPlayerIdsSync()
    if (ids.length === 0) return ""
    const rows = ids.map(playerId => `
                <div class="setting-row">
                    <div class="setting-text"><a class="setting-label text-primary" href="/player/${playerId}">${escapeHtml(getPlayerSync(playerId)?.name || `Player ${playerId}`)}</a> <span class="card-text">#${playerId}</span></div>
                    <div class="flex gap-2 shrink-0">${actionForm("unrestrict", { playerId: String(playerId) }, "Lift restriction", "btn-outline")}</div>
                </div>`).join("")
    return `
            <section class="card gap-1">
                <div class="flex flex-col gap-1">
                    <h2 class="card-title">Restricted players</h2>
                    <p class="card-text">They keep playing. Their records stay off rankings, rush and raid boards, their co-op rooms stay off the public list and invitations (friends still see them), and they can't join a stranger's room.${anticheatMode() === "off" ? " Anti-cheat is off, so this has no effect now." : ""}</p>
                </div>${rows}
            </section>`
}

function legendHtml(): string {
    return RULE_LEGEND.map(entry => `
                <div class="setting-row">
                    <div class="setting-text"><span class="setting-label">${escapeHtml(entry.title)}</span><p class="card-text">${escapeHtml(entry.text)}</p></div>
                </div>`).join("")
}

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/", { schema: query({ error: string, message: string, status: string, player: string }) }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { error, message, status: statusText, player: playerText } = request.query as { error?: string, message?: string, status?: string, player?: string }
        const status: FlagStatusFilter = FILTERS.some(filter => filter.id === statusText) ? statusText as FlagStatusFilter : "open"
        const playerId = /^[0-9]{1,15}$/.test(playerText ?? "") ? Number(playerText) : null
        const flags = listAnticheatFlagsSync({ status, playerId: playerId ?? undefined })
        const context: Record<string, string> = { back: "review", status, ...(playerId === null ? {} : { player: String(playerId) }) }

        const list = flags.length === 0
            ? `<div class="flex flex-col items-center gap-2 py-10 text-center"><p class="card-title">No flags</p><p class="card-text">${status === "open" ? "Nothing waits for review." : "No flags match."}</p></div>`
            : flags.map(flag => flagRowHtml(flag, true, context)).join("\n")

        const html = renderPage("anticheat", "Security", "security", {
            notice: noticeHtml(notices, error, message),
            tabs: TABS,
            modeCard: modeCardHtml(),
            slackCard: slackCardHtml(),
            filters: filterLinks(status, playerId),
            playerFilter: playerId === null ? "" : escapeHtml(String(playerId)),
            playerFilterLabel: playerId === null ? "" : `<a href="/security?status=${status}#review" class="chip">Player #${playerId} ✕</a>`,
            flagCount: `${flags.length} ${flags.length === 1 ? "flag" : "flags"}${flags.length >= 200 ? " (the newest 200)" : ""}`,
            statusFilter: status,
            list,
            restrictedCard: restrictedCardHtml(),
            legend: legendHtml()
        })
        reply.header("content-type", "text/html; charset=utf-8")
        reply.send(html)
    })
}

export default routes;
