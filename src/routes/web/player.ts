import { rewardManagementUi } from "./rewardManagementUi";
import { getEventPolicy } from "../../lib/eventPolicy";
import { scheduledContentEnabled } from "../../lib/eventSchedule";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAccountFromPlayerIdSync, getAllPlayersSync, getPlayerAccountIdsSync, getPlayerCharactersSync, getPlayerFromAccountIdSync, getPlayerSync } from "../../data/wdfpData";
import { DELETED_SAVE_DAYS, listKeptSavesSync } from "../../lib/saveDeletion";
import { Player } from "../../data/types";
import { isUnlocked } from "../../lib/developerMode";
import { escapeHtml, fillTemplate, noticeHtml, readPage, renderPage } from "./layout";
import { gameDayOf } from "../../lib/calendar";
import { contentRange, contentWarning } from "../../lib/eventCalendar";
import { getPlayerClockSync, MAX_CLOCK_OFFSET_DAYS, PlayerClock } from "../../lib/playerClock";
import { contentWarningText, formatUtcMinutes, warningNoticeHtml } from "./clockText";
import { mailLimits } from "../../lib/limits";
import { getAccountUserIdSync, getUserSync } from "../../data/users";
import { getClockStatus } from "../../lib/serverClock";
import { countOpenAnticheatFlagsSync, getPlayerAnticheatFlagsSync, getRestrictedPlayerIdsSync, isPlayerRestrictedSync } from "../../data/anticheatData";
import { anticheatMode } from "../../lib/anticheat";
import { flagRowHtml, playerActionsHtml, playerPageAnticheatNotices } from "./anticheat";
import { AccountApp, getAllPlayerAppsSync, getPlayerAppSync } from "../../data/appVersions";

interface GetPlayerParams {
    playerId: string | undefined
}

interface GetPlayerQuery {
    error: string | undefined
    message: string | undefined
}

const numberFormat = new Intl.NumberFormat("en-US")

// The `?error=` and `?message=` codes the admin API redirects to this page with (see `noticeHtml`).
const errorNotices = new Map<string, string>([
    ["save-missing", "Choose a save file to upload."],
    ["save-too-large", "That file is too large to be a save. Nothing was changed."],
    ["save-invalid", "That file is not a valid save. Nothing was changed; the server log names the field that is wrong."],
    ["save-failed", "The save could not be imported. Nothing was changed; see the server log."],
    ["dev-failed", "Developer mode could not be switched; see the server log."],
    ["clock-cooldown", "Nothing was changed: this account moved its content view less than a minute ago. Try again in a moment."],
    ["clock-invalid", "Nothing was changed: pick a valid day."],
    ["clock-out-of-range", `Nothing was changed: a player's clock can be at most ${MAX_CLOCK_OFFSET_DAYS} days from the server clock.`],
    ["clock-no-portal", `Nothing was changed: no summoning portal is open on that day at this time, and the game fails with C8601 when it shows the portals. Portals are open from ${formatUtcMinutes(new Date(contentRange().start))} to ${formatUtcMinutes(new Date(contentRange().end))} UTC.`]
])
const messageNotices = new Map<string, string>([
    ["save-imported", "Save imported. Restart the game to see it."],
    ["dev-on", "Developer mode on: every character, armament and item is unlocked and every quest but the Haunt cleared. Restart the game to see it."],
    ["dev-off", "Developer mode off: this player's own progress is back. Restart the game to see it."],
    ["dev-already-off", "Developer mode was already off."],
    ["reset", "Progress reset: this is a fresh player on the same account. Restart the game to start over."],
    ["clock-set", "Clock set. The game goes back to the title on its next request (\"The date changed\") and loads the new day."],
    ["clock-reset", "This player follows the server clock again. The game goes back to the title on its next request if that changes the day."]
])

/** "330 days behind", "1 day ahead". */
function offsetText(offsetDays: number): string {
    const days = Math.abs(offsetDays)
    return `${days} ${days === 1 ? "day" : "days"} ${offsetDays < 0 ? "behind" : "ahead"}`
}

