/**
 * The multi special exchange lounges (CO-3, docs/coop-polish-spec.md §3): three players gather for a campaign, the
 * host taps Go, and each of them gets the campaign's ticket decided (status 2) and draws it with
 * `multi_special_exchange/multi_draw_ticket`. There is no battle.
 *
 * This is the HTTP side: an in-memory registry of lounges, found by id (the client's `lounge_id`), by the six-digit
 * number the host shares, or listed. Every lounge route carries `(lounge_id, advice, establisher_viewer_id)`; the
 * `advice` is a random secret handed out by `lounge/create`, so a lounge id alone doesn't let anyone in. The socket side
 * (members, ready states, Start) is src/lib/coop/loungeHub.ts. No database access here: tests import it.
 */
import { randomBytes, randomInt } from "crypto"

/** `use_case` of the exchange campaign's lounge, the only one the client has. */
export const LOUNGE_USE_CASE_MULTI_SPECIAL_EXCHANGE = 1

/** Players per lounge: the client's Go needs three, none preparing. */
export const LOUNGE_CAPACITY = 3

/** A lounge nobody opened its socket to is dropped after this long. */
export const LOUNGE_UNUSED_MS = 10 * 60_000
/** An admission (from select or restore) lets its player's socket in once within this long. */
export const LOUNGE_ADMISSION_TTL_MS = 10 * 60_000
export const MAX_LOUNGES = 2000

export interface Lounge {
    loungeId: number
    advice: string
    /** six digits the host shares, in their own namespace (not a co-op room number) */
    loungeNumber: string
    useCase: number
    campaignId: number
    hostViewerId: number
    createdAt: number
    /** the host's Go went through: every member's ticket is decided */
    started: boolean
    /** players that select or restore let in: viewer id → player id (the hub keeps who is connected) */
    members: Map<number, number>
    /** one socket handshake each, per select or restore (as co-op rooms, SEC-12) */
    admissions: Map<number, { playerId: number, expiresAt: number }>
}

export class TooManyLoungesError extends Error {}

const byId = new Map<number, Lounge>()
const byNumber = new Map<string, Lounge>()
let nextLoungeId = 1

export function createLounge(hostViewerId: number, campaignId: number, useCase = LOUNGE_USE_CASE_MULTI_SPECIAL_EXCHANGE, now = Date.now()): Lounge {
    // a host has one lounge: making another one leaves the old one
    for (const lounge of [...byId.values()]) if (lounge.hostViewerId === hostViewerId && !lounge.started) deleteLounge(lounge.loungeId)
    if (byId.size >= MAX_LOUNGES) throw new TooManyLoungesError()
    let loungeNumber: string
    do loungeNumber = String(randomInt(0, 1_000_000)).padStart(6, "0")
    while (byNumber.has(loungeNumber))
    const lounge: Lounge = {
        loungeId: nextLoungeId++, advice: randomBytes(8).toString("hex"), loungeNumber, useCase, campaignId, hostViewerId,
        createdAt: now, started: false, members: new Map(), admissions: new Map()
    }
    byId.set(lounge.loungeId, lounge)
    byNumber.set(loungeNumber, lounge)
    return lounge
}

export function getLounge(loungeId: number): Lounge | undefined {
    return byId.get(Number(loungeId))
}

/** The lounge the client names, if its advice and host match (every lounge route and the handshake send all three). */
export function findLounge(loungeId: unknown, advice: unknown, establisherViewerId: unknown): Lounge | undefined {
    const lounge = byId.get(Number(loungeId))
    if (!lounge || String(advice ?? "") !== lounge.advice) return undefined
    if (establisherViewerId !== undefined && Number(establisherViewerId) !== lounge.hostViewerId) return undefined
    return lounge
}

/** By the number the host shared; spaces and dashes are ignored, as for room numbers. */
export function getLoungeByNumber(loungeNumber: string): Lounge | undefined {
    return byNumber.get(String(loungeNumber).replace(/[\s-]/g, ""))
}

export function listLounges(): Lounge[] {
    return [...byId.values()]
}

export function deleteLounge(loungeId: number): void {
    const lounge = byId.get(loungeId)
    if (!lounge) return
    byId.delete(loungeId)
    if (byNumber.get(lounge.loungeNumber) === lounge) byNumber.delete(lounge.loungeNumber)
}

/** Lets the player's next lounge handshake in (lounge/select, lounge/restore). */
export function admitToLounge(lounge: Lounge, viewerId: number, playerId: number, now = Date.now()): void {
    lounge.members.set(viewerId, playerId)
    lounge.admissions.set(viewerId, { playerId, expiresAt: now + LOUNGE_ADMISSION_TTL_MS })
}

/** Takes the player's admission, once; null without a valid one. */
export function takeLoungeAdmission(lounge: Lounge, viewerId: number, now = Date.now()): { playerId: number } | null {
    const admission = lounge.admissions.get(viewerId)
    if (!admission) return null
    lounge.admissions.delete(viewerId)
    return admission.expiresAt >= now ? { playerId: admission.playerId } : null
}

/**
 * Drops lounges that were never used: created over LOUNGE_UNUSED_MS ago and with nobody on the socket side (`inUse`).
 * A started lounge goes once its last socket closes (the hub).
 */
export function sweepUnusedLounges(inUse: (loungeId: number) => boolean, now = Date.now()): void {
    for (const lounge of [...byId.values()]) {
        if (now - lounge.createdAt > LOUNGE_UNUSED_MS && !inUse(lounge.loungeId)) deleteLounge(lounge.loungeId)
    }
}
