import multipart from "@fastify/multipart";
import { maxSaveFileBytes } from "../../data/saveSchema";
import { importPlayerSave, nextPlayerImportAt, playerSaveImportEnabled } from "../../lib/playerSaveImport";
// The player portal (ACC-2, docs/accounts.md "Web portal"): register, log in (with an optional TOTP second factor),
// log out, change the password, get a device link code (ACC-4). It is on the public game listener under /portal, so
// players reach it at the same address as the game; the admin site keeps its own listener.
//
// The shell signs in here too (ACC-3, docs/accounts.md "Shell login"): its WebView opens /portal/shell, the login and
// register pages carry `?next=shell` so they return there, and Play hands the shell a one-time code in the URL of
// /portal/shell/done, which the shell intercepts and trades for a device token at POST /portal/shell/token.
//
// Protection, besides the session cookie's flags (src/lib/portalAuth.ts):
// - every POST must come from the portal itself (Sec-Fetch-Site/Origin, as on the admin site), and every POST made
//   while logged in also carries the session's CSRF token;
// - per-IP rate limits on every POST (`RATE_LIMIT_PORTAL`, src/lib/rateLimit.ts) and a per-username limit on failed
//   logins (src/lib/portalAuth.ts);
// - helmet headers with a CSP allowing only the site's own resources, and `Cache-Control: no-store`;
// - notices are fixed codes with fixed texts (`?error=`/`?message=`), never text from the request.
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import { timingSafeEqual } from "crypto";
import { isIP } from "net";
import QRCode from "qrcode";
import { createLinkCodeSync, createUserSync, getUserAccountIdsSync, getUserByUsernameSync, getUserSync, setUserLastLoginSync, setUserPasswordHashSync, setUserTotpSync, useUserTotpStepSync, User } from "../../data/users";
import {
    addPortalSessionMfaFailureSync, countUserPortalSessionsSync, createPortalSessionSync, deletePortalSessionSync, deleteUserPortalSessionsSync,
    getPortalSessionSync, PortalSession, setPortalSessionPendingTotpSync
} from "../../data/portalSessions";
import { adminSessions } from "../../data/adminSessions";
import { hashPassword, passwordNeedsRehash, verifyPassword } from "../../lib/password";
import {
    clearLoginFailures, clearSessionCookie, loginLocked, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordProblem, recordLoginFailure,
    registrationOpen, sessionToken, setSessionCookie, USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH, usernameProblem
} from "../../lib/portalAuth";
import { generateTotpSecret, matchTotp, totpUri } from "../../lib/totp";
import { isSameSiteRequest } from "../../lib/adminGuard";
import { escapeHtml, fillTemplate, noticeHtml, PageNotices, readPage } from "../web/layout";
import { ignoredBody, jsonBody } from "../schemas";
import { createShellSignInSync, redeemShellSignInSync } from "../../data/shellSignIns";
import { unlinkDeviceSync } from "../../lib/deviceLink";
import { getAccountDeviceSecretHashSync } from "../../data/wdfpData";
import { signInDeviceSync, signOutDeviceSync, signOutInstallDeviceSync } from "../../lib/shellSignIn";
import { formatUtcMinutes } from "../web/clockText";
import { clockCard, eventRulesCard, modsCard, playerOfUser, profileCard } from "./playerCards";
import { setPlayerClockSync, runOnPlayerClockSync } from "../../lib/playerClock";
import { setPlayerDaySync, timeTravelAllowed } from "../../lib/playerClockChange";
import { getClientSerializedData } from "../../data/utils";
import { getTextSetting } from "../../data/serverSettings";
import { DELETED_SAVE_DAYS, deleteSaveSync } from "../../lib/saveDeletion";

/** The shell's way out of signing in: it intercepts this URL like the code's and plays as a guest. */
const GUEST_LINK = `        <p class="card-text"><a class="text-primary font-semibold" href="/portal/shell/done?guest=1">Play without an account</a>: your save stays on this server and is bound to this app installation.</p>`

/** Wrong TOTP codes allowed on one pending login before it has to start over with the password. */
const MFA_FAILURE_LIMIT = 5

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"])

const passwordField = { type: "string", maxLength: PASSWORD_MAX_LENGTH + 1 }
const usernameField = { type: "string", maxLength: 64 }
const codeField = { type: "string", maxLength: 16 }
const csrfField = { type: "string", maxLength: 64 }

