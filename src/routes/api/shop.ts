// Handles the insertion of mana into characters.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerItemSync, getPlayerSync, updatePlayerItemSync, updatePlayerSync } from "../../data/wdfpData";
import { getBossCoinShopItemsSync, getEventShopItemsSync, getGenericShopItemsSync, getShopItemSync } from "../../lib/assets";
import { CharacterReward, CharacterShopItemReward, CurrencyReward, CurrencyShopItemReward, EquipmentItemReward, EquipmentItemShopItemReward, Reward, RewardType, ShopItemRewardType, ShopItems, ShopItemUserCostType, ShopType } from "../../lib/types";
import { generateDataHeaders, getServerDate, getServerTime } from "../../utils";
import { currentPurchases, isOnSale, purchaseRefusal, recordPurchase } from "../../lib/shopLimits";
import { givePlayerRewardsSync } from "../../lib/quest";
import { arrayOf, boolean, gameBody, integer, object } from "../schemas";
import { atomicHandler } from "../../lib/atomic";
import { collectionUpdatesSync, MissionPattern, MissionUpdate, missionReplyFields, updateMissionsSync } from "../../lib/missions";

interface GetSalesListBody {
    equipment_enhancement_shop_category_ids: number[],
    boss_coin_shop_category_ids: number[],
    browse_treasure_flag: boolean,
    shop_types: ShopType[],
    event_list: {
        event_type: number,
        event_ids: number[]
    }[],
    viewer_id: number
}

const getSalesListSchema = gameBody({
    equipment_enhancement_shop_category_ids: arrayOf(integer),
    boss_coin_shop_category_ids: arrayOf(integer),
    browse_treasure_flag: boolean,
    shop_types: arrayOf(integer),
    event_list: arrayOf(object({ event_type: integer, event_ids: arrayOf(integer) }, ["event_type", "event_ids"]))
}, ["boss_coin_shop_category_ids", "shop_types", "event_list"])

interface BuyBody {
    shop_type: number,
    api_count: number,
    shop_item_id: number,
    number: number,
    viewer_id: number
}

