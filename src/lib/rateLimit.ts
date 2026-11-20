import type { FastifyInstance, FastifyServerOptions } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { isIP } from "net";

/** Requests allowed per IP per window. 0 or undefined for a group means no stricter limit. */
export interface RateLimitOptions {
    /** window length in ms (default 60 000) */
    windowMs?: number
    /** every route of the server (0 = unlimited) */
    global: number
    /** openapi login/token routes (game server only) */
    login?: number
    /** `tool/signup` (game server only) */
    signup?: number
    /** gacha draw routes (game server only) */
    gacha?: number
    /** the portal's POSTs: login, TOTP code, register, password (game server only) */
    portal?: number
    /** mutating `/api/*` routes (admin server only) */
    adminWrite?: number
    /** the admin site's login, TOTP code and first-admin setup (admin server only) */
    adminLogin?: number
    /** the admin site's catalogue images, thumbnails and sprite sheet (admin server only; default 3000) */
    adminImages?: number
}

const defaultWindowMs = 60_000

/** Static files the client downloads by the thousand (game assets, web assets) are never limited. */
const unlimitedPrefixes = ["/patch/Live/2.0.0", "/public/"]

/** Whether a request is exempt from every rate limit (static files). */
export function isRateLimitExempt(url: string): boolean {
    return unlimitedPrefixes.some(prefix => url.startsWith(prefix))
}

/**
 * The admin site's read-only catalogue images (ADM-2: the mail picker's unit thumbnails and the item sprite sheet) get
 * their own, much higher limit instead of the global one: a cold browser cache opens hundreds at once, and a refused
 * image went missing. They keep a cap all the same.
 */
const defaultAdminImages = 3000

function readCount(name: string, fallback: number): number {
    const raw = process.env[name]
    if (raw === undefined || raw === "") return fallback
    const value = Number.parseInt(raw, 10)
    return Number.isNaN(value) || value < 0 ? fallback : value
}

/** Limits for the game server from the environment; `undefined` when `RATE_LIMIT=0`. */
export function gameRateLimitFromEnv(): RateLimitOptions | undefined {
    if (process.env.RATE_LIMIT === "0") return undefined
    return {
        windowMs: readCount("RATE_LIMIT_WINDOW_MS", defaultWindowMs) || defaultWindowMs,
        global: readCount("RATE_LIMIT_GLOBAL", 600),
        login: readCount("RATE_LIMIT_LOGIN", 20),
        signup: readCount("RATE_LIMIT_SIGNUP", 10),
        gacha: readCount("RATE_LIMIT_GACHA", 60),
        portal: readCount("RATE_LIMIT_PORTAL", 10)
    }
}

/** Limits for the admin server from the environment; `undefined` when `RATE_LIMIT=0`. */
export function adminRateLimitFromEnv(): RateLimitOptions | undefined {
    if (process.env.RATE_LIMIT === "0") return undefined
    return {
        windowMs: readCount("RATE_LIMIT_WINDOW_MS", defaultWindowMs) || defaultWindowMs,
        global: readCount("RATE_LIMIT_ADMIN", 300),
        adminWrite: readCount("RATE_LIMIT_ADMIN_WRITE", 30),
        adminLogin: readCount("RATE_LIMIT_ADMIN_LOGIN", 10),
        adminImages: readCount("RATE_LIMIT_ADMIN_IMAGES", defaultAdminImages)
    }
}

/** `TRUST_PROXY` for Fastify's `trustProxy`: unset = false, `true`, a hop count, or an address/CIDR list. */
export function trustProxyFromEnv(): NonNullable<FastifyServerOptions["trustProxy"]> {
    const raw = process.env.TRUST_PROXY?.trim()
    if (!raw || raw === "false") return false
    if (raw === "true") return true
    if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10) as unknown as string // Fastify accepts a hop count; its typings omit it
    return raw.split(",").map(entry => entry.trim()).filter(entry => entry !== "")
}

