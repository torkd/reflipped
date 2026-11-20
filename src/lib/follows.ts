// Follows and other players' profiles (FT-15). A player follows another by viewer ID. The ID the game shows players
// and searches by (follow/search_kakao_pid) is the Kakao player ID, Reflipped's account number (`kakao_pid` below);
// the search takes a viewer ID too. Two players who follow each other are mutuals. The client's FollowState: 0 none, 1 mutual, 2 following (I follow them), 3 follower (they follow me); its
// follow list splits follow/lists' `follow_info` into the Follow, Followers and Mutuals tabs by that state. Limits
// come from the game's config (`config/config_iosbundled`, columns 12 and 13): 300 follows, 1500 followers.

import { PartyCategory } from "../data/types";
import {
    addCoopPartnerBattleSync, countPlayerFollowersSync, countPlayerFollowingSync, getAccountFromPlayerIdSync, getCoopPartnerBattlesSync, getPlayerCharacterSync, getPlayerFollowersSync,
    getPlayerFollowingSync, getPlayerFollowTimeSync, getPlayerPartyGroupListSync, getPlayerProfileSettingsSync, getPlayerPublicViewerIdSync,
    getPlayerSync, getViewerPlayerIdSync, insertPlayerFollowSync
} from "../data/wdfpData";
import { playerRankSync } from "./assets";
import { getCharactersEvolutionImgLevels } from "./character";
import { profileInfoSync, PROFILE_PARTY_CATEGORY } from "./profile";

export const MAX_FOLLOWS = 300
export const MAX_FOLLOWERS = 1500

/** follow/add's result codes: the player follows too many (FollowCountOver), the other has too many followers. */
export const FOLLOW_COUNT_OVER = 1451
export const PARTNER_FOLLOWED_COUNT_OVER = 1452
/** follow/search_kakao_pid's "player not found" (the client also knows 1457 and 1459 for it). */
export const PLAYER_NOT_FOUND = 1455

export const FollowState = { NONE: 0, MUTUAL: 1, FOLLOWING: 2, FOLLOWER: 3 } as const

/** How `playerId` stands towards `otherId`. */
export function followStateSync(playerId: number, otherId: number): number {
    if (playerId === otherId) return FollowState.NONE
    const following = getPlayerFollowTimeSync(playerId, otherId) !== null
    const follower = getPlayerFollowTimeSync(otherId, playerId) !== null
    return following && follower ? FollowState.MUTUAL : following ? FollowState.FOLLOWING : follower ? FollowState.FOLLOWER : FollowState.NONE
}

export function isMutualFollowSync(a: number, b: number): boolean {
    return followStateSync(a, b) === FollowState.MUTUAL
}

/**
 * Co-op (`establisher_follow` in room lists, searches and invitations): how the player with `viewerId` stands towards
 * the room's host. NONE when either viewer ID is unknown.
 */
export function establisherFollowSync(viewerId: number, hostViewerId: number): number {
    const playerId = getViewerPlayerIdSync(viewerId)
    const hostId = getViewerPlayerIdSync(hostViewerId)
    return playerId === null || hostId === null ? FollowState.NONE : followStateSync(playerId, hostId)
}

/** Whether the player follows the host: a mutual or a follower, from the host's side. */
export function followsHost(state: number): boolean {
    return state === FollowState.MUTUAL || state === FollowState.FOLLOWING
}

/**
 * The follow bonus (FT-43): score a co-op battle adds for every mutual follow among its players. The guides of the time
 * say it is for mutual follows only, starts at 10 points and grows with every co-op battle played together, up to
 * +9990 (gamerch.com/worldflipper/113644, world-flipper.hatenablog.jp/entry/2020/03/30/111909). Reflipped gives 10
 * per battle the pair has played to the end together as mutuals (both sent `finish`), this one included, and caps a
 * player's total at 9990. A battle counts only once both players finish it: one counted at its start could be raised
 * to the cap by starting and abandoning battles, which cost nothing (a mutual's guest pays no stamina, an abort gives
 * the host's back).
 *
 * The client (QuestStartRealRemote, the battle's score calculator) reads `follow_bonus_info` from the co-op start reply:
 * each player's `follow_bonus_list` (a map of mate viewer ID → bonus), and `total_follow_bonus`, which the battle adds
 * to its score as the `follow_bonus` score bonus (master `score/score_bonus`, kind FollowBonus, threshold 10) before the
 * time multiplier. A player missing from the list counts 0.
 */
export const FOLLOW_BONUS_STEP = 10
export const FOLLOW_BONUS_CAP = 9990

export interface FollowBonusInfo {
    viewer_id: number
    follow_bonus_list: Record<string, number>
    total_follow_bonus: number
}

