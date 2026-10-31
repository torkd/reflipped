/**
 * Co-op realtime socket server ("socklet").
 *
 * Protocol (docs/coop-research.md, message types in docs/coop-protocol.md):
 * - TCP; every message is a UTF-8 JSON value terminated by a NUL byte (Flash XMLSocket).
 * - The first client message is a plain handshake object with `socklet` = "cooperation_room"
 *   (lobby, "meeting") or "cooperation_battle". The reply is a `HandshakeResult` enum.
 * - Everything after that is TypePacker JSON in index mode: an enum value is `[index, ...args]`.
 * - The server is a relay: the lobby keeps member state; in battle it stamps a battle-wide order
 *   number on every broadcast command and fans it out (lockstep). It never simulates the battle.
 *
 * This is the first implementation, written from static analysis only. Every message in and out is
 * logged (`[coop]`) so device runs show exactly where client and server disagree.
 */
import net from "net"
import { randomBytes } from "crypto"
import { everyoneEnded, getRoom, openRound, startRound, takeAdmission, takeBattleAdmission } from "./rooms"
import { establisherOf } from "./mates"

// --- variant indices (docs/coop-protocol.md) ---------------------------------------------------
const HandshakeResult = { Accept: 0, Denied: 1, Reconnect: 2, Exception: 3, Complete: 4 }
const Client2Server = { Notify: 0, Broadcast: 1, Send: 2 }
const MeetingServer2Client = { Error: 0, Message: 1, Messages: 2 }
const MeetingNotify = {
    Enter: 0, Bye: 1, ChangeParty: 2, Ready: 3, Heartbeat: 4, Suspend: 5, StartBattle: 6,
    ChangeAutoplayMode: 7, ChangeAutoStart: 8, Log: 9, EnterComs: 10
}
const MeetingServerMessage = {
    Welcome: 0, Mates: 1, StateChanged: 2, AutoplayModeChanged: 3, AutoStartChanged: 4, Start: 5,
    Disbanded: 6, RemainingTime: 7, Update: 8, StartRemainingTime: 9, AckHeartbeat: 10
}
const BattleServer2Client = { Error: 0, Message: 1, Messages: 2, Send: 3 }
const BattleNotify = { SceneReady: 0, Finalize: 1, Measurement: 2, LineSpeedWarning: 3, Heartbeat: 4 }
const BattleServerMessage = { Leave: 0, BattleStart: 1, Finalized: 2, Measurement: 3, LineSpeedWarning: 4 }
/** ReadyState.Ready */
const READY_STATE_READY = [1]
/**
 * PlayerRoleKind for AI companions. The host's own mate arrives with 1; the value the original
 * server used for companions is unknown (enum values aren't in the schema). Verify on a device.
 */
/**
 * playerRoleKind of AI companions. At battle start the client marks every teammate with role 99 as
 * left (without a notice) and plays it itself, so companions need no network traffic. With another
 * role the client waits for their commands, stalls, and gives up ("Lost connection to the party").
 */
const COM_PLAYER_ROLE_KIND = 99

/** Players per room, AI companions included. */
export const ROOM_CAPACITY = 3

// Limits against a single client tying the server up (SEC-12). Messages are small JSON (a lobby mate, a few battle
// commands); the client sends lobby or battle traffic, or gets a keepalive, well within the idle limit.
export const MAX_MESSAGE_BYTES = 64 * 1024
export const MAX_CONNECTIONS = 4000
export const MAX_CONNECTIONS_PER_ADDRESS = 32
export const HANDSHAKE_TIMEOUT_MS = 10_000
export const IDLE_TIMEOUT_MS = 10 * 60_000

type Json = any

interface Peer {
    socket: net.Socket
    id: number
    kind?: "meeting" | "battle"
    connectionId?: string
    roomNumber?: string
    viewerId?: number
    /** the client's IP address */
    address: string
    /** the player behind a lobby connection, from its admission (unknown for one admitted without it, as in tests) */
    playerId?: number
    /**
     * The lobby or battle this connection belongs to. A room plays one round after another (Return to Room), and a
     * slow client's socket can outlive its round, so a peer keeps its own round's objects instead of looking the room
     * up: its messages and its disconnect then never touch the next round.
     */
    lobby?: Lobby
    battle?: Battle
    /** `quiet` keeps the message out of the traffic log (periodic noise) */
    send(value: Json, quiet?: boolean): void
}

interface Lobby {
    roomNumber: string
    members: Map<string, { peer: Peer, mate: Json | null }>
    /** AI companions added by EnterComs, keyed by their synthetic connection id */
    coms: Map<string, Json>
    /** connection ids at the time the battle started; the battle waits for all of them */
    startedWith: string[] | null
    /**
     * the address of each of those members' lobby connection; their battle connection must come from it, or carry the
     * member's battle admission from its signed `start`
     */
    startedFrom: Map<string, string>
    /** the viewer id of each of those members */
    startedViewers: Map<string, number>
}

interface Battle {
    roomNumber: string
    members: Map<string, Peer>
    sceneReady: Set<string>
    finalized: Set<string>
    started: boolean
    /** Finalized went out: the battle is over for everyone in it */
    over: boolean
    /** players who connected and left again; the battle no longer waits for them */
    departed: Set<string>
    /** players still missing when the battle started without them (BATTLE_START_WAIT_MS) */
    absent: Set<string>
    startTimer: NodeJS.Timeout | null
    /** battle-wide order number stamped into the second counter of every relayed Command */
    order: number
    /** the lobby that started this battle (its round), if it was still there when the first player connected */
    lobby: Lobby | null
}

