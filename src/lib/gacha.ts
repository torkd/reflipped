/**
 * Handles gacha summoning.
 * Right now all characters in a gacha's pool have an equal chance of being summoned.
 */

import { randomInt } from "crypto";
import movieSeeds from "../../assets/gacha_movie_seeds.json";
import rateUpMovieSeeds from "../../assets/gacha_rate_up_movie_seeds.json";
import { PlayerBoxGachaDrawnReward } from "../data/types";
import { givePlayerCharacterSync } from "./character";
import { givePlayerEquipmentSync } from "./equipment";
import { givePlayerRewardsSync } from "./quest";
import { BoxGachaBox, BoxGachaDrawResult, BoxGachaIdReward, BoxGachaRewardTier, BoxGachaRewardType, CharacterGacha, CharacterReward, CurrencyReward, EquipmentItemReward, Gacha, GachaCharacterDraw, GachaDrawResult, GachaDraws, GachaMovieSeeds, GachaMovieType, GachaType, PlayerRewardResult, Reward, RewardPlayerGachaDrawResult, RewardType } from "./types";

const rankMovieRates = [
    [ // 5*
        80,
        20
    ],
    [ // 4*
        80,
        20
    ],
    [
        100
    ]
]

export interface GachaResult {
    characterId: number,
    movieId: string,
    seed: number,
    entryCount: number
}

export interface SummonResult {
    freeVmoney: number,
    vmoney: number,
    pulls: GachaResult[],
}

/**
 * Selects a random index from a weighted pool.
 * 
 * @param min The minimum random value to pick.
 * @param max The maximum random value to pick.
 * @param pool The pool to select the random index from.
 * @returns The index that was selected. null if nothing was selected.
 */
export function randomPoolItem(
    min: number,
    max: number,
    pool: number[]
): number | null {
    let roll = randomInt(min, max)

    let offset = 0;
    let index = 0
    for (const rate of pool) {
        if ((rate + offset) >= roll) return index;
        offset += rate;
        index += 1;
    }
    return null;
}

/**
 * Picks an index of `weights` with the chance weight / sum of the weights (null if they are all 0). Weights are whole
 * numbers, as the master data gives them.
 */
export function randomWeightedIndex(weights: number[]): number | null {
    const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0)
    if (total <= 0) return null
    let roll = randomInt(0, total)
    for (let index = 0; index < weights.length; index++) {
        roll -= Math.max(0, weights[index])
        if (roll < 0) return index
    }
    return null
}

/** Pool keys in star order: "1" 5 stars, "2" 4 stars, "3" 3 stars. */
const RANK_KEYS = ["1", "2", "3"] as const
const rankStars = (key: string) => 6 - Number(key)

/**
 * A portal's star weights for one pull, from its master rarity table (`rankWeights`, e.g. 5 / 25 / 70, or 75 / 250 /
 * 675 on a festival portal). A guaranteed pull drops the ranks under `guaranteeRarity` and adds their weight to that
 * rank (5 / 95), as the client's odds page (GachaOdds getRarityWeight) shows it.
 */
export function gachaRankWeights(gacha: Gacha, guaranteed: boolean): number[] {
    return RANK_KEYS.map(key => {
        const stars = rankStars(key)
        const weight = gacha.rankWeights[key] ?? 0
        if (!guaranteed) return weight
        if (stars < gacha.guaranteeRarity) return 0
        if (stars > gacha.guaranteeRarity) return weight
        return RANK_KEYS.filter(other => rankStars(other) <= stars).reduce((sum, other) => sum + (gacha.rankWeights[other] ?? 0), 0)
    })
}