/** Two mutual follows playing a round together; their battle is counted once both have finished it. */
export interface FollowBonusPair {
    viewerIds: [number, number]
    playerIds: [number, number]
    finished: number[]
    counted: boolean
}

/** A co-op round's follow bonus: the start reply's list, and the pairs whose battle counts once they finish it. */
export interface FollowBonusRound {
    info: FollowBonusInfo[]
    pairs: FollowBonusPair[]
}

/**
 * The follow bonus of a co-op round's players (viewer IDs), this battle included for every pair of mutual follows
 * among them. Nothing is counted yet: see `noteFollowBonusFinishSync`.
 */
export function followBonusRoundSync(viewerIds: number[]): FollowBonusRound {
    const players = [...new Set(viewerIds)]
        .map(viewerId => ({ viewerId, playerId: getViewerPlayerIdSync(viewerId) }))
        .filter((entry): entry is { viewerId: number, playerId: number } => entry.playerId !== null)
    const lists = new Map(players.map(player => [player.viewerId, {} as Record<string, number>]))
    const pairs: FollowBonusPair[] = []
    for (const [index, player] of players.entries()) {
        for (const mate of players.slice(index + 1)) {
            if (player.playerId === mate.playerId || !isMutualFollowSync(player.playerId, mate.playerId)) continue
            const bonus = Math.min(FOLLOW_BONUS_STEP * (getCoopPartnerBattlesSync(player.playerId, mate.playerId) + 1), FOLLOW_BONUS_CAP)
            lists.get(player.viewerId)![String(mate.viewerId)] = bonus
            lists.get(mate.viewerId)![String(player.viewerId)] = bonus
            pairs.push({ viewerIds: [player.viewerId, mate.viewerId], playerIds: [player.playerId, mate.playerId], finished: [], counted: false })
        }
    }
    const info = players.map(({ viewerId }) => {
        const list = lists.get(viewerId)!
        const total = Object.values(list).reduce((sum, bonus) => sum + bonus, 0)
        return { "viewer_id": viewerId, "follow_bonus_list": list, "total_follow_bonus": Math.min(total, FOLLOW_BONUS_CAP) }
    })
    return { info, pairs }
}

/** A player finished the round's battle (`finish`, not `abort`): each of its pairs counts the battle once both have. */
export function noteFollowBonusFinishSync(round: FollowBonusRound | undefined, viewerId: number): void {
    for (const pair of round?.pairs ?? []) {
        if (pair.counted || !pair.viewerIds.includes(viewerId)) continue
        if (!pair.finished.includes(viewerId)) pair.finished.push(viewerId)
        if (pair.viewerIds.every(id => pair.finished.includes(id))) {
            addCoopPartnerBattleSync(pair.playerIds[0], pair.playerIds[1])
            pair.counted = true
        }
    }
}

const seconds = (date: Date) => Math.floor(date.getTime() / 1000)

/** A player's main party: the party the leader comes from, and the units other players see. */
function mainPartyCharacterIds(playerId: number): (number | null)[] {
    const slot = String(getPlayerSync(playerId)?.partySlot ?? 1)
    for (const group of Object.values(getPlayerPartyGroupListSync(playerId, PartyCategory.NORMAL))) {
        const party = group.list[slot]
        if (party !== undefined) return party.characterIds.slice(0, 3)
    }
    return [null, null, null]
}

function leaderOf(playerId: number): { id: number, evolutionLevel: number } {
    const fallback = getPlayerSync(playerId)?.leaderCharacterId ?? 1
    const id = mainPartyCharacterIds(playerId).find((characterId): characterId is number => characterId !== null) ?? fallback
    return { id, evolutionLevel: getCharactersEvolutionImgLevels(playerId, [id])[0] ?? 0 }
}

/**
 * A FollowInfo (follow/lists, the searches): who the other player is, as `playerId` sees them. null when the other
 * player has no viewer ID yet (an account that never signed up), as nobody could have found them.
 */
export function followInfoSync(playerId: number, otherId: number): Record<string, unknown> | null {
    const other = getPlayerSync(otherId)
    const viewerId = getPlayerPublicViewerIdSync(otherId)
    if (other === null || viewerId === null) return null
    const followTime = getPlayerFollowTimeSync(playerId, otherId)
    const followedTime = getPlayerFollowTimeSync(otherId, playerId)
    const leader = leaderOf(otherId)
    return {
        "viewer_id": viewerId,
        "kakao_pid": String(getAccountFromPlayerIdSync(otherId)?.id ?? ""),
        "name": other.name,
        "rank": playerRankSync(other.rankPoint),
        "role": other.role,
        "comment": other.comment,
        "degree_id": other.degreeId,
        "profile_image_url": null,
        "last_login_time": seconds(other.lastLoginTime),
        "follow_state": followStateSync(playerId, otherId),
        "follow_time": followTime === null ? null : seconds(followTime),
        "followed_time": followedTime === null ? null : seconds(followedTime),
        "leader_character_id": leader.id,
        "leader_character_evolution_img_level": leader.evolutionLevel
    }
}

