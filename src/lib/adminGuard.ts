/**
 * Browser-facing protection for the admin listener (SEC-10). The admin site has no login yet (ACC-5), so what
 * keeps it to its operator is the bind address (SEC-1). These hooks stop a web page the operator visits from using
 * their browser against it:
 * - Host check: a request must name the server by an IP address, `localhost`, or a name in `ADMIN_ALLOWED_HOSTS`
 *   (comma-separated), so a DNS-rebinding page (attacker name → 127.0.0.1) can't read or change anything;
 * - CSRF: a state-changing request (anything but GET/HEAD/OPTIONS) from a browser must come from the admin site
 *   itself (`Sec-Fetch-Site`, or `Origin` on browsers without it). Requests without either header are not from a
 *   browser form or fetch (curl, scripts, tests) and pass;
 * - `@fastify/helmet` headers with a CSP that allows only the site's own scripts, forms and frames.
 * There are no cookies yet; portal sessions (ACC-2) must be `Secure`, `HttpOnly` and `SameSite`.
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import { isIP } from "net";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"])

function allowedHostsFromEnv(): Set<string> {
    return new Set((process.env.ADMIN_ALLOWED_HOSTS ?? "").split(",").map(host => host.trim().toLowerCase()).filter(host => host !== ""))
}

/** The host name without port and IPv6 brackets. */
function hostName(host: string): string {
    const bracketed = host.match(/^\[([^\]]+)\]/)
    if (bracketed) return bracketed[1]
    return host.replace(/:\d+$/, "").toLowerCase()
}

export function isAllowedAdminHost(host: string | undefined, allowed: Set<string> = allowedHostsFromEnv()): boolean {
    if (!host) return false
    const name = hostName(host)
    return isIP(name) !== 0 || name === "localhost" || allowed.has(name)
}

/** Whether a state-changing request comes from the admin site itself, or not from a browser at all. */
export function isSameSiteRequest(request: FastifyRequest): boolean {
    const fetchSite = request.headers["sec-fetch-site"]
    if (typeof fetchSite === "string") return fetchSite === "same-origin" || fetchSite === "none"
    const origin = request.headers.origin
    if (origin === undefined) return true
    try {
        return new URL(origin).host === request.headers.host
    } catch {
        return false // "null" (sandboxed frames, file://) and garbage
    }
}

function forbid(reply: FastifyReply, message: string) {
    return reply.status(403).type("application/json").send({ error: "Forbidden", message })
}

/** Registers the host check, the CSRF check and the security headers. Call it before registering routes. */
export function registerAdminGuard(fastify: FastifyInstance) {
    const allowedHosts = allowedHostsFromEnv()

    fastify.addHook("onRequest", async (request, reply) => {
        // the raw Host header, never X-Forwarded-Host
        if (!isAllowedAdminHost(request.headers.host, allowedHosts))
            return forbid(reply, "Unknown host. Open the admin site by IP address or localhost, or add the name to ADMIN_ALLOWED_HOSTS.")
        if (!safeMethods.has(request.method) && !isSameSiteRequest(request))
            return forbid(reply, "Cross-site request refused.")
    })

    fastify.register(helmet, {
        contentSecurityPolicy: {
            directives: {
                "default-src": ["'self'"],
                "script-src": ["'self'"],
                "script-src-attr": ["'none'"],
                // the templates use a few style="" attributes
                "style-src": ["'self'", "'unsafe-inline'"],
                "img-src": ["'self'", "data:"],
                "font-src": ["'self'"],
                "connect-src": ["'self'"],
                "form-action": ["'self'"],
                "frame-ancestors": ["'none'"],
                "base-uri": ["'self'"],
                "object-src": ["'none'"],
                // the admin site is plain HTTP on a private address
                "upgrade-insecure-requests": null
            }
        },
        strictTransportSecurity: false,
        // helmet's default no-referrer makes browsers send `Origin: null` on the site's own form posts, and over plain
        // HTTP on a LAN address they send no Sec-Fetch-Site either, so the CSRF check would refuse every form
        referrerPolicy: { policy: "same-origin" }
    })
}
