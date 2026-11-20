// The admin site's login pages (ACC-5, src/lib/adminAuth.ts): log in with a portal user that has the admin role
// (password, then the TOTP code if they turned it on), log out, and the first admin's setup when there is none.
// Notices are fixed codes with fixed texts, as on every admin page.
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { adminSessions } from "../../data/adminSessions";
import { countAdminsSync, createUserSync, getUserByUsernameSync, setUserLastLoginSync, setUserPasswordHashSync, setUserRoleSync, useUserTotpStepSync } from "../../data/users";
import { adminCookie, currentAdminLogin, isHttpsAdminRequest, isLoopbackRequest, safeNext } from "../../lib/adminAuth";
import { hashPassword, passwordNeedsRehash, verifyPassword } from "../../lib/password";
import {
    clearLoginFailures, loginLocked, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordProblem, recordLoginFailure, USERNAME_MAX_LENGTH,
    USERNAME_MIN_LENGTH, usernameProblem
} from "../../lib/portalAuth";
import { matchTotp } from "../../lib/totp";
import { jsonBody } from "../schemas";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { escapeHtml, fillTemplate, noticeHtml, PageNotices, readPage } from "./layout";

/** Wrong TOTP codes allowed on one pending login before it has to start over with the password. */
const MFA_FAILURE_LIMIT = 5

const passwordField = { type: "string", maxLength: PASSWORD_MAX_LENGTH + 1 }
const usernameField = { type: "string", maxLength: 64 }
const nextQuery = { querystring: { type: "object", properties: { next: { type: "string", maxLength: 512 } } } }

const loginSchema = { ...nextQuery, ...jsonBody({ username: usernameField, password: passwordField }, ["username", "password"]) }
const totpSchema = { ...nextQuery, ...jsonBody({ code: { type: "string", maxLength: 16 } }, ["code"]) }
const setupSchema = jsonBody({ username: usernameField, password: passwordField, confirm: passwordField }, ["username", "password", "confirm"])
const logoutSchema = jsonBody({})

const loginNotices: PageNotices = {
    errors: new Map([
        ["invalid", "Wrong username or password, or this account isn't an admin."],
        ["locked", "Too many failed logins for this username. Try again in 15 minutes."],
        ["totp-expired", "The login took too long. Log in again."],
        ["totp-locked", "Too many wrong codes. Log in again."]
    ]),
    messages: new Map([
        ["logged-out", "You are logged out."],
        ["setup-done", "The admin account is ready."]
    ])
}
const totpNotices: PageNotices = {
    errors: new Map([["invalid", "That code is wrong or was already used. Wait for the next one and try again."]]),
    messages: new Map()
}
const setupNotices: PageNotices = {
    errors: new Map([
        ["taken", "That username belongs to a portal account and the password doesn't match it. Use its password, or another username."],
        ["username-length", `A username has ${USERNAME_MIN_LENGTH} to ${USERNAME_MAX_LENGTH} characters.`],
        ["username-characters", "A username may only use letters, digits, dots, dashes and underscores."],
        ["password-short", `A password needs at least ${PASSWORD_MIN_LENGTH} characters.`],
        ["password-long", `A password can have at most ${PASSWORD_MAX_LENGTH} characters.`],
        ["password-is-username", "The password can't be the username."],
        ["password-mismatch", "The two passwords are different."]
    ]),
    messages: new Map()
}

function sendLoginPage(request: FastifyRequest, reply: FastifyReply, page: string, title: string, values: Record<string, string> = {}) {
    const content = fillTemplate(readPage(`admin-login/${page}`), {
        usernameMin: String(USERNAME_MIN_LENGTH),
        usernameMax: String(USERNAME_MAX_LENGTH),
        passwordMin: String(PASSWORD_MIN_LENGTH),
        passwordMax: String(PASSWORD_MAX_LENGTH),
        ...values
    })
    const connectionNotice = isHttpsAdminRequest(request) || isLoopbackRequest(request) ? ""
        : `<div class="notice-error">This connection isn't encrypted, so others on the network could read the password. Reach the admin website over a VPN or an SSH tunnel.</div>`
    const html = fillTemplate(readPage("admin-login/layout"), { title: escapeHtml(title), connectionNotice, content })
    return reply.header("cache-control", "no-store").type("text/html; charset=utf-8").send(html)
}

function notice(notices: PageNotices, request: FastifyRequest): string {
    const { error, message } = request.query as { error?: unknown, message?: unknown }
    return noticeHtml(notices, error, message)
}

/** `path` with `params` and the page to return to. */
function withNext(path: string, next: string | null, params: Record<string, string> = {}): string {
    const query = new URLSearchParams(next === null ? params : { ...params, next }).toString()
    return query === "" ? path : `${path}?${query}`
}

function nextOf(request: FastifyRequest): string | null {
    return safeNext((request.query as { next?: unknown }).next)
}

/** Ends whatever admin session the request carries, then starts a full one. */
function startFullSession(request: FastifyRequest, reply: FastifyReply, userId: number) {
    const old = adminCookie.token(request)
    if (old !== null) adminSessions.delete(old)
    const { token } = adminSessions.create(userId)
    setUserLastLoginSync(userId)
    adminCookie.set(request, reply, token, adminSessions.ttlMs)
}

