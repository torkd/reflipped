import { nextPlayerImportAt, playerSaveImportEnabled } from "../../lib/playerSaveImport";
// The account page's cards about the user's player (ACC-8, docs/accounts.md "Player features"): the profile with the
// save download, the player's own clock when the user may move it, and the server's mods. Plain HTML fragments for
// web/pages/portal/account.html; every value from the save is escaped.
import type { User } from "../../data/users";
import { getUserAccountIdsSync } from "../../data/users";
import { getAccountFromPlayerIdSync, getPlayerFromAccountIdSync } from "../../data/wdfpData";
import type { Player } from "../../data/types";
import { getAssetLayers } from "../../lib/assetLayers";
import { playerRankSync } from "../../lib/assets";
import { gameDayOf } from "../../lib/calendar";
import { getPlayerClockSync } from "../../lib/playerClock";
import { timeTravelAllowed } from "../../lib/playerClockChange";
import { getEventPolicy, type EventMode } from "../../lib/eventPolicy";
import { scheduledContentEnabled } from "../../lib/eventSchedule";
import { getRewardPolicy, rewardPercent } from "../../lib/rewardPolicy";
import { formatUtcMinutes } from "../web/clockText";
import { escapeHtml } from "../web/layout";

const numberFormat = new Intl.NumberFormat("en-US")

/** The user's player: the one of their save (their most recently used account), if they have one. */
export function playerOfUser(userId: number): Player | null {
    const accountId = getUserAccountIdsSync(userId)[0]
    return accountId === undefined ? null : getPlayerFromAccountIdSync(accountId)
}

function stat(label: string, value: string): string {
    return `                <div class="stat">
                    <span class="stat-label">${label}</span>
                    <span class="stat-value text-base">${value}</span>
                </div>`
}

function card(title: string, text: string, body: string, badge = ""): string {
    return `        <section class="card">
            <div class="card-header">
                <div class="flex flex-col gap-1">
                    <h2 class="card-title">${title}</h2>
                    <p class="card-text">${text}</p>
                </div>
${badge}
            </div>
${body}
        </section>`
}

/**
 * Profile and save download; nothing without a player. The ID shown is the one the game's Account Info shows as the
 * player's PID: the account number the server sends as `playerId` at login (src/routes/openapi.ts), not the internal
 * player row number the admin site uses.
 */
export function profileCard(player: Player | null, csrf = ""): string {
    if (player === null) return ""
    const stats = [
        stat("Name", escapeHtml(player.name || "Unnamed")),
        stat("Player ID (PID)", String(getAccountFromPlayerIdSync(player.id)?.id ?? "unknown")),
        stat("Rank", numberFormat.format(playerRankSync(player.rankPoint))),
        stat("Beads", numberFormat.format(player.freeVmoney + player.vmoney)),
        stat("Mana", numberFormat.format(player.freeMana + player.paidMana)),
        stat("Comment", player.comment === "" ? "none" : escapeHtml(player.comment))
    ].join("\n")
    return card("Your player", "Your save as the server holds it. Download a copy to keep it, or to bring it to another server.",
        `            <section class="grid gap-4 grid-cols-2">
${stats}
            </section>
            <a href="/portal/save" class="btn-outline self-start" download>Download your save</a>${importForm(player, csrf)}`)
}

/**
 * ACC-15: replacing the save with a file, when the server's owner allows it (src/lib/playerSaveImport.ts); the time
 * of the next allowed import while the daily limit holds; nothing when imports are off.
 */
function importForm(player: Player, csrf: string): string {
    if (!playerSaveImportEnabled()) return ""
    const next = nextPlayerImportAt(player.id)
    if (next !== null)
        return `
            <p class="card-text">You imported a save less than a day ago. You can import again after ${escapeHtml(formatUtcMinutes(new Date(next)))} UTC.</p>`
    return `
            <form class="flex flex-col gap-3" method="post" action="/portal/save" enctype="multipart/form-data">
                <input type="hidden" name="csrf" value="${csrf}">
                <label class="field">Import a save
                    <input class="file-input" name="save" type="file" accept="application/json,.json" required>
                </label>
                <p class="card-text">Bring your progress from Local play or another server: download the save there, then import it here. It replaces your whole progress on this server, once a day at most. Close the game first, and restart it after the import.</p>
                <label class="flex items-start gap-2 card-text"><input class="check" type="checkbox" name="confirm" value="1" required> Replace my progress on this server with this file</label>
                <button type="submit" class="btn-primary self-start">Import save</button>
            </form>`
}

