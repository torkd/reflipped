/**
 * In-memory registry of co-op rooms (multi_battle_quest).
 *
 * Rooms are created over HTTP (`create_room`) and joined over the co-op socket
 * (see `socketServer.ts` and docs/coop-research.md). They live only as long as the process.
 */
import { randomBytes, randomInt } from "crypto"
import { AsyncLocalStorage } from "async_hooks"
import type { EventRunContext } from "../eventSchedule"
import type { FollowBonusRound } from "../follows"

/** The room's fixed event occurrence with an immutable reward-policy snapshot for one round. */
export type CoopEventContext = Readonly<EventRunContext & { rewardMultiplier: number }>

export interface CoopRoom {
    /** 6-digit string, shown to players and used in every socket handshake */
    roomNumber: string
    /**
     * Secret behind the room's invitation link (`wdfp://social-room?k=<token>`): the client sends it to
     * `verify_access_token`, `prepare` and `select_room` instead of the room number (docs/coop-research.md, "Room links").
     */
    accessToken: string
    questId: number
    /** `category` / `category_id` from the client (quest category) */
    category: number
    hostViewerId: number
    eventContext?: CoopEventContext
    /**
     * The balance epoch the room was created in (FT-47, src/lib/balance.ts): players see units the same way only
     * within one, so a room from another is not found for anyone else.
     */
    balanceEpoch?: number
    /** unix seconds */
    createdAt: number
    roomSequence: number
    /** share_room `share_type_list`: who may see/join the room (values not mapped yet) */
    shareTypes: number[]
    /**
     * The room's round: true from the battle's start (the lobby's StartBattle, or the first `start`) until the room
     * opens again (Return to Room, or the first player back in its lobby once the battle is over). Hidden from the room
     * list and invitations meanwhile.
     */
    inBattle: boolean
    /** how many rounds the room has started (1 in its first battle); tells a Return to Room's rounds apart */
    round: number
    /** when the current (or last) round started (Date.now()); none before the first */
    roundStartedAtMs?: number
    /** players of the current (or last) round: the ones who may Return to Room after it */
    lastRoundViewerIds: number[]
    /** those who reported the round's end over HTTP (finish or abort) */
    roundEndedViewerIds: number[]
    /** the round's follow bonus (FT-43), worked out at its first `start` so every player gets the same */
    followBonus?: FollowBonusRound
    /** viewers the HTTP routes let into the room (create, select, restore): the host and every player who joined */
    members: Set<number>
    /** Players who joined through an invitation this server delivered. */
    attentionMembers?: Set<number>
    /**
     * Pending socket admissions by viewer id. The socket handshake carries a viewer id the client chooses, so a lobby
     * connection is only accepted for a viewer whose own signed request just admitted it, once (SEC-12).
     */
    admissions: Map<number, Admission>
    /**
     * Viewers whose signed `start` just began their part of the battle, by viewer id → expiry (ms). A battle socket
     * from another address than its lobby's is accepted once with one (a phone that changed networks in between).
     */
    battleAdmissions: Map<number, number>
}

export interface Admission {
    /** ms */
    expires: number
    /** the viewer's player, from the signed request: the socket checks its lobby mate against this save (SEC-15) */
    playerId?: number
}

/**
 * How long an admission from create_room/select_room/restore_room waits for the socket handshake. Ten minutes, not
 * less: on the room list, typed-number and room-link paths the client asks whether to use boss boost points after
 * select_room and before it connects, and that dialog waits for the player with no time limit (CO-4).
 */
export const ADMISSION_TTL_MS = 10 * 60_000
/** How long a battle admission from `start` waits for the battle handshake (the client connects right after it). */
export const BATTLE_ADMISSION_TTL_MS = 2 * 60_000
/** Open rooms at most; create_room fails beyond it. Each host has one room at a time (the routes close the older one). */
export const MAX_ROOMS = 10_000

const rooms = new Map<string, CoopRoom>()
let nextSequence = 1

export class TooManyRoomsError extends Error {}

export function createRoom(hostViewerId: number, questId: number, category: number): CoopRoom {
    // 900,000 numbers: stay far below them, so the search for a free one ends quickly
    if (rooms.size >= MAX_ROOMS) throw new TooManyRoomsError(`${rooms.size} co-op rooms are open`)
    let roomNumber: string
    do {
        roomNumber = randomInt(100000, 1000000).toString()
    } while (rooms.has(roomNumber))

    const room: CoopRoom = {
        roomNumber,
        accessToken: randomBytes(32).toString("base64url"),
        questId,
        category,
        hostViewerId,
        createdAt: Math.floor(Date.now() / 1000),
        roomSequence: nextSequence++,
        shareTypes: [],
        inBattle: false,
        round: 0,
        lastRoundViewerIds: [],
        roundEndedViewerIds: [],
        members: new Set([hostViewerId]),
        admissions: new Map(),
        battleAdmissions: new Map()
    }
    rooms.set(roomNumber, room)
    return room
}

/** Lets `viewerId` (whose player is `playerId`) open one lobby connection to the room within ADMISSION_TTL_MS. */
export function admit(room: CoopRoom, viewerId: number, playerId?: number, now = Date.now()): void {
    room.members.add(viewerId)
    room.admissions.set(viewerId, { expires: now + ADMISSION_TTL_MS, playerId })
}

/** Uses up `viewerId`'s admission to the room; null if it has none or it expired. */
export function takeAdmission(room: CoopRoom, viewerId: number, now = Date.now()): Admission | null {
    const admission = room.admissions.get(viewerId)
    room.admissions.delete(viewerId)
    return admission !== undefined && admission.expires > now ? admission : null
}