/** follow/lists: everyone the player follows or is followed by, and how many follow them. */
export function followListsSync(playerId: number): { follow_info: Record<string, unknown>[], followed_count: number } {
    const others = new Set([...getPlayerFollowingSync(playerId), ...getPlayerFollowersSync(playerId)].map(follow => follow.playerId))
    const info = [...others].map(otherId => followInfoSync(playerId, otherId)).filter((entry): entry is Record<string, unknown> => entry !== null)
    return { "follow_info": info, "followed_count": countPlayerFollowersSync(playerId) }
}

export type FollowOutcome = "followed" | "already" | "self" | "count-over" | "partner-over"

/** Follows a player, within both players' limits. */
export function followPlayerSync(playerId: number, targetId: number, now: Date): FollowOutcome {
    if (playerId === targetId) return "self"
    if (getPlayerFollowTimeSync(playerId, targetId) !== null) return "already"
    if (countPlayerFollowingSync(playerId) >= MAX_FOLLOWS) return "count-over"
    if (countPlayerFollowersSync(targetId) >= MAX_FOLLOWERS) return "partner-over"
    insertPlayerFollowSync(playerId, targetId, now)
    return "followed"
}

/**
 * The favourite units another player sees (FT-36's party category 99), without making the set: a player who never
 * opened their own profile shows their main party's units.
 */
function favouriteCharacterIds(playerId: number): { characters: (number | null)[], unisons: (number | null)[] } {
    for (const group of Object.values(getPlayerPartyGroupListSync(playerId, PROFILE_PARTY_CATEGORY))) {
        const party = Object.values(group.list)[0]
        if (party !== undefined) return { characters: party.characterIds.slice(0, 3), unisons: party.unisonCharacterIds.slice(0, 3) }
    }
    return { characters: mainPartyCharacterIds(playerId), unisons: [null, null, null] }
}

function exBoostOf(playerId: number, characterId: number | null): Record<string, unknown> | null {
    if (characterId === null) return null
    const exBoost = getPlayerCharacterSync(playerId, characterId)?.exBoost
    return exBoost === undefined ? null : { "status_id": exBoost.statusId, "ability_id_list": exBoost.abilityIdList }
}

/**
 * profile/get_profile: another player's profile as `playerId` sees it. The counts the target hides with their
 * show/hide settings are null (the client's `Option`).
 */
export function otherProfileSync(playerId: number, targetId: number): Record<string, unknown> | null {
    const target = getPlayerSync(targetId)
    const viewerId = getPlayerPublicViewerIdSync(targetId)
    if (target === null || viewerId === null) return null
    const info = profileInfoSync(targetId)
    const settings = getPlayerProfileSettingsSync(targetId)
    const shown = (show: boolean, value: number) => show ? value : null
    const favourite = favouriteCharacterIds(targetId)
    const owned = (ids: (number | null)[]) => ids.map(id => id !== null && getPlayerCharacterSync(targetId, id) !== null ? id : null)
    const characters = owned(favourite.characters)
    const unisons = owned(favourite.unisons)
    return {
        "target_user_info": {
            "viewer_id": viewerId,
            "kakao_pid": String(getAccountFromPlayerIdSync(targetId)?.id ?? ""),
            "name": target.name,
            "rank": playerRankSync(target.rankPoint),
            "role": target.role,
            "comment": target.comment,
            "degree_id": target.degreeId,
            "follow_state": followStateSync(playerId, targetId),
            "leader_character_full_shot_evolution_level": leaderOf(targetId).evolutionLevel,
            "owned_character_count": shown(settings.showOwnedCharacterCount, info.owned_character_count),
            "max_owned_character_count": shown(settings.showOwnedCharacterCount, info.max_owned_character_count),
            "opened_mana_board_second_count": shown(settings.showOpenedManaBoardSecondCount, info.opened_mana_board_second_count),
            "max_opened_mana_board_second_count": shown(settings.showOpenedManaBoardSecondCount, info.max_opened_mana_board_second_count),
            "owned_degree_count": shown(settings.showOwnedDegreeCount, info.owned_degree_count),
            "max_owned_degree_count": shown(settings.showOwnedDegreeCount, info.max_owned_degree_count)
        },
        "favorite_character": {
            "character_ids": characters,
            "unison_character_ids": unisons,
            "character_ex_boost": characters.map(id => exBoostOf(targetId, id)),
            "unison_character_ex_boost": unisons.map(id => exBoostOf(targetId, id))
        }
    }
}
