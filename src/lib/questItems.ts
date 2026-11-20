// Quests that take items (FT-8): the Treasure Zone takes a Golden Skull (item 500000) on every clear, the Abyss
// bosses (challenge dungeon 1038-1040) and three advent quests an event item on every clear, and nine world story
// quests an item on their first clear only (the item unlocks them). The client asks "Start ... by using ...?" and
// says "The item(s) will only be used up once the quest has been cleared" (worldflipper.wiki.gg, "Treasure Zone":
// "You will not consume an additional Golden Skull until you have cleared the quest"), and refuses to start without
// them ("You do not have the necessary item(s) to start this quest."); this does the same for a client that asks
// anyway, and takes them on the clear.
//
// Challenge dungeon quests also need the quest the game shows them after (`viewable_need_quest_1`): main quest 1-8-4
// for the Treasure Zone, the floor before for a Depths quest.

import { getPlayerItemSync, givePlayerItemSync } from "../data/wdfpData";
import { referencedQuestClearedSync } from "./questAttempts";
import { BattleQuest } from "./types";

type ItemQuest = Pick<BattleQuest, "useItems" | "needQuest">

/** The items a quest takes on this clear: every clear, or the first for a quest that takes them once. */
function itemsDue(quest: ItemQuest, clearedBefore: boolean): { id: number, count: number }[] {
    if (quest.useItems === undefined || (!quest.useItems.always && clearedBefore)) return []
    return quest.useItems.items
}

/** Why a quest can't start for want of its items or of the quest before it, or null when it can. */
export function questItemsStartRefusal(playerId: number, quest: ItemQuest, clearedBefore: boolean): string | null {
    if (quest.needQuest !== undefined && !referencedQuestClearedSync(playerId, quest.needQuest.kind, quest.needQuest.questId)) {
        return `Needs quest ${quest.needQuest.questId} cleared first.`
    }
    for (const item of itemsDue(quest, clearedBefore)) {
        if ((getPlayerItemSync(playerId, item.id) ?? 0) < item.count) return "You do not have the necessary item(s) to start this quest."
    }
    return null
}

/**
 * Takes the items a clear uses and returns the new counts for the reply's `item_list`. A player who no longer has
 * them (spent elsewhere since the start) still keeps the clear, with the count kept at 0.
 */
export function takeQuestItemsSync(playerId: number, quest: ItemQuest, clearedBefore: boolean): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const item of itemsDue(quest, clearedBefore)) {
        const owned = getPlayerItemSync(playerId, item.id) ?? 0
        counts[String(item.id)] = givePlayerItemSync(playerId, item.id, -Math.min(owned, item.count))
    }
    return counts
}
