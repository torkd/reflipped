/**
 * Co-op recruitment ("attention": the bell that invites other players to a room).
 *
 * How the client drives it (static analysis, docs/coop-research.md "Recruitment"):
 * - The host taps Recruit → `multi_battle_quest/share_room`. While its room has a free slot, the host's client sends
 *   share_room again every `attention_recruitment_interval_seconds` (15), up to `attention_recruitment_redeliver_limit`
 *   (20) times, so a recent share_room means "still recruiting".
 * - The host's client summons AI companions itself once it has recruited for `summon_com_seconds`; the share_room
 *   reply's `config.summon_com_seconds` sets that value, which is how the server picks the wait.
 * - Every other player's client polls `attention/check` (every 10 s, 15 s in battle; not inside a co-op room) and gets
 *   rooms to join in `data.multi`. Declining or letting one expire is reported to `attention/action`.
 *
 * Reflipped delivers each recruiting room once to every player who polls, and waits longer for players before the
 * AI fill while somebody who could still join is around: a player who polled attention/check or opened the room
 * list recently, is not in a lobby, and has not declined this room.
 */
import { CoopRoom, getRoom, listRooms } from "./rooms"
import { coopSocketServer, ROOM_CAPACITY } from "./socketServer"
import { getSetting } from "../../data/serverSettings"
import { establisherOf, FOLLOW_STATE_NONE } from "./mates"

type Json = any

/** share_type_list values (RoomShareDialog): 1 = mutual follows, 2 = followers, 3 = random players (attention). */
export const SHARE_TYPE_RANDOM = 3

/**
 * How recently a player must have polled to count as online and free to join: a minute, or four polling intervals
 * when the admin made polling slower than that.
 */
function presenceWindowMs(): number {
    return Math.max(60, 4 * getSetting("client.attention_polling_seconds")) * 1000
}

/** A room whose host hasn't re-sent share_room for three of its intervals has stopped recruiting. */
function recruitStaleMs(): number {
    return 3 * getSetting("coop.recruit_interval_seconds") * 1000
}

/** Extra time the server gives the host's client to summon by itself before it fills the room. */
export const FILL_GRACE_MS = 5_000
/** How often a waiting room re-checks whether anybody could still join. */
const RECHECK_MS = 5_000

interface Delivery {
    deliveredAt: number
    /** the player declined it or let it expire */
    declined: boolean
}

interface Recruitment {
    roomNumber: string
    roomSequence: number
    /** ms when recruiting started (first share_room); the host's summon countdown starts here too */
    since: number
    /** ms of the latest share_room */
    lastShared: number
    /** viewer id → what happened to this room's attention for that player */
    delivered: Map<number, Delivery>
    makeCompanions: (count: number) => Json[]
    timer: NodeJS.Timeout | null
}

const recruitments = new Map<string, Recruitment>()
/** viewer id → ms of the latest attention/check or room list */
const presence = new Map<number, number>()

/** The player is online and looking (attention/check, get_rooms). */
export function notePresence(viewerId: number, now = Date.now()): void {
    presence.set(viewerId, now)
}

function recruitmentFor(room: CoopRoom): Recruitment | undefined {
    const recruitment = recruitments.get(room.roomNumber)
    return recruitment?.roomSequence === room.roomSequence ? recruitment : undefined
}

/**
 * share_room: starts recruiting for the room, or refreshes it. Returns the AI companion wait in seconds, counted
 * from the first share_room, for the reply's `summon_com_seconds`.
 */
export function shareRoom(room: CoopRoom, makeCompanions: (count: number) => Json[], now = Date.now()): number {
    let recruitment = recruitmentFor(room)
    if (!recruitment) {
        stopRecruiting(room.roomNumber)
        recruitment = {
            roomNumber: room.roomNumber,
            roomSequence: room.roomSequence,
            since: now,
            lastShared: now,
            delivered: new Map(),
            makeCompanions,
            timer: null
        }
        recruitments.set(room.roomNumber, recruitment)
    }
    recruitment.lastShared = now
    recruitment.makeCompanions = makeCompanions
    armFillTimer(recruitment, now)
    return companionDelaySeconds(room, now)
}

/** Forgets the room's recruitment (disbanded, battle started). */
export function stopRecruiting(roomNumber: string): void {
    const recruitment = recruitments.get(roomNumber)
    if (recruitment?.timer) clearTimeout(recruitment.timer)
    recruitments.delete(roomNumber)
}

/** Players who could still join the room: online, free, not the host, and haven't declined it. */
export function joinCandidates(room: CoopRoom, now = Date.now()): number[] {
    const recruitment = recruitmentFor(room)
    const candidates: number[] = []
    for (const [viewerId, seen] of presence) {
        if (now - seen > presenceWindowMs()) {
            presence.delete(viewerId)
            continue
        }
        if (viewerId === room.hostViewerId) continue
        if (recruitment?.delivered.get(viewerId)?.declined) continue
        if (coopSocketServer?.isInLobby(viewerId)) continue
        candidates.push(viewerId)
    }
    return candidates
}

