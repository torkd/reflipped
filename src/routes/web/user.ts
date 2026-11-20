import { scheduledContentEnabled } from "../../lib/eventSchedule";
import { getEventPolicy } from "../../lib/eventPolicy";
// The admin site's Users pages (ACC-2): portal users, and the help an admin gives a player who is locked out
// (a new password, two-step login off, logins ended). The actions are POSTs in src/routes/web_api/user.ts.
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAccountUserIdSync, getAllUsersSync, getUserAccountIdsSync, getUserSync, User } from "../../data/users";
import { findSaveSync } from "../../lib/saveAttach";
import { countUserPortalSessionsSync } from "../../data/portalSessions";
import { getAccountPlayers, getPlayerSync } from "../../data/wdfpData";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, registrationOpen, USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from "../../lib/portalAuth";
import { escapeHtml, noticeHtml, PageNotices, renderPage } from "./layout";
import { formatUtcMinutes } from "./clockText";
import { timeTravelForEveryone } from "../../lib/playerClockChange";

// The `?error=` and `?message=` codes src/routes/web_api/user.ts redirects with (see `noticeHtml`).
const listNotices: PageNotices = {
    errors: new Map([
        ["taken", "Nothing was created: that username is taken."],
        ["username-length", `Nothing was created: a username has ${USERNAME_MIN_LENGTH} to ${USERNAME_MAX_LENGTH} characters.`],
        ["username-characters", "Nothing was created: a username may only use letters, digits, dots, dashes and underscores."],
        ["password-short", `Nothing was created: a password needs at least ${PASSWORD_MIN_LENGTH} characters.`],
        ["password-long", `Nothing was created: a password can have at most ${PASSWORD_MAX_LENGTH} characters.`],
        ["password-is-username", "Nothing was created: the password can't be the username."]
    ]),
    messages: new Map([["deleted", "User deleted. Their players stay as guests."]])
}
const userNotices: PageNotices = {
    errors: new Map([
        ["password-short", `Nothing was changed: a password needs at least ${PASSWORD_MIN_LENGTH} characters.`],
        ["password-long", `Nothing was changed: a password can have at most ${PASSWORD_MAX_LENGTH} characters.`],
        ["password-is-username", "Nothing was changed: the password can't be the username."],
        ["save-unknown", "Nothing was changed: there is no player with that number or PID."],
        ["save-other-user", "Nothing was changed: that save belongs to another user. Detach it from them first."],
        ["save-none", "This user has no save to detach."],
        ["last-admin", "Nothing was changed: this is the only admin. Make another user an admin first, or nobody could log in to this website."]
    ]),
    messages: new Map([
        ["save-attached", "Save attached. It is this user's save now; the device that plays it keeps playing it."],
        ["save-replaced", "Save attached in place of the user's old one. The old save is a guest save now (find it under Players); the user's device plays the new one from its next launch, and any device that played it before starts a new guest."],
        ["save-already", "That save is already this user's."],
        ["save-detached", "Save detached: it is a guest save now, and its device keeps playing it. The game goes back to the title on its next request."],
        ["created", "User created. They can log in on the portal now."],
        ["password-set", "Password set and every login of this user ended. Give them the new password."],
        ["role-set", "Role saved."],
        ["time-travel-on", "This user can move their player's clock on the portal now."],
        ["time-travel-off", "This user can no longer move their player's clock. Their clock stays where it is; reset it on the player page if needed."],
        ["totp-off", "Two-step login is off. They log in with their password alone until they turn it on again."],
        ["logged-out", "Every portal and admin website login of this user has ended."]
    ])
}

function formatDate(date: Date | null): string {
    return date === null || isNaN(date.getTime()) ? "never" : `${formatUtcMinutes(date)} UTC`
}

