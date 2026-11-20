// Rules and helpers for the portal login (ACC-2, docs/accounts.md "Web portal"): what a username and a password must
// look like, the per-username limit on failed logins, and the session cookie.

import type { FastifyReply, FastifyRequest } from "fastify"
import { MAX_PASSWORD_LENGTH } from "./password"
import { PORTAL_SESSION_TTL_MS } from "../data/portalSessions"

export const USERNAME_MIN_LENGTH = 3
export const USERNAME_MAX_LENGTH = 24
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]+$/
export const PASSWORD_MIN_LENGTH = 10
export { MAX_PASSWORD_LENGTH as PASSWORD_MAX_LENGTH }

export type UsernameProblem = "username-length" | "username-characters"
export type PasswordProblem = "password-short" | "password-long" | "password-is-username"

export function usernameProblem(username: string): UsernameProblem | null {
    if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) return "username-length"
    if (!USERNAME_PATTERN.test(username)) return "username-characters"
    return null
}

export function passwordProblem(password: string, username: string): PasswordProblem | null {
    if (password.length < PASSWORD_MIN_LENGTH) return "password-short"
    if (password.length > MAX_PASSWORD_LENGTH) return "password-long"
    if (password.toLowerCase() === username.toLowerCase()) return "password-is-username"
    return null
}

/** Whether new users may sign up on the portal; `PORTAL_REGISTRATION=closed` leaves it to the admin site. */
export function registrationOpen(): boolean {
    return process.env.PORTAL_REGISTRATION?.trim().toLowerCase() !== "closed"
}

// Failed logins per username, in memory: the per-IP rate limit doesn't stop guesses spread over many addresses.
// Over the limit, that username's logins are refused for the rest of the window, right password or not.
export const LOGIN_FAILURE_LIMIT = 10
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000
const MAX_TRACKED_USERNAMES = 10_000

const failures = new Map<string, { count: number, since: number }>()

function failureEntry(username: string, now: number) {
    const key = username.toLowerCase()
    const entry = failures.get(key)
    if (entry !== undefined && now - entry.since >= LOGIN_FAILURE_WINDOW_MS) {
        failures.delete(key)
        return { key, entry: undefined }
    }
    return { key, entry }
}

/** Whether this username has used up its failed logins for now. */
export function loginLocked(username: string, now: number = Date.now()): boolean {
    const { entry } = failureEntry(username, now)
    return entry !== undefined && entry.count >= LOGIN_FAILURE_LIMIT
}

/** Counts a wrong password or TOTP code for this username, known or not. */
export function recordLoginFailure(username: string, now: number = Date.now()) {
    const { key, entry } = failureEntry(username, now)
    if (entry !== undefined) {
        entry.count++
        return
    }
    if (failures.size >= MAX_TRACKED_USERNAMES) {
        for (const [name, old] of failures) if (now - old.since >= LOGIN_FAILURE_WINDOW_MS) failures.delete(name)
        // still full: drop the oldest, so the map stays bounded
        if (failures.size >= MAX_TRACKED_USERNAMES) failures.delete(failures.keys().next().value!)
    }
    failures.set(key, { count: 1, since: now })
}

/** A successful login forgets the username's failures. */
export function clearLoginFailures(username: string) {
    failures.delete(username.toLowerCase())
}

/** For tests. */
export function resetLoginFailures() {
    failures.clear()
}

// The session cookie. Over HTTPS (behind a proxy, with TRUST_PROXY and X-Forwarded-Proto) it is `Secure` with the
// `__Host-` prefix, which browsers only accept from a secure origin, for the whole host and no subdomain. Over plain
// HTTP (a LAN server) browsers drop `Secure` cookies, so it is sent without; public servers must use HTTPS
// (docs/hardening.md). Always `HttpOnly` and `SameSite=Lax`: other sites' forms don't carry it, while following a
// link to the portal still finds the user logged in.
export interface SessionCookie {
    /** The session token from the request's cookie, if any. */
    token(request: FastifyRequest): string | null
    set(request: FastifyRequest, reply: FastifyReply, token: string, maxAgeMs: number): void
    clear(request: FastifyRequest, reply: FastifyReply): void
}

/**
 * A session cookie named `name` (`__Host-<name>` over HTTPS), with the attributes above. `isHttps` says whether a
 * request reached the server over HTTPS; by default Fastify's `request.protocol`, which follows `TRUST_PROXY`.
 */
export function sessionCookie(name: string, isHttps: (request: FastifyRequest) => boolean = request => request.protocol === "https"): SessionCookie {
    const cookieName = (request: FastifyRequest) => isHttps(request) ? `__Host-${name}` : name
    const attributes = (request: FastifyRequest) => `Path=/; HttpOnly; SameSite=Lax${isHttps(request) ? "; Secure" : ""}`
    return {
        token(request) {
            const header = request.headers.cookie
            if (typeof header !== "string") return null
            const wanted = cookieName(request)
            for (const part of header.split(";")) {
                const separator = part.indexOf("=")
                if (separator < 0) continue
                if (part.slice(0, separator).trim() !== wanted) continue
                const value = part.slice(separator + 1).trim()
                return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null
            }
            return null
        },
        set(request, reply, token, maxAgeMs) {
            reply.header("set-cookie", `${cookieName(request)}=${token}; Max-Age=${Math.floor(maxAgeMs / 1000)}; ${attributes(request)}`)
        },
        clear(request, reply) {
            reply.header("set-cookie", `${cookieName(request)}=; Max-Age=0; ${attributes(request)}`)
        }
    }
}

const portalCookie = sessionCookie("reflipped_portal")

/** The session token from the request's cookie, if any. */
export function sessionToken(request: FastifyRequest): string | null {
    return portalCookie.token(request)
}

export function setSessionCookie(request: FastifyRequest, reply: FastifyReply, token: string, maxAgeMs: number = PORTAL_SESSION_TTL_MS) {
    portalCookie.set(request, reply, token, maxAgeMs)
}

export function clearSessionCookie(request: FastifyRequest, reply: FastifyReply) {
    portalCookie.clear(request, reply)
}