export interface CoopSocketServerOptions {
    log?: (line: string) => void
    /** also log every message (default: COOP_DEBUG=1); otherwise only connections and room events */
    traffic?: boolean
    /**
     * How often (ms) every lobby member is sent an AckHeartbeat unasked; 0 turns it off. The client drops out of the
     * room ("Connection interrupted") when 30 s pass without one, and in practice it never sends the Heartbeat that
     * would be answered. A function is read before every round (src/server.ts passes the admin setting).
     */
    keepAliveMs?: number | (() => number)
    /**
     * How long (ms) a room without its host is kept: after its battle until the host is back (Return to Room), or after
     * the host left its lobby. Then `onExpire` closes it. The host's game disbands its room itself 60 s after a battle
     * (`quest_result_room_auto_disband_delay`), so this clears rooms whose host closed the app. 0 keeps them. A function
     * is read each time the timer is armed (src/server.ts passes the admin setting).
     */
    abandonedRoomMs?: number | (() => number)
    /** Closes an abandoned room (src/lib/coop/closeRoom.ts); without it rooms are never closed by the server. */
    onExpire?: (roomNumber: string) => void
    /**
     * Rebuilds a lobby mate from the player's save (src/lib/coop/mateCheck.ts), null to refuse it; without it mates are
     * relayed as the client sends them. src/server.ts passes the save check (SEC-15).
     */
    checkMate?: (playerId: number, mate: Json) => Json | null
}

function resolveMs(value: number | (() => number)): number {
    return typeof value === "function" ? value() : value
}

export const LOBBY_KEEP_ALIVE_MS = 10_000
/**
 * How long a battle waits, after its first SceneReady, for players of its lobby who never connect (their game crashed
 * between Start and the battle): then it starts without them. Players who left the lobby with Bye are on their way.
 */
export const BATTLE_START_WAIT_MS = 20_000
/** The client's own result-screen disband delay (master data `config/room_config`, 60 s) plus 30 s of slack. */
export const ABANDONED_ROOM_MS = 90_000

export class CoopSocketServer {
    private server: net.Server
    private lobbies = new Map<string, Lobby>()
    /** each room's host mate as last entered, so the room keeps its establisher while the host is away (Return to Room) */
    private hostMates = new Map<string, Json>()
    private battles = new Map<string, Battle>()
    private nextPeerId = 1
    private connectionsPerAddress = new Map<string, number>()
    /** every open connection, also those of earlier rounds that no room map holds any more */
    private peers = new Set<Peer>()
    private log: (line: string) => void
    private traffic: boolean
    private keepAliveMs: number | (() => number)
    private keepAliveTimer: NodeJS.Timeout | null = null
    private abandonedRoomMs: number | (() => number)
    private onExpire: ((roomNumber: string) => void) | null
    private checkMate: ((playerId: number, mate: Json) => Json | null) | null
    /** rooms whose host is away, closed by onExpire unless the host comes back first */
    private expiries = new Map<string, NodeJS.Timeout>()
    private listening = false

    constructor(options: CoopSocketServerOptions = {}) {
        this.log = options.log ?? (line => console.log(line))
        this.traffic = options.traffic ?? process.env.COOP_DEBUG === "1"
        this.keepAliveMs = options.keepAliveMs ?? LOBBY_KEEP_ALIVE_MS
        this.abandonedRoomMs = options.abandonedRoomMs ?? ABANDONED_ROOM_MS
        this.onExpire = options.onExpire ?? null
        this.checkMate = options.checkMate ?? null
        this.server = net.createServer(socket => this.accept(socket))
        this.server.maxConnections = MAX_CONNECTIONS
    }

    listen(port: number, host: string): Promise<number> {
        return new Promise((resolve, reject) => {
            this.server.once("error", reject)
            this.server.listen(port, host, () => {
                this.listening = true
                if (this.keepAliveTimer === null) this.scheduleKeepAlive()
                const address = this.server.address()
                resolve(typeof address === "object" && address ? address.port : port)
            })
        })
    }

    /** Arms the next keepalive round; with an interval of 0 it looks again a second later. */
    private scheduleKeepAlive() {
        if (!this.listening) return
        const ms = resolveMs(this.keepAliveMs)
        if (ms <= 0 && typeof this.keepAliveMs !== "function") return
        this.keepAliveTimer = setTimeout(() => {
            if (ms > 0) this.ackLobbies()
            this.scheduleKeepAlive()
        }, ms > 0 ? ms : 1000)
        this.keepAliveTimer.unref()
    }

    private ackLobbies() {
        for (const lobby of this.lobbies.values()) {
            for (const member of lobby.members.values()) {
                // a member that hasn't entered yet (no Enter, so no Welcome) isn't waiting on the room's timers
                if (member.mate === null) continue
                member.peer.send([MeetingServer2Client.Message, [MeetingServerMessage.AckHeartbeat, member.peer.connectionId]], true)
            }
        }
    }

