// The Star Sliver Exchange (FT-58, src/lib/starCrumbExchange.ts): `exchange/star_crumb` trades Star Slivers for one
// unit, armament or item. Shape from the client's ExchangeStarCrumbRealRemote (no capture): the request is
// `{ exchange_id }`, and the client reads the reply only through the common response.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerReceivableMailCountSync, getPlayerSync, updatePlayerSync } from "../../data/wdfpData";
import { atomicHandler } from "../../lib/atomic";
import { collectionUpdatesSync, missionReplyFields, missionResourcesSync, resourceMissionUpdatesSync, updateMissionsSync } from "../../lib/missions";
import { clampCount, playerLimits } from "../../lib/limits";
import { givePlayerRewardsSync } from "../../lib/quest";
import { comebackGachaPeriodSync } from "../../lib/comebackGacha";
import {
    EXCHANGE_OUT_OF_PERIOD, getStarCrumbExchange, isStarCrumbExchangeOpen, StarCrumbExchangeKind, starCrumbExchangeCost,
    starCrumbExchangeRefusalSync
} from "../../lib/starCrumbExchange";
import { CharacterReward, EquipmentItemReward, Reward, RewardType } from "../../lib/types";
import { generateDataHeaders, getServerDate } from "../../utils";
import { gameBody, integer } from "../schemas";

const starCrumbSchema = gameBody({ exchange_id: integer }, ["exchange_id"])

function send(reply: FastifyReply, viewerId: number, data: unknown, resultCode?: number) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        "data_headers": generateDataHeaders(resultCode === undefined ? { viewer_id: viewerId } : { viewer_id: viewerId, result_code: resultCode }),
        "data": data
    })
}

function rewardOf(kind: StarCrumbExchangeKind, id: number): Reward {
    switch (kind) {
        case StarCrumbExchangeKind.CHARACTER: return { name: "", type: RewardType.CHARACTER, id } as CharacterReward
        case StarCrumbExchangeKind.EQUIPMENT: return { name: "", type: RewardType.EQUIPMENT, id, count: 1 } as EquipmentItemReward
        case StarCrumbExchangeKind.ITEM: return { name: "", type: RewardType.ITEM, id, count: 1 } as EquipmentItemReward
    }
}

const routes = async (fastify: FastifyInstance) => {
    // One exchange: its price in Star Slivers for its target; 3006 (ExchangePeriodError) outside its period
    fastify.post("/star_crumb", { schema: starCrumbSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const { exchange_id: exchangeId } = request.body as { exchange_id: number }
        const { viewerId, playerId } = request.viewer
        const now = getServerDate()

        const exchange = getStarCrumbExchange(exchangeId)
        if (exchange === null) return reply.status(400).send({ "error": "Bad Request", "message": "No such exchange." })
        const cost = starCrumbExchangeCost(exchange)
        if (cost === null) return reply.status(400).send({ "error": "Bad Request", "message": "The exchange has no price." })
        // a Welcome Back exchange follows the player's own Welcome Back Portal period (FT-65)
        const comeback = exchange.comebackGachaId === null ? null : comebackGachaPeriodSync(playerId, now)
        if (!isStarCrumbExchangeOpen(exchange, now, comeback)) return send(reply, viewerId, [], EXCHANGE_OUT_OF_PERIOD)
        const refusal = starCrumbExchangeRefusalSync(playerId, exchange)
        if (refusal !== null) return reply.status(400).send({ "error": "Bad Request", "message": refusal })

        // a balance past the client's limit (an imported save) counts as the limit, which is what /load showed the client
        const balance = clampCount(getPlayerSync(playerId)!.starCrumb, playerLimits.starCrumb)
        if (balance < cost) return reply.status(400).send({ "error": "Bad Request", "message": "Not enough Star Slivers." })
        const starCrumb = balance - cost
        updatePlayerSync({ id: playerId, starCrumb })

        const resourcesBefore = missionResourcesSync(playerId)
        const given = givePlayerRewardsSync(playerId, [rewardOf(exchange.kind, exchange.targetId)])
        // a target the server's data doesn't know: roll the Star Slivers back (atomicHandler) rather than take them for nothing
        if (given === null || given.character_list.length + given.equipment_list.length + Object.keys(given.items).length === 0)
            throw new Error(`star sliver exchange ${exchangeId} gave nothing`)
        const missions = updateMissionsSync(playerId, now, [
            ...resourceMissionUpdatesSync(playerId, resourcesBefore).filter(update => !("amount" in update) || update.amount > 0),
            ...collectionUpdatesSync(playerId)
        ])

        return send(reply, viewerId, {
            "user_info": { "star_crumb": starCrumb },
            "joined_character_id_list": given.joined_character_id_list,
            "character_list": given.character_list,
            "equipment_list": given.equipment_list,
            "item_list": given.items,
            ...missionReplyFields(missions, getPlayerReceivableMailCountSync(playerId, now) > 0)
        })
    }))
}

export default routes;