/**
 * The server on the phone (SH-13 step 5b): the Reflipped app opens its admin site with a one-time login instead of a
 * password. The app writes a random code to this file (in its private storage, which no other app can read or write)
 * and opens `/login/once/<code>`; the file is deleted at every attempt, so each code works once, and only within two
 * minutes. Every app on the phone can reach 127.0.0.1, so /setup and the password login stay closed then: the first
 * one-time login creates the phone's admin account itself.
 */
function onceLoginFile(): string | null {
    const file = process.env.ADMIN_LOGIN_CODE_FILE?.trim()
    return file ? file : null
}

const ONCE_CODE_MAX_AGE_MS = 2 * 60 * 1000
// a name the portal can't register (a space isn't allowed in usernames), so no app on the phone can take it first and
// have it made admin (security review 2026-11-13)
const PHONE_ADMIN = "phone admin"

function sendPhoneOnly(reply: FastifyReply, status: number, message: string) {
    return reply.code(status).type("text/html; charset=utf-8").header("cache-control", "no-store").send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Reflipped</title></head>`
        + `<body style="font-family:sans-serif;margin:2rem;line-height:1.5"><h1>Reflipped</h1><p>${escapeHtml(message)}</p></body></html>`)
}

/**
 * The one-time code, or null when there is none. A stale or malformed file is deleted; a valid one stays until it is
 * used (`useOnceCode`): a wrong guess against a 256-bit code proves nothing, and deleting at every miss let any app or
 * web page on the phone keep cancelling the owner's login (security review 2026-11-13).
 */
function readOnceCode(file: string): string | null {
    let code: string | null = null
    let stale = false
    try {
        stale = Date.now() - statSync(file).mtimeMs > ONCE_CODE_MAX_AGE_MS
        if (!stale) code = readFileSync(file, "utf8").trim()
    } catch { return null }
    if (stale || code === null || !/^[0-9a-f]{32,128}$/.test(code)) {
        try { unlinkSync(file) } catch { /* already gone */ }
        return null
    }
    return code
}

function useOnceCode(file: string) {
    try { unlinkSync(file) } catch { /* already gone */ }
}

function sameCode(expected: string, sent: string): boolean {
    const a = Buffer.from(expected), b = Buffer.from(sent)
    return a.length === b.length && timingSafeEqual(a, b)
}

export interface AdminLoginRoutesOptions {
    /** false with `ADMIN_AUTH=off`: the pages then only send the visitor to the dashboard */
    enabled: boolean
}

const routes = async (fastify: FastifyInstance, options: AdminLoginRoutesOptions) => {
    // a path, not a query: the app opens only addresses without one (ServerIdentity.resourceAddress)
    fastify.get("/login/once/:code", { schema: { params: { type: "object", properties: { code: { type: "string", maxLength: 128 } }, required: ["code"] } } }, async (request, reply) => {
        const file = onceLoginFile()
        if (!options.enabled || file === null) return reply.redirect("/login")
        const expected = readOnceCode(file)
        const sent = (request.params as { code: string }).code
        if (!isLoopbackRequest(request) || expected === null || !sameCode(expected, sent)) {
            request.log.info("one-time admin login refused")
            return sendPhoneOnly(reply, 403, "This link has expired. Open the server settings from the Reflipped app again.")
        }
        useOnceCode(file)
        let admin = getUserByUsernameSync(PHONE_ADMIN)
        if (admin === null) {
            // nobody logs in with this password: the account is reached only through one-time logins
            admin = createUserSync({ username: PHONE_ADMIN, passwordHash: await hashPassword(randomBytes(32).toString("hex")), role: "admin" })
            if (admin === null) return sendPhoneOnly(reply, 500, "The server couldn't create its admin account.")
        } else if (admin.role !== "admin") {
            setUserRoleSync(admin.id, "admin")
        }
        startFullSession(request, reply, admin.id)
        return reply.redirect("/")
    })

    fastify.get("/login", { schema: nextQuery }, async (request, reply) => {
        if (!options.enabled) return reply.redirect("/")
        if (onceLoginFile() !== null)
            return sendPhoneOnly(reply, 200, "This server runs on your phone. Open its settings from the Reflipped app: Menu, then Admin panel.")
        if (countAdminsSync() === 0) return reply.redirect("/setup")
        const login = currentAdminLogin(request, reply)
        if (login !== null && !login.session.mfaPending) return reply.redirect(nextOf(request) ?? "/")
        return sendLoginPage(request, reply, "login", "Log in", {
            notice: notice(loginNotices, request),
            action: escapeHtml(withNext("/login", nextOf(request)))
        })
    })

    fastify.post("/login", { schema: loginSchema }, async (request, reply) => {
        if (!options.enabled || onceLoginFile() !== null) return reply.redirect("/")
        const next = nextOf(request)
        const { username, password } = request.body as { username: string, password: string }
        if (loginLocked(username)) return reply.redirect(withNext("/login", next, { error: "locked" }))
        const user = getUserByUsernameSync(username)
        // an unknown username still costs one verification (src/lib/password.ts); a player's account gets the same answer
        if (!await verifyPassword(user?.passwordHash ?? null, password) || user === null || user.role !== "admin") {
            recordLoginFailure(username)
            request.log.info({ username: user === null ? undefined : user.username }, "admin login refused")
            return reply.redirect(withNext("/login", next, { error: "invalid" }))
        }
        if (passwordNeedsRehash(user.passwordHash)) setUserPasswordHashSync(user.id, await hashPassword(password))

        if (user.totpSecret !== null) {
            const old = adminCookie.token(request)
            if (old !== null) adminSessions.delete(old)
            const { token, session } = adminSessions.create(user.id, { mfaPending: true })
            adminCookie.set(request, reply, token, session.expires.getTime() - Date.now())
            return reply.redirect(withNext("/login/totp", next))
        }
        clearLoginFailures(username)
        startFullSession(request, reply, user.id)
        request.log.info({ userId: user.id }, "admin login")
        return reply.redirect(next ?? "/")
    })

    fastify.get("/login/totp", { schema: nextQuery }, async (request, reply) => {
        if (!options.enabled) return reply.redirect("/")
        const next = nextOf(request)
        const login = currentAdminLogin(request, reply)
        if (login === null) return reply.redirect(withNext("/login", next, { error: "totp-expired" }))
        if (!login.session.mfaPending) return reply.redirect(next ?? "/")
        return sendLoginPage(request, reply, "login-totp", "Two-step login", {
            notice: notice(totpNotices, request),
            action: escapeHtml(withNext("/login/totp", next))
        })
    })

    fastify.post("/login/totp", { schema: totpSchema }, async (request, reply) => {
        if (!options.enabled) return reply.redirect("/")
        const next = nextOf(request)
        const login = currentAdminLogin(request, reply)
        if (login === null) return reply.redirect(withNext("/login", next, { error: "totp-expired" }))
        const { token, session, user } = login
        if (!session.mfaPending) return reply.redirect(next ?? "/")

        const step = user.totpSecret === null ? null : matchTotp(user.totpSecret, (request.body as { code: string }).code)
        if (step === null || !useUserTotpStepSync(user.id, step)) {
            recordLoginFailure(user.username)
            if (adminSessions.addMfaFailure(token) >= MFA_FAILURE_LIMIT || loginLocked(user.username)) {
                adminSessions.delete(token)
                adminCookie.clear(request, reply)
                return reply.redirect(withNext("/login", next, { error: "totp-locked" }))
            }
            return reply.redirect(withNext("/login/totp", next, { error: "invalid" }))
        }
        clearLoginFailures(user.username)
        // a new token for the full login
        startFullSession(request, reply, user.id)
        request.log.info({ userId: user.id }, "admin login")
        return reply.redirect(next ?? "/")
    })

    fastify.post("/logout", { schema: logoutSchema }, async (request, reply) => {
        if (!options.enabled) return reply.redirect("/")
        const token = adminCookie.token(request)
        if (token !== null) adminSessions.delete(token)
        adminCookie.clear(request, reply)
        return reply.redirect("/login?message=logged-out")
    })

    // --- the first admin ---

    fastify.get("/setup", async (request, reply) => {
        if (!options.enabled || countAdminsSync() > 0 || onceLoginFile() !== null) return reply.redirect("/login")
        if (!isLoopbackRequest(request))
            return sendLoginPage(request, reply, "setup-remote", "No admin yet", { port: String(request.socket.localPort ?? 8001) })
        return sendLoginPage(request, reply, "setup", "Create the first admin", { notice: notice(setupNotices, request) })
    })

    fastify.post("/setup", { schema: setupSchema }, async (request, reply) => {
        if (!options.enabled || countAdminsSync() > 0 || !isLoopbackRequest(request) || onceLoginFile() !== null)
            return reply.redirect("/login")
        const { username, password, confirm } = request.body as { username: string, password: string, confirm: string }

        // an existing portal account becomes the admin with its own password
        const existing = getUserByUsernameSync(username)
        if (existing !== null) {
            if (!await verifyPassword(existing.passwordHash, password)) return reply.redirect("/setup?error=taken")
            if (countAdminsSync() > 0) return reply.redirect("/login")
            setUserRoleSync(existing.id, "admin")
            request.log.info({ userId: existing.id }, "admin setup: portal user made the first admin")
            startFullSession(request, reply, existing.id)
            return reply.redirect("/")
        }

        const problem = usernameProblem(username) ?? passwordProblem(password, username) ?? (password === confirm ? null : "password-mismatch")
        if (problem !== null) return reply.redirect(`/setup?error=${problem}`)
        const passwordHash = await hashPassword(password)
        // another setup may have finished while this one was hashing
        if (countAdminsSync() > 0) return reply.redirect("/login")
        const user = createUserSync({ username, passwordHash, role: "admin" })
        if (user === null) return reply.redirect("/setup?error=taken")
        request.log.info({ userId: user.id }, "admin setup: first admin created")
        startFullSession(request, reply, user.id)
        return reply.redirect("/")
    })
}

export default routes;
