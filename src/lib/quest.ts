import { randomInt } from "crypto";
import { clientSerializeDate } from "../data/utils";
import { getPlayerEquipmentSync, getPlayerItemSync, getPlayerCharacterSync, getPlayerSync, givePlayerItemSync, updatePlayerSync } from "../data/wdfpData";
import { getRareScoreRewardGroup } from "./assets";
import { givePlayerCharacterSync } from "./character";
import { givePlayerEquipmentSync } from "./equipment";
import { CharacterReward, CommonScoreReward, CurrencyReward, CurrencyScoreReward, DropScoreRewardId, EquipmentItemReward, GivePlayerScoreRewardsResult, ItemScoreReward, PlayerRewardResult, RareScoreRewardGroup, Reward, RewardType, ScoreReward, ScoreRewardType } from "./types";
import { creditEarnedCurrencySync, creditEarnedItemSync } from "./rewardCredits";
import { playerLimits } from "./limits";
import { currentEarningMultiplier, isRunCurrency, runProgress, scaleEarnedAmount, scaleEarnedReward } from "./rewardPolicy";
import { currentRunSpeed } from "./eventSchedule";
import { NO_BOOSTS, RewardBoosts } from "./rewardCampaigns";
import { itemBoost } from "./bossBattlePickup";
import { Player } from "../data/types";
import rewardElementMap from "../../assets/reward_element_map.json";

/** `reward/reward_element_map` kinds: the reward types they convert (6 element, 7 aether, the client's QuestRewardKind). */
const ELEMENT_REWARD_KINDS: Record<number, string> = { 6: "1", 7: "2" }

/**
 * The item of an element or aether reward (type 6 or 7; for a score reward entry, its `reward_type`):
 * `reward/reward_element_map` picks it by the reward's rarity (its id) and the quest's enemy element (the converter
 * derives it from the quest's recommended element, as the client does). Undefined for any other reward, or when the
 * quest has no enemy element in the assets (the daily quests, FT-26).
 */
export function elementRewardItemId(type: number, rarity: number, enemyElement?: number): number | undefined {
    const kind = ELEMENT_REWARD_KINDS[type]
    if (kind === undefined || enemyElement === undefined) return undefined
    return (rewardElementMap as Record<string, Record<string, Record<string, number>>>)[kind]?.[String(rarity)]?.[String(enemyElement)]
}

/**
 * A rare score reward with an element or aether reward turned into the item it gives (see `elementRewardItemId`).
 * Any other reward, or one without an item, is returned as it is, and grants nothing as before.
 */
export function resolveElementReward(reward: Reward, enemyElement?: number): Reward {
    const element = reward as Reward as EquipmentItemReward
    const itemId = elementRewardItemId(reward.type as number, element.id, enemyElement)
    if (itemId === undefined) return reward
    return { type: RewardType.ITEM, id: itemId, count: element.count } as Reward as EquipmentItemReward
}

/**
 * How a score reward group pays out, from the master data and the two captured finish replies
 * (`docs/routes/{single,multi}_battle_quest_finish.md`):
 *  - a `type 1` entry is one slot of a rare pool: it hits with its `rarity`, then picks one reward of the pool by the
 *    pool's own `rarity` weights (every pool's weights add up to 1). Quest 2006's group has 15 slots of rarity 1, and
 *    its reply lists 15 drops.
 *  - the `type 0` entries are one weighted lottery: `field5` is the weight in 1/1000, most groups add up to 1000 (one
 *    drop per draw), the others to less (a draw can drop nothing). One entry drops its fixed `count`, never the whole
 *    group: group 11000209 (counts 30 to 50, weights 105/90/100/70/35) dropped 35, 40, 45 and 30 in turn in the
 *    captured boss reply, not 30 + 35 + 40 + 45 + 50.
 * The type 0 lottery is drawn once for every "roll" of the quest: the master row's column right before its score reward
 * group (10 for most story event quests, 13 to 20 for bosses, 30 or 40 for the tower dungeons; 18 for the captured
 * boss, whose reply has 9 hits of a 40 % group). `scoreRewardDrops.rolls` is only the fallback for a quest without
 * it and for the callers that pass none. `random` is the one source of randomness, replaceable in tests.
 */
export const scoreRewardDrops = {
    rolls: 10,
    random: (): number => randomInt(0, 2 ** 30) / 2 ** 30,
}

/**
 * One weighted draw: the index of the entry the point lands on, or -1 when it lands past the weights (a draw that
 * drops nothing). `span` is the width the point is drawn over, at least the weights' sum.
 */
export function drawWeighted(weights: number[], span = weights.reduce((sum, weight) => sum + weight, 0)): number {
    let point = scoreRewardDrops.random() * span
    return weights.findIndex(weight => (point -= weight) < 0)
}