/** The player's own clock, when the user may move it; nothing otherwise. */
export function clockCard(user: User, player: Player | null, csrf: string): string {
    if (player === null || !timeTravelAllowed(user)) return ""
    const clock = getPlayerClockSync(player.id)
    if (clock === null) return ""
    const now = `${formatUtcMinutes(clock.date)} UTC`
    const days = Math.abs(clock.offsetDays)
    const state = clock.offsetDays === 0 ? "Server clock" : `${days} ${days === 1 ? "day" : "days"} ${clock.offsetDays < 0 ? "behind" : "ahead"}`
    const text = `Move your game alone to another day, for example to play an earlier event again. The rest of the server stays where it is. Your game's date now: ${escapeHtml(now)}.`
    return card("Time travel", text, `            <form class="flex gap-3 flex-wrap items-end" method="post" action="/portal/clock">
                <input type="hidden" name="csrf" value="${csrf}">
                <label class="field">Game day
                    <input class="input" name="date" type="date" value="${gameDayOf(clock.date.getTime())}" required>
                </label>
                <button type="submit" class="btn-primary">Go to this day</button>
            </form>
            <form method="post" action="/portal/clock/reset">
                <input type="hidden" name="csrf" value="${csrf}">
                <button type="submit" class="btn-outline self-start"${clock.offsetDays === 0 ? " disabled" : ""}>Follow the server's date</button>
            </form>
            <p class="card-text">Reopen the game to load the selected historical period. Your daily rewards still follow normal time. You can change periods once a minute.</p>`,
        `                <span class="${clock.offsetDays === 0 ? "badge-off" : "badge-on"}">${escapeHtml(state)}</span>`)
}

/** Read-only server rules, visible to players whether or not they have linked a save. */
export function eventRulesCard(user: User): string {
    const policy = getEventPolicy()
    const reward = getRewardPolicy()
    const modes: Record<EventMode, string> = { classic: "Classic", accelerated: "Accelerated", "time-travel": "Time Travel", manual: "Manual" }
    const mode = scheduledContentEnabled() ? modes[policy.mode] : "Legacy clock"
    const management = reward.management === "automatic"
        ? "Automatic — the server's reward rules: original amounts, and every event can be finished at any event speed."
        : "Managed — the server administrator controls the reward rules."
    const travel = timeTravelAllowed(user) ? "Available to your account" : "Not available to your account"
    const admin = user.role === "admin" && scheduledContentEnabled()
        ? `<p class="card-text">Admin time travel: ${policy.adminTimeTravel ? "enabled" : "disabled"}.</p>` : ""
    return card("Event and reward rules", "The server's current settings for events and earned rewards.",
        `            <section class="grid gap-4 grid-cols-2">
${stat("Event mode", escapeHtml(mode))}
${stat("Earned rewards", `${rewardPercent(reward.multiplier)}%`)}
            </section>
            ${reward.bossMultiplier !== reward.multiplier ? `<p class="card-text">Boss battles earn ${rewardPercent(reward.bossMultiplier)}%.</p>` : ""}
            <p class="card-text">${escapeHtml(management)}</p>
            <p class="card-text">Time travel: ${escapeHtml(travel)}.${scheduledContentEnabled() ? " Daily resets follow normal time." : ""}</p>
            ${admin}`)
}

/** The mods the server sends with the game data, and whether its English translation is on. */
export function modsCard(): string {
    const layers = getAssetLayers()
    const names = layers.mods.map(mod => mod.location.slice(mod.location.lastIndexOf("/") + 1))
    const list = names.length === 0
        ? `            <p class="card-text">This server has no mods: the game looks as it always did.</p>`
        : `            <ul class="flex flex-col gap-1 list-disc pl-5 text-on-surface">
${names.map(name => `                <li>${escapeHtml(name)}</li>`).join("\n")}
            </ul>`
    const translation = layers.i18n === "on" && layers.built.en?.overlay !== undefined
        ? "The English translation is on for phones set to English."
        : "The English translation is off."
    return card("Mods on this server", `Files that change the game's pictures, sounds or text for every player. ${translation}`, list)
}