    close(): Promise<void> {
        this.listening = false
        if (this.keepAliveTimer !== null) clearTimeout(this.keepAliveTimer)
        this.keepAliveTimer = null
        for (const timer of this.expiries.values()) clearTimeout(timer)
        this.expiries.clear()
        return new Promise(resolve => {
            for (const peer of this.peers) peer.socket.destroy()
            this.server.close(() => resolve())
        })
    }

    /**
     * Adds AI companions ([{comId, degreeId, name, party (lobby format), rank}]) as ready members
     * without a socket; the host's client plays them. Broadcasts the new member list.
     */
    private addCompanions(lobby: Lobby, coms: Json[]) {
        for (const com of coms) {
            const connectionId = `com-${com.comId}`
            lobby.coms.set(connectionId, {
                allowHealFromOtherPlayers: true, autoSpeedLevel: 0, autoStart: true, autoplayMode: true,
                autoskillMode: 0, comId: com.comId, connectionId, dashBehaviorMode: 0,
                degreeId: com.degreeId, entryTime: Date.now(), name: com.name, party: com.party,
                playerRoleKind: COM_PLAYER_ROLE_KIND, rank: com.rank, skillAbilityBehaviorMode: 0,
                // The client validates every member's ViewerId (integer ≥ 1) at the end of the
                // battle and throws C5230 for 0, so give companions their comId.
                state: READY_STATE_READY, viewerId: Number(com.comId)
            })
        }
        this.toLobby(lobby, [MeetingServer2Client.Message, [MeetingServerMessage.Mates, this.mates(lobby)]])
    }

    /** The host's lobby mate: as it is in the lobby, or as it last was (null if the host never entered). */
    hostMate(roomNumber: string): Json | null {
        return this.hostMates.get(roomNumber) ?? null
    }

    /**
     * After `delayMs`, fills the room's free slots with companions from `makeCompanions(count)`,
     * unless the battle started, the client already summoned, or the room is full or gone.
     */
    scheduleCompanions(roomNumber: string, delayMs: number, makeCompanions: (count: number) => Json[], capacity = ROOM_CAPACITY) {
        const timer = setTimeout(() => {
            this.fillWithCompanions(roomNumber, makeCompanions, capacity, `after ${Math.round(delayMs / 1000)} s`)
        }, delayMs)
        timer.unref()
    }

    /**
     * Fills the room's free slots with companions from `makeCompanions(count)` now, unless the battle started, the
     * room already has companions (the client summoned), or it is full or gone. Returns how many were added.
     */
    fillWithCompanions(roomNumber: string, makeCompanions: (count: number) => Json[], capacity = ROOM_CAPACITY, reason = ""): number {
        const lobby = this.lobbies.get(roomNumber)
        if (!lobby || lobby.startedWith || lobby.coms.size > 0) return 0
        const free = capacity - lobby.members.size
        if (free <= 0) return 0
        this.log(`[coop] room ${roomNumber}: adding ${free} companion(s)${reason ? " " + reason : ""}`)
        this.addCompanions(lobby, makeCompanions(free))
        return free
    }

    /** Whether the viewer is a member of any room's lobby (so busy, not free to join another room). */
    isInLobby(viewerId: number): boolean {
        for (const lobby of this.lobbies.values()) {
            for (const member of lobby.members.values()) {
                if (member.peer.viewerId === viewerId) return true
            }
        }
        return false
    }

    /** Tells everyone still in the room's lobby that it was disbanded, then forgets the lobby. */
    disband(roomNumber: string, textKey = "multibattle_room_dismissed"): void {
        const lobby = this.lobbies.get(roomNumber)
        this.cancelExpiry(roomNumber)
        this.hostMates.delete(roomNumber)
        if (!lobby) return
        this.toLobby(lobby, [MeetingServer2Client.Message, [MeetingServerMessage.Disbanded, textKey]])
        this.forgetLobby(lobby)
    }

    /**
     * Whether the room's current round is over, so its lobby may open again: the round never started or was reopened,
     * every player reported its end over HTTP, the battle sent Finalized, or its last battle socket closed (which
     * forgets the started lobby). Between StartBattle and the battle's end it is not, also for a player who left early.
     */
    roundOver(roomNumber: string): boolean {
        const room = getRoom(roomNumber)
        if (!room?.inBattle || everyoneEnded(room)) return true
        const lobby = this.lobbies.get(roomNumber)
        if (!lobby?.startedWith) return true
        const battle = this.battles.get(roomNumber)
        return battle?.lobby === lobby && battle.over
    }

    /**
     * Opens the room again for a new round once its battle is over (Return to Room, docs/coop-research.md): the started
     * lobby is dropped, so the next lobby handshake starts a fresh one; a battle socket still open keeps its own
     * objects (Peer.battle) until it closes. Returns false, changing nothing, while the round is still being played.
     */
    reopen(roomNumber: string): boolean {
        const room = getRoom(roomNumber)
        if (!room || !this.roundOver(roomNumber)) return false
        if (room.inBattle) this.log(`[coop] room ${roomNumber}: open again after its battle`)
        openRound(room)
        const lobby = this.lobbies.get(roomNumber)
        if (lobby?.startedWith) this.forgetLobby(lobby)
        // the room waits for its host from now on, whoever opened it
        this.armExpiry(roomNumber)
        return true
    }

    /** Whether the room's host is in its current lobby. */
    private hostPresent(roomNumber: string): boolean {
        const lobby = this.lobbies.get(roomNumber)
        return lobby !== undefined && [...lobby.members.values()].some(m => this.isHost(lobby, m.peer))
    }