/** The index of the reward a rare pool gives: its own `rarity` values are weights that add up to 1. */
export function pickFromRarePool(pool: Reward[]): number {
    const weights = pool.map(reward => Math.max(0, (reward as { rarity?: number }).rarity ?? 0))
    const span = weights.reduce((sum, weight) => sum + weight, 0)
    if (span <= 0) return Math.min(pool.length - 1, Math.floor(scoreRewardDrops.random() * pool.length))
    const picked = drawWeighted(weights, span)
    return picked < 0 ? pool.length - 1 : picked
}

/** The weight of a fixed (type 0) score reward entry, in 1/1000 (1000 when the entry has none). */
export function fixedWeight(reward: ScoreReward): number {
    const weight = (reward as { field5?: number }).field5
    return Math.max(0, typeof weight === "number" && Number.isFinite(weight) ? weight : 1000)
}

/**
 * Grants a player score rewards: see `scoreRewardDrops` for how a group pays out.
 * 
 * @param playerId The ID of the player.
 * @param groupId The ID of the score reward group.
 * @param scoreRewards The score rewards inside of the group.
 * @param enemyElement The quest's enemy element, for element and aether rewards (see `resolveElementReward`).
 * @param boosts The open reward campaigns' rates (FT-37): every item, mana and exp drop by its kind's rate, before the
 *   reward multiplier (which only scales some currencies).
 * @param runSpeed The playing run's speed (`currentRunSpeed()`): event shop currencies drop that many times.
 * @returns A result detailing what was added/changed.
 */
/**
 * A drop's count at a reward campaign's rate (FT-37). Drops are mostly one item, which a rounded-down 1.5 would never
 * raise, so the fraction is paid by chance: on average the drop pays the rate, as the client's expected drops show.
 */
export function boostedCount(count: number, rate: number): number {
    if (rate === 1 || count <= 0) return count
    const exact = count * rate
    const whole = Math.floor(exact)
    return whole + (scoreRewardDrops.random() < exact - whole ? 1 : 0)
}

/** A rare drop at the campaign rate of its kind: items by the item rate (Boss Coins by theirs), mana and exp by theirs. */
function boostedReward(reward: Reward, boosts: RewardBoosts): Reward {
    const rate = reward.type === RewardType.ITEM ? itemBoost(boosts, (reward as EquipmentItemReward).id) : reward.type === RewardType.MANA ? boosts.mana : reward.type === RewardType.EXP ? boosts.exp : 1
    if (rate === 1 || !("count" in reward)) return reward
    return { ...reward, count: boostedCount((reward as CurrencyReward).count, rate) } as Reward
}

