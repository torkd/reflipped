// Collect item events' quest drops (FT-2, the treasure hunts: `reward/event/collect_item_event` kinds 0 and 1). While
// an event runs, the quests its `collect_item_event_quest_relation` names drop its item: one draw from every additional
// reward group of the quest's reward relation whose lowest enemy level the quest's enemy level reaches (the client lists
// the same groups as the quest's extra drops, `getAdditionalRewardGroupIdsByEnemyLevel`). The finish reply names each
// drop in `drop_additional_reward_ids` (`group_id`, `index`, `number`), and the items go straight to the player. A kind 1
// event's items are then spent in its shop (the event item shop, event type 9).
//
// Every group the client lists drops, not only the highest tier reached: `getAdditionalRewardGroupIdsByEnemyLevel` returns
// them all, though no capture confirms the amounts a clear gave. The rows hold one reward each (weight 1). Boost points
// don't raise them (the event's help, `rich_text/help_event_treasure_hunter`: "Kaleidoscope Drops are not affected by the
// reward bonuses granted by Boss Boost Points and Kaleidoscope Boost Points").

import collectItemDrops from "../../assets/collect_item_event_drops.json";
import { masterDate } from "../utils";
import { isContentPeriodOpen } from "./eventSchedule";
import { drawWeighted } from "./quest";
import { IdLists, rangeCovers } from "./questRanges";
import { creditEarnedItemSync } from "./rewardCredits";
import { runProgress, scaleEarnedAmount } from "./rewardPolicy";
import { DropScoreRewardId, QuestCategory } from "./types";

interface DropData {
    events: Record<string, { kind: number, itemId: number, start: string, end: string, exchangeEnd: string | null }>
    quests: Record<string, { kind: number, ids: IdLists, tiers: { minEnemyLevel: number, groupId: number }[] }[]>
    additionalRewards: Record<string, { index: number, kind: number, id: number, amount: number, weight: number }[]>
}

const data = collectItemDrops as DropData

/** QuestRewardKind 0: an item. The tables hold no other kind. */
const ITEM_REWARD = 0

/** The additional reward groups a quest draws from at a date: those of every running event covering it. */
export function collectItemDropGroups(category: QuestCategory, questId: number, enemyLevel: number | undefined, date: Date): number[] {
    if (enemyLevel === undefined) return []
    const groups: number[] = []
    for (const [eventId, event] of Object.entries(data.events)) {
        // projected like every event's period when event scheduling is on (src/lib/eventSchedule.ts)
        if (!isContentPeriodOpen(masterDate(event.start).getTime(), masterDate(event.end).getTime(), date)) continue
        for (const relation of data.quests[eventId] ?? []) {
            if (!rangeCovers(relation.kind, relation.ids, category, questId)) continue
            for (const tier of relation.tiers) if (tier.minEnemyLevel <= enemyLevel) groups.push(tier.groupId)
        }
    }
    return groups
}

export interface CollectItemDropResult {
    drops: DropScoreRewardId[]
    /** the items' new totals, for the reply's item list */
    items: Record<string, number>
}

/** Draws and gives a cleared quest's collect item event drops; the event's item is its run's progress, at `runSpeed` (FT-32). */
export function giveCollectItemDropsSync(playerId: number, category: QuestCategory, questId: number, enemyLevel: number | undefined,
    date: Date, rewardMultiplier?: number, runSpeed = 1): CollectItemDropResult {
    const result: CollectItemDropResult = { drops: [], items: {} }
    for (const groupId of collectItemDropGroups(category, questId, enemyLevel, date)) {
        const rows = data.additionalRewards[String(groupId)] ?? []
        const hit = drawWeighted(rows.map(row => row.weight))
        if (hit < 0) continue
        const row = rows[hit]
        if (row.kind !== ITEM_REWARD) continue
        const amount = scaleEarnedAmount(runProgress(row.amount, runSpeed), "item", row.id, rewardMultiplier)
        const credited = creditEarnedItemSync(playerId, row.id, amount)
        result.items[String(row.id)] = credited.total
        result.drops.push({ group_id: groupId, index: row.index, number: credited.amount })
    }
    return result
}