const loginSchema = jsonBody({ username: usernameField, password: passwordField }, ["username", "password"])
const registerSchema = jsonBody({ username: usernameField, password: passwordField, confirm: passwordField }, ["username", "password", "confirm"])
const totpLoginSchema = jsonBody({ code: codeField, csrf: csrfField }, ["code", "csrf"])
const csrfOnlySchema = jsonBody({ csrf: csrfField })
const passwordSchema = jsonBody({ csrf: csrfField, current: passwordField, password: passwordField, confirm: passwordField }, ["csrf", "current", "password", "confirm"])
const clockSchema = jsonBody({ csrf: csrfField, date: { type: "string", maxLength: 10 } }, ["csrf", "date"])
const unlinkSchema = jsonBody({ csrf: csrfField, password: passwordField }, ["csrf", "password"])
const deleteSaveSchema = jsonBody({ csrf: csrfField, password: passwordField, confirm: { type: "string", maxLength: 8 } }, ["csrf", "password"])
const totpSetupSchema = jsonBody({ csrf: csrfField, code: codeField }, ["csrf", "code"])
const totpDisableSchema = jsonBody({ csrf: csrfField, password: passwordField }, ["csrf", "password"])
const shellLogoutSchema = jsonBody({ deviceToken: { type: "string", maxLength: 128 }, whiteKey: { type: "string", minLength: 16, maxLength: 128 } })
const shellTokenSchema = jsonBody({ code: { type: "string", maxLength: 64 }, whiteKey: { type: "string", maxLength: 128 }, appId: { type: "string", maxLength: 32 } }, ["code"])

const usernameTexts = {
    "username-length": `A username has ${USERNAME_MIN_LENGTH} to ${USERNAME_MAX_LENGTH} characters.`,
    "username-characters": "A username may only use letters, digits, dots, dashes and underscores."
}
const passwordTexts = {
    "password-short": `A password needs at least ${PASSWORD_MIN_LENGTH} characters.`,
    "password-long": `A password can have at most ${PASSWORD_MAX_LENGTH} characters.`,
    "password-is-username": "The password can't be the username.",
    "password-mismatch": "The two passwords are different."
}

const loginNotices: PageNotices = {
    errors: new Map([
        ["invalid", "Wrong username or password."],
        ["locked", "Too many failed logins for this username. Try again in 15 minutes."],
        ["totp-expired", "The login took too long. Log in again."],
        ["totp-locked", "Too many wrong codes. Log in again."]
    ]),
    messages: new Map([
        ["logged-out", "You are logged out."],
        ["password-changed", "Password changed. Log in with the new one."]
    ])
}
const totpLoginNotices: PageNotices = {
    errors: new Map([["invalid", "That code is wrong or was already used. Wait for the next one and try again."]]),
    messages: new Map()
}
const registerNotices: PageNotices = {
    errors: new Map<string, string>([
        ["taken", "That username is taken."],
        ...Object.entries(usernameTexts),
        ...Object.entries(passwordTexts)
    ]),
    messages: new Map()
}
const accountNotices: PageNotices = {
    errors: new Map<string, string>([
        ["current-wrong", "Your current password is wrong. Nothing was changed."],
        ...Object.entries(passwordTexts),
        ["totp-password-wrong", "Wrong password. Two-step login is still on."],
        ["unlink-password-wrong", "Wrong password. The device is still linked."],
        ["clock-invalid", "Pick a valid day. Your game's date didn't change."],
        ["clock-out-of-range", "That day is too far away. Your game's date didn't change."],
        ["clock-no-portal", "The game can't open on that day: no summoning portal is open then. Pick another day; your game's date didn't change."],
        ["clock-cooldown", "Wait one minute between changes to your historical period."],
        ["time-travel-off", "Time travel isn't open to your account. Ask the person who runs this server."],
        ["no-player", "You have no save yet, so there is nothing to download or move."],
        ["save-import-off", "This server doesn't let players import a save. Ask the person who runs it."],
        ["save-import-wait", "You imported a save less than a day ago. Try again later."],
        ["save-confirm", "Tick the box to confirm that the file replaces your progress. Nothing was changed."],
        ["save-missing", "Choose a save file first. Nothing was changed."],
        ["save-too-large", "That file is too big to be a save. Nothing was changed."],
        ["save-invalid", "That file isn't a save this server can read. Nothing was changed."],
        ["save-failed", "The import failed. Nothing was changed; try again later."],
        ["delete-password-wrong", "Wrong password. Your save wasn't deleted."],
        ["delete-confirm", "Tick the box to confirm that you want to delete your save. Nothing was changed."]
    ]),
    messages: new Map([
        ["welcome", "Your account is ready."],
        ["password-changed", "Password changed. Your other logins have ended."],
        ["totp-on", "Two-step login is on. You'll need a code from your app the next time you log in."],
        ["totp-off", "Two-step login is off."],
        ["clock-set", "Your game moves to that day at its next step: it goes back to the title screen and loads the new day."],
        ["clock-reset", "Your game follows the server's date again from its next step."],
        ["save-imported", "Save imported. Restart the game to play it."],
        ["save-deleted", `Your save is deleted. The next time you start the game, it begins a new one. If this was a mistake, ask the person who runs this server within ${DELETED_SAVE_DAYS} days: they can bring it back.`],
        ["unlinked", "Device unlinked. Its game stops at the next request. Your save is kept: sign in from the app or use a link code to play it again."]
    ])
}
const totpSetupNotices: PageNotices = {
    errors: new Map([["invalid", "That code is wrong. Check the app shows the Reflipped entry and try the next code."]]),
    messages: new Map()
}

