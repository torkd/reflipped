// Titles (degrees): the ones a player owns, from degree missions (FT-2) and title mail (FT-4).

import degreeIds from "../../assets/degree.json";
import { getPlayerDegreesSync, getPlayerSync } from "../data/wdfpData";

/** Every player owns title 1 ("World Voyager", `degree_default`); it isn't stored. */
export const DEFAULT_DEGREE_ID = 1

const knownDegreeIds = new Set<number>(degreeIds)

/** Whether the game has a title (`master/degree/degree`). */
export function isKnownDegree(degreeId: number): boolean {
    return knownDegreeIds.has(degreeId)
}

/**
 * The titles a player owns, ascending: the default title, the stored ones, and the title the player has set (an
 * imported save keeps its title but brings no title list).
 */
export function getPlayerOwnedDegreeIdsSync(playerId: number): number[] {
    const owned = new Set([DEFAULT_DEGREE_ID, ...getPlayerDegreesSync(playerId)])
    const degreeId = getPlayerSync(playerId)?.degreeId
    if (degreeId !== undefined && isKnownDegree(degreeId)) owned.add(degreeId)
    return [...owned].sort((a, b) => a - b)
}
