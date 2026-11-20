// The admin site's login (ACC-5, docs/accounts.md "Admin login"). Every page and `/api/*` route of the admin listener
// needs a logged-in portal user with the admin role, or for `/api/*` the `ADMIN_API_TOKEN` (scripts, curl). With no
// admin user yet, the site offers to create the first one, from the server itself only (a loopback address).
//
// Sessions are the portal's kind (src/data/portalSessions.ts) in their own table (src/data/adminSessions.ts) and
// cookie, so a portal login never opens the admin site. Admin POSTs carry no CSRF token: the SEC-10 check
// (src/lib/adminGuard.ts) refuses every state-changing request from another origin, the portal on the game port
// included, and the `SameSite=Lax` cookie isn't sent on other sites' forms anyway.
//
// `ADMIN_AUTH=off` turns the login off (the site is then open to whoever reaches the listener, as before ACC-5);
// tests build the admin server that way unless they test the login.
import type { FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "crypto";
import { BlockList, isIP } from "net";
import { adminSessions } from "../data/adminSessions";
import { countAdminsSync, getUserSync, User } from "../data/users";
import type { PortalSession } from "../data/portalSessions";
import { sessionCookie } from "./portalAuth";

export const adminCookie = sessionCookie("reflipped_admin", isHttpsAdminRequest)

/** An `ADMIN_API_TOKEN` shorter than this is ignored: it would be guessable. */
export const MIN_API_TOKEN_LENGTH = 32

/** Paths that open without a login. */
const OPEN_PATHS = new Set(["/login", "/login/totp", "/logout", "/setup"])

/** Whether the admin site needs a login: on unless `ADMIN_AUTH=off`. */
export function adminAuthFromEnv(): boolean {
    return process.env.ADMIN_AUTH?.trim().toLowerCase() !== "off"
}

/** `ADMIN_API_TOKEN`, or null when unset or too short (with a warning). */
export function adminApiTokenFromEnv(warn: (message: string) => void = message => console.warn(message)): string | null {
    const token = process.env.ADMIN_API_TOKEN?.trim() ?? ""
    if (token === "") return null
    if (token.length < MIN_API_TOKEN_LENGTH) {
        warn(`ADMIN_API_TOKEN is ignored: it needs at least ${MIN_API_TOKEN_LENGTH} characters`)
        return null
    }
    return token
}

/** Whether the request comes from this machine. The admin listener trusts no proxy, so this is the socket's address. */
export function isLoopbackRequest(request: FastifyRequest): boolean {
    const address = request.ip.replace(/^::ffff:/, "")
    return address === "::1" || (isIP(address) === 4 && address.startsWith("127."))
}

let trustedProxies: { raw: string, list: BlockList | null } | null = null

/**
 * `ADMIN_TRUST_PROXY`: the addresses (comma-separated IPs or CIDRs) of a web server in front of the admin site that
 * ends HTTPS, or null when unset. Entries that aren't an address are skipped with a warning.
 */
function adminTrustedProxies(warn: (message: string) => void = console.warn): BlockList | null {
    const raw = process.env.ADMIN_TRUST_PROXY?.trim() ?? ""
    if (trustedProxies !== null && trustedProxies.raw === raw) return trustedProxies.list
    let list: BlockList | null = null
    for (const entry of raw.split(",").map(part => part.trim()).filter(part => part !== "")) {
        const [address, prefix] = entry.split("/")
        const family = isIP(address)
        const bits = prefix === undefined ? (family === 6 ? 128 : 32) : Number(prefix)
        if (family === 0 || !Number.isInteger(bits) || bits < 0 || bits > (family === 6 ? 128 : 32) || (prefix !== undefined && !/^\d+$/.test(prefix))) {
            warn(`ADMIN_TRUST_PROXY: ignoring ${JSON.stringify(entry)}, which isn't an IP address or CIDR`)
            continue
        }
        list ??= new BlockList()
        list.addSubnet(address, bits, family === 6 ? "ipv6" : "ipv4")
    }
    trustedProxies = { raw, list }
    return list
}

/**
 * Whether an admin request reached the server over HTTPS: its own socket, or `X-Forwarded-Proto: https` from a web
 * server listed in `ADMIN_TRUST_PROXY`. Only the scheme is believed from it, never X-Forwarded-Host or -For (the admin
 * listener trusts no proxy for those, SEC-12): it decides the login cookie's `Secure` flag and the unencrypted
 * connection warning.
 */
export function isHttpsAdminRequest(request: FastifyRequest): boolean {
    if (request.protocol === "https") return true
    const proxies = adminTrustedProxies()
    const peer = request.socket.remoteAddress
    if (proxies === null || peer === undefined) return false
    const mapped = peer.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    const address = mapped === null ? peer : mapped[1]
    if (!proxies.check(address, isIP(address) === 6 ? "ipv6" : "ipv4")) return false
    const header = request.headers["x-forwarded-proto"]
    const proto = (Array.isArray(header) ? header[0] : header)?.split(",")[0].trim().toLowerCase()
    return proto === "https"
}

function sameSecret(expected: string, sent: string): boolean {
    const a = Buffer.from(expected)
    const b = Buffer.from(sent)
    return a.length === b.length && timingSafeEqual(a, b)
}

function bearerToken(request: FastifyRequest): string | null {
    const header = request.headers.authorization
    if (typeof header !== "string") return null
    const match = header.match(/^Bearer\s+(\S+)$/i)
    return match === null ? null : match[1]
}

export interface AdminLogin {
    token: string
    session: PortalSession
    user: User
}

/**
 * The request's admin session and user, pending TOTP or full, or null (the cookie is cleared when it names no live
 * session). A user who is no longer an admin has no admin session: theirs is ended.
 */
export function currentAdminLogin(request: FastifyRequest, reply: FastifyReply): AdminLogin | null {
    const token = adminCookie.token(request)
    if (token === null) return null
    const session = adminSessions.get(token)
    const user = session === null ? null : getUserSync(session.userId)
    if (session === null || user === null || user.role !== "admin") {
        if (session !== null) adminSessions.delete(token)
        adminCookie.clear(request, reply)
        return null
    }
    return { token, session, user }
}

/** Where a GET goes back to after the login: a path on this site only, never `//host` or a URL. */
export function safeNext(next: unknown): string | null {
    if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null
    if (next.length > 512 || /[\u0000-\u001f]/.test(next)) return null
    const path = next.split("?")[0]
    return OPEN_PATHS.has(path) ? null : next
}

function unauthorized(reply: FastifyReply, message: string) {
    return reply.status(401).type("application/json").send({ error: "Unauthorized", message })
}

/**
 * The admin listener's onRequest hook: passes open paths and static files, `/api/*` with the API token, and requests
 * of a full admin login (setting `request.adminUser`). Anything else: a page GET goes to the login (or, with no admin
 * yet, the setup) page, other requests get a 401.
 */
export function createAdminLoginGuard(options: { enabled: boolean, apiToken: string | null }) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        const path = request.url.split("?")[0]
        if (!options.enabled || path.startsWith("/public/") || OPEN_PATHS.has(path) || path.startsWith("/login/once/")) return
        const api = path === "/api" || path.startsWith("/api/")

        const bearer = bearerToken(request)
        if (api && bearer !== null && options.apiToken !== null && sameSecret(options.apiToken, bearer)) return

        const login = currentAdminLogin(request, reply)
        if (login !== null && !login.session.mfaPending) {
            request.adminUser = login.user
            return
        }

        const noAdmin = countAdminsSync() === 0
        if (api || (request.method !== "GET" && request.method !== "HEAD"))
            return unauthorized(reply, noAdmin
                ? "The admin site has no admin yet. Open /setup on the server itself to create one."
                : "Log in to the admin site first, or send the ADMIN_API_TOKEN as a Bearer token.")
        if (noAdmin) return reply.redirect("/setup")
        const next = safeNext(request.url)
        return reply.redirect(next === null || next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`)
    }
}

declare module "fastify" {
    interface FastifyRequest {
        /** the logged-in admin (ACC-5); null with the login off, on open paths, or for the API token */
        adminUser: User | null
    }
}