    /**
     * (Re)starts the abandoned-room timer: the room closes when it fires unless its host is back in the lobby by then,
     * or its battle is still running (the battle's end arms it again). Only the host's entry cancels it.
     */
    private armExpiry(roomNumber: string, restart = true) {
        if (!restart && this.expiries.has(roomNumber)) return
        this.cancelExpiry(roomNumber)
        const ms = resolveMs(this.abandonedRoomMs)
        if (ms <= 0 || this.onExpire === null || !getRoom(roomNumber) || this.hostPresent(roomNumber)) return
        const timer = setTimeout(() => {
            this.expiries.delete(roomNumber)
            if (!getRoom(roomNumber) || this.hostPresent(roomNumber) || !this.roundOver(roomNumber)) return
            this.log(`[coop] room ${roomNumber}: its host has been away ${Math.round(ms / 1000)} s, closing it`)
            this.onExpire?.(roomNumber)
        }, ms)
        timer.unref()
        this.expiries.set(roomNumber, timer)
    }

    private cancelExpiry(roomNumber: string) {
        const timer = this.expiries.get(roomNumber)
        if (timer === undefined) return
        clearTimeout(timer)
        this.expiries.delete(roomNumber)
    }

    /**
     * Whether a player can join the room's lobby: "battle" once the battle started, "filled" when
     * every slot is taken by a player (an AI companion's slot can be taken over), else "open".
     */
    joinStatus(roomNumber: string): "open" | "filled" | "battle" {
        const lobby = this.lobbies.get(roomNumber)
        if (!lobby) return "open"
        // a finished round's lobby opens again for whoever comes in first (handshake)
        if (lobby.startedWith) return this.roundOver(roomNumber) ? "open" : "battle"
        return lobby.members.size >= ROOM_CAPACITY ? "filled" : "open"
    }

    /** Members in the room's lobby, players and AI companions. */
    memberCount(roomNumber: string): number {
        const lobby = this.lobbies.get(roomNumber)
        return lobby ? lobby.members.size + lobby.coms.size : 0
    }

    /** Players connected to a room's lobby (AI companions not counted). */
    humanCount(roomNumber: string): number {
        return this.lobbies.get(roomNumber)?.members.size ?? 0
    }

    // --- connection handling --------------------------------------------------------------------

    private accept(socket: net.Socket) {
        const address = normaliseAddress(socket.remoteAddress ?? "")
        const open = this.connectionsPerAddress.get(address) ?? 0
        if (open >= MAX_CONNECTIONS_PER_ADDRESS) {
            this.log(`[coop] refused a connection from ${address}: ${open} already open`)
            socket.destroy()
            return
        }
        this.connectionsPerAddress.set(address, open + 1)
        socket.once("close", () => {
            const left = (this.connectionsPerAddress.get(address) ?? 1) - 1
            if (left > 0) this.connectionsPerAddress.set(address, left)
            else this.connectionsPerAddress.delete(address)
        })

        const peer: Peer = {
            socket,
            id: this.nextPeerId++,
            address,
            send: (value: Json, quiet?: boolean) => {
                const text = typeof value === "string" ? value : JSON.stringify(value)
                if (this.traffic && !quiet) this.log(`[coop] #${peer.id} -> ${text}`)
                socket.write(text + "\0", "utf8")
            }
        }
        this.log(`[coop] #${peer.id} connected from ${socket.remoteAddress}:${socket.remotePort}`)
        socket.setNoDelay(true)
        const handshakeTimer = setTimeout(() => {
            if (!peer.kind) {
                this.log(`[coop] #${peer.id} no handshake within ${HANDSHAKE_TIMEOUT_MS / 1000} s`)
                socket.destroy()
            }
        }, HANDSHAKE_TIMEOUT_MS)
        handshakeTimer.unref()
        socket.once("close", () => clearTimeout(handshakeTimer))
        socket.setTimeout(IDLE_TIMEOUT_MS, () => {
            this.log(`[coop] #${peer.id} idle for ${IDLE_TIMEOUT_MS / 1000} s`)
            socket.destroy()
        })
        this.peers.add(peer)

        let buffer = Buffer.alloc(0)
        socket.on("data", chunk => {
            buffer = Buffer.concat([buffer, chunk])
            if (buffer.indexOf(0) === -1 && buffer.length > MAX_MESSAGE_BYTES) {
                this.log(`[coop] #${peer.id} message over ${MAX_MESSAGE_BYTES} bytes`)
                buffer = Buffer.alloc(0)
                socket.destroy()
                return
            }
            let end: number
            while ((end = buffer.indexOf(0)) !== -1) {
                const text = buffer.subarray(0, end).toString("utf8")
                buffer = buffer.subarray(end + 1)
                if (text.length === 0) continue
                if (this.traffic) this.log(`[coop] #${peer.id} <- ${text}`)
                try {
                    this.receive(peer, text)
                } catch (error) {
                    this.log(`[coop] #${peer.id} error handling message: ${(error as Error).stack ?? error}`)
                }
            }
        })
        socket.on("close", () => {
            this.log(`[coop] #${peer.id} closed`)
            this.peers.delete(peer)
            this.disconnect(peer)
        })
        socket.on("error", error => this.log(`[coop] #${peer.id} socket error: ${error.message}`))
    }

