// The co-op boss events (FT-23, `hard_multi_event`, "For The Reckoning ... Steambot"; four runs from May to December
// 2024): one co-op quest per event, played like an advent boss, with a special reward a player receives only while they
// have a daily count left. The count is the event's periodic reward point (`reward/periodic_reward_point`, mail type
// 15), refilled at the daily reset (src/lib/rewardPoints.ts: 2 a day, kept up to 99). A won battle with a count left
// spends one and drops the quest's periodic reward group (`reward/periodic_reward`: the event's augment gear, 9 of
// them): the finish reply names the drop in `drop_periodic_reward_ids` (`group_id`, `index`, `number`) and carries the
// new count in `user_periodic_reward_point_list`, which the client applies (`processQuestFinish`). Without a count left
// the battle pays its usual rewards only. Converted by scripts/converter.py (`convert_hard_multi_event_quest`,
// `convert_periodic_reward`).
//
// Each event unlocks on its own conditions (`game_system_unlock`, the event's `unlockSystem`: player rank 120, the
// Necropolis' Beast of the Abyss and the event's Descension boss on Godly cleared). The client hides a locked event;
// the server checks the same conditions when a host creates a room or starts the battle (a co-op guest is let in by
// the room, like the period check).

import hardMultiEventQuests from "../../assets/hard_multi_event_quest.json";
import periodicRewards from "../../assets/periodic_reward.json";
import { getPlayerPeriodicRewardPointValueSync } from "./rewardPoints";
import { setPlayerPeriodicRewardPointSync } from "../data/wdfpData";
import { creditEarnedItemSync } from "./rewardCredits";
import { scaleEarnedAmount } from "./rewardPolicy";
import { RewardType } from "./types";
import { systemUnlockRefusal } from "./questAttempts";

interface HardMultiQuestRewards {
    /** the event's `game_system_unlock` key (e.g. `hard_multi_red`) */
    unlockSystem?: string
    /** the `reward/periodic_reward` group a rewarded clear drops */
    periodicRewardGroup?: number
    /** the event's periodic reward point: the daily count a rewarded clear spends */
    periodicRewardPointId?: number
}

interface PeriodicReward {
    index: number
    /** 0, an item, in every row */
    rewardType: number
    id: number
    count: number
    weight: number
}

const quests = hardMultiEventQuests as Record<string, HardMultiQuestRewards>
const groups = periodicRewards as Record<string, PeriodicReward[]>

export interface PeriodicRewardDrop {
    group_id: number
    index: number
    number: number
}

export interface PeriodicRewardResult {
    /** `drop_periodic_reward_ids` */
    drops: PeriodicRewardDrop[]
    /** the new totals of the items received, for the reply's `item_list` */
    items: Record<string, number>
    /** `user_periodic_reward_point_list`: the spent count's new value; empty when none was spent */
    points: { id: number, point: number }[]
}

/** Why the player can't play a co-op boss quest yet (its event's unlock conditions), or null when they can. */
export function hardMultiUnlockRefusal(playerId: number, questId: number): string | null {
    const system = quests[String(questId)]?.unlockSystem
    return system === undefined ? null : systemUnlockRefusal(playerId, system)
}

const NOTHING: PeriodicRewardResult = { drops: [], items: {}, points: [] }

/**
 * A won co-op boss battle's special reward: when the quest has one and the player has a daily count left, spends one
 * and gives every entry of the quest's periodic reward group (one each in the master data), scaled like other earned
 * items and capped at what the player may own.
 */
export function givePeriodicRewardSync(playerId: number, questId: number, rewardMultiplier?: number): PeriodicRewardResult {
    const quest = quests[String(questId)]
    if (quest?.periodicRewardGroup === undefined || quest.periodicRewardPointId === undefined) return NOTHING
    const rewards = groups[String(quest.periodicRewardGroup)] ?? []
    const left = getPlayerPeriodicRewardPointValueSync(playerId, quest.periodicRewardPointId)
    if (rewards.length === 0 || left <= 0) return NOTHING

    setPlayerPeriodicRewardPointSync(playerId, quest.periodicRewardPointId, left - 1)
    const result: PeriodicRewardResult = { drops: [], items: {}, points: [{ id: quest.periodicRewardPointId, point: left - 1 }] }
    for (const reward of rewards) {
        if (reward.rewardType !== RewardType.ITEM) continue
        const credited = creditEarnedItemSync(playerId, reward.id, scaleEarnedAmount(reward.count, "item", reward.id, rewardMultiplier))
        result.items[String(reward.id)] = credited.total
        result.drops.push({ group_id: quest.periodicRewardGroup, index: reward.index, number: credited.amount })
    }
    return result
}
