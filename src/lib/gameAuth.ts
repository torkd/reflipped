// Authentication for the game API (`/latest/api/index.php/*`).
//
// Every game route is authenticated by `gameAuthPreHandler` unless it opts out with
// `{ config: { gameAuth: "none" } }`. The client identifies itself by `viewer_id` in the request body;
// the hook resolves it to a live viewer session and the account's player and exposes them as
// `request.viewer`, so route handlers don't look sessions up themselves.
//
// The hook also checks the request signature the client sends with every game request (SEC-3,
// docs/apk-analysis.md "Request signing"): `PARAM = sha1(UDID + viewer_id + path + raw body)` and
// `GAME-APP-ID = viewer_id`. The UDID comes from the viewer session, bound at `tool/signup` and `/load`,
// so a viewer ID alone no longer authenticates. `PARAM_CHECK` picks what a failure does: `enforce` (the
// default: reject with 403), `log` (let it through with a warning) or `off`.

import { createHash, timingSafeEqual } from "crypto";
import { FastifyReply, FastifyRequest } from "fastify";
import { Session, SessionType } from "../data/types";
import { getAccountPlayers, getSession, updateSessionExpirySync, VIEWER_SESSION_TTL_MS, viewerSessionExpiry } from "../data/wdfpData";

/** `"viewer"` (the default) requires a live viewer session; `"none"` skips the check. */
export type GameAuthMode = "viewer" | "none"

/** What a game request with a missing or wrong signature gets: `log` lets it through with a warning, `enforce` rejects it. */
export type ParamCheckMode = "off" | "log" | "enforce"

/** The authenticated caller of a game route. */
export interface GameViewer {
    viewerId: number
    accountId: number
    playerId: number
}

declare module "fastify" {
    interface FastifyContextConfig {
        gameAuth?: GameAuthMode
    }

    interface FastifyRequest {
        /** Set by `gameAuthPreHandler`; only read it in routes that don't opt out of game auth. */
        viewer: GameViewer
        /** The game request body as sent (base64 msgpack), kept by the body parser for the `PARAM` check. */
        rawBody: string | null
    }
}

/** A session used within this window of its last renewal is not renewed again, to avoid a write per request. */
const RENEW_AFTER_MS = 60 * 60 * 1000

/** Slides a viewer session's expiry forward if it was last renewed more than an hour ago. */
export function renewViewerSession(session: Session) {
    if (session.expires.getTime() - Date.now() > VIEWER_SESSION_TTL_MS - RENEW_AFTER_MS) return
    session.expires = viewerSessionExpiry()
    updateSessionExpirySync(session.token, session.expires)
}

/** Parses a `viewer_id` body field, returning null unless it's a positive integer. */
export function parseViewerId(value: unknown): number | null {
    const viewerId = Number(value)
    return Number.isSafeInteger(viewerId) && viewerId > 0 ? viewerId : null
}

/** Reads `PARAM_CHECK`; unset or unknown means `enforce`, so a typo can't turn the check off. */
export function paramCheckModeFromEnv(value = process.env.PARAM_CHECK): ParamCheckMode {
    return value === "off" || value === "log" ? value : "enforce"
}

/** The `PARAM` header the client sends: `sha1_hex(UDID + viewer_id + path + raw body)`, path like `/latest/api/index.php/load`. */
export function computeRequestParam(udid: string, viewerId: number | string, path: string, rawBody: string): string {
    return createHash("sha1").update(udid + viewerId + path + rawBody).digest("hex")
}

/** Returns the header's value if it was sent exactly once. */
function singleHeader(value: string | string[] | undefined): string | undefined {
    return typeof value === "string" ? value : undefined
}

/** Checks a game request's `GAME-APP-ID` and `PARAM` headers against the viewer and its bound UDID; returns why it fails, or null. */
function requestSignatureFailure(request: FastifyRequest, viewerId: number, udid: string | null | undefined): string | null {
    if (!udid) return "no UDID bound to the viewer"
    if (singleHeader(request.headers["game-app-id"]) !== String(viewerId)) return "GAME-APP-ID does not match viewer_id"

    const param = singleHeader(request.headers["param"])
    if (param === undefined) return "missing PARAM"
    if (request.rawBody === null) return "no raw body"

    const expected = Buffer.from(computeRequestParam(udid, viewerId, request.url.split("?")[0], request.rawBody))
    const received = Buffer.from(param.toLowerCase())
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return "PARAM mismatch"
    return null
}

/**
 * Builds the preHandler for every game route: requires `body.viewer_id` to name an unexpired viewer session whose
 * account has a player, checks the request signature as `paramCheck` says, renews the session and sets `request.viewer`.
 */
export function createGameAuthPreHandler(paramCheck: ParamCheckMode = paramCheckModeFromEnv()) {
    return (request: FastifyRequest, reply: FastifyReply) => gameAuthPreHandler(request, reply, paramCheck)
}

async function gameAuthPreHandler(request: FastifyRequest, reply: FastifyReply, paramCheck: ParamCheckMode) {
    if (request.routeOptions.config.gameAuth === "none") return

    const viewerId = parseViewerId((request.body as { viewer_id?: unknown } | undefined)?.viewer_id)
    if (viewerId === null) return reply.status(400).send({
        "error": "Bad Request",
        "message": "Invalid request body."
    })

    const session = await getSession(String(viewerId))
    if (session === null || session.type !== SessionType.VIEWER) return reply.status(400).send({
        "error": "Bad Request",
        "message": "Invalid viewer id."
    })

    if (paramCheck !== "off") {
        const failure = requestSignatureFailure(request, viewerId, session.udid)
        if (failure !== null) {
            request.log.warn({ viewerId, reason: failure }, "game request signature check failed")
            if (paramCheck === "enforce") return reply.status(403).send({
                "error": "Forbidden",
                "message": "Invalid request signature."
            })
        }
    }

    const playerId = (await getAccountPlayers(session.accountId))[0]
    if (playerId === undefined) return reply.status(500).send({
        "error": "Internal Server Error",
        "message": "No players bound to account."
    })

    renewViewerSession(session)

    request.viewer = { viewerId, accountId: session.accountId, playerId }
}