    private receive(peer: Peer, text: string) {
        // Flash Player asks for a policy file before using a socket; AIR apps normally don't.
        if (text.startsWith("<policy-file-request")) {
            peer.send('<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*" to-ports="*"/></cross-domain-policy>')
            return
        }
        const message = JSON.parse(text)
        if (!peer.kind) return this.handshake(peer, message)
        if (peer.kind === "meeting") return this.meeting(peer, message)
        return this.battle(peer, message)
    }

    private deny(peer: Peer, textKey: string) {
        this.log(`[coop] #${peer.id} denied: ${textKey}`)
        peer.send([HandshakeResult.Denied, textKey])
        peer.socket.end()
    }

    private handshake(peer: Peer, command: Json) {
        const roomNumber = normaliseRoomNumber(String(command?.roomNumber ?? ""))
        const room = getRoom(roomNumber)
        if (!room) {
            this.log(`[coop] #${peer.id} handshake for unknown room ${roomNumber}`)
            peer.send([HandshakeResult.Denied, "multibattle_room_not_found"])
            peer.socket.end()
            return
        }
        peer.roomNumber = roomNumber

        if (command.socklet === "cooperation_room") {
            // the viewer id is the client's word: accept it only with the admission its own signed create_room,
            // select_room or restore_room just made, once (SEC-12)
            const viewerId = Number(command.viewerId)
            const admission = Number.isSafeInteger(viewerId) && viewerId > 0 ? takeAdmission(room, viewerId) : null
            if (admission === null) {
                this.log(`[coop] #${peer.id} no admission to room ${roomNumber} for viewer ${command.viewerId}`)
                return this.deny(peer, "multibattle_room_not_found")
            }
            // Back in a room whose battle is over, by any way (Return to Room, restore_room after a restart, a typed
            // number): the room opens again for its next round. While the battle runs, the lobby is closed.
            if (room.inBattle && !this.reopen(roomNumber)) return this.deny(peer, "multibattle_room_already_started")
            const existing = this.lobbies.get(roomNumber)
            if (existing && existing.members.size + existing.coms.size >= ROOM_CAPACITY) {
                // a player takes an AI companion's place; with no companion left the room is full
                const companion = [...existing.coms.keys()].pop()
                if (!companion) return this.deny(peer, "multibattle_room_filled")
                existing.coms.delete(companion)
                this.log(`[coop] room ${roomNumber}: a player replaces ${companion}`)
            }
            peer.kind = "meeting"
            peer.viewerId = viewerId
            peer.playerId = admission.playerId
            peer.connectionId = newConnectionId()
            const lobby = this.lobbyFor(roomNumber)
            if (this.isHost(lobby, peer)) this.cancelExpiry(roomNumber)
            peer.lobby = lobby
            lobby.members.set(peer.connectionId, { peer, mate: null })
            peer.send([HandshakeResult.Accept, peer.connectionId, roomNumber])
            return
        }
        if (command.socklet === "cooperation_battle") {
            // only a member the lobby started with, once, from the address of its lobby connection (SEC-12). A refused
            // battle handshake sends the player to the title screen, so a member whose address changed since the lobby
            // (Wi-Fi to mobile data, a carrier NAT handing out another address) is let in once with the battle
            // admission of its own signed `start`, which the client sends right before it connects (CO-4).
            const connectionId = String(command.connectionId ?? "")
            const lobby = this.lobbies.get(roomNumber)
            const member = lobby?.startedWith?.includes(connectionId) === true
                && !this.battles.get(roomNumber)?.members.has(connectionId)
            const sameAddress = member && lobby!.startedFrom.get(connectionId) === peer.address
            const viewerId = lobby?.startedViewers.get(connectionId)
            const movedWithAdmission = member && !sameAddress && viewerId !== undefined && takeBattleAdmission(room, viewerId)
            if (!sameAddress && !movedWithAdmission) {
                this.log(`[coop] #${peer.id} battle handshake refused for ${connectionId} in room ${roomNumber}`)
                return this.deny(peer, "multibattle_room_not_found")
            }
            if (movedWithAdmission) {
                this.log(`[coop] #${peer.id} battle connection for ${connectionId} from a new address (lobby ${lobby!.startedFrom.get(connectionId)}, now ${peer.address}), admitted by its start`)
            }
            peer.kind = "battle"
            peer.connectionId = connectionId
            const battle = this.battleFor(roomNumber)
            peer.battle = battle
            battle.members.set(peer.connectionId, peer)
            peer.send([HandshakeResult.Accept, peer.connectionId, roomNumber])
            return
        }
        this.log(`[coop] #${peer.id} unknown socklet ${command?.socklet}`)
        peer.send([HandshakeResult.Exception, `unknown socklet ${command?.socklet}`])
        peer.socket.end()
    }

    // --- lobby ("meeting") ----------------------------------------------------------------------