/** Whether a listen address only takes connections from this machine (`localhost`, 127.0.0.0/8, `::1`). */
export function isLoopbackHost(host: string): boolean {
    const address = host.trim().replace(/^\[|\]$/g, "").toLowerCase()
    if (address === "localhost" || address === "::1") return true
    return isIP(address) === 4 && address.startsWith("127.")
}

/** The eight 16-bit groups of an IPv6 address, or null if it isn't one. */
function ipv6Groups(address: string): number[] | null {
    if (isIP(address) !== 6) return null
    let text = address.split("%")[0]
    // a dotted IPv4 tail (::ffff:1.2.3.4) as two groups
    const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
    if (dotted !== null) {
        const [a, b, c, d] = dotted[2].split(".").map(Number)
        text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
    }
    const [head, tail] = text.includes("::") ? text.split("::") : [text, undefined]
    const left = head === "" ? [] : head.split(":")
    const right = tail === undefined || tail === "" ? [] : tail.split(":")
    const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    return groups.length === 8 ? groups.map(group => Number.parseInt(group, 16)) : null
}

/**
 * The rate-limit bucket of a client address (SEC-16): an IPv4 address as is (also when IPv4-mapped), an IPv6 address
 * by its /64 prefix. A phone or a home connection gets a whole /64 and picks addresses inside it freely, so a bucket
 * per IPv6 address would let one client spread over unlimited buckets.
 */
export function rateLimitKey(ip: string): string {
    const groups = ipv6Groups(ip)
    if (groups === null) return ip
    const mapped = groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff
    if (mapped) return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".")
    return `${groups.slice(0, 4).map(group => group.toString(16)).join(":")}::/64`
}

type RouteGroup = "login" | "signup" | "gacha" | "portal" | "adminWrite" | "adminLogin" | "adminImages"

function routeGroup(method: string, url: string): RouteGroup | undefined {
    if (url.startsWith("/openapi/service/") && (url.includes("/auth/") || url.includes("/accessToken/") || url.includes("/zat/")))
        return "login"
    if (url === "/latest/api/index.php/tool/signup") return "signup"
    if (url === "/latest/api/index.php/gacha/exec" || url === "/latest/api/index.php/box_gacha/exec"
        || url.startsWith("/latest/api/index.php/gacha/exchange_"))
        return "gacha"
    if (url.startsWith("/portal/") && method === "POST") return "portal"
    if ((url.startsWith("/api/catalog/thumbnail/") || url === "/api/catalog/sheet") && (method === "GET" || method === "HEAD"))
        return "adminImages"
    if (url.startsWith("/api/") && method !== "GET" && method !== "HEAD")
        return "adminWrite"
    // only the admin server has these routes
    if ((url === "/login" || url === "/login/totp" || url === "/setup") && method === "POST") return "adminLogin"
    return undefined
}

/**
 * Registers `@fastify/rate-limit` with a per-IP limit on every route and stricter per-route limits
 * (via `config.rateLimit`) for login, signup, gacha, the portal's POSTs, admin writes and the admin login. Call it before registering routes.
 * Over the limit the client gets a 429 with the plugin's small JSON body.
 */
export function registerRateLimit(fastify: FastifyInstance, options: RateLimitOptions | undefined) {
    if (!options) return
    const timeWindow = options.windowMs ?? defaultWindowMs

    // runs before the plugin's own onRoute hook, which reads config.rateLimit
    fastify.addHook("onRoute", (route) => {
        const methods = Array.isArray(route.method) ? route.method : [route.method]
        for (const method of methods) {
            const group = routeGroup(method, route.url)
            const max = group === undefined ? undefined
                : group === "adminImages" ? options.adminImages ?? defaultAdminImages : options[group]
            if (!max) continue
            route.config = { ...route.config, rateLimit: { max, timeWindow } }
        }
    })

    fastify.register(fastifyRateLimit, {
        global: true,
        max: options.global === 0 ? Number.MAX_SAFE_INTEGER : options.global,
        timeWindow,
        // a request over a Unix socket (the server on the phone) has no address
        keyGenerator: (request) => rateLimitKey(request.ip ?? "local"),
        allowList: (request) => isRateLimitExempt(request.url)
    })
}