/** Seconds a recruiting room waits for players before AI companions fill it (admin settings). */
export function companionDelaySeconds(room: CoopRoom, now = Date.now()): number {
    return joinCandidates(room, now).length > 0
        ? getSetting("coop.companion_delay_players_seconds")
        : getSetting("coop.companion_delay_seconds")
}

/**
 * The server's own fill, a fallback for when the host's client doesn't summon (e.g. it ignored summon_com_seconds or
 * went to the background). It re-checks the wait when it fires, since players can come and go.
 */
function armFillTimer(recruitment: Recruitment, now = Date.now()): void {
    if (recruitment.timer) clearTimeout(recruitment.timer)
    recruitment.timer = null
    const room = getRoom(recruitment.roomNumber)
    if (!room || room.roomSequence !== recruitment.roomSequence || room.inBattle) {
        stopRecruiting(recruitment.roomNumber)
        return
    }
    const due = recruitment.since + companionDelaySeconds(room, now) * 1000 + FILL_GRACE_MS
    if (now >= due) {
        // Does nothing when the client already summoned or the room is full. The recruitment itself stays: a player can
        // still take a companion's place until the host stops re-sending share_room.
        coopSocketServer?.fillWithCompanions(room.roomNumber, recruitment.makeCompanions, ROOM_CAPACITY,
            `after ${Math.round((now - recruitment.since) / 1000)} s of recruiting`)
        return
    }
    // Look again every few seconds: when the last player who could join declines, lets the invitation expire or joins,
    // the wait drops to the short one without waiting for the host's next share_room.
    recruitment.timer = setTimeout(() => armFillTimer(recruitment), Math.min(due - now, RECHECK_MS))
    recruitment.timer.unref()
}

/**
 * attention/check: up to `max` recruiting rooms the player can join and hasn't been offered yet, as `data.multi`
 * entries (AttentionCheckRealRemoteService.successHandler). Each room is offered to a player once.
 */
export function takeAttentions(viewerId: number, max: number, now = Date.now()): Json[] {
    const entries: Json[] = []
    if (max <= 0) return entries
    if (coopSocketServer?.isInLobby(viewerId)) return entries
    const rooms = listRooms().sort((a, b) => a.createdAt - b.createdAt)
    for (const room of rooms) {
        if (entries.length >= max) break
        const recruitment = recruitmentFor(room)
        if (!recruitment) continue
        if (now - recruitment.lastShared > recruitStaleMs()) continue
        if (room.hostViewerId === viewerId || room.inBattle) continue
        if (recruitment.delivered.has(viewerId)) continue
        if ((coopSocketServer?.joinStatus(room.roomNumber) ?? "open") !== "open") continue
        recruitment.delivered.set(viewerId, { deliveredAt: now, declined: false })
        entries.push(attentionEntry(room))
    }
    return entries
}

/**
 * attention/action: the player declined an attention, let it expire, or left a room joined through one. The request
 * doesn't say which attention, so every room offered to the player and not answered yet counts as declined.
 */
export function noteAttentionAction(viewerId: number, factors: string[]): void {
    if (!factors.some(factor => factor === "Decline" || factor === "Expire" || factor === "Disconnect" || factor === "Neglect")) return
    for (const recruitment of recruitments.values()) {
        const delivery = recruitment.delivered.get(viewerId)
        if (delivery && !delivery.declined) delivery.declined = true
    }
}

/** A `data.multi` entry for attention/check. */
function attentionEntry(room: CoopRoom): Json {
    const establisher = establisherOf(coopSocketServer?.hostMate(room.roomNumber) ?? null)
    return {
        "attention_key": `${room.roomNumber}-${room.roomSequence}`,
        "quest_info": {
            "category_id": room.category,
            "quest_id": room.questId,
            "room_number": room.roomNumber,
            "host_entry_time": room.createdAt,
            "establisher_rank": establisher.rank,
            "establisher_character": establisher.characterId,
            "establisher_character_evolution_img_level": establisher.evolutionLevel,
            "establisher_follow": FOLLOW_STATE_NONE
        }
    }
}

/** For the admin dashboard: rooms recruiting now and players online who could join one. */
export function recruitmentSummary(now = Date.now()): { recruitingRooms: number, availablePlayers: number } {
    let recruitingRooms = 0
    for (const recruitment of recruitments.values()) {
        if (now - recruitment.lastShared <= recruitStaleMs()) recruitingRooms++
    }
    let availablePlayers = 0
    for (const [viewerId, seen] of presence) {
        if (now - seen <= presenceWindowMs() && !coopSocketServer?.isInLobby(viewerId)) availablePlayers++
    }
    return { recruitingRooms, availablePlayers }
}

/** Tests only: forget all recruitment and presence state. */
export function resetRecruitment(): void {
    for (const recruitment of recruitments.values()) if (recruitment.timer) clearTimeout(recruitment.timer)
    recruitments.clear()
    presence.clear()
}
