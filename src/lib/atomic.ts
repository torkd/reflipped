// Atomic game API handlers (SEC-7, docs/hardening.md "Input and abuse").
//
// A handler that checks a balance, deducts it and grants something makes several writes. `atomicHandler`
// runs the whole handler in one SQLite transaction, so either every write commits or none does:
// - a thrown error (a bug, a constraint failure, a crash mid-way) rolls back and becomes the usual 500;
// - a 4xx/5xx reply rolls back too, so a handler that has already deducted a cost and then rejects the
//   request (say, an invalid reward id) leaves nothing behind.
// The handler must be synchronous. SQLite access (src/data/sqlite.ts) is synchronous, so while the handler runs no other
// request can interleave between its check and its write; a handler with an `await` couldn't keep that
// promise, and TypeScript rejects one here.

import { FastifyReply, FastifyRequest } from "fastify";
import { runInTransactionSync } from "../data/wdfpData";

export type SyncRouteHandler = (request: FastifyRequest, reply: FastifyReply) => FastifyReply | void

/**
 * Runs writes atomically and sends the buffered response only after COMMIT succeeds. Even a deferred foreign-key
 * failure at COMMIT must become a 500, rather than a success response for writes SQLite rolled back.
 * `onRollback` restores any accompanying in-memory state on an error reply, handler throw or failed COMMIT.
 */
export function atomicHandler(handler: SyncRouteHandler, onRollback?: () => void): (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void> {
    return async (request, reply) => {
        let hasPayload = false
        let payload: unknown
        // Keep Fastify's normal reply methods and fluent chaining, but intercept send (including send called by
        // redirect). Methods run with the proxy as `this`, so a chain cannot escape the buffered reply. The real
        // reply is never marked sent until the transaction has finished; serialization and hooks still run normally.
        const buffered = new Proxy(reply, {
            get(target, key, receiver) {
                if (key === "send") return (value?: unknown) => {
                    if (hasPayload) return receiver
                    // Fastify interprets Error payloads as error responses. Raise them while the transaction is
                    // still open so its normal error handler runs after rollback, including statusCode errors.
                    if (value instanceof Error) throw value
                    payload = value
                    hasPayload = true
                    return receiver
                }
                if (key === "sent") return hasPayload || target.sent
                const value = Reflect.get(target, key, receiver)
                if (typeof value !== "function") return value
                return (...args: unknown[]) => {
                    const result = Reflect.apply(value, receiver, args)
                    return result === target ? receiver : result
                }
            }
        })
        let result: FastifyReply | void
        let rolledBack = false
        try {
            result = runInTransactionSync(
                () => handler(request, buffered),
                () => { rolledBack = reply.statusCode >= 400; return rolledBack }
            )
        } catch (error) {
            onRollback?.()
            throw error
        }
        if (rolledBack) onRollback?.()
        // Flush outside the transaction and its rollback handling: a response/serialization failure after COMMIT
        // cannot undo committed database writes or restore in-memory state to its pre-transaction value.
        if (hasPayload) return reply.send(payload)
        return result === buffered ? reply : result
    }
}
