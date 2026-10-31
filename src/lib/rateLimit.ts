import type { FastifyInstance, FastifyServerOptions } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";

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
    /** mutating `/api/*` routes (admin server only) */
    adminWrite?: number
}

const defaultWindowMs = 60_000

/** Static files the client downloads by the thousand (game assets, web assets) are never limited. */
const unlimitedPrefixes = ["/patch/Live/2.0.0", "/public/"]

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
        gacha: readCount("RATE_LIMIT_GACHA", 60)
    }
}

/** Limits for the admin server from the environment; `undefined` when `RATE_LIMIT=0`. */
export function adminRateLimitFromEnv(): RateLimitOptions | undefined {
    if (process.env.RATE_LIMIT === "0") return undefined
    return {
        windowMs: readCount("RATE_LIMIT_WINDOW_MS", defaultWindowMs) || defaultWindowMs,
        global: readCount("RATE_LIMIT_ADMIN", 300),
        adminWrite: readCount("RATE_LIMIT_ADMIN_WRITE", 30)
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

function routeGroup(method: string, url: string): "login" | "signup" | "gacha" | "adminWrite" | undefined {
    if (url.startsWith("/openapi/service/") && (url.includes("/auth/") || url.includes("/accessToken/") || url.includes("/zat/")))
        return "login"
    if (url === "/latest/api/index.php/tool/signup") return "signup"
    if (url === "/latest/api/index.php/gacha/exec" || url === "/latest/api/index.php/box_gacha/exec"
        || url.startsWith("/latest/api/index.php/gacha/exchange_"))
        return "gacha"
    if (url.startsWith("/api/") && method !== "GET" && method !== "HEAD")
        return "adminWrite"
    return undefined
}

/**
 * Registers `@fastify/rate-limit` with a per-IP limit on every route and stricter per-route limits
 * (via `config.rateLimit`) for login, signup, gacha and admin writes. Call it before registering routes.
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
            const max = group === undefined ? undefined : options[group]
            if (!max) continue
            route.config = { ...route.config, rateLimit: { max, timeWindow } }
        }
    })

    fastify.register(fastifyRateLimit, {
        global: true,
        max: options.global === 0 ? Number.MAX_SAFE_INTEGER : options.global,
        timeWindow,
        allowList: (request) => unlimitedPrefixes.some(prefix => request.url.startsWith(prefix))
    })
}