export function givePlayerScoreRewardsSync(
    playerId: number,
    groupId?: number,
    scoreRewards?: ScoreReward[],
    boostPointUsed: boolean = false,
    enemyElement?: number,
    rewardMultiplier?: number,
    rolls: number = scoreRewardDrops.rolls,
    boosts: RewardBoosts = NO_BOOSTS,
    runSpeed: number = currentRunSpeed()
): GivePlayerScoreRewardsResult {
    const base = rewardMultiplier ?? currentEarningMultiplier()

    const dropScoreRewardIds: DropScoreRewardId[] = []
    const dropRareRewardIds: DropScoreRewardId[] = []

    let mana = 0
    let vmoney = 0
    let expPool = 0
    let joinedCharacterIdList: number[] = []
    let characterList: Object[] = []
    let equipmentList: Object[] = []
    let items: Record<string, number> = {}

    if (scoreRewards !== undefined && groupId !== undefined) {
        const fixed = scoreRewards.map((reward, position) => ({ reward, index: position + 1 }))
            .filter(entry => entry.reward.type === ScoreRewardType.ITEM)

        // the fixed items: `rolls` draws of one weighted lottery
        if (fixed.length > 0) {
            const weights = fixed.map(entry => fixedWeight(entry.reward))
            const span = Math.max(1000, weights.reduce((sum, weight) => sum + weight, 0))
            for (let draw = 0; draw < rolls; draw++) {
                const hit = drawWeighted(weights, span)
                if (hit < 0) continue
                const reward = fixed[hit].reward as CommonScoreReward
                let rewardAmount = 0

                // an element or aether entry (reward_type 6 or 7, its id the rarity) gives an item like an item entry
                const elementItemId = elementRewardItemId(reward.reward_type, (reward as ItemScoreReward).id, enemyElement)
                switch (elementItemId === undefined ? reward.reward_type : RewardType.ITEM) {
                    case RewardType.ITEM: {
                        const itemReward = reward as ItemScoreReward
                        const itemId = elementItemId ?? itemReward.id
                        // an event shop currency is the run's progress: it drops at the run's speed (FT-32)
                        const count = isRunCurrency(itemId) ? runProgress(itemReward.count, runSpeed) : itemReward.count
                        rewardAmount = scaleEarnedAmount(boostedCount(count * (boostPointUsed ? 2 : 1), itemBoost(boosts, itemId)), "item", itemId, base)
                        const credited = creditEarnedItemSync(playerId, itemId, rewardAmount)
                        rewardAmount = credited.amount
                        items[String(itemId)] = credited.total
                        break;
                    }
                    case RewardType.MANA: {
                        const currencyReward = reward as CurrencyScoreReward
                        rewardAmount = scaleEarnedAmount(boostedCount(currencyReward.count * (boostPointUsed ? 2 : 1), boosts.mana), "mana", undefined, base)
                        rewardAmount = creditEarnedCurrencySync(playerId, "mana", rewardAmount).amount
                        mana += rewardAmount
                        break;
                    }
                    case RewardType.EXP: {
                        const currencyReward = reward as CurrencyScoreReward
                        rewardAmount = scaleEarnedAmount(boostedCount(currencyReward.count * (boostPointUsed ? 2 : 1), boosts.exp), "exp", undefined, base)
                        rewardAmount = creditEarnedCurrencySync(playerId, "exp", rewardAmount).amount
                        expPool += rewardAmount
                        break;
                    }
                }

                dropScoreRewardIds.push({
                    group_id: groupId,
                    index: fixed[hit].index,
                    number: rewardAmount
                })
            }
        }

        // the rare pool slots: one chance each
        for (const scoreReward of scoreRewards) {
            if (scoreReward.type !== ScoreRewardType.RARE_POOL) continue
            const slot = scoreReward as RareScoreRewardGroup
            if (!(scoreRewardDrops.random() < slot.rarity)) continue

            const rareGroupId = slot.id
            const group = getRareScoreRewardGroup(rareGroupId)
            if (group === null || group.length === 0) continue

            const picked = pickFromRarePool(group)

            const resolved = resolveElementReward(group[picked], enemyElement)
            const item = resolved.type === RewardType.ITEM ? resolved as EquipmentItemReward : undefined
            const runScaled = item !== undefined && isRunCurrency(item.id) ? { ...item, count: runProgress(item.count, runSpeed) } : resolved
            const reward = scaleEarnedReward(boostedReward(runScaled, boosts), base)
            const ownedBefore = ownedRewardCountSync(playerId, reward)
            const result = givePlayerRewardsSync(playerId, [reward], true)
            if (!result) continue

            // merge arrays
            mana += result.user_info.free_mana
            vmoney += result.user_info.free_vmoney
            expPool += result.user_info.exp_pool
            joinedCharacterIdList = [...joinedCharacterIdList, ...result.joined_character_id_list]
            characterList = [...characterList, ...result.character_list]
            equipmentList = [...equipmentList, ...result.equipment_list]

            // merge items
            for (const [itemId, count] of Object.entries(result.items)) {
                items[itemId] = count
            }

            // add reward id to table
            dropRareRewardIds.push({
                group_id: rareGroupId,
                index: picked + 1,
                number: Math.max(0, ownedRewardCountSync(playerId, reward) - ownedBefore)
            })
        }
    }

    return {
        drop_score_reward_ids: dropScoreRewardIds,
        drop_rare_reward_ids: dropRareRewardIds,
        user_info: {
            free_mana: mana,
            free_vmoney: vmoney,
            exp_pool: expPool
        },
        character_list: characterList,
        joined_character_id_list: joinedCharacterIdList,
        equipment_list: equipmentList,
        items: items
    }
}

/**
 * Batch gives a specific player data an array of rewards.
 * 
 * @param playerId The ID of the player to reward.
 * @param rewards The array of rewards to give.
 * @returns A PlayerRewardResult.
 */
