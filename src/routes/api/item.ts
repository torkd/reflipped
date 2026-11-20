// item/use_item: the items a player uses from the item list. Only the stamina items (FT-25: Staminade and the event
// treats, `item/item` effect kinds StaminaFixed and StaminaRate) are used this way; they are refused (AlreadyStaminaMax)
// once stamina is at the overflow cap.
//
// item/sell (FT-40): the item list's Sell tab sells an item for mana, `sale_price` (master column 15) each, if the
// item is `sellable` (column 21) and in its period (columns 18-19; outside it the client shows "This item can no
// longer be sold." for result code 2054). Ability cores (category 5) keep at least 3 (the client: "Can only be sold
// when you own 4 or more", its slider stops at owned - 3). That also covers the client's other core rule, no sale when
// every core owned is in use (`isAbilitySoulAndAllUsed`): it counts the most copies one party uses
// (`getUsedAbilitySoulMaxNum`, `countMaxUsedItems`), at most a party's 3 core slots. A sale that would pass the mana
// cap is refused, as the client refuses it. The client builds its result dialog itself and reads the new balances from the common fields.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerItemSync, getPlayerSync, updatePlayerItemSync, updatePlayerSync } from "../../data/wdfpData";
import { atomicHandler } from "../../lib/atomic";
import { playerRankSync } from "../../lib/assets";
import { addStaminaSync, ALREADY_STAMINA_MAX, itemStamina, serializeStamina, staminaAtCapSync } from "../../lib/stamina";
import { generateDataHeaders, getServerDate, masterDate } from "../../utils";
import { arrayOf, gameBody, integer, object } from "../schemas";
import sellRules from "../../../assets/sell_rules.json";
import { isContentPeriodOpen } from "../../lib/eventSchedule";
import { playerLimits } from "../../lib/limits";

interface SellItemBody {
    item_id: number
    sell_number: number
    viewer_id: number
}

const sellItemSchema = gameBody({ item_id: integer, sell_number: integer }, ["item_id", "sell_number"])

/** The sellable items: price in mana, category (5 an ability core) and sale period (master dates, Japan time). */
const sellableItems = (sellRules as unknown as { items: Record<string, { price: number, category: number, start: string | null, end: string | null }> }).items
const ABILITY_CORE_CATEGORY = 5
const ABILITY_CORES_KEPT = 3
/** `ItemSellRemote`'s OutOfPeriodError. */
const ITEM_SELL_OUT_OF_PERIOD = 2054

interface UseItemBody {
    items: { id: number, number: number }[]
    viewer_id: number
}

const useItemSchema = gameBody({
    items: arrayOf(object({ id: integer, number: integer }, ["id", "number"]), 100)
}, ["items"])

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/use_item", { schema: useItemSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as UseItemBody
        const viewerId = request.viewer.viewerId
        const playerId = request.viewer.playerId
        const player = getPlayerSync(playerId)
        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })
        const rank = playerRankSync(player.rankPoint)

        // every item must be a stamina item the player has enough of
        let gained = 0
        const counts: Record<string, number> = {}
        for (const { id, number } of body.items) {
            const perItem = itemStamina(id, rank)
            const owned = (counts[String(id)] ?? getPlayerItemSync(playerId, id) ?? 0)
            if (perItem === null || number < 1 || owned < number) return reply.status(400).send({
                "error": "Bad Request",
                "message": perItem === null ? "Not a usable item." : "Not enough items."
            })
            counts[String(id)] = owned - number
            gained += perItem * number
        }

        reply.header("content-type", "application/x-msgpack")
        const now = getServerDate()
        if (staminaAtCapSync(playerId, now)) return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId, result_code: ALREADY_STAMINA_MAX }),
            "data": []
        })

        for (const [id, count] of Object.entries(counts)) updatePlayerItemSync(playerId, id, count)
        const stamina = addStaminaSync(playerId, gained, now)!

        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "user_info": serializeStamina(stamina),
                "item_list": counts
            }
        })
    }))

    fastify.post("/sell", { schema: sellItemSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SellItemBody
        const viewerId = request.viewer.viewerId
        const playerId = request.viewer.playerId
        const player = getPlayerSync(playerId)
        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })
        const refuse = (message: string) => reply.status(400).send({ "error": "Bad Request", "message": message })

        const item = sellableItems[String(body.item_id)]
        if (item === undefined) return refuse("This item can't be sold.")
        const now = getServerDate()
        if (!isContentPeriodOpen(item.start === null ? undefined : masterDate(item.start).getTime(), item.end === null ? undefined : masterDate(item.end).getTime(), now)) {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId, result_code: ITEM_SELL_OUT_OF_PERIOD }),
                "data": []
            })
        }
        const number = body.sell_number
        const owned = getPlayerItemSync(playerId, body.item_id) ?? 0
        if (!Number.isSafeInteger(number) || number < 1 || number > owned) return refuse("Not enough items.")
        if (item.category === ABILITY_CORE_CATEGORY && owned - number < ABILITY_CORES_KEPT) return refuse(`Keep at least ${ABILITY_CORES_KEPT} ability cores.`)
        const freeMana = player.freeMana + item.price * number
        if (freeMana > playerLimits.mana) return refuse("Too much mana.")

        updatePlayerItemSync(playerId, body.item_id, owned - number)
        updatePlayerSync({ id: playerId, freeMana })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "user_info": { "free_mana": freeMana },
                "item_list": { [String(body.item_id)]: owned - number }
            }
        })
    }))
}

export default routes;
