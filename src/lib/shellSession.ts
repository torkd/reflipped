// Native shell capability hints. These never authenticate a browser or open an admin route.
import type { FastifyRequest } from "fastify"
import { isIP } from "net"
import { getAccountsFromDeviceSecretHashSync } from "../data/wdfpData"
import { getAccountUserIdSync, getUserSync } from "../data/users"
import { deviceSecretFromBody, hashDeviceSecret } from "./deviceSecret"
import { adminAuthFromEnv } from "./adminAuth"
import { isAllowedAdminHost } from "./adminGuard"
import { isLoopbackHost } from "./rateLimit"

function localAddress(host: string): boolean {
    const name = host.replace(/^\[|\]$/g, "")
    return isLoopbackHost(name) || (isIP(name) === 4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(name))
}

/** Explicit HTTPS reverse-proxy URL, or HTTP on a private/loopback address. Never trust a request's forwarded host. */
export function shellAdminUrl(request: FastifyRequest): string | null {
    if (!adminAuthFromEnv() || process.env.ADMIN_PORT === "0") return null
    const configured = process.env.SHELL_ADMIN_URL?.trim()
    if (configured) {
        try {
            const url = new URL(configured)
            if ((url.protocol !== "https:" && !(url.protocol === "http:" && localAddress(url.hostname)))
                || url.username || url.password || url.search || url.hash) return null
            return url.href
        } catch { return null }
    }
    // Automatic hints are limited to direct LAN/localhost listeners. Public reverse proxies need an explicit URL.
    try {
        const game = new URL(`http://${request.headers.host}`)
        const host = game.hostname.replace(/^\[|\]$/g, "")
        const bind = process.env.ADMIN_HOST || "127.0.0.1"
        const port = process.env.ADMIN_PORT === undefined ? 8001 : Number(process.env.ADMIN_PORT)
        if (game.username || game.password || game.pathname !== "/" || game.search || game.hash
            || !localAddress(host) || !isAllowedAdminHost(game.hostname) || !Number.isInteger(port) || port < 1 || port > 65535
            || (isLoopbackHost(bind) && !isLoopbackHost(host))
            || (!["0.0.0.0", "::", "*"].includes(bind) && !isLoopbackHost(bind) && bind !== host)
            || port === Number(process.env.LISTEN_PORT || 8000)) return null
        game.port = String(port)
        game.pathname = "/"
        return game.href
    } catch { return null }
}

export function shellSession(request: FastifyRequest, whiteKey: unknown) {
    const secret = deviceSecretFromBody({ whiteKey })
    const accounts = secret === null ? [] : getAccountsFromDeviceSecretHashSync(hashDeviceSecret(secret))
    // Old databases may have duplicate device secrets; do not choose a privileged identity ambiguously.
    const userId = accounts.length === 1 ? getAccountUserIdSync(accounts[0].id) : null
    const user = userId === null ? null : getUserSync(userId)
    const isAdmin = user?.role === "admin"
    return { account: user !== null, isAdmin, adminUrl: isAdmin ? shellAdminUrl(request) : null }
}
