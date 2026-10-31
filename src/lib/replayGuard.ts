// Idempotent game requests (SEC-7, docs/hardening.md "Input and abuse").
//
// The client numbers its requests: every game API body carries `api_count`, a counter the client
// raises only after a request succeeds (`/load` resets it to 1). When a request fails at the network
// level the client retries it with the same `api_count` and the same body, plus `retry_count` = the
// attempt number. So within a session, a request with the `api_count` and body of one that already
// succeeded is a retry: if the server committed the first attempt but the reply was lost, running it
// again would charge and grant twice.
//
// This guard keeps, per player, the last successful reply with the route, `api_count` and a hash of the
// body (without `retry_count`) it answered. A retry (`retry_count` > 0) that matches gets that reply again
// instead of running the handler; a retry that arrives while the first copy is still running waits for it
// and then gets its reply. A request without `retry_count` always runs: the client sends it only on a first
// attempt, and tools that send a fixed `api_count` aren't mistaken for retries. Error replies are not kept, so a request that failed runs again. `/load` forgets the player's
// entry, since the counter restarts there. The store is in memory: a restart between the commit and the
// retry loses it.

import { createHash } from "crypto";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { unpack } from "msgpackr";

/** A kept reply is only replayed this long; the client gives up retrying well before. */
const replayTtlMs = 10 * 60 * 1000
/** A first copy that runs longer than this no longer holds back its duplicates. */
const pendingTimeoutMs = 30 * 1000

interface ReplayEntry {
    route: string
    apiCount: number
    bodyHash: string
    createdAt: number
    /** set once the first copy has replied with a 2xx */
    response: { statusCode: number, contentType: string | undefined, payload: unknown } | null
    /** resolves when the first copy has finished */
    settled: Promise<void>
    settle: () => void
}

const entries = new Map<number, ReplayEntry>()
const requestEntries = new WeakMap<FastifyRequest, ReplayEntry>()

function hashBody(body: Record<string, unknown>): string {
    const { retry_count: _, ...rest } = body
    return createHash("sha256").update(JSON.stringify(rest)).digest("hex")
}

function requestKey(request: FastifyRequest): { playerId: number, route: string, apiCount: number, bodyHash: string, isRetry: boolean } | null {
    const playerId = request.viewer?.playerId
    const body = request.body
    if (typeof playerId !== "number" || isNaN(playerId) || body === null || typeof body !== "object") return null
    const apiCount = (body as Record<string, unknown>).api_count
    if (typeof apiCount !== "number" || !Number.isFinite(apiCount)) return null
    return {
        playerId,
        route: request.routeOptions.url ?? request.url,
        apiCount,
        bodyHash: hashBody(body as Record<string, unknown>),
        isRetry: Number((body as Record<string, unknown>).retry_count) > 0
    }
}

function matches(entry: ReplayEntry | undefined, key: { route: string, apiCount: number, bodyHash: string }): entry is ReplayEntry {
    return entry !== undefined
        && entry.route === key.route
        && entry.apiCount === key.apiCount
        && entry.bodyHash === key.bodyHash
        && Date.now() - entry.createdAt < replayTtlMs
}

function sendKept(reply: FastifyReply, response: NonNullable<ReplayEntry["response"]>): FastifyReply {
    if (response.contentType !== undefined) reply.header("content-type", response.contentType)
    // the root onSend hook encodes a msgpack reply again
    const payload = response.contentType === "application/x-msgpack" && typeof response.payload === "string"
        ? unpack(Buffer.from(response.payload, "base64"))
        : response.payload
    return reply.status(response.statusCode).send(payload)
}

/** Forgets the player's kept reply; `/load` calls it because the client's `api_count` restarts there. */
export function forgetReplays(playerId: number): void {
    entries.delete(playerId)
}

/**
 * Adds the replay guard to the game API plugin. Register it after the game auth preHandler, which
 * sets `request.viewer`; routes without a viewer (`gameAuth: "none"`) are not guarded.
 */
export function registerReplayGuard(api: FastifyInstance): void {
    api.addHook("preHandler", async (request, reply) => {
        const key = requestKey(request)
        if (key === null) return

        let entry = key.isRetry ? entries.get(key.playerId) : undefined
        if (matches(entry, key) && entry.response === null && Date.now() - entry.createdAt < pendingTimeoutMs) {
            // the first copy is still running: wait for it
            await Promise.race([entry.settled, new Promise(resolve => setTimeout(resolve, pendingTimeoutMs).unref())])
            entry = entries.get(key.playerId)
        }
        if (matches(entry, key) && entry.response !== null) {
            request.log.info({ route: key.route, apiCount: key.apiCount }, "replayed a repeated game request")
            return sendKept(reply, entry.response)
        }

        let settle!: () => void
        const settled = new Promise<void>(resolve => { settle = resolve })
        const fresh: ReplayEntry = { route: key.route, apiCount: key.apiCount, bodyHash: key.bodyHash, createdAt: Date.now(), response: null, settled, settle }
        entries.set(key.playerId, fresh)
        requestEntries.set(request, fresh)
    })

    // onSend, not preSerialization: Fastify skips preSerialization for a non-JSON content type. The root
    // onSend hook (src/app.ts) has already encoded a msgpack reply by now, so `sendKept` decodes it again.
    api.addHook("onSend", async (request, reply, payload) => {
        const entry = requestEntries.get(request)
        if (entry !== undefined && reply.statusCode >= 200 && reply.statusCode < 300) {
            const contentType = reply.getHeader("content-type")
            entry.response = { statusCode: reply.statusCode, contentType: typeof contentType === "string" ? contentType : undefined, payload }
            // a request this one made meanwhile (fastify.inject) may have taken the slot
            entries.set(request.viewer.playerId, entry)
        }
        return payload
    })

    api.addHook("onResponse", async (request) => {
        const entry = requestEntries.get(request)
        if (entry === undefined) return
        requestEntries.delete(request)
        const playerId = request.viewer.playerId
        if (entry.response === null && entries.get(playerId) === entry) entries.delete(playerId)
        entry.settle()
    })
}