/** The player page's clock card values (FT-5, src/lib/playerClock.ts). */
function clockValues(clock: PlayerClock): Record<string, string> {
    const now = `${formatUtcMinutes(clock.date)} UTC`
    const warning = contentWarning(clock.offsetDays)
    return {
        clockTravelDisabled: scheduledContentEnabled() && !getEventPolicy().adminTimeTravel ? "disabled" : "",
        clockTravelHelp: scheduledContentEnabled() ? "Chooses a historical content period. Progression time and daily rewards keep advancing normally. Enable admin time travel in Settings to change this selection." : "Moves this player alone to another game day, at the server clock’s time of day. Their clock runs with the server clock.",
        clockState: clock.offsetDays === 0 ? (scheduledContentEnabled() ? "Server schedule" : "Server clock") : escapeHtml(offsetText(clock.offsetDays)),
        clockBadge: clock.offsetDays === 0 ? "badge-off" : "badge-on",
        clockNow: escapeHtml(clock.offsetDays === 0 ? `Now ${now}, the server clock.` : `Now ${now}, ${offsetText(clock.offsetDays)}${clock.offsetDays < 0 ? "" : " of"} the server clock.`),
        clockDay: gameDayOf(clock.date.getTime()),
        clockWarning: warning === null ? "" : warningNoticeHtml(contentWarningText(warning, clock.offsetDays === 0 ? "The server clock" : "This player's clock", getClockStatus().frozen))
    }
}

function formatDate(date: Date): string {
    return isNaN(date.getTime()) ? "never" : `${formatUtcMinutes(date)} UTC`
}

/** SH-15: the app the player's account last signed in with, as plain text (escape it for HTML). */
function appText(app: AccountApp | null): string {
    if (app === null) return "App not seen since app versions were recorded"
    if (app.version === null) return "Older app or original client"
    return `App ${app.version}${app.build ? ` · build ${app.build}` : ""}`
}

/**
 * The send mail card (`web/pages/send-mail.html`, run by `mail-picker.js`), for one player or, with "all", for every
 * player. The texts are our own; nothing from a request goes in.
 */
function sendMailFormHtml(target: number | "all"): string {
    const values = target === "all" ? {
        mailTarget: "all",
        // read by mail-picker.js, not confirm.js: the script sends the form itself
        mailConfirm: ` data-confirm-send="Send this mail to every player on the server?"`,
        mailTitle: "Send mail to all players",
        mailHelp: `Put the same gift in every player's gift box. A player whose box is full (${mailLimits.pendingMails} mails waiting), whom the gift would take past what the game lets them own, or on whose clock its expiry date has passed, is skipped; the result says how many. Players who join later don't get it.`,
        mailButton: "Send to all players"
    } : {
        mailTarget: String(target),
        mailConfirm: "",
        mailTitle: "Send mail",
        mailHelp: "Put a gift in this player's gift box. They see it after the next load.",
        mailButton: "Send mail"
    }
    return fillTemplate(readPage("send-mail"), { ...values, ...rewardManagementUi() })
}

/**
 * ADM-3: whether a player matches the Players list's search: a part of the name, ignoring case, or, for a number, the
 * player number or the PID (the account number the game's Account Info shows).
 */
export function playerMatches(player: Player, pid: number | undefined, search: string): boolean {
    if (/^[0-9]{1,15}$/.test(search) && (player.id === Number(search) || pid === Number(search))) return true
    return player.name.toLowerCase().includes(search.toLowerCase())
}

/**
 * The Players list's count line, for the whole list or a search. It doesn't repeat the search, so a link can't put its
 * own words in the page's text (the search box shows it).
 */
function playerCountText(shown: number, total: number, searching: boolean): string {
    if (!searching) return total === 1 ? "1 player on this server." : `${total} players on this server.`
    return `${shown} of ${total} ${total === 1 ? "player" : "players"} ${shown === 1 ? "matches" : "match"} the search.`
}

/** The Players list's cheat review marks: open flags and "restricted" (SEC-18). Nothing for a player with neither. */
function anticheatBadges(openFlags: number, restricted: boolean): string {
    return `${openFlags > 0 ? `<span class="chip-warning">${openFlags} ${openFlags === 1 ? "flag" : "flags"}</span>` : ""}${restricted ? `<span class="chip-warning">restricted</span>` : ""}`
}