    private meeting(peer: Peer, message: Json) {
        const lobby = peer.lobby
        const self = lobby?.members.get(peer.connectionId!)
        if (!lobby || !self) return
        const [kind, ...args] = message

        if (kind === Client2Server.Broadcast) {
            // e.g. [Emotion(kind)] → Messages(sender, broadcasts) to the other members
            this.toLobby(lobby, [MeetingServer2Client.Messages, peer.connectionId, args[0]], peer.connectionId)
            return
        }
        if (kind === Client2Server.Send) {
            const [targets, payload] = args
            for (const target of targets ?? []) {
                lobby.members.get(String(target))?.peer.send([MeetingServer2Client.Messages, peer.connectionId, [payload]])
            }
            return
        }
        if (kind !== Client2Server.Notify) return

        const [notify, ...params] = args[0]
        switch (notify) {
            case MeetingNotify.Enter: {
                const mate = this.savedMate(peer, params[0])
                if (mate === null) return this.refuseMate(peer)
                self.mate = this.withHostReady(lobby, peer, { ...mate, connectionId: peer.connectionId })
                if (this.isHost(lobby, peer)) this.hostMates.set(lobby.roomNumber, self.mate)
                const mates = this.mates(lobby)
                peer.send([MeetingServer2Client.Message, [MeetingServerMessage.Welcome, this.roomInfo(lobby), mates]])
                this.toLobby(lobby, [MeetingServer2Client.Message, [MeetingServerMessage.Mates, mates]], peer.connectionId)
                break
            }
            case MeetingNotify.ChangeParty: {
                const mate = this.savedMate(peer, params[0])
                if (mate === null) return this.refuseMate(peer)
                self.mate = this.withHostReady(lobby, peer, { ...mate, connectionId: peer.connectionId })
                if (this.isHost(lobby, peer)) this.hostMates.set(lobby.roomNumber, self.mate)
                this.toLobby(lobby, [MeetingServer2Client.Message, [MeetingServerMessage.Mates, this.mates(lobby)]])
                break
            }
            case MeetingNotify.Ready: {
                // The host has no ready button and the client's ready countdown skips the leader, yet
                // StartBattle requires every member to be Ready: the host is always Ready.
                const state = this.isHost(lobby, peer) ? READY_STATE_READY : params[0]
                if (self.mate) self.mate.state = state
                this.toLobby(lobby, [MeetingServer2Client.Message, [MeetingServerMessage.StateChanged, peer.connectionId, state]])
                break
            }
            case MeetingNotify.Heartbeat:
                peer.send([MeetingServer2Client.Message, [MeetingServerMessage.AckHeartbeat, peer.connectionId]])
                break
            case MeetingNotify.ChangeAutoplayMode: {
                const [mode, flag] = params
                if (self.mate) self.mate.autoplayMode = mode
                this.toLobby(lobby, [MeetingServer2Client.Message, [MeetingServerMessage.AutoplayModeChanged, peer.connectionId, mode, flag]])
                break
            }
            case MeetingNotify.ChangeAutoStart: {
                const [flag] = params
                if (self.mate) self.mate.autoStart = flag
                this.toLobby(lobby, [MeetingServer2Client.Message, [MeetingServerMessage.AutoStartChanged, peer.connectionId, flag]])
                break
            }
            case MeetingNotify.StartBattle: {
                lobby.startedWith = [...lobby.members.keys()]
                lobby.startedFrom = new Map([...lobby.members].map(([id, member]) => [id, member.peer.address]))
                lobby.startedViewers = new Map([...lobby.members].map(([id, member]) => [id, member.peer.viewerId!]))
                const room = getRoom(lobby.roomNumber)
                if (room) startRound(room, [...lobby.members.values()].map(m => m.peer.viewerId!))
                // a battle of an earlier round whose last socket is still open keeps running on its own (Peer.battle);
                // this round's players get a new one
                const previous = this.battles.get(lobby.roomNumber)
                if (previous && previous.lobby !== lobby) this.forgetBattle(previous)
                this.toLobby(lobby, [MeetingServer2Client.Message, [MeetingServerMessage.Start, this.mates(lobby)]])
                break
            }
            case MeetingNotify.Bye:
                // The client sends Bye when it moves on to the battle and then closes the socket itself.
                // Closing it from the server side makes the client report "lost connection to the party".
                // So only remove the member here; the socket stays open until the client closes it.
                this.leaveLobby(lobby, peer.connectionId!)
                peer.lobby = undefined
                break
            case MeetingNotify.EnterComs: {
                // AI companions from the summon route: [{comId, degreeId, name, party, rank}].
                // The server may have filled the room in the meantime (its fallback timer), so add only as many as
                // still fit.
                const [coms] = params
                const free = Math.max(0, ROOM_CAPACITY - lobby.members.size - lobby.coms.size)
                this.addCompanions(lobby, (coms ?? []).slice(0, free))
                break
            }
            case MeetingNotify.Suspend:
            case MeetingNotify.Log:
                break // logged above
            default:
                this.log(`[coop] #${peer.id} unhandled meeting notify ${notify}`)
        }
    }

    /** The room's establisher: the member whose viewer id created the room over HTTP. */
    private isHost(lobby: Lobby, peer: Peer): boolean {
        return getRoom(lobby.roomNumber)?.hostViewerId === peer.viewerId
    }

    private withHostReady(lobby: Lobby, peer: Peer, mate: Json): Json {
        return this.isHost(lobby, peer) ? { ...mate, state: READY_STATE_READY } : mate
    }

    /** The mate as the player's save has it (checkMate), or as sent without a check; null when it's refused. */
    private savedMate(peer: Peer, mate: Json): Json | null {
        if (mate === null || typeof mate !== "object" || Array.isArray(mate)) return null
        if (this.checkMate === null || peer.playerId === undefined) return mate
        return this.checkMate(peer.playerId, mate)
    }

