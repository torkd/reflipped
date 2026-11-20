// What a battle finish (`single_battle_quest/finish`, and through it `multi_battle_quest/finish`) may claim (SEC-13,
// docs/hardening.md "Input and abuse"). The client reports its own score, clear time, field mana and party; the
// rewards themselves come from the quest's asset data, so these checks bound the values that are added or stored as
// sent: field mana is credited, the party earns unit exp (and the exp pool the overflow), the score and time become
// the quest's records and the clear rank.
//
// Nothing in the request lets the server check a run itself (`reproduce_log_data` is device log metadata, not a
// replay), so a plausible lie still passes: these are bounds, not proof.

/** The client's party slots: three main units and three Seconds (unison). */
export const PARTY_SLOTS = 3

/**
 * Field mana (`add_mana`, the mana picked up during the battle) one finish may credit. The game's own scale is small:
 * the regular mission "Obtain N mana through battles" ends at 1,000 in total, and both captured finishes sent 0. A
 * larger claim is credited up to this and logged.
 */
export const FIELD_MANA_MAX = 10_000

/** A clear time the client can't have measured (negative): ranked as the slowest, never S+. */
const SLOWEST_CLEAR_MS = 2 ** 31 - 1

interface PartySlot { id: number | null }

export interface FinishClaims {
    add_mana: number
    score: number
    elapsed_time_ms: number
    statistics: {
        party: {
            characters: (PartySlot | null)[]
            unison_characters: (PartySlot | null)[]
        }
    }
}

export interface CheckedFinish {
    /** field mana to credit, 0 to FIELD_MANA_MAX */
    fieldMana: number
    /** a whole, non-negative score */
    score: number
    /** the clear time for the rank and the records */
    clearTimeMs: number
    /** the units that earn exp: each once, from the first three main and the first three Second slots */
    partyCharacterIds: number[]
    /** the fields that were out of range, for the log (never the request's other contents) */
    clamped: string[]
}

function slotIds(slots: (PartySlot | null)[] | undefined): number[] {
    return (slots ?? []).slice(0, PARTY_SLOTS)
        .map(slot => slot?.id)
        .filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id))
}

/** Bounds a finish's claims (see the file comment). */
export function checkFinishClaims(body: FinishClaims): CheckedFinish {
    const clamped: string[] = []

    const mana = Number.isFinite(body.add_mana) ? Math.trunc(body.add_mana) : 0
    const fieldMana = Math.min(Math.max(mana, 0), FIELD_MANA_MAX)
    if (fieldMana !== body.add_mana) clamped.push("add_mana")

    const score = Number.isFinite(body.score) ? Math.min(Math.max(Math.floor(body.score), 0), Number.MAX_SAFE_INTEGER) : 0
    if (score !== body.score) clamped.push("score")

    const elapsed = body.elapsed_time_ms
    const clearTimeMs = Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : SLOWEST_CLEAR_MS
    if (clearTimeMs !== elapsed) clamped.push("elapsed_time_ms")

    const party = body.statistics.party
    const listed = [...slotIds(party.characters), ...slotIds(party.unison_characters)]
    const partyCharacterIds = [...new Set(listed)]
    const sent = (party.characters?.length ?? 0) + (party.unison_characters?.length ?? 0)
    if (partyCharacterIds.length !== listed.length || sent > PARTY_SLOTS * 2) clamped.push("statistics.party")

    return { fieldMana, score, clearTimeMs, partyCharacterIds, clamped }
}