/** The player page's cheat review card: the restriction state, its buttons and this player's flags (SEC-18). */
function anticheatSectionHtml(playerId: number): string {
    const flags = getPlayerAnticheatFlagsSync(playerId, 50)
    const restricted = isPlayerRestrictedSync(playerId)
    const open = flags.filter(flag => flag.status === "open" && flag.severity !== "info").length
    const context = { back: "player" }
    const rows = flags.length === 0 ? `<p class="card-text">No flags for this player.</p>` : flags.map(flag => flagRowHtml(flag, false, context)).join("\n")
    return `            <section class="card gap-1">
                <div class="card-header">
                    <h2 class="card-title">Cheat review</h2>
                    <span class="${restricted ? "chip-warning" : "badge-off"}">${restricted ? "restricted" : "not restricted"}</span>
                </div>
                <p class="card-text">${open} open ${open === 1 ? "flag" : "flags"}. ${restricted ? "Restricted: this player keeps playing, but their records stay off shared boards and their co-op rooms off the public list. They aren't told." : "A restricted player keeps playing, but their records stay off shared boards and their co-op rooms off the public list. They aren't told."}${anticheatMode() === "off" ? " Anti-cheat is off, so a restriction has no effect now." : ""} <a class="text-primary" href="/anticheat?status=all&player=${playerId}">Open in the review page</a></p>
                <div class="flex gap-3 flex-wrap">${playerActionsHtml(playerId, context)}</div>
${rows}
            </section>`
}

/** The Players page's notices (FT-59: restoring a deleted save). */
const playersNotices = {
    errors: new Map([
        ["restore-missing", "That deleted save isn't kept any more (restored already, or past its 30 days)."],
        ["restore-no-account", "That save's account no longer exists, so it can't be restored."],
        ["restore-failed", "The save couldn't be restored. Nothing was changed; the log has the details."]
    ]),
    messages: new Map([["restored", "Save restored. If the player is in the game, it goes back to the title and loads it."]])
}

/**
 * FT-59: the saves players deleted (from the game or the portal), kept DELETED_SAVE_DAYS days for an admin to restore
 * (src/lib/saveDeletion.ts). Restoring replaces a save the account started since; the row says so.
 */
