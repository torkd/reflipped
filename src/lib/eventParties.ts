// Event party sets (the rush event's and the Hanifolk Carnival's, FT-11): the client keeps them apart from the normal
// parties by party category (its party group sources: 2 the Carnival, 3 raids, 4 the rush event) and saves them
// through party/edit like any other. A player who has none yet starts with a copy of their normal parties; raid sets
// have a layout of their own (raidPartyGroupsSync).

import { PartyCategory, PlayerParty, PlayerPartyGroup } from "../data/types";
import { deletePlayerPartyGroupListSync, getPlayerCharactersSync, getPlayerPartyGroupListSync, insertPlayerPartyGroupListSync } from "../data/wdfpData";
import { QuestCategory } from "./types";

/** The client's party categories for event party sets. */
export const CARNIVAL_PARTY_CATEGORY = 2 as PartyCategory
export const RAID_PARTY_CATEGORY = 3 as PartyCategory

/**
 * The party category a battle of this quest category plays its party from when it starts through
 * single_battle_quest/start (SEC-18 R6 snapshots the start party from it). In the client (0.0.81) only three quest
 * kinds have a party group source of their own: the Carnival (2), raids (3) and the rush event (4); every other kind
 * plays a normal party. Raids and the rush event start through their own routes, so a slot here means nothing for
 * them: null, and R6 is skipped.
 */
export function startPartyCategory(questCategory: number): PartyCategory | null {
    if (questCategory === QuestCategory.CARNIVAL_EVENT) return CARNIVAL_PARTY_CATEGORY
    if (questCategory === QuestCategory.RAID_EVENT || questCategory === QuestCategory.RUSH_EVENT) return null
    return PartyCategory.NORMAL
}

/**
 * The raid sets' layout (FT-12, FT-76), as the master `player/player_party_raid_event` has it: 6 sets of 3 parties,
 * numbered 1-18 in order (set g holds 3g-2 to 3g), named Party A to C. The client plays every party of the chosen set
 * in the battle, the first as the player's own (Main) and the others run by the AI (Sub): the raid start sequence's
 * remoteFinishedHandler (client 0.0.81) makes one battle member per party of the group, labelled with the UI strings
 * `raid_event_party_main` and `raid_event_party_sub` + its index. It refuses to start while a unit is in two parties of
 * the set (RaidEventBattleStartableState.DuplicatedCharacters, from the group's getDuplicatedCharacterIds). The wiki
 * says the same: "you must form 3 parties", "a unit can only be used once across all parties", while armaments and
 * Ability Cores may repeat (https://worldflipper.wiki.gg/wiki/Raid_Event:_Sagas_of_Conquest_Event).
 */
export const RAID_SET_COUNT = 6
export const RAID_SET_PARTY_COUNT = 3
const RAID_PARTY_NAMES = ["Party A", "Party B", "Party C"]

/** Whether stored raid sets have that layout (the sets copied from the normal parties before FT-76 held 10 each). */
function isRaidLayout(groups: Record<string, PlayerPartyGroup>): boolean {
    if (Object.keys(groups).length !== RAID_SET_COUNT) return false
    for (let set = 1; set <= RAID_SET_COUNT; set++) {
        const slots = Object.keys(groups[String(set)]?.list ?? {}).map(Number).sort((a, b) => a - b)
        const expected = Array.from({ length: RAID_SET_PARTY_COUNT }, (_, index) => (set - 1) * RAID_SET_PARTY_COUNT + index + 1)
        if (slots.join() !== expected.join()) return false
    }
    return true
}

function emptyParty(leader: number): PlayerParty {
    return {
        name: "", characterIds: [leader, null, null], unisonCharacterIds: [null, null, null], equipmentIds: [null, null, null],
        abilitySoulIds: [null, null, null], edited: false, options: { allowOtherPlayersToHealMe: true }, category: RAID_PARTY_CATEGORY
    }
}

/**
 * New raid sets, with no unit in two parties of a set. The master's own default puts the starting unit (id 1) in each
 * party, which the client refuses as duplicates, so each set is filled from parties the player already built instead:
 * their old raid set of that number (sets stored in the old layout) and then the normal party group of that number,
 * in party order. A party is taken when its leader isn't in the set yet, without any other unit the set already holds;
 * a party still missing gets the first owned unit the set doesn't hold as its only member. Only a player with fewer
 * units than that keeps the master's default there (the starting unit), which the client shows as a duplicate.
 */
