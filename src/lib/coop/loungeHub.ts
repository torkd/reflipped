/**
 * The socket side of the multi special exchange lounge (`multi_special_exchange_socklet`, CO-3,
 * docs/coop-polish-spec.md §3.3). It shares the co-op socket's port and framing (src/lib/coop/socketServer.ts hands it
 * every connection whose handshake names this socklet); enums are in index form.
 *
 * - Handshake C→S `{socklet, viewerId, useCase, loungeId, advice, establisherViewerId}`; S→C `[0, id, loungeId]`
 *   Accept, `[1, key]` Denied.
 * - C→S `[0, [n, …]]`: 0 Enter(detail), 1 Heartbeat, 2 Log, 3 Ready([s]), 4 Start (the host's Go), 5 Suspend, 6 Bye.
 * - S→C `[1, [n, …]]`: 0 StateChanged(viewerId, [s]), 1 Disbanded(key), 2 RemainingTime, 3 Welcome(details),
 *   4 Mates(details), 5 Start, 6 StartError, 7 AckHeartbeat(viewerId).
 *
 * Rules the client sets: a lounge holds three, Go needs all three and none preparing, every member readies itself on
 * entering, a second Welcome on one connection makes the client leave, and 30 s without an AckHeartbeat drops it.
 * `StartError` other than NOT_ENOUGH crashes the client, so it is never sent. No database access here: deciding the
 * tickets on Start is `onStart` (src/lib/multiSpecialExchangeLounge.ts, passed by src/server.ts).
 */
import type net from "net"
import { deleteLounge, findLounge, getLounge, Lounge, LOUNGE_CAPACITY, takeLoungeAdmission } from "./lounges"

const HandshakeResult = { Accept: 0, Denied: 1, Exception: 2 }
const LoungeServer2Client = { Error: 0, Message: 1 }
const LoungeNotify = { Enter: 0, Heartbeat: 1, Log: 2, Ready: 3, Start: 4, Suspend: 5, Bye: 6 }
const LoungeServerMessage = {
    StateChanged: 0, Disbanded: 1, RemainingTime: 2, Welcome: 3, Mates: 4, Start: 5, StartError: 6, AckHeartbeat: 7
}
/** StartError(NOT_ENOUGH): the client's "not enough players" dialog; the API and INVALID variants crash it */
const START_ERROR_NOT_ENOUGH = [1]
const READY_STATE_READY = 1

type Json = any

/** What the hub needs of a socket server connection. */
export interface LoungePeer {
    id: number
    socket: net.Socket
    send(value: Json, quiet?: boolean): void
}

interface Member {
    viewerId: number
    playerId: number
    peer: LoungePeer
    /** the PlayerDetail without its ready state and viewer id; null until Enter */
    detail: Json | null
    ready: boolean
    /** Enter on the current connection answered with its one Welcome */
    entered: boolean
    suspendedAt?: number
    graceTimer?: NodeJS.Timeout
}

interface LoungeState {
    lounge: Lounge
    /** by viewer id, in order of entry; the host first once it is in */
    members: Map<number, Member>
    /** after Start: drop the lounge even if a socket stays open */
    disbandTimer?: NodeJS.Timeout
}

export interface LoungeStartMember { viewerId: number, playerId: number }

export interface LoungeHubOptions {
    log: (line: string) => void
    /** like the lobby's resume grace (ms); 0 removes a member at once */
    resumeGraceMs: () => number
    /**
     * Decides every member's ticket (status 2) when the host's Go goes through; false (or a throw) refuses the start,
     * which the host sees as "not enough players". Without it the start just goes through (tests).
     */
    onStart?: (lounge: Lounge, members: LoungeStartMember[]) => boolean
}

/** The client's own `lounge_auto_disband_delay` (master data `config/room_config`): a started lounge goes after it. */
export const LOUNGE_STARTED_TTL_MS = 60_000
const NAME_MAX = 32

export class LoungeHub {
    private states = new Map<number, LoungeState>()
    private peerState = new WeakMap<LoungePeer, { state: LoungeState, viewerId: number }>()

    constructor(private options: LoungeHubOptions) {}

    /** Players on the lounge's socket, away ones included (the slots they hold). */
    memberCount(loungeId: number): number {
        return this.states.get(loungeId)?.members.size ?? 0
    }

    /** Whether the viewer holds a slot in the lounge's socket side. */
    isMember(loungeId: number, viewerId: number): boolean {
        return this.states.get(loungeId)?.members.has(viewerId) ?? false
    }

    /** The host's PlayerDetail as it entered, for the lounge list. */
    hostDetail(loungeId: number): Json | null {
        const state = this.states.get(loungeId)
        return state?.members.get(state.lounge.hostViewerId)?.detail ?? null
    }

    inUse(loungeId: number): boolean {
        return this.states.has(loungeId)
    }

    /** AckHeartbeat to every entered member (the socket server's keepalive round). */
    ackAll() {
        for (const state of this.states.values()) {
            for (const member of state.members.values()) {
                if (!member.entered || member.suspendedAt !== undefined) continue
                member.peer.send([LoungeServer2Client.Message, [LoungeServerMessage.AckHeartbeat, member.viewerId]], true)
            }
        }
    }