const buySchema = gameBody({
    shop_type: integer,
    api_count: integer,
    shop_item_id: integer,
    number: integer
}, ["shop_type", "shop_item_id", "number"])

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/buy", { schema: buySchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as BuyBody

        const viewerId = request.viewer.viewerId
        const shopType = body.shop_type
        const rawPurchaseAmount = body.number
        const shopItemId = body.shop_item_id
        if (isNaN(shopType) || isNaN(rawPurchaseAmount) || isNaN(shopItemId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const purchaseAmount = rawPurchaseAmount

        const playerId = request.viewer.playerId
        const player = isNaN(playerId) ? null : getPlayerSync(playerId)

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // get the shop item's data
        const shopItemData = getShopItemSync(shopType, shopItemId)
        if (shopItemData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Shop item with specified id does not exist."
        })

        // the product's limits: period, rank, amount per purchase and stock (SEC-15)
        const now = getServerDate()
        const purchases = currentPurchases(playerId, shopType, shopItemId, now)
        const refusal = purchaseRefusal(shopItemData, purchaseAmount, player.rankPoint, purchases, now)
        if (refusal !== null) return reply.status(400).send({
            "error": "Bad Request",
            "message": refusal
        })
        recordPurchase(playerId, shopType, shopItemId, purchases, purchaseAmount)

        // keep track of various stats
        const itemList: Record<string, number> = {}
        let freeVmoney = player.freeVmoney
        let freeMana = player.freeMana
        let bondTokens = player.bondToken

        // verify user costs
        const userCost = shopItemData.userCost
        if (userCost !== undefined) {
            switch (userCost.type) {
                case ShopItemUserCostType.MANA:
                    freeMana -= (userCost.amount * purchaseAmount)
                    break;
                case ShopItemUserCostType.BEADS:
                    freeVmoney -= (userCost.amount * purchaseAmount)
                    break;
                case ShopItemUserCostType.AMITY_SCROLL:
                    bondTokens -= (userCost.amount * purchaseAmount)
            }

            if (0 > freeVmoney) return reply.status(400).send({
                "error": "Bad Request",
                "message": `Not enough beads to purchase shop item.`
            })
            if (0 > freeMana) return reply.status(400).send({
                "error": "Bad Request",
                "message": `Not enough mana to purchase shop item.`
            })
            if (0 > bondTokens) return reply.status(400).send({
                "error": "Bad Request",
                "message": `Not enough amity scrolls to purchase shop item.`
            })
        }

        // verify cost items
        {
            for (const cost of shopItemData.costs) {
                const itemId = cost.id
                const itemAmount = getPlayerItemSync(playerId, itemId) ?? 0
                const newItemAmount = itemAmount - (cost.amount * purchaseAmount)
                if (0 > newItemAmount) return reply.status(400).send({
                    "error": "Bad Request",
                    "message": `Not enough of item with id ${itemId} to purchase shop item.`
                })

                itemList[itemId] = newItemAmount
            }

            // deduct cost item
            for (const [itemId, newAmount] of Object.entries(itemList)) {
                updatePlayerItemSync(playerId, itemId, newAmount)
            }
        }

        // update player
        updatePlayerSync({
            id: playerId,
            freeMana: freeMana,
            freeVmoney: freeVmoney,
            bondToken: bondTokens
        })

        // build rewards array
        const rewards: Reward[] = []
        for (const reward of shopItemData.rewards) {
            switch (reward.type) {
                case ShopItemRewardType.ITEM: {
                    const shopReward = reward as EquipmentItemShopItemReward
                    rewards.push({
                        name: "",
                        type: RewardType.ITEM,
                        id: shopReward.id,
                        count: shopReward.count * purchaseAmount
                    } as EquipmentItemReward)
                    break;
                }
                case ShopItemRewardType.EXP: {
                    const shopReward = reward as CurrencyShopItemReward
                    rewards.push({
                        name: "",
                        type: RewardType.EXP,
                        count: shopReward.count * purchaseAmount
                    } as CurrencyReward)
                    break;
                }
                case ShopItemRewardType.MANA:{
                    const shopReward = reward as CurrencyShopItemReward
                    rewards.push({
                        name: "",
                        type: RewardType.MANA,
                        count: shopReward.count * purchaseAmount
                    } as CurrencyReward)
                    break;
                }
                case ShopItemRewardType.CHARACTER: {
                    const shopReward = reward as CharacterShopItemReward
                    for (let i = 0; i < purchaseAmount; i++) {
                        rewards.push({
                            name: "",
                            type: RewardType.CHARACTER,
                            id: shopReward.id
                        } as CharacterReward)
                    }
                    break;
                }
                case ShopItemRewardType.EQUIPMENT: {
                    const shopReward = reward as EquipmentItemShopItemReward
                    rewards.push({
                        name: "",
                        type: RewardType.EQUIPMENT,
                        id: shopReward.id,
                        count: shopReward.count * purchaseAmount
                    } as EquipmentItemReward)
                    break;
                }

            }
        }
        // give rewards
        const rewardResult = givePlayerRewardsSync(playerId, rewards)

        // missions (FT-2): Trove buys and the mana spent there, Boss Coin trades, and what the rewards added
        const missionUpdates: MissionUpdate[] = []
        if (shopType === ShopType.TREASURE) {
            missionUpdates.push({ pattern: MissionPattern.TREASURE_SHOP_BOUGHT_ITEM_COUNT, amount: purchaseAmount })
            if (userCost?.type === ShopItemUserCostType.MANA) missionUpdates.push({ pattern: MissionPattern.TREASURE_SHOP_USED_MANA_COUNT, amount: userCost.amount * purchaseAmount })
        }
        if (shopType === ShopType.BOSS_COIN) {
            missionUpdates.push({ pattern: MissionPattern.TRADED_COUNT_BY_BOSS_COIN_SHOP, amount: purchaseAmount })
            if (rewards.some(reward => reward.type === RewardType.EQUIPMENT)) missionUpdates.push({ pattern: MissionPattern.TRADED_COUNT_TO_EQUIPMENT_BY_BOSS_COIN, amount: purchaseAmount })
        }
        const missionResult = updateMissionsSync(playerId, now, [...missionUpdates.filter(update => !("amount" in update) || update.amount > 0), ...collectionUpdatesSync(playerId)])

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_info": {
                    "free_mana": freeMana + (rewardResult?.user_info.free_mana ?? 0),
                    "exp_pool": player.expPool + (rewardResult?.user_info.exp_pool ?? 0),
                    "exp_pooled_time": getServerTime(player.expPooledTime),
                    "bond_token": bondTokens
                },
                "joined_character_id_list": rewardResult?.joined_character_id_list ?? [],
                "character_list": rewardResult?.character_list ?? [],
                "equipment_list": rewardResult?.equipment_list ?? [],
                "item_list": {
                    ...itemList,
                    ...(rewardResult?.items ?? {})
                },
                ...missionReplyFields(missionResult)
            }
        })
    }))

    fastify.post("/get_sales_list", { schema: getSalesListSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetSalesListBody

        const viewerId = request.viewer.viewerId
        const shopTypes = body.shop_types
        const bossCoinShopCategoryIds = body.boss_coin_shop_category_ids
        const eventList = body.event_list
        if (shopTypes === undefined || bossCoinShopCategoryIds === undefined || eventList === undefined) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        let toParseShopItems: Record<number, ShopItems> = {}

        // shop types
        for (const type of shopTypes) {
            const items = getGenericShopItemsSync(type)
            const existing = toParseShopItems[type] ?? {}
            toParseShopItems[type] = items === null ? existing : { ...existing, ...items }
        }

        // event list
        for (const event of eventList) {
            const type = event.event_type
            for (const eventId of event.event_ids) {
                const items = getEventShopItemsSync(type, eventId)
                const existing = toParseShopItems[ShopType.EVENT_ITEM] ?? {}
                toParseShopItems[ShopType.EVENT_ITEM] = items === null ? existing : { ...existing, ...items }
            }
        }

        // boss coin shop category ids
        for (const category of bossCoinShopCategoryIds) {
            const items = getBossCoinShopItemsSync(category)
            const existing = toParseShopItems[ShopType.BOSS_COIN] ?? {}
            toParseShopItems[ShopType.BOSS_COIN] = items === null ? existing : { ...existing, ...items }
        }

        // parse shop items
        const salesList: Object[] = []

        const now = getServerDate()
        for (const [shopType, items] of Object.entries(toParseShopItems)) {
            for (const [itemId, item] of Object.entries(items)) {
                if (isOnSale(item, now)) {
                    // the player's counts, which the client compares with the product's limits (its canBuy)
                    const purchases = currentPurchases(playerId, Number(shopType), Number(itemId), now)
                    salesList.push({
                        "shop_item_id": Number(itemId),
                        "stock_quantity": -1, // stock shared by all players; -1 = none
                        "today_purchase_num": purchases.dayCount,
                        "this_month_purchase_num": purchases.monthCount,
                        "total_purchase_num": purchases.total,
                        "group_info": {
                            "group_total_stock_quantity": -1,
                            "group_total_purchase_num": 0,
                            "multi_stage": false
                        },
                        "shop_type": Number(shopType)
                    })
                }
            }
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "sales_list": salesList
            }
        })
    }))
}

export default routes;