export function buildRaidSets(
    oldSets: Record<string, PlayerPartyGroup>,
    normal: Record<string, PlayerPartyGroup>,
    ownedCharacterIds: number[]
): Record<string, PlayerPartyGroup> {
    const sets: Record<string, PlayerPartyGroup> = {}
    for (let set = 1; set <= RAID_SET_COUNT; set++) {
        const sources = [oldSets[String(set)], normal[String(set)]].flatMap(group =>
            Object.entries(group?.list ?? {}).sort(([a], [b]) => Number(a) - Number(b)).map(([, party]) => party))
        const used = new Set<number>()
        const parties: PlayerParty[] = []
        const take = (party: PlayerParty) => {
            const keep = (id: number | null | undefined) => id === null || id === undefined || used.has(id) ? null : id
            const characterIds = [0, 1, 2].map(slot => keep(party.characterIds[slot]))
            const unisonCharacterIds = [0, 1, 2].map(slot => keep(party.unisonCharacterIds[slot]))
            for (const id of [...characterIds, ...unisonCharacterIds]) if (id !== null) used.add(id)
            parties.push({ ...party, characterIds, unisonCharacterIds })
        }
        for (const party of sources) {
            if (parties.length === RAID_SET_PARTY_COUNT) break
            const leader = party.characterIds[0]
            if (leader !== null && leader !== undefined && !used.has(leader)) take(party)
        }
        while (parties.length < RAID_SET_PARTY_COUNT) {
            const leader = ownedCharacterIds.find(id => !used.has(id))
            if (leader === undefined) parties.push(emptyParty(1))
            else take(emptyParty(leader))
        }
        const list: Record<string, PlayerParty> = {}
        parties.forEach((party, index) => {
            list[String((set - 1) * RAID_SET_PARTY_COUNT + index + 1)] = { ...party, name: RAID_PARTY_NAMES[index], category: RAID_PARTY_CATEGORY }
        })
        sets[String(set)] = { list, colorId: oldSets[String(set)]?.colorId ?? normal[String(set)]?.colorId ?? 15, category: RAID_PARTY_CATEGORY }
    }
    return sets
}

/** A player's raid sets: built the first time, and rebuilt once if they are stored in another layout. */
function raidPartyGroupsSync(playerId: number): Record<string, PlayerPartyGroup> {
    const groups = getPlayerPartyGroupListSync(playerId, RAID_PARTY_CATEGORY)
    if (isRaidLayout(groups)) return groups
    const owned = Object.keys(getPlayerCharactersSync(playerId)).map(Number).sort((a, b) => a - b)
    const sets = buildRaidSets(groups, getPlayerPartyGroupListSync(playerId, PartyCategory.NORMAL), owned)
    deletePlayerPartyGroupListSync(playerId, RAID_PARTY_CATEGORY)
    insertPlayerPartyGroupListSync(playerId, sets)
    return sets
}

/** A category's party groups as `user_party_group_list` sends them, copied from the normal parties the first time. */
export function eventPartyGroupListSync(playerId: number, category: PartyCategory): Record<string, unknown>[] {
    let groups = category === RAID_PARTY_CATEGORY ? raidPartyGroupsSync(playerId) : getPlayerPartyGroupListSync(playerId, category)
    if (Object.keys(groups).length === 0) {
        groups = getPlayerPartyGroupListSync(playerId, PartyCategory.NORMAL)
        for (const group of Object.values(groups)) {
            for (const party of Object.values(group.list)) party.category = category
            group.category = category
        }
        insertPlayerPartyGroupListSync(playerId, groups)
    }
    return Object.entries(groups).map(([groupId, group]) => ({
        "party_group_color_id": group.colorId,
        "party_group_id": Number(groupId),
        "party_list": Object.entries(group.list).map(([partyId, party]) => ({
            "ability_soul_ids": party.abilitySoulIds,
            "character_ids": party.characterIds,
            "equipment_ids": party.equipmentIds,
            "unison_character_ids": party.unisonCharacterIds,
            "options": { "allow_other_players_to_heal_me": party.options.allowOtherPlayersToHealMe },
            "party_edited": party.edited,
            "party_id": Number(partyId),
            "party_name": party.name
        }))
    }))
}