function deletedSavesHtml(): string {
    const saves = listKeptSavesSync()
    if (saves.length === 0) return ""
    const rows = saves.map(save => {
        const current = getPlayerFromAccountIdSync(save.accountId)
        const replaces = current === null ? "The account has no save now."
            : `Replaces the save the account started since: ${escapeHtml(current.name || "Unnamed")} (#${current.id}).`
        return `                <div class="list-row">
                    <div class="avatar">${escapeHtml((save.name || "?").slice(0, 1).toUpperCase())}</div>
                    <div class="flex flex-col flex-1 min-w-0">
                        <span class="font-semibold text-on-background truncate">${escapeHtml(save.name || "Unnamed")} · rank ${save.rank}</span>
                        <span class="text-sm text-on-surface-variant">PID ${save.accountId} · player #${save.playerId} · deleted ${formatDate(save.deletedAt)} from the ${save.source === "portal" ? "portal" : "game"} · kept until ${formatDate(save.expiresAt)}</span>
                        <span class="text-sm text-on-surface-variant">${replaces}</span>
                    </div>
                    <form method="post" action="/api/player/restoreDeleted?id=${save.id}">
                        <button class="btn-outline" type="submit">Restore</button>
                    </form>
                </div>`
    }).join("\n")
    return `            <section class="card p-2 md:p-3 gap-1">
                <div class="px-3 pt-2 flex flex-col gap-1">
                    <h2 class="card-title">Deleted saves</h2>
                    <p class="card-text">Saves players deleted themselves, from the game or the portal. Each is kept for ${DELETED_SAVE_DAYS} days, then removed for good. Restore puts it back on its account; the player's game loads it at its next request.</p>
                </div>
${rows}
            </section>`
}

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
        const { q } = request.query as { q?: unknown }
        const search = typeof q === "string" ? q.trim().slice(0, 100) : ""
        const allPlayers = getAllPlayersSync(0, Number.MAX_SAFE_INTEGER)
        const pids = getPlayerAccountIdsSync()
        const players = search === "" ? allPlayers : allPlayers.filter(player => playerMatches(player, pids.get(player.id), search))
        const apps = getAllPlayerAppsSync()
        const openFlags = countOpenAnticheatFlagsSync()
        const restricted = new Set(getRestrictedPlayerIdsSync())

        const listContent = allPlayers.length === 0
            ? `                <div class="flex flex-col items-center gap-2 py-10 text-center">
                    <p class="card-title">No players yet</p>
                    <p class="card-text">Open the Reflipped app on a phone connected to this server and sign in as a guest.</p>
                </div>`
            : players.length === 0
            ? `                <div class="flex flex-col items-center gap-2 py-10 text-center">
                    <p class="card-title">No player matches</p>
                    <p class="card-text">Search by name, player number or PID.</p>
                </div>`
            : players.map(player => `                <a href="/player/${player.id}" class="list-row">
                    <div class="avatar">${escapeHtml((player.name || "?").slice(0, 1).toUpperCase())}</div>
                    <div class="flex flex-col flex-1 min-w-0">
                        <span class="font-semibold text-on-background truncate">${escapeHtml(player.name || "Unnamed")}</span>
                        <span class="text-sm text-on-surface-variant">PID ${pids.get(player.id) ?? "unknown"} · last login ${formatDate(player.lastLoginTime)}</span>
                        <span class="text-sm text-on-surface-variant truncate">${escapeHtml(appText(apps.get(player.id) ?? null))}</span>
                    </div>
                    ${anticheatBadges(openFlags.get(player.id) ?? 0, restricted.has(player.id))}
                    <span class="badge-off">#${player.id}</span>
                </a>`).join("\n")

        const { error, message } = request.query as { error?: unknown, message?: unknown }
        const html = renderPage("players", "Players", "players", {
            notice: noticeHtml(playersNotices, error, message),
            deletedSaves: deletedSavesHtml(),
            playerCountText: playerCountText(players.length, allPlayers.length, search !== ""),
            query: escapeHtml(search),
            listContent,
            sendMailForm: allPlayers.length === 0 ? "" : sendMailFormHtml("all")
        })
        reply.header("content-type", "text/html; charset=utf-8")
        reply.send(html)
    })

    fastify.get("/:playerId", async (request: FastifyRequest, reply: FastifyReply) => {
        const { playerId } = request.params as GetPlayerParams
        const { error, message } = request.query as GetPlayerQuery
        const parsedPlayerId = Number(playerId)
        if (isNaN(parsedPlayerId)) return reply.redirect("/player");

        const player = getPlayerSync(parsedPlayerId)
        if (player === null) return reply.redirect("/player");

        const clock = getPlayerClockSync(parsedPlayerId)
        if (clock === null) return reply.redirect("/player");
        const unlocked = isUnlocked(parsedPlayerId)
        const accountId = getAccountFromPlayerIdSync(parsedPlayerId)?.id
        const owner = accountId === undefined ? null : getUserSync(getAccountUserIdSync(accountId) ?? -1)
        const notice = noticeHtml({
            errors: new Map([...errorNotices, ...playerPageAnticheatNotices.errors]),
            messages: new Map([...messageNotices, ...playerPageAnticheatNotices.messages])
        }, error, message)

        const html = renderPage("player", player.name || `Player ${parsedPlayerId}`, "players", {
            notice,
            playerId: String(parsedPlayerId),
            pid: accountId === undefined ? "unknown" : String(accountId),
            sendMailForm: sendMailFormHtml(parsedPlayerId),
            anticheatSection: anticheatSectionHtml(parsedPlayerId),
            playerName: escapeHtml(player.name || "Unnamed"),
            playerInitial: escapeHtml((player.name || "?").slice(0, 1).toUpperCase()),
            lastLogin: formatDate(player.lastLoginTime),
            appText: escapeHtml(appText(getPlayerAppSync(parsedPlayerId))),
            ownerText: owner === null ? "A guest save, not tied to a user." : `Belongs to user <a class="text-primary" href="/user/${owner.id}">${escapeHtml(owner.username)}</a>.`,
            characterCount: numberFormat.format(Object.keys(getPlayerCharactersSync(parsedPlayerId)).length),
            beads: numberFormat.format(player.freeVmoney + player.vmoney),
            mana: numberFormat.format(player.freeMana + player.paidMana),
            stamina: numberFormat.format(player.stamina),
            ...clockValues(clock),
            ...rewardManagementUi(),
            developerModeState: unlocked ? "On" : "Off",
            developerModeBadge: unlocked ? "badge-on" : "badge-off",
            developerModeNext: unlocked ? "off" : "on",
            developerModeButton: unlocked ? "Turn off" : "Turn on",
            developerModeHelp: unlocked
                ? "Everything is unlocked. Turning it off restores this player's own progress from before; anything earned since is dropped. Mail sent from this site meanwhile that still waits in the gift box is kept."
                : "Turning it on saves this player's progress, then gives every character (max level, evolved, all mana nodes), all equipment, every item and currency at about a third of its limit (so rewards and shops still fit), rank 100, and clears every quest, boss battle and event except the Haunt. Turning it off restores the saved progress, plus the mail sent from this site meanwhile that still waits."
        })
        reply.header("content-type", "text/html; charset=utf-8")
        reply.send(html)
    })
}

export default routes;
