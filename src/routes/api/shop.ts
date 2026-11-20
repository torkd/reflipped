// Handles the insertion of mana into characters.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { troveLineup, troveProduct } from "../../lib/trove";
import { getPlayerItemSync, getPlayerSync, updatePlayerItemSync, updatePlayerSync } from "../../data/wdfpData";
import { getBossCoinShopItemsSync, getEventShopItemsSync, getGenericShopItemsSync, getShopItemSync } from "../../lib/assets";
import { CharacterReward, CharacterShopItemReward, CurrencyReward, CurrencyShopItemReward, EquipmentItemReward, EquipmentItemShopItemReward, Reward, RewardType, ShopItemRewardType, ShopItems, ShopItemUserCostType, ShopType } from "../../lib/types";
import { generateDataHeaders, getServerDate, getServerTime } from "../../utils";
import { currentPurchases, isOnSale, purchaseRefusal, recordPurchase, salesListEntry } from "../../lib/shopLimits";
import { givePlayerRewardsSync } from "../../lib/quest";
import { arrayOf, boolean, gameBody, ignoredBody, integer, object } from "../schemas";
import { addStaminaSync, ALREADY_STAMINA_MAX, serializeStamina, STAMINA_REFILL, staminaAtCapSync } from "../../lib/stamina";
import { clampCount, playerLimits } from "../../lib/limits";
import { atomicHandler } from "../../lib/atomic";
import { payBeads } from "../../lib/beads";
import { augmentSalesListSync, buyAugmentSync } from "../../lib/augmentShop";
import { chooseLineupSync, hiddenLineupItemsSync, LINEUP_OUT_OF_PERIOD, lineupChoiceSync, lineupPurchaseRefusal } from "../../lib/lineupChoice";
import { missionResourcesSync, resourceMissionUpdatesSync, collectionUpdatesSync, MissionPattern, MissionUpdate, missionReplyFields, updateMissionsSync } from "../../lib/missions";

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

const getLineupSchema = gameBody({ shop_type: integer, campaign_id: integer }, ["shop_type", "campaign_id"])
const setLineupSchema = gameBody({ shop_type: integer, campaign_id: integer, lineup_id: integer }, ["shop_type", "campaign_id", "lineup_id"])

function lineupReply(reply: FastifyReply, viewerId: number, data: unknown, resultCode?: number) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        "data_headers": generateDataHeaders(resultCode === undefined ? { viewer_id: viewerId } : { viewer_id: viewerId, result_code: resultCode }),
        "data": data
    })
}

