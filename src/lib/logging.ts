import { randomBytes } from "crypto";
import type { FastifyError, FastifyInstance, FastifyRequest, FastifyServerOptions } from "fastify";
import { STATUS_CODES } from "http";

/**
 * Safe request logging (OPS-2): request IDs, nothing secret in the log, generic error bodies.
 *
 * - Every request gets a random ID, logged as `reqId` and returned as the `X-Request-Id` header, so a
 *   player's report or a 500 body can be matched to its log lines.
 * - The request log has the method, the URL with sensitive query values masked, the host and the client
 *   address. Bodies and headers are never logged; log objects that carry a token or save field anyway
 *   are redacted by key (`redactPaths`).
 * - A 5xx reply says only "Internal Server Error" and the request ID; the error and its stack go to the log.
 *   4xx replies keep their message (validation, rate limit), which describes the request, not the server.
 */

export const REQUEST_ID_HEADER = "x-request-id"

/** Query keys whose values are masked in logged URLs: tokens, keys, codes, signatures, device IDs. */
// `k` is a co-op room link's token (multi_invitation/join?k=)
const sensitiveQueryKey = /token|key|secret|pass|zat|zrt|code|sig|auth|session|udid|param|device|^k$/i
/** Longest URL written to the log; the rest is cut off. */
const maxLoggedUrlLength = 512

/** Keys masked wherever they appear in a log object, at the top level or one level down. */
const sensitiveKeys = [
    "token", "zat", "zrt", "accessToken", "access_token", "refreshToken", "password", "secret",
    "whiteKey", "deviceKey", "udid", "save", "saveData", "body", "headers"
]
export const redactPaths = sensitiveKeys.flatMap(key => [key, `*.${key}`])

export function genReqId(): string {
    return randomBytes(8).toString("hex")
}

/** The URL as it is logged: values of sensitive query keys masked, at most `maxLoggedUrlLength` characters. */
export function redactUrl(url: string): string {
    const queryStart = url.indexOf("?")
    let out = url
    if (queryStart !== -1) {
        const query = url.slice(queryStart + 1).split("&").map(part => {
            const eq = part.indexOf("=")
            if (eq === -1) return part
            let key = part.slice(0, eq)
            try { key = decodeURIComponent(key) } catch { /* keep the raw key */ }
            return sensitiveQueryKey.test(key) ? `${part.slice(0, eq)}=[redacted]` : part
        })
        out = `${url.slice(0, queryStart)}?${query.join("&")}`
    }
    return out.length > maxLoggedUrlLength ? out.slice(0, maxLoggedUrlLength) + "…" : out
}

/** Pino serializers for `req` and `res`, replacing Fastify's defaults. */
export const serializers = {
    req(request: FastifyRequest) {
        return {
            method: request.method,
            url: redactUrl(request.url),
            host: request.host,
            remoteAddress: request.ip
        }
    },
    res(reply: { statusCode: number }) {
        return { statusCode: reply.statusCode }
    }
}

/** Adds the serializers and redaction to a logger config; `false` (no logger) stays `false`. */
export function withSafeLogging(logger: FastifyServerOptions["logger"]): FastifyServerOptions["logger"] {
    if (logger === undefined || logger === false) return false
    const base = logger === true ? {} : logger
    return { ...base, serializers, redact: { paths: redactPaths, censor: "[redacted]" } }
}

/** Request IDs on every reply and the error handler. */
export function registerSafeErrors(fastify: FastifyInstance) {
    fastify.addHook("onRequest", (request, reply, done) => {
        reply.header(REQUEST_ID_HEADER, request.id)
        done()
    })

    fastify.setErrorHandler((error: FastifyError, request, reply) => {
        const statusCode = error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 600
            ? error.statusCode
            : 500
        if (statusCode >= 500) {
            request.log.error({ err: error }, "request failed")
            return reply.status(statusCode).type("application/json").send({
                statusCode,
                error: STATUS_CODES[statusCode] ?? "Internal Server Error",
                message: "Internal Server Error",
                requestId: request.id
            })
        }
        request.log.info({ err: { code: error.code, message: error.message } }, "request rejected")
        return reply.status(statusCode).type("application/json").send({
            statusCode,
            code: error.code,
            error: STATUS_CODES[statusCode] ?? "Error",
            message: error.message
        })
    })
}