    /** A lobby member whose mate can't be accepted leaves; the client reports the lost connection. */
    private refuseMate(peer: Peer) {
        this.log(`[coop] #${peer.id} mate refused`)
        peer.socket.destroy()
    }

    /** The members' mates, the host first, then players in order of entry, then AI companions. */
    private mates(lobby: Lobby): Json[] {
        const players = [...lobby.members.values()].filter(m => m.mate)
        const host = players.filter(m => this.isHost(lobby, m.peer))
        return [...host, ...players.filter(m => !host.includes(m))].map(m => m.mate).concat([...lobby.coms.values()])
    }

    /**
     * Welcome's room info. The establisher is always the room's host, also while a guest who came back first is alone
     * in the lobby: an empty establisherConnectionId then, and the host's name and leader as last seen.
     */
    private roomInfo(lobby: Lobby): Json {
        const room = getRoom(lobby.roomNumber)
        const host = [...lobby.members.values()].find(m => m.peer.viewerId === room?.hostViewerId && m.mate)
        const establisher = establisherOf(this.hostMate(lobby.roomNumber))
        return {
            establisherCharacter: establisher.characterId,
            establisherConnectionId: host?.peer.connectionId ?? "",
            establisherName: establisher.name,
            questCategory: room?.category ?? 0,
            questId: room?.questId ?? 0,
            roomNumber: lobby.roomNumber,
            status: 0 // RoomStatus: value meanings not mapped yet
        }
    }

    private toLobby(lobby: Lobby, value: Json, exceptConnectionId?: string) {
        for (const [id, member] of lobby.members) {
            if (id !== exceptConnectionId) member.peer.send(value)
        }
    }

    // --- battle ---------------------------------------------------------------------------------

    private battle(peer: Peer, message: Json) {
        const battle = peer.battle
        if (!battle || battle.members.get(peer.connectionId!) !== peer) return
        const [kind, ...args] = message

        if (kind === Client2Server.Broadcast) {
            // [Command(senderCounter, 0, 0, frame, commandString)] → stamp the order number and relay
            // to everyone, the sender included, so all clients apply commands in the same order.
            const commands = (args[0] ?? []).map((command: Json) => {
                const [variant, senderCounter, , , frame, commandString] = command
                return [variant, senderCounter, battle.order++, 0, frame, commandString]
            })
            this.toBattle(battle, [BattleServer2Client.Messages, peer.connectionId, commands])

            return
        }
        if (kind === Client2Server.Send) {
            const [targets, payload] = args
            for (const target of targets ?? []) {
                battle.members.get(String(target))?.send([BattleServer2Client.Send, peer.connectionId, payload])
            }
            return
        }
        if (kind !== Client2Server.Notify) return

        const [notify, ...params] = args[0]
        switch (notify) {
            case BattleNotify.SceneReady:
                battle.sceneReady.add(peer.connectionId!)
                this.startIfReady(battle)
                if (!battle.started && battle.startTimer === null) {
                    battle.startTimer = setTimeout(() => {
                        if (battle.started) return
                        for (const id of this.expected(battle)) if (!battle.sceneReady.has(id)) battle.absent.add(id)
                        this.log(`[coop] room ${battle.roomNumber}: starting without ${[...battle.absent].join(", ")}`)
                        this.startIfReady(battle)
                    }, BATTLE_START_WAIT_MS)
                    battle.startTimer.unref()
                }
                break
            case BattleNotify.Finalize:
                battle.finalized.add(peer.connectionId!)
                this.finalizeIfDone(battle)
                break
            case BattleNotify.Measurement: {
                const [sequence, appTime] = params
                peer.send([BattleServer2Client.Message, [BattleServerMessage.Measurement, sequence, appTime, 0]])
                break
            }
            case BattleNotify.LineSpeedWarning: {
                const [span] = params
                this.toBattle(battle, [BattleServer2Client.Message, [BattleServerMessage.LineSpeedWarning, peer.connectionId, span]], peer.connectionId)
                break
            }
            case BattleNotify.Heartbeat:
                break
            default:
                this.log(`[coop] #${peer.id} unhandled battle notify ${notify}`)
        }
    }

    /** Everyone the lobby started with (or, without a lobby, everyone connected) is in `set`. */
    /**
     * The players the battle waits for: everyone its lobby started with (or, without a lobby, everyone connected), except
     * those who left the battle or never came. A player between its lobby Bye and its battle handshake is still awaited.
     */
    private expected(battle: Battle): string[] {
        const ids = battle.lobby?.startedWith ?? [...battle.members.keys()]
        return ids.filter(id => !battle.departed.has(id) && !battle.absent.has(id))
    }

    private allPresent(battle: Battle, set: Set<string>): boolean {
        return this.expected(battle).every(id => set.has(id))
    }

    /** BattleStart once every awaited player sent SceneReady. */
    private startIfReady(battle: Battle) {
        if (battle.started || battle.sceneReady.size === 0 || !this.allPresent(battle, battle.sceneReady)) return
        battle.started = true
        if (battle.startTimer !== null) clearTimeout(battle.startTimer)
        this.toBattle(battle, [BattleServer2Client.Message, [BattleServerMessage.BattleStart]])
    }