/** `viewerId`'s signed `start` for the room: its battle socket may come from a new address once (see battleAdmissions). */
export function admitToBattle(room: CoopRoom, viewerId: number, now = Date.now()): void {
    room.battleAdmissions.set(viewerId, now + BATTLE_ADMISSION_TTL_MS)
}

/** Uses up `viewerId`'s battle admission to the room; false if it has none or it expired. */
export function takeBattleAdmission(room: CoopRoom, viewerId: number, now = Date.now()): boolean {
    const expires = room.battleAdmissions.get(viewerId)
    room.battleAdmissions.delete(viewerId)
    return expires !== undefined && expires > now
}

/** The rooms `viewerId` is the host of. */
export function roomsHostedBy(viewerId: number): CoopRoom[] {
    return [...rooms.values()].filter(room => room.hostViewerId === viewerId)
}

/** A round's battle starts with these players (the lobby's members at StartBattle). */
export function startRound(room: CoopRoom, viewerIds: number[]): void {
    if (!room.inBattle && room.eventContext) {
        // A reused lobby must follow the current reward rules for future battles. Existing
        // ActiveQuests retain their previous immutable object until their own finish commits.
        // Resolve lazily: this registry is also imported before DB configuration by socket tools.
        const { getRewardPolicy } = require("../rewardPolicy") as typeof import("../rewardPolicy")
        // every co-op battle is a boss fight: the event ones report a quest category that is not a boss category
        room.eventContext = Object.freeze({ ...room.eventContext, rewardMultiplier: getRewardPolicy().bossMultiplier })
    }
    if (!room.inBattle) {
        room.round++
        room.roundStartedAtMs = Date.now()
    }
    room.inBattle = true
    room.lastRoundViewerIds = [...new Set(viewerIds)]
    room.roundEndedViewerIds = []
    room.followBonus = undefined
}

/**
 * The round `viewerId` is finishing now: a room in battle that started with them, hasn't seen their end yet and plays
 * the finish's quest. A guest who crashed in one room (still in battle there) and finishes in another can be in several:
 * the most recently started round wins (SEC-18 review).
 */
export function finishingRoundOf(viewerId: number, questId: number, category: number): CoopRoom | undefined {
    let found: CoopRoom | undefined
    for (const room of rooms.values()) {
        if (!room.inBattle || room.questId !== questId || room.category !== category) continue
        if (!room.lastRoundViewerIds.includes(viewerId) || room.roundEndedViewerIds.includes(viewerId)) continue
        if (found === undefined || (room.roundStartedAtMs ?? 0) >= (found.roundStartedAtMs ?? 0)) found = room
    }
    return found
}

/** The room is a lobby again, open for its next round. */
export function openRound(room: CoopRoom): void {
    room.inBattle = false
}

/** A player's finish or abort: its part of the round is over. */
export function noteRoundEnded(viewerId: number): void {
    for (const room of rooms.values()) {
        if (room.inBattle && room.lastRoundViewerIds.includes(viewerId) && !room.roundEndedViewerIds.includes(viewerId)) {
            room.roundEndedViewerIds.push(viewerId)
        }
    }
}

/** Every player of the round reported its end over HTTP. */
export function everyoneEnded(room: CoopRoom): boolean {
    return room.lastRoundViewerIds.length > 0 && room.lastRoundViewerIds.every(id => room.roundEndedViewerIds.includes(id))
}

export function getRoom(roomNumber: string): CoopRoom | undefined {
    return rooms.get(roomNumber)
}

/** The room an invitation link's token belongs to. */
export function getRoomByAccessToken(accessToken: string): CoopRoom | undefined {
    if (accessToken.length === 0) return undefined
    for (const room of rooms.values()) {
        if (room.accessToken === accessToken) return room
    }
    return undefined
}

export function deleteRoom(roomNumber: string): void {
    rooms.delete(roomNumber)
}

/** Whether a viewer belongs to an open room for this quest (its host started it: SEC-16's period check). */
const authorisedCoopStart = new AsyncLocalStorage<{
    viewerId: number, questId: number, category: number, hostViewerId: number,
    /** the player joined through an invitation this server delivered (attentionMembers): their start costs no stamina */
    joinedByInvitation: boolean
}>()

/** Server-internal proof for the injected single start; no client-supplied body can set this context. */
export function runOnCoopStart<T>(room: CoopRoom, viewerId: number, fn: () => T): T {
    return authorisedCoopStart.run({
        viewerId, questId: room.questId, category: room.category, hostViewerId: room.hostViewerId,
        joinedByInvitation: room.attentionMembers?.has(viewerId) === true
    }, fn)
}

/** The injected single start is authorised only for the exact co-op room quest and viewer. */
export function isInRoomFor(viewerId: number, questId: number, category: number): boolean {
    const proof = authorisedCoopStart.getStore()
    return proof?.viewerId === viewerId && proof.questId === questId && proof.category === category
}

/** The host of the co-op room whose start is running for this viewer and quest, or null outside one. */
export function coopStartHostViewerId(viewerId: number, questId: number, category: number): number | null {
    const proof = authorisedCoopStart.getStore()
    return proof !== undefined && proof.viewerId === viewerId && proof.questId === questId && proof.category === category ? proof.hostViewerId : null
}

/** Whether the co-op start running for this viewer and quest is a guest's who joined through an invitation. */
export function coopStartJoinedByInvitation(viewerId: number, questId: number, category: number): boolean {
    return coopStartHostViewerId(viewerId, questId, category) !== null && authorisedCoopStart.getStore()!.joinedByInvitation
}

export function listRooms(): CoopRoom[] {
    return [...rooms.values()]
}