export function givePlayerRewardsSync(
    playerId: number,
    rewards: Reward[],
    earned: boolean = false
): PlayerRewardResult | null {
    let mana = 0
    let vmoney = 0
    let expPool = 0
    let joinedCharacterIdList: number[] = []
    let characters: Map<number, Object> = new Map()
    let equipment: Map<number, Object> = new Map()
    let items: Map<number, number> = new Map()

    for (const reward of rewards) {
        switch (reward.type) {
            case RewardType.ITEM: {
                const convertedReward = (reward as EquipmentItemReward)
                const itemId = convertedReward.id
                const result = earned ? creditEarnedItemSync(playerId, itemId, convertedReward.count).total : givePlayerItemSync(playerId, itemId, convertedReward.count)
                items.set(itemId, earned ? result : (items.get(itemId) ?? 0) + result)
                break;
            }
            case RewardType.EQUIPMENT: {
                const convertedReward = (reward as EquipmentItemReward)
                const equipmentId = convertedReward.id
                const owned = getPlayerEquipmentSync(playerId, equipmentId)
                const amount = earned ? Math.min(convertedReward.count, Math.max(0, playerLimits.equipmentCopies - (owned === null ? 0 : owned.stack + 1))) : convertedReward.count
                if (earned && amount <= 0) break
                const result = givePlayerEquipmentSync(playerId, equipmentId, amount)
                equipment.set(equipmentId, result)
                break;
            }
            case RewardType.CHARACTER: {
                const characterId = (reward as CharacterReward).id
                const giveResult = givePlayerCharacterSync(playerId, characterId, earned)

                const giveItem = giveResult?.item
                if (giveItem !== undefined) {
                    const itemId = giveItem.id
                    items.set(itemId, earned ? getPlayerItemSync(playerId, itemId) ?? 0 : (items.get(itemId) ?? 0) + giveItem.count)
                }
    
                const giveCharacter = giveResult?.character
                if (giveCharacter !== undefined) {
                    characters.set(characterId, giveCharacter)
                }
                break;
            }
            case RewardType.BEADS: {
                vmoney += earned ? creditEarnedCurrencySync(playerId, "beads", (reward as CurrencyReward).count).amount : (reward as CurrencyReward).count
                break;
            }
            case RewardType.MANA: {
                mana += earned ? creditEarnedCurrencySync(playerId, "mana", (reward as CurrencyReward).count).amount : (reward as CurrencyReward).count
                break;
            }
            case RewardType.EXP: {
                expPool += earned ? creditEarnedCurrencySync(playerId, "exp", (reward as CurrencyReward).count).amount : (reward as CurrencyReward).count
                break;
            }
        }
    }

    if (!earned && (mana > 0 || vmoney > 0 || expPool > 0)) {
        // get player
        const player = getPlayerSync(playerId)
        if (player === null) return null;

        updatePlayerSync({
            id: playerId,
            freeVmoney: player.freeVmoney + vmoney,
            freeMana: player.freeMana + mana,
            expPool: player.expPool + expPool
        })
    }
    
    // build return values
    const characterList: Object[] = []
    const equipmentList: Object[] = []
    const itemsRecord: Record<string, number> = {}
    
    characters.forEach(character => {
        characterList.push(character)
    })

    equipment.forEach(equipment => {
        equipmentList.push(equipment)
    })

    items.forEach((number, id) => {
        itemsRecord[id] = number
    })

    return {   
        user_info: {
            free_mana: mana,
            free_vmoney: vmoney,
            exp_pool: expPool
        },
        character_list: characterList,
        joined_character_id_list: joinedCharacterIdList,
        equipment_list: equipmentList,
        items: itemsRecord
    }
}

/**
 * Gives a player a specific reward.
 * 
 * @param playerId The ID of the player.
 * @param reward The reward to give.
 * @returns A PlayerRewardResult.
 */
export function givePlayerRewardSync(
    playerId: number,
    reward: Reward
): PlayerRewardResult | null {
    return givePlayerRewardsSync(playerId, [reward])
}

/** Earned quest rewards are scaled once before the generic grant function; purchases use the generic function. */
export function givePlayerEarnedRewardsSync(playerId: number, rewards: Reward[], rewardMultiplier?: number): PlayerRewardResult | null {
    return givePlayerRewardsSync(playerId, rewards.map(reward => scaleEarnedReward(reward, rewardMultiplier)), true)
}
export function givePlayerEarnedRewardSync(playerId: number, reward: Reward, rewardMultiplier?: number): PlayerRewardResult | null {
    return givePlayerEarnedRewardsSync(playerId, [reward], rewardMultiplier)
}

/** Inventory deltas make drop counts match credits after caps, including mixed and repeated score rewards. */
function ownedRewardCountSync(playerId: number, reward: Reward): number {
    const id = (reward as EquipmentItemReward).id
    if (reward.type === RewardType.ITEM) return getPlayerItemSync(playerId, id) ?? 0
    if (reward.type === RewardType.CHARACTER) { const owned = getPlayerCharacterSync(playerId, id); return owned === null ? 0 : owned.stack + 1 }
    if (reward.type === RewardType.EQUIPMENT) { const owned = getPlayerEquipmentSync(playerId, id); return owned === null ? 0 : owned.stack + 1 }
    const player = getPlayerSync(playerId)
    return reward.type === RewardType.BEADS ? player?.freeVmoney ?? 0 : reward.type === RewardType.MANA ? player?.freeMana ?? 0 : player?.expPool ?? 0
}