/** Whether a host name is this machine, where plain HTTP is not readable by others. */
function isLoopbackHost(host: string | undefined): boolean {
    if (!host) return false
    const name = host.replace(/^\[([^\]]+)\].*$/, "$1").replace(/:\d+$/, "").toLowerCase()
    return name === "localhost" || name === "::1" || (isIP(name) === 4 && name.startsWith("127."))
}

function renderPortalPage(request: FastifyRequest, page: string, title: string, values: Record<string, string> = {}): string {
    const content = fillTemplate(readPage(`portal/${page}`), {
        usernameMin: String(USERNAME_MIN_LENGTH),
        usernameMax: String(USERNAME_MAX_LENGTH),
        passwordMin: String(PASSWORD_MIN_LENGTH),
        passwordMax: String(PASSWORD_MAX_LENGTH),
        ...values
    })
    const connectionNotice = request.protocol === "https" || isLoopbackHost(request.headers.host) ? ""
        : `<div class="notice-error">This connection isn't encrypted, so others on the network could read your password. Use a password you don't use anywhere else.</div>`
    const shell = forShell(request) || request.url.split("?")[0].startsWith("/portal/shell") || inAppView(request)
    return fillTemplate(readPage("portal/layout"), { title: escapeHtml(title), connectionNotice, content,
        shellStyle: shell ? '<link rel="stylesheet" href="/public/css/shell-portal.css">' : "",
        shellClass: shell ? "shell-portal" : "",
        serverIdentity: shell ? `<p class="shell-server-name">${escapeHtml(getTextSetting("server.name"))}</p>` : "" })
}

function sendPage(reply: FastifyReply, html: string) {
    return reply.type("text/html; charset=utf-8").send(html)
}

function notice(notices: PageNotices, request: FastifyRequest): string {
    const { error, message } = request.query as { error?: unknown, message?: unknown }
    return noticeHtml(notices, error, message)
}

