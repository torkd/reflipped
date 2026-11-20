import { boardHiddenPlayers } from "./anticheat";
// Suggested parties (FT-50): every battle's quest detail has a button that sends quest/get_recent_other_player_party
// ({ category, quest_id }) and lists other players' parties that cleared the quest; the player can copy one. The
// client (QuestGetRecentOtherPlayerPartyRemote) reads `recent_other_player_party`, each entry with party_name (String),
// power (Int) and, per slot, character_id_N, unison_character_id_N, equipment_id_N, ability_soul_id_N,
// evolution_img_level_N and unison_evolution_img_level_N (Int or null). It refuses the whole reply if a field has
// another type, and looks every id up in its master data (an unknown one stops it with C8601).
//
// A won single_battle_quest/finish keeps the party as the player's latest for that quest (one per player and quest),
// with only the units, armaments and Ability Cores (assets/ability_soul.json; cores are items) the player owns and the
// game has, and the party's power score at that moment (src/lib/partyPower.ts, the client's own formula; the panel
// shows the value it is sent). Guess: how many, the newest 10 other players.

import abilitySoulIds from "../../assets/ability_soul.json";
import { getEquipmentMaxLevelSync, getCharacterDataSync } from "./assets";
import { getCharactersEvolutionImgLevels } from "./character";
import { partySlotIds } from "./borderRewards";
import { partyPowerSync } from "./partyPower";
import { getPlayerCharacterSync, getPlayerEquipmentSync, getPlayerItemSync, getPlayerPartyBySlotSync, getRecentQuestPartiesSync, RecentQuestParty, upsertPlayerRecentQuestPartySync } from "../data/wdfpData";

/** How many parties the reply lists. */
export const recentPartyCount = 10

const SLOTS = 3

/** The battle statistics' party, as single_battle_quest/finish sends it. */
export interface StatisticsParty {
    characters?: unknown
    unison_characters?: unknown
    equipments?: unknown
    ability_soul_ids?: unknown
}

function slots(ids: (number | null)[]): (number | null)[] {
    return Array.from({ length: SLOTS }, (_, slot) => ids[slot] ?? null)
}

const knownCharacter = (id: number | null): id is number => id !== null && getCharacterDataSync(id) !== null
const knownEquipment = (id: number | null): id is number => id !== null && getEquipmentMaxLevelSync(id) !== null
const abilitySouls = new Set<number>(abilitySoulIds)
const knownAbilitySoul = (id: number | null): id is number => id !== null && abilitySouls.has(id)

/**
 * Keeps the party of a won battle as the player's latest for the quest. `partySlot` is the party the battle started
 * with (players.party_slot); its name is used only if its main units are the battle's, since a co-op battle may not
 * have set it.
 */
export function recordRecentQuestPartySync(playerId: number, category: number, questId: number, party: StatisticsParty, partySlot: number, date: Date) {
    const owned = (id: number | null) => knownCharacter(id) && getPlayerCharacterSync(playerId, id) !== null ? id : null
    const characters = slots(partySlotIds(party.characters)).map(owned)
    const unisonCharacters = slots(partySlotIds(party.unison_characters)).map(owned)
    const equipments = slots(partySlotIds(party.equipments))
        .map(id => knownEquipment(id) && getPlayerEquipmentSync(playerId, id) !== null ? id : null)
    const souls = slots(partySlotIds(party.ability_soul_ids))
        .map(id => knownAbilitySoul(id) && (getPlayerItemSync(playerId, id) ?? 0) > 0 ? id : null)
    if (characters.every(id => id === null)) return

    const stored = getPlayerPartyBySlotSync(playerId, partySlot)
    const sameParty = stored !== null && stored.characterIds.every((id, slot) => (id ?? null) === characters[slot])
    upsertPlayerRecentQuestPartySync(playerId, category, questId, {
        name: sameParty ? stored.name : "",
        characters,
        unisonCharacters,
        equipments,
        abilitySouls: souls,
        evolutionImgLevels: getCharactersEvolutionImgLevels(playerId, characters),
        unisonEvolutionImgLevels: getCharactersEvolutionImgLevels(playerId, unisonCharacters),
        power: partyPowerSync(playerId, characters.map((character, slot) => ({
            character,
            unisonCharacter: unisonCharacters[slot],
            equipment: equipments[slot],
            abilitySoul: souls[slot]
        })))
    }, date)
}

function clientEntry(party: RecentQuestParty): Record<string, unknown> {
    // a stored id the game no longer has (master data changed) is left out rather than stop the client
    const character = (id: number | null | undefined) => knownCharacter(id ?? null) ? id : null
    const level = (characterId: number | null | undefined, level: number | null | undefined) =>
        knownCharacter(characterId ?? null) && typeof level === "number" ? level : null
    const entry: Record<string, unknown> = {
        "party_name": typeof party.name === "string" ? party.name : "",
        // parties stored before the power was kept have none
        "power": typeof party.power === "number" && Number.isSafeInteger(party.power) ? party.power : 0
    }
    for (let slot = 0; slot < SLOTS; slot++) {
        const n = slot + 1
        entry[`character_id_${n}`] = character(party.characters?.[slot])
        entry[`unison_character_id_${n}`] = character(party.unisonCharacters?.[slot])
        entry[`equipment_id_${n}`] = knownEquipment(party.equipments?.[slot] ?? null) ? party.equipments[slot] : null
        entry[`ability_soul_id_${n}`] = knownAbilitySoul(party.abilitySouls?.[slot] ?? null) ? party.abilitySouls[slot] : null
        entry[`evolution_img_level_${n}`] = level(party.characters?.[slot], party.evolutionImgLevels?.[slot])
        entry[`unison_evolution_img_level_${n}`] = level(party.unisonCharacters?.[slot], party.unisonEvolutionImgLevels?.[slot])
    }
    return entry
}

/** The reply's `recent_other_player_party`: other players' latest clearing parties of the quest, newest first. */
export function recentOtherPlayerPartiesSync(playerId: number, category: number, questId: number): Record<string, unknown>[] {
    // parties of developer-mode players (everything unlocked) and restricted players aren't suggestions to others (SEC-18)
    return getRecentQuestPartiesSync(category, questId, playerId, recentPartyCount, boardHiddenPlayers()).map(clientEntry)
        .filter(entry => [1, 2, 3].some(n => entry[`character_id_${n}`] !== null))
}