    close() {
        for (const state of this.states.values()) this.forget(state)
    }

    private deny(peer: LoungePeer, key: string) {
        this.options.log(`[lounge] #${peer.id} denied: ${key}`)
        peer.send([HandshakeResult.Denied, key])
        peer.socket.end()
    }

    handshake(peer: LoungePeer, command: Json) {
        const viewerId = Number(command?.viewerId)
        const lounge = findLounge(command?.loungeId, command?.advice, command?.establisherViewerId)
        if (!lounge) return this.deny(peer, "multibattle_room_not_found")
        const admission = Number.isSafeInteger(viewerId) && viewerId > 0 ? takeLoungeAdmission(lounge, viewerId) : null
        if (admission === null) {
            this.options.log(`[lounge] #${peer.id} no admission to lounge ${lounge.loungeId} for viewer ${command?.viewerId}`)
            return this.deny(peer, "multibattle_room_not_found")
        }
        if (lounge.started) return this.deny(peer, "multibattle_room_already_started")
        const state = this.stateFor(lounge)
        const existing = state.members.get(viewerId)
        if (existing) {
            // back from the background (lounge/restore, then a fresh handshake), or a stale connection: same slot
            if (existing.graceTimer !== undefined) clearTimeout(existing.graceTimer)
            existing.graceTimer = undefined
            existing.suspendedAt = undefined
            const old = existing.peer
            this.peerState.delete(old)
            if (old !== peer && !old.socket.destroyed) old.socket.destroy()
            existing.peer = peer
            existing.entered = false
            this.options.log(`[lounge] lounge ${lounge.loungeId}: ${viewerId} is back`)
        } else {
            if (state.members.size >= LOUNGE_CAPACITY) return this.deny(peer, "multibattle_room_filled")
            state.members.set(viewerId, { viewerId, playerId: admission.playerId, peer, detail: null, ready: false, entered: false })
        }
        this.peerState.set(peer, { state, viewerId })
        peer.send([HandshakeResult.Accept, String(viewerId), lounge.loungeId])
    }

    receive(peer: LoungePeer, message: Json) {
        const own = this.peerState.get(peer)
        const member = own?.state.members.get(own.viewerId)
        if (!own || !member || member.peer !== peer) return
        const { state } = own
        const [kind, body] = Array.isArray(message) ? message : []
        if (kind !== 0 || !Array.isArray(body)) return
        const [notify, ...params] = body
        switch (notify) {
            case LoungeNotify.Enter: {
                if (member.entered) break // one Welcome per connection, or the client leaves
                member.detail = playerDetail(params[0])
                member.entered = true
                const details = this.details(state)
                peer.send([LoungeServer2Client.Message, [LoungeServerMessage.Welcome, details]])
                this.toLounge(state, [LoungeServer2Client.Message, [LoungeServerMessage.Mates, details]], member.viewerId)
                break
            }
            case LoungeNotify.Heartbeat:
                peer.send([LoungeServer2Client.Message, [LoungeServerMessage.AckHeartbeat, member.viewerId]], true)
                break
            case LoungeNotify.Ready: {
                const ready = Array.isArray(params[0]) && params[0][0] === READY_STATE_READY
                member.ready = ready
                this.toLounge(state, [LoungeServer2Client.Message, [LoungeServerMessage.StateChanged, member.viewerId, [ready ? 1 : 0]]])
                break
            }
            case LoungeNotify.Start:
                this.start(state, member)
                break
            case LoungeNotify.Suspend:
                this.suspend(state, member, "Suspend")
                break
            case LoungeNotify.Bye:
                this.peerState.delete(peer)
                this.leave(state, member)
                break
            case LoungeNotify.Log:
                break
            default:
                this.options.log(`[lounge] #${peer.id} unhandled notify ${notify}`)
        }
    }

    disconnect(peer: LoungePeer) {
        const own = this.peerState.get(peer)
        if (!own) return
        this.peerState.delete(peer)
        const member = own.state.members.get(own.viewerId)
        if (!member || member.peer !== peer) return
        if (this.suspend(own.state, member, "connection closed")) return
        this.leave(own.state, member)
    }

    // --- internals ------------------------------------------------------------------------------

