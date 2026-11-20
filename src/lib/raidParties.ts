// The party group a player started their current raid battle with (FT-12): kept until the finish, which stores it with
// the record if the battle sets the quest's best score (src/lib/raid.ts). Like the active quest, it lives in memory.

import { RaidRecord } from "../data/wdfpData";

const battleParties = new Map<number, RaidRecord["party"]>()

export function setRaidBattleParty(playerId: number, party: RaidRecord["party"]) {
    battleParties.set(playerId, party)
}

/** The party group of the player's current raid battle, and forgets it. */
export function takeRaidBattleParty(playerId: number): RaidRecord["party"] {
    const party = battleParties.get(playerId) ?? []
    battleParties.delete(playerId)
    return party
}