    /** Finalized once every awaited player sent Finalize. */
    private finalizeIfDone(battle: Battle) {
        if (battle.over || battle.finalized.size === 0 || !this.allPresent(battle, battle.finalized)) return
        battle.over = true
        this.toBattle(battle, [BattleServer2Client.Message, [BattleServerMessage.Finalized]])
        if (this.isCurrentBattle(battle)) this.armExpiry(battle.roomNumber)
    }

    /** Whether the battle belongs to the room's current round (no player has gone back to the room since). */
    private isCurrentBattle(battle: Battle): boolean {
        const lobby = this.lobbies.get(battle.roomNumber)
        return lobby === undefined || lobby === battle.lobby
    }

    private toBattle(battle: Battle, value: Json, exceptConnectionId?: string) {
        for (const [id, member] of battle.members) {
            if (id !== exceptConnectionId) member.send(value)
        }
    }

    // --- bookkeeping ----------------------------------------------------------------------------

    /** Drops the lobby from its room's slot, if it is still the room's lobby (not a later round's). */
    private forgetLobby(lobby: Lobby) {
        if (this.lobbies.get(lobby.roomNumber) === lobby) this.lobbies.delete(lobby.roomNumber)
    }

    /** Drops the battle from its room's slot, if it is still the room's battle; its sockets keep their own reference. */
    private forgetBattle(battle: Battle) {
        if (this.battles.get(battle.roomNumber) === battle) this.battles.delete(battle.roomNumber)
    }

    /**
     * A member leaves the lobby (Bye, or its socket closed): the others get the new member list. A lobby that hasn't
     * started is dropped once empty, and without its host the room starts waiting for it (armExpiry).
     */
    private leaveLobby(lobby: Lobby, connectionId: string) {
        lobby.members.delete(connectionId)
        if (lobby.members.size > 0) {
            this.toLobby(lobby, [MeetingServer2Client.Message, [MeetingServerMessage.Mates, this.mates(lobby)]])
        } else if (!lobby.startedWith) {
            this.forgetLobby(lobby)
        }
        // a guest coming and going doesn't extend a wait already running
        if (!lobby.startedWith) this.armExpiry(lobby.roomNumber, false)
    }

    private lobbyFor(roomNumber: string): Lobby {
        let lobby = this.lobbies.get(roomNumber)
        if (!lobby) {
            lobby = { roomNumber, members: new Map(), coms: new Map(), startedWith: null, startedFrom: new Map(), startedViewers: new Map() }
            this.lobbies.set(roomNumber, lobby)
        }
        return lobby
    }

    private battleFor(roomNumber: string): Battle {
        let battle = this.battles.get(roomNumber)
        if (!battle) {
            const lobby = this.lobbies.get(roomNumber)
            battle = {
                roomNumber, members: new Map(), sceneReady: new Set(), finalized: new Set(), started: false, over: false, order: 0,
                departed: new Set(), absent: new Set(), startTimer: null,
                lobby: lobby?.startedWith ? lobby : null
            }
            this.battles.set(roomNumber, battle)
        }
        return battle
    }

    private disconnect(peer: Peer) {
        if (!peer.roomNumber || !peer.connectionId) return
        if (peer.kind === "meeting") {
            const lobby = peer.lobby
            if (!lobby || lobby.members.get(peer.connectionId)?.peer !== peer) return
            this.leaveLobby(lobby, peer.connectionId)
        } else if (peer.kind === "battle") {
            const battle = peer.battle
            if (!battle || battle.members.get(peer.connectionId) !== peer) return
            battle.members.delete(peer.connectionId)
            battle.departed.add(peer.connectionId)
            if (battle.members.size === 0) {
                if (battle.startTimer !== null) clearTimeout(battle.startTimer)
                // only this battle's round: the room may already be in its next round (Return to Room)
                const current = this.isCurrentBattle(battle)
                this.forgetBattle(battle)
                if (battle.lobby) this.forgetLobby(battle.lobby)
                if (current) this.armExpiry(peer.roomNumber)
            } else {
                this.toBattle(battle, [BattleServer2Client.Message, [BattleServerMessage.Leave, peer.connectionId]])
                // the others may have been waiting only for this player
                this.startIfReady(battle)
                this.finalizeIfDone(battle)
            }
        }
    }
}

/** The client strips a leading "Debug" from room numbers (developer leftover); do the same. */
function normaliseRoomNumber(roomNumber: string): string {
    return roomNumber.startsWith("Debug") ? roomNumber.slice(5) : roomNumber
}

/** An IPv4 client on a dual-stack listener shows up as `::ffff:a.b.c.d`; compare and count it as `a.b.c.d`. */
export function normaliseAddress(address: string): string {
    return address.startsWith("::ffff:") && address.includes(".") ? address.slice(7) : address
}

function newConnectionId(): string {
    return randomBytes(8).toString("hex")
}

// --- process-wide instance ----------------------------------------------------------------------

export const COOP_SOCKET_DEFAULT_PORT = 18888

/** The running server, if any (set by src/server.ts), so HTTP routes can read room state. */
export let coopSocketServer: CoopSocketServer | null = null

export function setCoopSocketServer(server: CoopSocketServer | null): void {
    coopSocketServer = server
}

/** Port the co-op socket listens on and that `select_room` advertises. */
export function coopSocketPort(): number {
    const port = Number.parseInt(process.env.COOP_SOCKET_PORT ?? "")
    return Number.isNaN(port) ? COOP_SOCKET_DEFAULT_PORT : port
}
