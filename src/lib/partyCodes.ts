// Party codes (FT-41, storage in src/data/partyCodes.ts). A stored party goes back to other players in party/refer,
// whose reply the client checks field by field and refuses whole if one field has the wrong type
// (`PartyReferRemote.successHandler`). So party/publish keeps only the fields that reply has, in the types it expects:
// a body schema checks them and normaliseBattleParty() drops everything else.
import { arrayOf, integer, nullable, object, Schema } from "../routes/schemas";

/** A party has three slots of each kind. */
const SLOTS = 3

const partyCharacter = nullable(object({
    id: integer,
    evolution_level: integer,
    exp: integer,
    over_limit_step: integer,
    ex_boost: nullable(object({ status_id: integer, ability_id_list: arrayOf(integer, 10) }, ["status_id", "ability_id_list"])),
    mana_node_ids: nullable(arrayOf(integer, 300)),
    illustration_settings: nullable(arrayOf(integer, 10))
}, ["id", "evolution_level", "exp", "over_limit_step"]))

/** The `battle_party` of party/publish, which party/refer returns. Every slot may be empty (null). */
export const battlePartySchema: Schema = object({
    characters: arrayOf(partyCharacter, SLOTS),
    unison_characters: arrayOf(partyCharacter, SLOTS),
    equipments: arrayOf(nullable(object({ equipment_id: integer, level: integer }, ["equipment_id", "level"])), SLOTS),
    ability_soul_ids: arrayOf(nullable(integer), SLOTS)
}, ["characters", "unison_characters", "equipments", "ability_soul_ids"])

export interface PartyCodeCharacter {
    id: number
    evolution_level: number
    exp: number
    over_limit_step: number
    ex_boost: { status_id: number, ability_id_list: number[] } | null
    mana_node_ids: number[] | null
    illustration_settings: number[] | null
}

export interface PartyCodeBattleParty {
    characters: (PartyCodeCharacter | null)[]
    unison_characters: (PartyCodeCharacter | null)[]
    equipments: ({ equipment_id: number, level: number } | null)[]
    ability_soul_ids: (number | null)[]
}

/**
 * What the publishing player owns. A slot holding a unit or armament they don't own (or one the game doesn't have) is
 * emptied, as party/edit does: the code goes to other players, whose client looks each id up in its master data and
 * stops with an error (C8601) on an unknown one.
 */
export interface PartyOwnership {
    ownsCharacter(id: number): boolean
    ownsEquipment(id: number): boolean
}

function normaliseCharacter(character: PartyCodeCharacter | null | undefined, owned: PartyOwnership): PartyCodeCharacter | null {
    if (character === null || character === undefined || !owned.ownsCharacter(character.id)) return null
    return {
        id: character.id,
        evolution_level: character.evolution_level,
        exp: character.exp,
        over_limit_step: character.over_limit_step,
        ex_boost: character.ex_boost ? { status_id: character.ex_boost.status_id, ability_id_list: [...character.ex_boost.ability_id_list] } : null,
        mana_node_ids: character.mana_node_ids ? [...character.mana_node_ids] : null,
        illustration_settings: character.illustration_settings ? [...character.illustration_settings] : null
    }
}

/** A `battle_party` that passed battlePartySchema, with only the fields party/refer sends and only owned slots. */
export function normaliseBattleParty(party: PartyCodeBattleParty, owned: PartyOwnership): PartyCodeBattleParty {
    return {
        characters: party.characters.map(character => normaliseCharacter(character, owned)),
        unison_characters: party.unison_characters.map(character => normaliseCharacter(character, owned)),
        equipments: party.equipments.map(equipment => equipment && owned.ownsEquipment(equipment.equipment_id)
            ? { equipment_id: equipment.equipment_id, level: equipment.level } : null),
        ability_soul_ids: party.ability_soul_ids.map(id => id ?? null)
    }
}
