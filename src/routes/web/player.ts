import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAllPlayersSync, getPlayerCharactersSync, getPlayerSync } from "../../data/wdfpData";
import { isUnlocked } from "../../lib/developerMode";
import { escapeHtml, renderPage } from "./layout";

interface GetPlayerParams {
    playerId: string | undefined
}

interface GetPlayerQuery {
    error: string | undefined
    message: string | undefined
}

const numberFormat = new Intl.NumberFormat("en-US")

// The `?error=` and `?message=` codes the admin API redirects with. The page shows only these fixed texts, so a
// crafted link can't put its own words on it, and exception messages never reach it; unknown codes show nothing.
const errorNotices = new Map<string, string>([
    ["save-missing", "Choose a save file to upload."],
    ["save-too-large", "That file is too large to be a save. Nothing was changed."],
    ["save-invalid", "That file is not a valid save. Nothing was changed; the server log names the field that is wrong."],
    ["save-failed", "The save could not be imported. Nothing was changed; see the server log."],
    ["dev-failed", "Developer mode could not be switched; see the server log."]
])
const messageNotices = new Map<string, string>([
    ["save-imported", "Save imported. Restart the game to see it."],
    ["dev-on", "Developer mode on: every character, armament, item and quest is unlocked. Restart the game to see it."],
    ["dev-off", "Developer mode off: this player's own progress is back. Restart the game to see it."],
    ["dev-already-off", "Developer mode was already off."],
    ["reset", "Progress reset: this is a fresh player on the same account. Restart the game to start over."]
])

function noticeHtml(error: string | undefined, message: string | undefined): string {
    const errorText = typeof error === "string" ? errorNotices.get(error) : undefined
    if (errorText !== undefined) return `<div class="notice-error">${escapeHtml(errorText)}</div>`
    const messageText = typeof message === "string" ? messageNotices.get(message) : undefined
    return messageText !== undefined ? `<div class="notice-info">${escapeHtml(messageText)}</div>` : ""
}

function formatDate(date: Date): string {
    return isNaN(date.getTime()) ? "never" : date.toISOString().replace("T", " ").slice(0, 16) + " UTC"
}

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
        const players = getAllPlayersSync(0, Number.MAX_SAFE_INTEGER)

        const listContent = players.length === 0
            ? `                <div class="flex flex-col items-center gap-2 py-10 text-center">
                    <p class="card-title">No players yet</p>
                    <p class="card-text">Open the Reflipped app on a phone connected to this server and sign in as a guest.</p>
                </div>`
            : players.map(player => `                <a href="/player/${player.id}" class="list-row">
                    <div class="avatar">${escapeHtml((player.name || "?").slice(0, 1).toUpperCase())}</div>
                    <div class="flex flex-col flex-1 min-w-0">
                        <span class="font-semibold text-on-background truncate">${escapeHtml(player.name || "Unnamed")}</span>
                        <span class="text-sm text-on-surface-variant">Last login ${formatDate(player.lastLoginTime)}</span>
                    </div>
                    <span class="badge-off">#${player.id}</span>
                </a>`).join("\n")

        const html = renderPage("players", "Players", "players", {
            playerCountText: players.length === 1 ? "1 player on this server." : `${players.length} players on this server.`,
            listContent
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

        const unlocked = isUnlocked(parsedPlayerId)
        const notice = noticeHtml(error, message)

        const html = renderPage("player", player.name || `Player ${parsedPlayerId}`, "players", {
            notice,
            playerId: String(parsedPlayerId),
            playerName: escapeHtml(player.name || "Unnamed"),
            playerInitial: escapeHtml((player.name || "?").slice(0, 1).toUpperCase()),
            lastLogin: formatDate(player.lastLoginTime),
            characterCount: numberFormat.format(Object.keys(getPlayerCharactersSync(parsedPlayerId)).length),
            beads: numberFormat.format(player.freeVmoney + player.vmoney),
            mana: numberFormat.format(player.freeMana + player.paidMana),
            stamina: numberFormat.format(player.stamina),
            developerModeState: unlocked ? "On" : "Off",
            developerModeBadge: unlocked ? "badge-on" : "badge-off",
            developerModeNext: unlocked ? "off" : "on",
            developerModeButton: unlocked ? "Turn off" : "Turn on",
            developerModeHelp: unlocked
                ? "Everything is unlocked. Turning it off restores this player's own progress from before; anything earned since is dropped."
                : "Turning it on saves this player's progress, then gives every character (max level, evolved, all mana nodes), all equipment, large stacks of every item and currency, rank 100, and clears every quest, boss battle and event. Turning it off restores the saved progress."
        })
        reply.header("content-type", "text/html; charset=utf-8")
        reply.send(html)
    })
}

export default routes;