/** The Users page's time travel card (ACC-8, src/lib/playerClockChange.ts). */
function timeTravelValues(user: User): Record<string, string> {
    if (scheduledContentEnabled()) return {
        timeTravelText: user.role === "admin"
            ? `Admin time travel is ${getEventPolicy().adminTimeTravel ? "enabled" : "disabled"} globally in Settings.`
            : "Player time travel is available only in Time Travel event mode. Choose that mode in Settings to enable it for players.",
        timeTravelNext: "0", timeTravelButton: "Controlled by event settings", timeTravelDisabled: "disabled"
    }
    const everyone = timeTravelForEveryone()
    return {
        timeTravelText: everyone
            ? "Every user can move their own player's clock on the portal (PORTAL_TIME_TRAVEL=all), so this switch changes nothing."
            : user.timeTravel
                ? "On: this user can move their own player to another game day on the portal, to play earlier events. Other players stay where they are."
                : "Off: only you can move this user's player to another day (on the player page). Turn it on to let them do it on the portal.",
        timeTravelNext: user.timeTravel ? "0" : "1",
        timeTravelButton: user.timeTravel ? "Turn off time travel" : "Turn on time travel",
        timeTravelDisabled: everyone ? "disabled" : ""
    }
}

function roleText(user: User): string {
    return user.role === "admin" ? "Admin" : "Player"
}

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
        const { error, message } = request.query as { error?: unknown, message?: unknown }
        const users = getAllUsersSync()
        const listContent = users.length === 0
            ? `                <div class="flex flex-col items-center gap-2 py-10 text-center">
                    <p class="card-title">No users yet</p>
                    <p class="card-text">Players create their account on the portal, or you create one below.</p>
                </div>`
            : users.map(user => `                <a href="/user/${user.id}" class="list-row">
                    <div class="avatar">${escapeHtml(user.username.slice(0, 1).toUpperCase())}</div>
                    <div class="flex flex-col flex-1 min-w-0">
                        <span class="font-semibold text-on-background truncate">${escapeHtml(user.username)}</span>
                        <span class="text-sm text-on-surface-variant">Last login ${formatDate(user.lastLoginTime)}</span>
                    </div>
                    <span class="${user.role === "admin" ? "badge-on" : "badge-off"}">${roleText(user)}</span>
                </a>`).join("\n")

        const html = renderPage("users", "Users", "users", {
            userCountText: users.length === 1 ? "1 user." : `${users.length} users.`,
            notice: noticeHtml(listNotices, error, message),
            listContent,
            registrationText: registrationOpen()
                ? "Players can also sign up themselves on the portal (set PORTAL_REGISTRATION=closed to stop that)."
                : "Sign-up on the portal is closed (PORTAL_REGISTRATION=closed), so new users are created here.",
            usernameMin: String(USERNAME_MIN_LENGTH),
            usernameMax: String(USERNAME_MAX_LENGTH),
            passwordMin: String(PASSWORD_MIN_LENGTH),
            passwordMax: String(PASSWORD_MAX_LENGTH)
        })
        reply.header("content-type", "text/html; charset=utf-8")
        reply.send(html)
    })

    fastify.get("/:userId", async (request: FastifyRequest, reply: FastifyReply) => {
        const { userId } = request.params as { userId: string }
        const { error, message } = request.query as { error?: unknown, message?: unknown }
        const id = Number(userId)
        const user = Number.isSafeInteger(id) ? getUserSync(id) : null
        if (user === null) return reply.redirect("/user")

        // each save with its account ID, the PID the game shows (ADM-3)
        const saves = (await Promise.all(getUserAccountIdsSync(user.id).map(async accountId =>
            (await getAccountPlayers(accountId)).map(playerId => ({ accountId, playerId }))))).flat()
        const playerIds = saves.map(save => save.playerId)
        const saveName = playerIds.length === 0 ? "" : getPlayerSync(playerIds[0])?.name || "Unnamed"
        const sessions = countUserPortalSessionsSync(user.id)
        const html = renderPage("user", user.username, "users", {
            notice: noticeHtml(userNotices, error, message),
            userId: String(user.id),
            username: escapeHtml(user.username),
            roleText: roleText(user),
            totpText: user.totpSecret === null ? "Off" : "On",
            sessions: `${sessions} ${sessions === 1 ? "device" : "devices"}`,
            created: formatDate(user.createdTime),
            lastLogin: formatDate(user.lastLoginTime),
            players: playerIds.length === 0 ? "none yet"
                : playerIds.map(playerId => `<a class="text-primary" href="/player/${playerId}">#${playerId}</a>`).join(", "),
            saveText: playerIds.length === 0 ? "This user has no save yet. It starts when they sign in on the Reflipped app or link a device."
                : `Player #${playerIds[0]} (${escapeHtml(saveName)}), PID ${saves[0].accountId}.`,
            saveLink: playerIds.length === 0 ? "" : `<a class="btn-outline w-fit" href="/player/${playerIds[0]}">Open the save</a>`,
            detachDisabled: playerIds.length === 0 ? "disabled" : "",
            roleOptions: (["player", "admin"] as const).map(role =>
                `                                <option value="${role}"${user.role === role ? " selected" : ""}>${role === "admin" ? "Admin" : "Player"}</option>`).join("\n"),
            ...timeTravelValues(user),
            totpResetDisabled: user.totpSecret === null ? "disabled" : "",
            passwordMin: String(PASSWORD_MIN_LENGTH),
            passwordMax: String(PASSWORD_MAX_LENGTH)
        })
        reply.header("content-type", "text/html; charset=utf-8")
        reply.send(html)
    })

    // ADM-3: the attach form's confirmation. Player numbers and PIDs overlap (#12 and PID 12 are usually two saves), so
    // the page names the save the number found and what happens to the user's own; only its button attaches, by the
    // save's player number. Nothing changes here.
    fastify.get("/:userId/attach", async (request: FastifyRequest, reply: FastifyReply) => {
        const { userId } = request.params as { userId: string }
        const { playerId, idKind } = request.query as { playerId?: unknown, idKind?: unknown }
        const id = Number(userId)
        const user = Number.isSafeInteger(id) ? getUserSync(id) : null
        if (user === null) return reply.redirect("/user")
        const number = typeof playerId === "string" ? playerId.trim() : ""
        const save = /^[0-9]{1,15}$/.test(number) ? findSaveSync(Number(number), idKind === "pid" ? "pid" : "player") : null
        const player = save === null ? null : getPlayerSync(save.playerId)
        if (save === null || player === null) return reply.redirect(`/user/${user.id}?error=save-unknown`)
        const owner = getAccountUserIdSync(save.accountId)
        if (owner === user.id) return reply.redirect(`/user/${user.id}?message=save-already`)
        if (owner !== null) return reply.redirect(`/user/${user.id}?error=save-other-user`)

        // the user's own save, the one an attach replaces (src/lib/saveAttach.ts: their most recent account)
        const currentAccountId = getUserAccountIdsSync(user.id)[0]
        const currentPlayerId = currentAccountId === undefined ? undefined : (await getAccountPlayers(currentAccountId))[0]
        const username = escapeHtml(user.username)
        const consequence = currentAccountId === undefined
            ? `It becomes ${username}'s save. The device that plays it keeps playing it.`
            : `It replaces ${username}'s save, ${escapeHtml((currentPlayerId === undefined ? null : getPlayerSync(currentPlayerId))?.name || "Unnamed")} (${currentPlayerId === undefined ? "no player" : `player #${currentPlayerId}`}, PID ${currentAccountId}), which becomes a guest save. ${username}'s device, if one is linked, moves to this save from its next launch, a device that played this save before starts a new guest, and the sessions of both saves end.`
        const html = renderPage("attach-save", "Attach this save?", "users", {
            userId: String(user.id),
            username,
            saveName: escapeHtml(player.name || "Unnamed"),
            saveInitial: escapeHtml((player.name || "?").slice(0, 1).toUpperCase()),
            savePlayerId: String(save.playerId),
            savePid: String(save.accountId),
            saveLastLogin: formatDate(player.lastLoginTime),
            consequence
        })
        reply.header("content-type", "text/html; charset=utf-8")
        reply.send(html)
    })
}

export default routes;
