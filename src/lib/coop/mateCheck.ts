/**
 * The lobby mate a client sends (`Enter` / `ChangeParty`, docs/coop-protocol.md) as its save has it (SEC-15). The other
 * players' games show and simulate the party from the mate, so a client could otherwise show a name, a rank or units
 * it doesn't have. The player's own choices (which units and armaments, its battle settings) are kept; everything the
 * save knows comes from the save: name, rank, title, and each unit's and armament's growth. A unit, armament or ability
 * soul the player doesn't own becomes an empty slot.
 *
 * Every client, the sender included, builds that player's battle from this mate (the lobby's Start), so what comes
 * back here is what the player fights with.
 */
import { getPlayerCharacterManaNodesSync, getPlayerCharactersSync, getPlayerEquipmentListSync, getPlayerItemsSync, getPlayerSync } from "../../data/wdfpData"
import { clampEquipmentLevel, playerRankSync } from "../assets"

type Json = any

/** Option<T> as the client sends it: Some(x) = [0, x], None = [1]. */
const NONE = [1]
const some = (value: Json) => [0, value]
const optionValue = (option: Json): Json | undefined => Array.isArray(option) && option[0] === 0 ? option[1] : undefined
const optionList = (value: Json): Json[] => Array.isArray(value) ? value : []

/** The mate with what the save knows taken from the save; null if the player doesn't exist. */
export function checkMateAgainstSave(playerId: number, mate: Json): Json | null {
    const player = getPlayerSync(playerId)
    if (player === null) return null
    const characters = getPlayerCharactersSync(playerId)
    const equipment = getPlayerEquipmentListSync(playerId)
    const items = getPlayerItemsSync(playerId)

    const character = (option: Json) => {
        const id = optionValue(option)?.id
        const owned = Number.isSafeInteger(id) ? characters[String(id)] : undefined
        if (owned === undefined) return NONE
        const sent = optionValue(option)
        return some({
            ...sent,
            id,
            evolution_level: owned.evolutionLevel,
            exp: owned.exp,
            over_limit_step: owned.overLimitStep,
            mana_node_ids: getPlayerCharacterManaNodesSync(playerId, id),
            ex_boost: owned.exBoost === undefined ? NONE : some({ status_id: owned.exBoost.statusId, ability_id_list: owned.exBoost.abilityIdList }),
            illustration_settings: owned.illustrationSettings === undefined ? NONE : some(owned.illustrationSettings)
        })
    }
    const armament = (option: Json) => {
        const id = optionValue(option)?.equipmentId
        const owned = Number.isSafeInteger(id) ? equipment[String(id)] : undefined
        if (owned === undefined) return NONE
        // capped like every HTTP reply that carries it (/load, the equipment routes), so the battle has the level the
        // client was shown
        return some({ equipmentId: id, level: clampEquipmentLevel(id, owned.level), enhancementLevel: owned.enhancementLevel })
    }
    // An ability soul is an item whose id is its armament's id (selling an armament gives it), not the armament: the
    // party screen offers the souls in the player's items, one slot per copy held.
    const soulsLeft = new Map<number, number>()
    const soul = (option: Json) => {
        const id = optionValue(option)
        if (!Number.isSafeInteger(id)) return NONE
        const left = soulsLeft.get(id) ?? items[String(id)] ?? 0
        if (left < 1) return NONE
        soulsLeft.set(id, left - 1)
        return some(id)
    }

    const party = mate?.party ?? {}
    return {
        ...mate,
        name: player.name,
        rank: playerRankSync(player.rankPoint),
        degreeId: player.degreeId,
        party: {
            ...party,
            characters: optionList(party.characters).map(character),
            unison_characters: optionList(party.unison_characters).map(character),
            equipments: optionList(party.equipments).map(armament),
            abilitySoulIds: optionList(party.abilitySoulIds).map(soul)
        }
    }
}
