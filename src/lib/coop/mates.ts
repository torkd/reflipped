/**
 * Reading the lobby mate the client sends (`Enter` / `ChangeParty`, docs/coop-protocol.md): who leads a party, and the
 * establisher (host) fields that get_rooms, search_room, verify_access_token, attention/check and the lobby's Welcome
 * show for a room.
 */

type Json = any

/** FollowState for "not following"; there are no follows between players yet (FT-15). */
export const FOLLOW_STATE_NONE = 0

/** The party's first character: party.characters is Array<Option<{id, evolution_level, ...}>>, Some(x) = [0, x]. */
export function leaderCharacter(mate: Json | null): { id: number, evolutionLevel: number } | null {
    const first = mate?.party?.characters?.[0]
    if (!Array.isArray(first) || first[0] !== 0 || !Number.isSafeInteger(first[1]?.id)) return null
    const evolution = first[1].evolution_level
    return { id: first[1].id, evolutionLevel: Number.isSafeInteger(evolution) && evolution >= 0 ? evolution : 0 }
}

export interface Establisher {
    name: string
    rank: number
    /** leader character id; 1 when the host's party isn't known (the client only type-checks it) */
    characterId: number
    evolutionLevel: number
}

/** Longest establisher name shown to others: the mate is the client's word, and names are 32 characters at most (playerText). */
const MAX_NAME_LENGTH = 32
/** Highest establisher rank shown to others. */
const MAX_RANK = 9999

/**
 * The establisher fields from the host's mate (null: the host hasn't entered the lobby yet). They go to every player who
 * browses rooms or gets an invitation, so they are bounded here (SEC-12).
 */
export function establisherOf(hostMate: Json | null): Establisher {
    const leader = leaderCharacter(hostMate)
    const rank = hostMate?.rank
    return {
        name: typeof hostMate?.name === "string" ? hostMate.name.slice(0, MAX_NAME_LENGTH) : "",
        rank: Number.isSafeInteger(rank) && rank >= 1 && rank <= MAX_RANK ? rank : 1,
        characterId: leader?.id ?? 1,
        evolutionLevel: leader?.evolutionLevel ?? 0
    }
}