export function drawGachaSync(
    gacha: Gacha,
    drawAmount: number,
    /** every pull at the guaranteed rates (at least 4 stars): the 4 & 5-Star Portal Ticket (FT-14) */
    guaranteed: boolean = false
): GachaDrawResult {
    const normalWeights = gachaRankWeights(gacha, false)
    const guaranteedWeights = gachaRankWeights(gacha, true)
    const guaranteeNumber = Math.max(0, gacha.guaranteeNumber)

    const pulls: Map<number, number> = new Map()

    for (let drawNumber = 0; drawNumber < drawAmount; drawNumber++) {
        // the last `guaranteeNumber` pulls (1 on every portal) of each full 10 are guaranteed; a single pull never is
        const inTen = drawNumber % 10
        const tenIsFull = drawNumber - inTen + 10 <= drawAmount
        const weights = guaranteed || (tenIsFull && inTen >= 10 - guaranteeNumber) ? guaranteedWeights : normalWeights

        // the rank, then a unit of it by the master odds (rate-up units have more)
        const rank = randomWeightedIndex(weights)
        const ratePool = rank === null ? undefined : gacha.pool[RANK_KEYS[rank]]
        if (ratePool === undefined || ratePool.length === 0) throw new Error(`portal pool has no rank ${rank === null ? "?" : RANK_KEYS[rank]}`)
        const selectedItem = ratePool[randomWeightedIndex(ratePool.map(item => item.odds)) ?? 0]
        pulls.set(selectedItem.id, (pulls.get(selectedItem.id) ?? 0) + 1)
    }

    return pulls
}

export function rewardPlayerGachaDrawResultSync(
    playerId: number,
    gacha: Gacha,
    gachaDrawResult: GachaDrawResult
): RewardPlayerGachaDrawResult {

    const draws: GachaDraws = []
    const characters: Map<number, Object> = new Map()
    const equipment: Map<number, Object> = new Map()
    const items: Map<number, number> = new Map()

    if (gacha.type == GachaType.CHARACTER) {
        const characterGacha = gacha as CharacterGacha
        // reward characters
        for (const [characterId, amount] of gachaDrawResult) {
            for (let n = 0; n < amount; n++) {
                const giveResult = givePlayerCharacterSync(playerId, characterId)
                
                if (giveResult !== null) {
                    // get character rarity
                    const rarity = Math.floor(characterId / 100000) - 1
                    // decide on movie
                    const movieType = randomPoolItem(1, 101, rankMovieRates[rarity]) ?? GachaMovieType.NORMAL

                    // pick a seed
                    const isRateUp = (gacha as CharacterGacha).movieName !== "normal"
                    const seeds = ((isRateUp ? rateUpMovieSeeds : movieSeeds) as GachaMovieSeeds)[rarity + 1][movieType]
                    const seedIndex = randomInt(0, seeds.length + 1)

                    // build draw
                    const draw: GachaCharacterDraw = {
                        "character_id": characterId,
                        "movie_id": movieType === GachaMovieType.NORMAL ? characterGacha.movieName : characterGacha.guaranteeMovieName,
                        "seed": seeds[seedIndex] ?? seeds[0],
                        "entry_count": 1
                    }
                    
                    // set values in items map, characters map, and draws array.
                    const giveItem = giveResult.item
                    if (giveItem !== undefined) {
                        draw['ex_boost_item'] = giveItem // add ex_boost_item to draw
                        items.set(giveItem.id, (items.get(giveItem.id) ?? 0) + giveItem.count)
                    }

                    const existingCharacter = characters.get(characterId)
                    if (existingCharacter) {
                        characters.set(characterId, {...existingCharacter, ...giveResult.character})
                    } else {    
                        characters.set(characterId, giveResult.character)
                    }
                    draws.push(draw)
                }

            }
        }
    } else {
        for (const [equipmentId, amount] of gachaDrawResult) {
            const giveResult = givePlayerEquipmentSync(playerId, equipmentId, amount);

            equipment.set(equipmentId, giveResult)
            for (let i = 0; i < amount; i++) {
                draws.push({
                    "equipment_id": equipmentId,
                    "treasure_up_type": 0    
                })
            }
        }
    }
    
    const returnCharacters: Object[] = [];
    for (const value of characters.values()) {
        returnCharacters.push(value)
    }

    const returnEquipment: Object[] = []
    for (const value of equipment.values()) {
        returnEquipment.push(value)
    }
    
    const returnItems: Record<number, number> = {}
    for (const [itemId, amount] of items) {
        returnItems[itemId] = amount
    }

    return {
        draw: draws,
        characters: returnCharacters,
        equipment: returnEquipment,
        items: returnItems
    }
}

/**
 * Performs box gacha draws.
 * 
 * @param rewards A record, where the key is the reward id and the value is a BoxGachaReward
 * @param drawnRewards The current draws the player has made on the box gacha.
 * @param drawAmount The number of draws to perform.
 */
