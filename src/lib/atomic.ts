// Atomic game API handlers (SEC-7, docs/hardening.md "Input and abuse").
//
// A handler that checks a balance, deducts it and grants something makes several writes. `atomicHandler`
// runs the whole handler in one SQLite transaction, so either every write commits or none does:
// - a thrown error (a bug, a constraint failure, a crash mid-way) rolls back and becomes the usual 500;
// - a 4xx/5xx reply rolls back too, so a handler that has already deducted a cost and then rejects the
//   request (say, an invalid reward id) leaves nothing behind.
// The handler must be synchronous. better-sqlite3 is synchronous, so while the handler runs no other
// request can interleave between its check and its write; a handler with an `await` couldn't keep that
// promise, and TypeScript rejects one here.

import { FastifyReply, FastifyRequest } from "fastify";
import { runInTransactionSync } from "../data/wdfpData";

export type SyncRouteHandler = (request: FastifyRequest, reply: FastifyReply) => FastifyReply | void

/** Wraps a synchronous route handler so its database writes are one transaction, rolled back on an error reply or throw. */
export function atomicHandler(handler: SyncRouteHandler): (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void> {
    return async (request, reply) => runInTransactionSync(
        () => handler(request, reply),
        () => reply.statusCode >= 400
    )
}