    private start(state: LoungeState, member: Member) {
        const lounge = state.lounge
        if (member.viewerId !== lounge.hostViewerId || lounge.started) {
            this.options.log(`[lounge] lounge ${lounge.loungeId}: Start from ${member.viewerId} ignored`)
            return
        }
        const members = [...state.members.values()]
        const everyone = members.length >= LOUNGE_CAPACITY
            && members.every(m => m.entered && m.suspendedAt === undefined && (m.ready || m.viewerId === lounge.hostViewerId))
        let decided = everyone
        if (everyone && this.options.onStart) {
            try {
                decided = this.options.onStart(lounge, members.map(m => ({ viewerId: m.viewerId, playerId: m.playerId })))
            } catch (error) {
                this.options.log(`[lounge] lounge ${lounge.loungeId}: deciding the tickets failed: ${(error as Error).stack ?? error}`)
                decided = false
            }
        }
        if (!decided) {
            member.peer.send([LoungeServer2Client.Message, [LoungeServerMessage.StartError, START_ERROR_NOT_ENOUGH]])
            return
        }
        lounge.started = true
        this.options.log(`[lounge] lounge ${lounge.loungeId}: started with ${members.map(m => m.viewerId).join(", ")}`)
        this.toLounge(state, [LoungeServer2Client.Message, [LoungeServerMessage.Start]])
        // each client closes its socket on the scene change; drop the lounge in any case after the client's own delay
        state.disbandTimer = setTimeout(() => this.forget(state), LOUNGE_STARTED_TTL_MS)
        state.disbandTimer.unref()
    }

    /** Keeps an entered member's slot while it is away; false without a grace (it leaves) or once started. */
    private suspend(state: LoungeState, member: Member, reason: string): boolean {
        if (!member.entered || state.lounge.started) return false
        if (member.suspendedAt !== undefined) return true
        const ms = this.options.resumeGraceMs()
        if (ms <= 0) return false
        member.suspendedAt = Date.now()
        member.graceTimer = setTimeout(() => {
            member.graceTimer = undefined
            if (state.members.get(member.viewerId) === member && member.suspendedAt !== undefined) this.leave(state, member)
        }, ms)
        member.graceTimer.unref()
        this.options.log(`[lounge] lounge ${state.lounge.loungeId}: ${member.viewerId} is away (${reason}), keeping its slot ${Math.round(ms / 1000)} s`)
        return true
    }

    /** A member leaves; before the start a host takes the lounge with it. */
    private leave(state: LoungeState, member: Member) {
        if (member.graceTimer !== undefined) clearTimeout(member.graceTimer)
        state.members.delete(member.viewerId)
        const lounge = state.lounge
        if (!lounge.started && member.viewerId === lounge.hostViewerId) {
            this.options.log(`[lounge] lounge ${lounge.loungeId}: its host left, disbanding it`)
            this.toLounge(state, [LoungeServer2Client.Message, [LoungeServerMessage.Disbanded, "multibattle_room_dismissed"]], undefined, true)
            this.forget(state)
            return
        }
        if (state.members.size === 0) {
            // an empty lounge that hasn't started stays for its host's restore until it goes unused (lounges.ts)
            if (lounge.started) this.forget(state)
            else this.states.delete(lounge.loungeId)
            return
        }
        if (!lounge.started) this.toLounge(state, [LoungeServer2Client.Message, [LoungeServerMessage.Mates, this.details(state)]])
    }

    private forget(state: LoungeState) {
        if (state.disbandTimer !== undefined) clearTimeout(state.disbandTimer)
        for (const member of state.members.values()) if (member.graceTimer !== undefined) clearTimeout(member.graceTimer)
        if (this.states.get(state.lounge.loungeId) === state) this.states.delete(state.lounge.loungeId)
        if (getLounge(state.lounge.loungeId) === state.lounge) deleteLounge(state.lounge.loungeId)
    }

    private stateFor(lounge: Lounge): LoungeState {
        let state = this.states.get(lounge.loungeId)
        if (!state || state.lounge !== lounge) {
            state = { lounge, members: new Map() }
            this.states.set(lounge.loungeId, state)
        }
        return state
    }

    /**
     * Every member that entered (away ones too: their slot is kept), the host first. The host is always Ready, as in
     * the room lobby: its client never sends Ready([1]) and keeps Go disabled while any mate is Preparing (CO-9).
     */
    private details(state: LoungeState): Json[] {
        const hostViewerId = state.lounge.hostViewerId
        const members = [...state.members.values()].filter(m => m.detail !== null)
        members.sort((a, b) => Number(b.viewerId === hostViewerId) - Number(a.viewerId === hostViewerId))
        return members.map(m => ({ ...m.detail, readyState: [m.ready || m.viewerId === hostViewerId ? 1 : 0], viewerId: m.viewerId }))
    }

    /** To every connected member that entered; `toEntering` also to those still before their Welcome. */
    private toLounge(state: LoungeState, value: Json, exceptViewerId?: number, toEntering = false) {
        for (const member of state.members.values()) {
            if (member.viewerId === exceptViewerId || member.suspendedAt !== undefined || (!member.entered && !toEntering)) continue
            member.peer.send(value)
        }
    }
}

/** The PlayerDetail fields the client sends in Enter, typed and bounded; the others see them as they are. */
function playerDetail(sent: Json): Json {
    const int = (value: unknown) => Number.isSafeInteger(Number(value)) ? Number(value) : 0
    return {
        characterId: int(sent?.characterId),
        degreeId: int(sent?.degreeId),
        evolutionLevel: int(sent?.evolutionLevel),
        name: typeof sent?.name === "string" ? sent.name.slice(0, NAME_MAX) : "",
        rank: int(sent?.rank)
    }
}