export function drawBoxGachaSync(
    rewards: BoxGachaBox,
    drawnRewards: PlayerBoxGachaDrawnReward[],
    drawAmount: number, // the number of times to draw
    stopOnFeaturedReward: boolean = false
): BoxGachaDrawResult {
    // build drawn reward map
    const drawnRewardsMap = new Map(drawnRewards.map(reward => [reward.id, reward.number]))

    const rewardsPool: string[] = []
    for (const [rewardId, reward] of Object.entries(rewards)) {
        for (let i = 0; i < (reward.available - (drawnRewardsMap.get(Number(rewardId)) ?? 0)); i++) {
            rewardsPool.push(rewardId)
        }
    }

    let drawnMana = 0
    let drawnExp = 0
    const drawnCharacters: Map<number, number> = new Map()
    const drawnEquipment: Map<number, number> = new Map()
    const drawnItems: Map<number, number> = new Map()
    const sessionDrawnRewards: Map<string, number> = new Map()

    let totalDraws = 0

    for (let n = 0; n < drawAmount && rewardsPool.length > 0; n++) {
        const rollIndex = randomInt(rewardsPool.length)
        const rewardId = rewardsPool[rollIndex]
        const reward = rewards[rewardId]

        switch (reward.type) {
            case BoxGachaRewardType.ITEM: {
                const itemId = (reward as BoxGachaIdReward).id
                drawnItems.set(itemId, (drawnItems.get(itemId) ?? 0) + reward.count)
                break;
            }
            case BoxGachaRewardType.EQUIPMENT: {
                const equipmentId = (reward as BoxGachaIdReward).id
                drawnEquipment.set(equipmentId, (drawnEquipment.get(equipmentId) ?? 0) + reward.count)
                break;
            }
            case BoxGachaRewardType.MANA: {
                drawnMana += reward.count
                break;
            }
            case BoxGachaRewardType.EXP: {
                drawnExp += reward.count
                break;
            }
            case BoxGachaRewardType.CHARACTER: {
                const characterId = (reward as BoxGachaIdReward).id
                drawnCharacters.set(characterId, (drawnCharacters.get(characterId) ?? 0) + reward.count)
                break;
            }
        }
        
        sessionDrawnRewards.set(rewardId, (sessionDrawnRewards.get(rewardId) ?? 0) + 1)
        rewardsPool.splice(rollIndex, 1)
        totalDraws += 1

        // break if the reward was featured & stop of featured is enabled
        if (reward.tier == BoxGachaRewardTier.FEATURED && stopOnFeaturedReward) break;
    }

    // return the draw result
    const returnSessionDrawnRewards: PlayerBoxGachaDrawnReward[] = []

    sessionDrawnRewards.forEach((value, rewardId) => {
        returnSessionDrawnRewards.push({
            id: Number(rewardId),
            number: value
        })
    })

    return {
        mana: drawnMana,
        exp: drawnExp,
        characters: drawnCharacters,
        equipment: drawnEquipment,
        items: drawnItems,
        rewards: returnSessionDrawnRewards
    }
}

/**
 * Rewards a player with the results of a box gacha draw.
 * 
 * @param playerId The ID of the player.
 * @param drawResult The box gacha draw result.
 * @returns A PlayerRewardResult.
 */
export function rewardPlayerBoxGachaResultSync(
    playerId: number,
    drawResult: BoxGachaDrawResult
): PlayerRewardResult | null {
    const rewards: Reward[] = []

    // convert draw results into rewards

    // items
    for (const [itemId, number] of drawResult.items) {
        rewards.push({
            name: '',
            type: RewardType.ITEM,
            id: itemId,
            count: number
        } as EquipmentItemReward)
    }

    // equipment
    for (const [equipmentId, number] of drawResult.equipment) {
        rewards.push({
            name: '',
            type: RewardType.EQUIPMENT,
            id: equipmentId,
            count: number
        } as EquipmentItemReward)
    }

    // characters
    for (const [characterId, number] of drawResult.characters) {
        for (let i = 0; i < number; i++) {
            rewards.push({
                name: '',
                type: RewardType.CHARACTER,
                id: characterId,
            } as CharacterReward)
        }
    }

    // mana & exp
    rewards.push({
        name: '',
        type: RewardType.EXP,
        count: drawResult.exp,
    } as CurrencyReward)
    rewards.push({
        name: '',
        type: RewardType.MANA,
        count: drawResult.mana,
    } as CurrencyReward)

    return givePlayerRewardsSync(playerId, rewards)
}