// The player's own profile (FT-36, Menu → Profile): profile/get_my_profile's counts, the show/hide settings and the
// favourite units ("Fav. Units"), plus renaming. The client keeps the favourite units as a party set of their own,
// party category 99 (its "Profile" party group source), saved through party/edit like the event party sets; /load
// never sends it. Titles and the comment have their own routes (profile/update_degree, update_comment).

import characters from "../../assets/character.json";
import degrees from "../../assets/degree.json";
import { PartyCategory, PlayerPartyGroup } from "../data/types";
import { getPlayerCharacterBoardsSync, getPlayerPartyGroupListSync, getPlayerProfileSettingsSync, getPlayerSync, insertPlayerPartyGroupListSync, ProfileSettings } from "../data/wdfpData";
import { getPlayerOwnedDegreeIdsSync } from "./degrees";

/** The client's party category for the profile's favourite units. */
export const PROFILE_PARTY_CATEGORY = 99 as PartyCategory

/**
 * The longest player name: the game's config (`config/config_iosbundled` column 15, `max_player_name_length`), which
 * caps the name box (its `maxChars`). The tutorial's notice says 10, but the box takes 20.
 */
export const PLAYER_NAME_MAX_LENGTH = 20

/**
 * The units the profile counts: every unit of the character table except the 7xxxxx event and guest units and the
 * 999999 placeholder (454, the captured `max_owned_character_count`). Those with more than three skills have a second
 * mana board (397, the captured `max_opened_mana_board_second_count`), as when a unit joins (src/lib/character.ts).
 */
const characterTable = characters as Record<string, { skill_count: number }>
const profileCharacterIds = new Set(Object.keys(characterTable).filter(id => !id.startsWith("7") && id !== "999999").map(Number))
const secondBoardCharacterIds = new Set([...profileCharacterIds].filter(id => characterTable[String(id)].skill_count > 3))

export function profileInfoSync(playerId: number): Record<string, number> {
    const owned = getPlayerCharacterBoardsSync(playerId).filter(character => profileCharacterIds.has(character.id))
    return {
        "owned_character_count": owned.length,
        "max_owned_character_count": profileCharacterIds.size,
        "opened_mana_board_second_count": owned.filter(character => secondBoardCharacterIds.has(character.id) && character.manaBoardIndex >= 2).length,
        "max_opened_mana_board_second_count": secondBoardCharacterIds.size,
        "owned_degree_count": getPlayerOwnedDegreeIdsSync(playerId).length,
        "max_owned_degree_count": (degrees as unknown[]).length
    }
}

export function serializeProfileSettings(settings: ProfileSettings): Record<string, boolean> {
    return {
        "show_owned_character_count": settings.showOwnedCharacterCount,
        "show_opened_mana_board_second_count": settings.showOpenedManaBoardSecondCount,
        "show_owned_degree_count": settings.showOwnedDegreeCount
    }
}

export function profileSettingsReplySync(playerId: number): Record<string, boolean> {
    return serializeProfileSettings(getPlayerProfileSettingsSync(playerId))
}

/**
 * The favourite units' party set, made the first time: one group (1, colour 7) of one party (1), as captured, holding
 * the units of the player's main party, which the player owns.
 */
export function ensureProfilePartySync(playerId: number): Record<string, PlayerPartyGroup> {
    const existing = getPlayerPartyGroupListSync(playerId, PROFILE_PARTY_CATEGORY)
    if (Object.keys(existing).length > 0) return existing

    const mainSlot = getPlayerSync(playerId)?.partySlot ?? 1
    const mainParty = Object.values(getPlayerPartyGroupListSync(playerId, PartyCategory.NORMAL))
        .map(group => group.list[String(mainSlot)]).find(party => party !== undefined)
    const groups: Record<string, PlayerPartyGroup> = {
        "1": {
            colorId: 7,
            category: PROFILE_PARTY_CATEGORY,
            list: {
                "1": {
                    name: "Setting Favorite Units",
                    characterIds: mainParty?.characterIds.slice(0, 3) ?? [1, null, null],
                    unisonCharacterIds: [null, null, null],
                    equipmentIds: [null, null, null],
                    abilitySoulIds: [null, null, null],
                    edited: false,
                    options: { allowOtherPlayersToHealMe: true },
                    category: PROFILE_PARTY_CATEGORY
                }
            }
        }
    }
    insertPlayerPartyGroupListSync(playerId, groups)
    return groups
}

/** The favourite units as get_my_profile's `user_party_group_list` sends them. */
export function profilePartyGroupListSync(playerId: number): Record<string, unknown>[] {
    return Object.entries(ensureProfilePartySync(playerId)).map(([groupId, group]) => ({
        "party_group_id": Number(groupId),
        "party_group_color_id": group.colorId,
        "party_list": Object.entries(group.list).map(([partyId, party]) => ({
            "party_id": Number(partyId),
            "party_group_id": Number(groupId),
            "party_name": party.name,
            "character_ids": party.characterIds,
            "unison_character_ids": party.unisonCharacterIds,
            "equipment_ids": party.equipmentIds,
            "ability_soul_ids": party.abilitySoulIds,
            "options": { "allow_other_players_to_heal_me": party.options.allowOtherPlayersToHealMe },
            "party_edited": party.edited
        }))
    }))
}

/**
 * Whether a new player name is acceptable: 1 to 20 characters after trimming, with no control characters. A refused
 * one gets the client's "word can't be used" dialog (result code 207), as a banned word did.
 */
export function playerNameProblem(name: string): string | null {
    const trimmed = name.trim()
    const length = [...trimmed].length
    if (length === 0) return "empty"
    if (length > PLAYER_NAME_MAX_LENGTH) return "too long"
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(trimmed)) return "control character"
    return null
}