const routes = async (fastify: FastifyInstance) => {
    // A select item campaign's lineup (FT-38, src/lib/lineupChoice.ts): the one the player chose, lineup_id null for none
    // yet (the client then offers the choice); 1652 outside the campaign. Read-only.
    fastify.post("/get_campaign_lineup_id", { schema: getLineupSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { shop_type: number, campaign_id: number }
        const lookup = lineupChoiceSync(request.viewer.playerId, body.shop_type, body.campaign_id, getServerDate())
        if (lookup.outcome === "out-of-period") return lineupReply(reply, request.viewer.viewerId, [], LINEUP_OUT_OF_PERIOD)
        return lineupReply(reply, request.viewer.viewerId, { "lineup_id": lookup.lineupId })
    })

    // Choosing the lineup: once, during the campaign's choosing period (1652 outside it). The client reads nothing back.
    fastify.post("/set_campaign_lineup_id", { schema: setLineupSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { shop_type: number, campaign_id: number, lineup_id: number }
        const outcome = chooseLineupSync(request.viewer.playerId, body.shop_type, body.campaign_id, body.lineup_id, getServerDate())
        if (outcome === "out-of-period") return lineupReply(reply, request.viewer.viewerId, [], LINEUP_OUT_OF_PERIOD)
        if (outcome === "unknown-lineup") return reply.status(400).send({ "error": "Bad Request", "message": "No such lineup in this campaign." })
        if (outcome === "already-chosen") return reply.status(400).send({ "error": "Bad Request", "message": "The lineup was chosen already." })
        return lineupReply(reply, request.viewer.viewerId, [])
    }))

    // A stamina refill with beads (FT-25): free beads first, then paid ones; refused (AlreadyStaminaMax) at the cap
    fastify.post("/recover_stamina", { schema: ignoredBody }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const viewerId = request.viewer.viewerId
        const playerId = request.viewer.playerId
        const player = getPlayerSync(playerId)
        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })
        reply.header("content-type", "application/x-msgpack")
        const now = getServerDate()
        if (staminaAtCapSync(playerId, now)) return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId, result_code: ALREADY_STAMINA_MAX }),
            "data": []
        })

        const fromFree = Math.min(Math.max(player.freeVmoney, 0), STAMINA_REFILL.vmoney)
        const fromPaid = STAMINA_REFILL.vmoney - fromFree
        if (player.vmoney < fromPaid) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not enough vmoney."
        })
        const freeVmoney = player.freeVmoney - fromFree
        const vmoney = player.vmoney - fromPaid
        updatePlayerSync({ id: playerId, freeVmoney, vmoney })
        const stamina = addStaminaSync(playerId, STAMINA_REFILL.stamina, now)!

        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "user_info": {
                    // clamped like /load, which shows the same balances
                    "free_vmoney": clampCount(freeVmoney, playerLimits.virtualMoney - clampCount(vmoney, playerLimits.virtualMoney)),
                    "vmoney": clampCount(vmoney, playerLimits.virtualMoney),
                    ...serializeStamina(stamina)
                }
            }
        })
    }))

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

        // the augment shop (FT-54): levels of an armament's augmentation, paid in items
        if (shopType === ShopType.EQUIPMENT_ENHANCEMENT) {
            const augment = buyAugmentSync(playerId, shopItemId, purchaseAmount, getServerDate())
            if ("refusal" in augment) return reply.status(400).send({
                "error": "Bad Request",
                "message": augment.refusal
            })
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({
                    viewer_id: viewerId
                }),
                "data": {
                    "user_info": {
                        "free_mana": player.freeMana,
                        "exp_pool": player.expPool,
                        "exp_pooled_time": getServerTime(player.expPooledTime),
                        "bond_token": player.bondToken
                    },
                    "joined_character_id_list": [],
                    "character_list": [],
                    "equipment_list": [augment.equipment],
                    "item_list": augment.items
                }
            })
        }

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
            // a select item campaign's items: only the chosen lineup's (FT-38)
            ?? lineupPurchaseRefusal(playerId, shopType, shopItemId, now)
        if (refusal !== null) return reply.status(400).send({
            "error": "Bad Request",
            "message": refusal
        })
        // the Trove (FT-9): only the player's products of the day, at their discounted price
        const troveEntry = shopType === ShopType.TREASURE ? troveProduct(playerId, shopItemId, now) : null
        if (shopType === ShopType.TREASURE && troveEntry === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not in today's lineup."
        })
        recordPurchase(playerId, shopType, shopItemId, purchases, purchaseAmount)

        // keep track of various stats
        const itemList: Record<string, number> = {}
        let freeVmoney = player.freeVmoney
        let vmoney = player.vmoney
        let freeMana = player.freeMana
        let bondTokens = player.bondToken

        // verify user costs
        const userCost = shopItemData.userCost === undefined || troveEntry?.discount == null ? shopItemData.userCost
            : { ...shopItemData.userCost, amount: troveEntry.discount.price }
        if (userCost !== undefined) {
            switch (userCost.type) {
                case ShopItemUserCostType.MANA:
                    freeMana -= (userCost.amount * purchaseAmount)
                    break;
                case ShopItemUserCostType.BEADS: {
                    // any beads, free ones first (FT-46): the Bundle Marketplace's original price was paid beads only
                    const paid = payBeads({ free: freeVmoney, paid: vmoney }, userCost.amount * purchaseAmount)
                    if (paid === null) freeVmoney = -1
                    else ({ free: freeVmoney, paid: vmoney } = paid)
                    break;
                }
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
            vmoney: vmoney,
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
        const resourcesBeforeRewards = missionResourcesSync(playerId)
        const rewardResult = givePlayerRewardsSync(playerId, rewards)

        // missions (FT-2): Trove buys and the mana spent there, Boss Coin trades, and what the rewards added
        const missionUpdates: MissionUpdate[] = resourceMissionUpdatesSync(playerId, resourcesBeforeRewards)
        if (userCost?.type === ShopItemUserCostType.MANA) missionUpdates.push({ pattern: MissionPattern.TOTAL_USED_MANA_COUNT, amount: userCost.amount * purchaseAmount })
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
                    "bond_token": bondTokens,
                    // the bead balance, after a bead cost (clamped like /load)
                    ...(userCost?.type === ShopItemUserCostType.BEADS ? {
                        "free_vmoney": clampCount(freeVmoney, playerLimits.virtualMoney - clampCount(vmoney, playerLimits.virtualMoney)),
                        "vmoney": clampCount(vmoney, playerLimits.virtualMoney)
                    } : {})
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

        // shop types (the Trove has its own daily lineup, below)
        for (const type of shopTypes) {
            if (type === ShopType.TREASURE || type === ShopType.EQUIPMENT_ENHANCEMENT) continue
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
            // a select item campaign's other lineups (FT-71): shop/buy would refuse them
            const hidden = hiddenLineupItemsSync(playerId, Number(shopType), now)
            for (const [itemId, item] of Object.entries(items)) {
                if (isOnSale(item, now) && !hidden.has(Number(itemId))) salesList.push(salesListEntry(playerId, Number(shopType), Number(itemId), now))
            }
        }

        // the augment shop (FT-54): one entry per armament of the categories asked, at its current stage
        if (shopTypes.includes(ShopType.EQUIPMENT_ENHANCEMENT)) {
            salesList.push(...augmentSalesListSync(playerId, body.equipment_enhancement_shop_category_ids ?? [], now))
        }

        // the Trove (FT-9): the player's lineup of the day, with each product's stock left and its discount
        if (shopTypes.includes(ShopType.TREASURE)) {
            for (const product of troveLineup(playerId, now)) {
                const item = getShopItemSync(ShopType.TREASURE, product.shopItemId)
                if (item === null || !isOnSale(item, now)) continue
                const purchases = currentPurchases(playerId, ShopType.TREASURE, product.shopItemId, now)
                salesList.push({
                    "shop_item_id": product.shopItemId,
                    "stock_quantity": item.dailyStock === undefined ? -1 : Math.max(0, item.dailyStock - purchases.dayCount),
                    "today_purchase_num": purchases.dayCount,
                    "this_month_purchase_num": purchases.monthCount,
                    "total_purchase_num": purchases.total,
                    ...(product.discount === null ? {} : {
                        "discount_id": product.discount.discountId,
                        "discount_rate": product.discount.rate,
                        "discounted_price": product.discount.price
                    }),
                    "shop_type": ShopType.TREASURE
                })
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