function csrfMatches(session: PortalSession, sent: unknown): boolean {
    if (typeof sent !== "string") return false
    const expected = Buffer.from(session.csrfToken)
    const actual = Buffer.from(sent)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** The request's session and user, or null (its cookie is cleared when it names no live session). */
function currentLogin(request: FastifyRequest, reply: FastifyReply): { token: string, session: PortalSession, user: User } | null {
    const token = sessionToken(request)
    if (token === null) return null
    const session = getPortalSessionSync(token)
    const user = session === null ? null : getUserSync(session.userId)
    if (session === null || user === null) {
        clearSessionCookie(request, reply)
        return null
    }
    return { token, session, user }
}

/**
 * Whether the request is part of the shell's sign-in (`?next=shell`): the login and register pages then return to
 * /portal/shell instead of the account page. Only this one value is accepted, so it can't redirect anywhere else.
 */
function forShell(request: FastifyRequest): boolean {
    return (request.query as { next?: unknown }).next === "shell"
}

/**
 * The Reflipped app's own web views add "ReflippedApp" to their user agent. Their portal pages (account management
 * from the game's Account Info) then use the same look as the app's sign-in. Styling only: never a permission.
 */
function inAppView(request: FastifyRequest): boolean {
    return /\bReflippedApp\b/.test(String(request.headers["user-agent"] ?? ""))
}

/**
 * The shell's way out of signing in, except in its "Link an account" sign-in (user agent "ReflippedLinking"): that
 * player already plays as a guest, so the link would only lead back. Styling only, like `inAppView`.
 */
function guestLink(request: FastifyRequest): string {
    return /\bReflippedLinking\b/.test(String(request.headers["user-agent"] ?? "")) ? "" : GUEST_LINK
}

/** `path` with `params` and, for the shell's sign-in, `next=shell`. */
function portalUrl(path: string, shell: boolean, params: Record<string, string> = {}): string {
    const query = new URLSearchParams(shell ? { ...params, next: "shell" } : params).toString()
    return query === "" ? path : `${path}?${query}`
}

/** Where a finished login goes. */
function homeUrl(shell: boolean): string {
    return shell ? "/portal/shell" : "/portal"
}

/** A full login (password and, if on, TOTP code done), or null after redirecting to the login page. */
function requireLogin(request: FastifyRequest, reply: FastifyReply, shell = false) {
    const login = currentLogin(request, reply)
    if (login === null || login.session.mfaPending) {
        reply.redirect(portalUrl("/portal/login", shell))
        return null
    }
    return login
}

/** Like `requireLogin`, for a POST: also checks the form's CSRF token (a mismatch is a 403). */
function requireLoginPost(request: FastifyRequest, reply: FastifyReply, shell = false) {
    const login = requireLogin(request, reply, shell)
    if (login === null) return null
    if (!csrfMatches(login.session, (request.body as { csrf?: unknown }).csrf)) {
        reply.status(403).type("application/json").send({ error: "Forbidden", message: "The form expired. Reload the page and try again." })
        return null
    }
    return login
}

/** Ends whatever session the request carries, then starts a full one for the user. */
function startFullSession(request: FastifyRequest, reply: FastifyReply, userId: number) {
    const old = sessionToken(request)
    if (old !== null) deletePortalSessionSync(old)
    const { token } = createPortalSessionSync(userId)
    setUserLastLoginSync(userId)
    setSessionCookie(request, reply, token)
}

function formatDate(date: Date | null): string {
    return date === null || isNaN(date.getTime()) ? "never" : `${formatUtcMinutes(date)} UTC`
}

/** The account page's card about the user's save and the device bound to it (ACC-6). */
function saveCard(userId: number, csrf: string): { saveBadge: string, saveState: string, saveText: string, saveControls: string } {
    const accountId = getUserAccountIdsSync(userId)[0]
    if (accountId === undefined) return {
        saveBadge: "badge-off", saveState: "No save yet",
        saveText: "You have no save yet. Sign in from the Reflipped app, or play on a device and link it with a code, and your progress is saved to this account.",
        saveControls: ""
    }
    if (getAccountDeviceSecretHashSync(accountId) === null) return {
        saveBadge: "badge-off", saveState: "No device",
        saveText: "No device plays your save at the moment. Sign in from the Reflipped app, or link a device with a code, to play it again.",
        saveControls: ""
    }
    // no "last played" date: the player's last login is on the server clock, which can be a 2025 date (CLAUDE.md, "Server clock")
    return {
        saveBadge: "badge-on", saveState: "Device linked",
        saveText: "A device plays your save. If you lost it or sold it, unlink it: its game stops, and your save stays here for you to play on another device.",
        saveControls: `            <form class="flex flex-col gap-4" method="post" action="/portal/unlink">
                <input type="hidden" name="csrf" value="${csrf}">
                <label class="field">Password
                    <input class="input" name="password" type="password" autocomplete="current-password" required maxlength="${PASSWORD_MAX_LENGTH}">
                </label>
                <button type="submit" class="btn-danger self-start">Unlink device</button>
            </form>`
    }
}

/** The account page's card for deleting the save (FT-59); empty without a save. */
function deleteSaveCard(hasSave: boolean, csrf: string): string {
    if (!hasSave) return ""
    return `        <section class="card">
            <div class="card-header">
                <div class="flex flex-col gap-1">
                    <h2 class="card-title">Delete your save</h2>
                    <p class="card-text">Deletes your progress on this server: your units, items and story. Your account and its login stay, and the game starts a new save the next time you play. The server's owner keeps a copy for ${DELETED_SAVE_DAYS} days and can bring it back if you ask in time; after that it is gone.</p>
                </div>
            </div>
            <form class="flex flex-col gap-4" method="post" action="/portal/save/delete">
                <input type="hidden" name="csrf" value="${csrf}">
                <label class="field">Password
                    <input class="input" name="password" type="password" autocomplete="current-password" required maxlength="${PASSWORD_MAX_LENGTH}">
                </label>
                <label class="flex items-start gap-2 card-text"><input class="check" type="checkbox" name="confirm" value="1" required> Delete my progress on this server</label>
                <button type="submit" class="btn-danger self-start">Delete my save</button>
            </form>
        </section>`
}

/** "ABCD EFGH …": a TOTP secret in groups of four, easier to type. */
function groupedSecret(secret: string): string {
    return secret.replace(/(.{4})(?=.)/g, "$1 ")
}

const routes = async (fastify: FastifyInstance) => {
    // the portal's forms are plain HTML forms; game msgpack never comes here
    fastify.removeContentTypeParser("application/x-www-form-urlencoded")
    fastify.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(body as string)))
    })

    fastify.addHook("onRequest", async (request, reply) => {
        reply.header("cache-control", "no-store")
        if (!safeMethods.has(request.method) && !isSameSiteRequest(request))
            return reply.status(403).type("application/json").send({ error: "Forbidden", message: "Cross-site request refused." })
    })

    // the player's own save import (ACC-15): one file of at most a save's size
    fastify.register(multipart, { limits: { fileSize: maxSaveFileBytes, files: 1, fields: 4, parts: 6 } })

    fastify.register(helmet, {
        contentSecurityPolicy: {
            directives: {
                "default-src": ["'self'"],
                "script-src": ["'self'"],
                "script-src-attr": ["'none'"],
                "style-src": ["'self'", "'unsafe-inline'"],
                // the TOTP QR code is a data: SVG
                "img-src": ["'self'", "data:"],
                "font-src": ["'self'"],
                "connect-src": ["'self'"],
                "form-action": ["'self'"],
                "frame-ancestors": ["'none'"],
                "base-uri": ["'self'"],
                "object-src": ["'none'"],
                // LAN servers run on plain HTTP; public ones set up HTTPS in their proxy
                "upgrade-insecure-requests": null
            }
        },
        // left to the HTTPS proxy: the game listener also serves plain-HTTP LAN setups
        strictTransportSecurity: false,
        // as on the admin site: browsers would send `Origin: null` on the portal's own forms otherwise
        referrerPolicy: { policy: "same-origin" }
    })

    fastify.get("/", async (request, reply) => {
        const login = requireLogin(request, reply)
        if (login === null) return reply
        const { user, session } = login
        const csrf = escapeHtml(session.csrfToken)
        const sessions = countUserPortalSessionsSync(user.id)
        const player = playerOfUser(user.id)
        const totpControls = user.totpSecret === null
            ? `            <a href="/portal/totp" class="btn-outline self-start">Turn on</a>`
            : `            <form class="flex flex-col gap-4" method="post" action="/portal/totp/disable">
                <input type="hidden" name="csrf" value="${csrf}">
                <label class="field">Password
                    <input class="input" name="password" type="password" autocomplete="current-password" required maxlength="${PASSWORD_MAX_LENGTH}">
                </label>
                <button type="submit" class="btn-danger self-start">Turn off</button>
            </form>`
        return sendPage(reply, renderPortalPage(request, "account", user.username, {
            ...saveCard(user.id, csrf),
            username: escapeHtml(user.username),
            notice: notice(accountNotices, request),
            created: escapeHtml(formatDate(user.createdTime)),
            sessions: `${sessions} ${sessions === 1 ? "device" : "devices"}`,
            csrf,
            totpBadge: user.totpSecret === null ? "badge-off" : "badge-on",
            totpState: user.totpSecret === null ? "Off" : "On",
            totpControls,
            profileCard: profileCard(player, csrf),
            deleteSaveCard: deleteSaveCard(player !== null, csrf),
            clockCard: clockCard(user, player, csrf),
            eventRulesCard: eventRulesCard(user),
            modsCard: modsCard()
        }))
    })

    fastify.get("/login", async (request, reply) => {
        const shell = forShell(request)
        const login = currentLogin(request, reply)
        if (login !== null && !login.session.mfaPending) return reply.redirect(homeUrl(shell))
        return sendPage(reply, renderPortalPage(request, "login", "Log in", {
            notice: notice(loginNotices, request),
            subtitle: shell ? "Log in to play with your account on this device." : "Log in to your Reflipped account.",
            action: escapeHtml(portalUrl("/portal/login", shell)),
            registerLink: registrationOpen()
                ? `        <p class="card-text">New here? <a class="text-primary font-semibold" href="${escapeHtml(portalUrl("/portal/register", shell))}">Create an account</a>.</p>`
                : "",
            guestLink: shell ? guestLink(request) : ""
        }))
    })

    fastify.post("/login", { schema: loginSchema }, async (request, reply) => {
        const shell = forShell(request)
        const { username, password } = request.body as { username: string, password: string }
        if (loginLocked(username)) return reply.redirect(portalUrl("/portal/login", shell, { error: "locked" }))
        const user = getUserByUsernameSync(username)
        // an unknown username still costs one verification (src/lib/password.ts)
        if (!await verifyPassword(user?.passwordHash ?? null, password) || user === null) {
            recordLoginFailure(username)
            return reply.redirect(portalUrl("/portal/login", shell, { error: "invalid" }))
        }
        if (passwordNeedsRehash(user.passwordHash)) setUserPasswordHashSync(user.id, await hashPassword(password))

        if (user.totpSecret !== null) {
            const old = sessionToken(request)
            if (old !== null) deletePortalSessionSync(old)
            const { token, session } = createPortalSessionSync(user.id, { mfaPending: true })
            setSessionCookie(request, reply, token, session.expires.getTime() - Date.now())
            return reply.redirect(portalUrl("/portal/login/totp", shell))
        }
        clearLoginFailures(username)
        startFullSession(request, reply, user.id)
        return reply.redirect(homeUrl(shell))
    })

    fastify.get("/login/totp", async (request, reply) => {
        const shell = forShell(request)
        const login = currentLogin(request, reply)
        if (login === null) return reply.redirect(portalUrl("/portal/login", shell, { error: "totp-expired" }))
        if (!login.session.mfaPending) return reply.redirect(homeUrl(shell))
        return sendPage(reply, renderPortalPage(request, "login-totp", "Two-step login", {
            notice: notice(totpLoginNotices, request),
            csrf: escapeHtml(login.session.csrfToken),
            action: escapeHtml(portalUrl("/portal/login/totp", shell)),
            logoutAction: escapeHtml(portalUrl("/portal/logout", shell))
        }))
    })

    fastify.post("/login/totp", { schema: totpLoginSchema }, async (request, reply) => {
        const shell = forShell(request)
        const login = currentLogin(request, reply)
        if (login === null) return reply.redirect(portalUrl("/portal/login", shell, { error: "totp-expired" }))
        const { token, session, user } = login
        if (!session.mfaPending) return reply.redirect(homeUrl(shell))
        const { code, csrf } = request.body as { code: string, csrf: string }
        if (!csrfMatches(session, csrf)) return reply.redirect(portalUrl("/portal/login/totp", shell, { error: "invalid" }))

        const step = user.totpSecret === null ? null : matchTotp(user.totpSecret, code)
        if (step === null || !useUserTotpStepSync(user.id, step)) {
            recordLoginFailure(user.username)
            if (addPortalSessionMfaFailureSync(token) >= MFA_FAILURE_LIMIT || loginLocked(user.username)) {
                deletePortalSessionSync(token)
                clearSessionCookie(request, reply)
                return reply.redirect(portalUrl("/portal/login", shell, { error: "totp-locked" }))
            }
            return reply.redirect(portalUrl("/portal/login/totp", shell, { error: "invalid" }))
        }
        clearLoginFailures(user.username)
        // a new token for the full login
        startFullSession(request, reply, user.id)
        return reply.redirect(homeUrl(shell))
    })

    fastify.get("/register", async (request, reply) => {
        const shell = forShell(request)
        if (!registrationOpen()) return reply.redirect(portalUrl("/portal/login", shell))
        return sendPage(reply, renderPortalPage(request, "register", "Create an account", {
            notice: notice(registerNotices, request),
            action: escapeHtml(portalUrl("/portal/register", shell)),
            loginUrl: escapeHtml(portalUrl("/portal/login", shell)),
            guestLink: shell ? guestLink(request) : ""
        }))
    })

    fastify.post("/register", { schema: registerSchema }, async (request, reply) => {
        const shell = forShell(request)
        if (!registrationOpen()) return reply.redirect(portalUrl("/portal/login", shell))
        const { username, password, confirm } = request.body as { username: string, password: string, confirm: string }
        const problem = usernameProblem(username) ?? passwordProblem(password, username) ?? (password === confirm ? null : "password-mismatch")
        if (problem !== null) return reply.redirect(portalUrl("/portal/register", shell, { error: problem }))
        if (getUserByUsernameSync(username) !== null) return reply.redirect(portalUrl("/portal/register", shell, { error: "taken" }))

        const user = createUserSync({ username, passwordHash: await hashPassword(password) })
        // taken by a registration that finished while this one was hashing
        if (user === null) return reply.redirect(portalUrl("/portal/register", shell, { error: "taken" }))
        startFullSession(request, reply, user.id)
        return reply.redirect(shell ? "/portal/shell" : "/portal?message=welcome")
    })

    fastify.post("/logout", { schema: csrfOnlySchema }, async (request, reply) => {
        const shell = forShell(request)
        const login = currentLogin(request, reply)
        if (login !== null) {
            if (!csrfMatches(login.session, (request.body as { csrf?: unknown }).csrf))
                return reply.redirect(login.session.mfaPending ? portalUrl("/portal/login/totp", shell) : homeUrl(shell))
            deletePortalSessionSync(login.token)
        }
        clearSessionCookie(request, reply)
        return reply.redirect(portalUrl("/portal/login", shell, { message: "logged-out" }))
    })

    // --- the shell's sign-in (ACC-3) ---

    // The page the shell's WebView opens: Play as the logged-in user on this device, or log in first.
    fastify.get("/shell", async (request, reply) => {
        const login = requireLogin(request, reply, true)
        if (login === null) return reply
        return sendPage(reply, renderPortalPage(request, "shell", "Play on this device", {
            username: escapeHtml(login.user.username),
            csrf: escapeHtml(login.session.csrfToken),
            guestLink: guestLink(request)
        }))
    })

    // Play: a one-time code for the shell, in the URL of the page the shell intercepts.
    fastify.post("/shell", { schema: csrfOnlySchema }, async (request, reply) => {
        const login = requireLoginPost(request, reply, true)
        if (login === null) return reply
        return reply.redirect(`/portal/shell/done?code=${createShellSignInSync(login.user.id)}`)
    })

    // The shell stops its WebView before this page loads; a browser that isn't the shell lands here.
    fastify.get("/shell/done", async (request, reply) => {
        return sendPage(reply, renderPortalPage(request, "shell-done", "Back to the app"))
    })

    // The shell trades the code for a device token, its device secret from then on (src/lib/shellSignIn.ts). `whiteKey`
    // is the shell's own per-install key, so a user without a save yet takes over this install's guest save.
    fastify.post("/shell/token", { schema: shellTokenSchema }, async (request, reply) => {
        const { code, whiteKey, appId } = request.body as { code: string, whiteKey?: string, appId?: string }
        const userId = redeemShellSignInSync(code)
        if (userId === null) return reply.status(400).type("application/json").send({ error: "Bad Request", code: "invalid-code", message: "The sign-in expired. Sign in again." })
        const signIn = signInDeviceSync(userId, whiteKey ?? null, appId ?? "")
        request.log.info({ userId, accountId: signIn.accountId, source: signIn.source }, "shell sign-in: device bound to the user's save")
        return reply.type("application/json").send({ deviceToken: signIn.token, playerId: String(signIn.accountId) })
    })

    // The shell's Log out (ACC-12): the device token proves the device; its account lets go of the device's viewer ID,
    // so the next account the device plays can take it. The reply is the same for an unknown token.
    fastify.post("/shell/logout", { schema: shellLogoutSchema }, async (request, reply) => {
        const { deviceToken, whiteKey } = request.body as { deviceToken?: string, whiteKey?: string }
        if ((deviceToken === undefined) === (whiteKey === undefined)) return reply.code(400).send({ error: "Bad Request" })
        const released = deviceToken !== undefined ? signOutDeviceSync(deviceToken) : signOutInstallDeviceSync(whiteKey!)
        request.log.info({ released }, "shell log out")
        return reply.status(204).send()
    })

    // --- device linking (ACC-4, src/lib/deviceLink.ts) ---

    // A code to type in the game as the profile comment. It is shown in this reply only, never put in a URL, and a
    // new code ends the user's earlier one.
    fastify.post("/link", { schema: csrfOnlySchema }, async (request, reply) => {
        const login = requireLoginPost(request, reply)
        if (login === null) return reply
        const { code, expires } = createLinkCodeSync(login.user.id)
        return sendPage(reply, renderPortalPage(request, "link", "Link a device", {
            code: escapeHtml(`${code.slice(0, 4)}-${code.slice(4)}`),
            expires: escapeHtml(formatDate(expires))
        }))
    })

    fastify.post("/password", { schema: passwordSchema }, async (request, reply) => {
        const login = requireLoginPost(request, reply)
        if (login === null) return reply
        const { user, token } = login
        const { current, password, confirm } = request.body as { current: string, password: string, confirm: string }
        if (!await verifyPassword(user.passwordHash, current)) return reply.redirect("/portal?error=current-wrong")
        const problem = passwordProblem(password, user.username) ?? (password === confirm ? null : "password-mismatch")
        if (problem !== null) return reply.redirect(`/portal?error=${problem}`)

        setUserPasswordHashSync(user.id, await hashPassword(password))
        deleteUserPortalSessionsSync(user.id, token)
        // an admin's admin-site logins end too (ACC-5)
        adminSessions.deleteForUser(user.id)
        return reply.redirect("/portal?message=password-changed")
    })

    // The user gives up the device their save is bound to (src/lib/deviceLink.ts, `unlinkDeviceSync`). It asks for the
    // password as the other destructive settings do.
    fastify.post("/unlink", { schema: unlinkSchema }, async (request, reply) => {
        const login = requireLoginPost(request, reply)
        if (login === null) return reply
        const { user } = login
        const { password } = request.body as { password: string }
        if (!await verifyPassword(user.passwordHash, password)) return reply.redirect("/portal?error=unlink-password-wrong")
        const unbound = unlinkDeviceSync(user.id)
        request.log.info({ userId: user.id, accountIds: unbound }, "device unlinked")
        return reply.redirect("/portal?message=unlinked")
    })

    // FT-59: the user deletes their own save (src/lib/saveDeletion.ts: kept for an admin to restore, the account stays).
    // Password and a ticked box, as the other destructive settings ask.
    fastify.post("/save/delete", { schema: deleteSaveSchema }, async (request, reply) => {
        const login = requireLoginPost(request, reply)
        if (login === null) return reply
        const { user } = login
        const { password, confirm } = request.body as { password: string, confirm?: string }
        if (!await verifyPassword(user.passwordHash, password)) return reply.redirect("/portal?error=delete-password-wrong")
        if (confirm !== "1") return reply.redirect("/portal?error=delete-confirm")
        const player = playerOfUser(user.id)
        if (player === null) return reply.redirect("/portal?error=no-player")
        const kept = deleteSaveSync(player.id, "portal")
        request.log.info({ userId: user.id, playerId: player.id, kept }, "save deleted from the portal")
        return reply.redirect("/portal?message=save-deleted")
    })

    // --- player features (ACC-8, src/routes/portal/playerCards.ts) ---

    // The user's save, as the admin site exports it: on the player's clock, which decides what mail has expired.
    fastify.get("/save", async (request, reply) => {
        const login = requireLogin(request, reply)
        if (login === null) return reply
        const player = playerOfUser(login.user.id)
        const data = player === null ? null
            : runOnPlayerClockSync(player.id, () => getClientSerializedData(player.id, { serializeRushEventData: true, serializeSaveData: true }))
        if (player === null || data === null) return reply.redirect("/portal?error=no-player")
        request.log.info({ userId: login.user.id, playerId: player.id }, "portal save download")
        reply.header("content-disposition", `attachment; filename="reflipped-save-${player.id}.json"`)
        return reply.type("application/json").send(data)
    })

    // ACC-15: the player replaces their own save with a file, when the server's owner allows it (src/lib/playerSaveImport.ts).
    // A multipart form, so the CSRF token and the confirmation come as parts and are checked here, before the import.
    // the file and the fields come as multipart parts (read below), not as a parsed body: hence ignoredBody
    fastify.post("/save", { schema: ignoredBody }, async (request, reply) => {
        const login = requireLogin(request, reply)
        if (login === null) return reply
        const player = playerOfUser(login.user.id)
        if (player === null) return reply.redirect("/portal?error=no-player")
        const fields: Record<string, string> = {}
        let file: Buffer | null = null
        try {
            for await (const part of request.parts()) {
                if (part.type === "file") {
                    if (part.fieldname === "save" && file === null) file = await part.toBuffer()
                    else await part.toBuffer()
                } else if (typeof part.value === "string") {
                    fields[part.fieldname] = part.value
                }
            }
        } catch (error) {
            const tooLarge = error instanceof Error && (error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE"
            request.log.warn({ userId: login.user.id, playerId: player.id, reason: tooLarge ? "too large" : "unreadable upload" }, "portal save import rejected")
            return reply.redirect(`/portal?error=${tooLarge ? "save-too-large" : "save-invalid"}`)
        }
        if (!csrfMatches(login.session, fields.csrf))
            return reply.status(403).type("application/json").send({ error: "Forbidden", message: "The form expired. Reload the page and try again." })
        if (!playerSaveImportEnabled()) return reply.redirect("/portal?error=save-import-off")
        if (nextPlayerImportAt(player.id) !== null) return reply.redirect("/portal?error=save-import-wait")
        if (fields.confirm !== "1") return reply.redirect("/portal?error=save-confirm")
        if (file === null || file.length === 0) return reply.redirect("/portal?error=save-missing")
        const result = importPlayerSave(player.id, file, request.log, { byPlayer: true })
        request.log.info({ userId: login.user.id, playerId: player.id, result }, "portal save import")
        if (result === "imported") return reply.redirect("/portal?message=save-imported")
        return reply.redirect(`/portal?error=${result === "automatic" ? "save-import-off" : result === "invalid" ? "save-invalid" : "save-failed"}`)
    })

    // Time travel: only when an admin turned it on for the user, or for everyone (PORTAL_TIME_TRAVEL=all).
    fastify.post("/clock", { schema: clockSchema }, async (request, reply) => {
        const login = requireLoginPost(request, reply)
        if (login === null) return reply
        if (!timeTravelAllowed(login.user)) return reply.redirect("/portal?error=time-travel-off")
        const player = playerOfUser(login.user.id)
        if (player === null) return reply.redirect("/portal?error=no-player")
        // never forced: a day without a portal would break the user's game
        const result = setPlayerDaySync(player.id, (request.body as { date: string }).date, false, login.user.role === "admin")
        if (result === "clock-set") request.log.info({ userId: login.user.id, playerId: player.id }, "portal time travel")
        return reply.redirect(result === "clock-set" ? "/portal?message=clock-set" : `/portal?error=${result}`)
    })

    fastify.post("/clock/reset", { schema: csrfOnlySchema }, async (request, reply) => {
        const login = requireLoginPost(request, reply)
        if (login === null) return reply
        if (!timeTravelAllowed(login.user)) return reply.redirect("/portal?error=time-travel-off")
        const player = playerOfUser(login.user.id)
        if (player === null) return reply.redirect("/portal?error=no-player")
        setPlayerClockSync(player.id, null)
        return reply.redirect("/portal?message=clock-reset")
    })

    fastify.get("/totp", async (request, reply) => {
        const login = requireLogin(request, reply)
        if (login === null) return reply
        const { user, session, token } = login
        if (user.totpSecret !== null) return reply.redirect("/portal")
        // the same secret on a reload, so a scan already made still works
        let secret = session.pendingTotpSecret
        if (secret === null) {
            secret = generateTotpSecret()
            setPortalSessionPendingTotpSync(token, secret)
        }
        const qrCode = await QRCode.toDataURL(totpUri("Reflipped", user.username, secret), { type: "image/png", margin: 0, errorCorrectionLevel: "M" })
        return sendPage(reply, renderPortalPage(request, "totp-setup", "Two-step login", {
            notice: notice(totpSetupNotices, request),
            qrCode,
            secret: escapeHtml(groupedSecret(secret)),
            csrf: escapeHtml(session.csrfToken)
        }))
    })

    fastify.post("/totp", { schema: totpSetupSchema }, async (request, reply) => {
        const login = requireLoginPost(request, reply)
        if (login === null) return reply
        const { user, session, token } = login
        if (user.totpSecret !== null) return reply.redirect("/portal")
        const secret = session.pendingTotpSecret
        if (secret === null) return reply.redirect("/portal/totp")
        const step = matchTotp(secret, (request.body as { code: string }).code)
        if (step === null) return reply.redirect("/portal/totp?error=invalid")

        setUserTotpSync(user.id, secret)
        // the code just typed can't log in again
        useUserTotpStepSync(user.id, step)
        setPortalSessionPendingTotpSync(token, null)
        return reply.redirect("/portal?message=totp-on")
    })

    fastify.post("/totp/disable", { schema: totpDisableSchema }, async (request, reply) => {
        const login = requireLoginPost(request, reply)
        if (login === null) return reply
        const { user } = login
        if (!await verifyPassword(user.passwordHash, (request.body as { password: string }).password))
            return reply.redirect("/portal?error=totp-password-wrong")
        setUserTotpSync(user.id, null)
        return reply.redirect("/portal?message=totp-off")
    })
}

export default routes;
