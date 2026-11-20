// The party of a battle in a battle history (Practice Combat, FT-17; Score Scramble, FT-86): what the history detail
// shows per slot. The client's history entries read each slot's unit, unison unit, armament with its level and
// enhancement level, ability soul and the unit's damage (`character_<n>_total_damage`), from the finish or abort body's
// statistics. Imports neither practice.ts nor scoreAttack.ts, which both use it.
import { getPlayerEquipmentSync } from "../data/wdfpData";
import { partySlotIds } from "./borderRewards";

export interface HistoryParty {
    characters: (number | null)[]
    unisonCharacters: (number | null)[]
    equipments: (number | null)[]
    /** an armament's level and enhancement level at the battle (null for an empty slot or an armament not owned) */
    equipmentLevels: (number | null)[]
    enhancementLevels: (number | null)[]
    abilitySouls: (number | null)[]
    /** each slot's damage over the battle; null for an empty slot */
    damage: (number | null)[]
}

function nonNegative(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER) : 0
}

function zonesOf(statistics: Record<string, unknown>): Record<string, unknown>[] {
    const zones = Array.isArray(statistics.zones) ? statistics.zones : []
    return zones.filter((zone): zone is Record<string, unknown> => zone !== null && typeof zone === "object")
}

/**
 * Each party slot's damage: the slot's `members[slot].origin_damage` summed over the zones (the members' damage adds up
 * to the zone's `damage_deal_total` in the captured solo and co-op finishes). null for an empty slot.
 */
export function slotDamage(statistics: Record<string, unknown>, characters: (number | null)[]): (number | null)[] {
    return characters.map((characterId, slot) => {
        if (characterId === null) return null
        let total = 0
        for (const zone of zonesOf(statistics)) {
            const members = Array.isArray(zone.members) ? zone.members : []
            const member = members[slot]
            if (member !== null && typeof member === "object") total += nonNegative((member as Record<string, unknown>).origin_damage)
        }
        return Math.min(total, Number.MAX_SAFE_INTEGER)
    })
}

/** The party of a finish or abort body's statistics, with the player's armaments' levels as they are now. */
export function historyPartySync(playerId: number, statistics: Record<string, unknown>): HistoryParty {
    const party = (statistics.party !== null && typeof statistics.party === "object" ? statistics.party : {}) as Record<string, unknown>
    const characters = partySlotIds(party.characters)
    const equipments = partySlotIds(party.equipments)
    const owned = equipments.map(id => id === null ? null : getPlayerEquipmentSync(playerId, id))
    return {
        characters,
        unisonCharacters: partySlotIds(party.unison_characters),
        equipments,
        equipmentLevels: owned.map(equipment => equipment?.level ?? null),
        enhancementLevels: owned.map(equipment => equipment?.enhancementLevel ?? null),
        abilitySouls: partySlotIds(party.ability_soul_ids),
        damage: slotDamage(statistics, characters)
    }
}

/** A history entry's per-slot fields (`character_id_1`, `equipment1_id`, `character_1_total_damage`, ...). */
export function historyPartyFields(party: Partial<HistoryParty> & Pick<HistoryParty, "characters" | "unisonCharacters" | "equipments" | "abilitySouls">): Record<string, unknown> {
    const entry: Record<string, unknown> = {}
    for (let slot = 0; slot < 3; slot++) {
        entry[`character_id_${slot + 1}`] = party.characters[slot] ?? null
        entry[`unison_character_id_${slot + 1}`] = party.unisonCharacters[slot] ?? null
        entry[`equipment${slot + 1}_id`] = party.equipments[slot] ?? null
        entry[`equipment_level_${slot + 1}`] = party.equipmentLevels?.[slot] ?? null
        entry[`enhancement_level_${slot + 1}`] = party.enhancementLevels?.[slot] ?? null
        entry[`ability_soul_id_${slot + 1}`] = party.abilitySouls[slot] ?? null
        entry[`character_${slot + 1}_total_damage`] = party.damage?.[slot] ?? null
    }
    return entry
}
