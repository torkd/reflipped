// Handles the insertion of mana into characters.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { deletePlayerEquipmentSync, getPlayerEquipmentSync, getPlayerItemSync, getPlayerSync, givePlayerItemSync, playerOwnsEquipmentSync, updatePlayerEquipmentSync, updatePlayerItemSync, updatePlayerPartyGroupSync } from "../../data/wdfpData";
import { generateDataHeaders, getServerDate } from "../../utils";
import { clientSerializeEquipment } from "../../lib/equipment";
import { getEquipmentMaxLevelSync } from "../../lib/assets";
import { UserEquipment } from "../../data/types";
import { arrayOf, boolean, gameBody, integer, object } from "../schemas";
import { atomicHandler } from "../../lib/atomic";
import { collectionUpdatesSync, MissionPattern, missionReplyFields, updateMissionsSync } from "../../lib/missions";

interface SetProtectionBody {
    protection: boolean
    equipment_ids: number[]
    viewer_id: number
    api_count: number
}

const setProtectionSchema = gameBody({
    protection: boolean,
    equipment_ids: arrayOf(integer),
    api_count: integer
}, ["protection", "equipment_ids"])

interface UpgradeBody {
    use_stack: boolean,
    upgrade_count: number,
    item_id?: number,
    viewer_id: number,
    api_count: number,
    equipment_id: number
}

const upgradeSchema = gameBody({
    use_stack: boolean,
    upgrade_count: integer,
    item_id: integer,
    api_count: integer,
    equipment_id: integer
}, ["equipment_id", "upgrade_count"])

interface SellEquipmentListItem {
    equipment_id: number
}

interface SellStackEquipmentListItem extends SellEquipmentListItem {
    number: number
}

interface SellBody {
    equipment_list: SellEquipmentListItem[],
    viewer_id: number,
    api_count: number
}

// equipment_list items have equipment_id (sell_equipment) and number (sell_stack)
const sellSchema = gameBody({
    equipment_list: arrayOf(object({ equipment_id: integer, number: integer }, ["equipment_id"])),
    api_count: integer
}, ["equipment_list"])

const wrightpieceItemId = 100000

/**
 * The Starsteel Ingot that awakens an armament without a duplicate (master `item/item`): 12001 up to 4★, 12002 for 5★
 * only.
 */
function starsteelIngotFor(equipmentId: number): number {
    return Math.floor(equipmentId / 1000000) >= 5 ? 12002 : 12001
}

// wrightpiece cost for each rank of weapon
const equipmentUpgradeCost = [
    5,
    10,
    15,
    20,
    25
]

// wrightpiece reward for selling each rank of weapon
const equipmentSellReward = [
    0,
    0,
    1,
    5,
    15
]

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/sell_equipment", { schema: sellSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SellBody

        const toSellEquipmentList = body.equipment_list
        const viewerId = request.viewer.viewerId
        if (toSellEquipmentList === undefined) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        // get wrightpieces
        let newWrightPieces = 0;
        const returnItemList: Record<number, number> = {}

        // sell stacks
        for (const toSell of toSellEquipmentList) {
            const equipmentId = toSell.equipment_id
            const equipmentRarity = Math.floor(equipmentId / 1000000) - 1

            // get the data for the equipment
            const playerEquipmentData = getPlayerEquipmentSync(playerId, equipmentId)
            if (playerEquipmentData === null) return reply.status(400).send({
                "error": "Bad Request",
                "message": "Player does not own equipment."
            }) 

            // add wright pieces
            const stack = playerEquipmentData.stack
            newWrightPieces += (equipmentSellReward[equipmentRarity] ?? 0) * stack

            // delete equipment
            deletePlayerEquipmentSync(playerId, equipmentId)

            // give ability soul
            returnItemList[equipmentId] = givePlayerItemSync(playerId, equipmentId, stack)
        }

        // give wrightpieces
        returnItemList[wrightpieceItemId] = givePlayerItemSync(playerId, wrightpieceItemId, newWrightPieces)

        // respond to client
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "item_list": returnItemList,
                "mail_arrived": false
            }
        })
    }))

    fastify.post("/sell_stack", { schema: sellSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SellBody

        const toSellEquipmentList = body.equipment_list
        const viewerId = request.viewer.viewerId
        if (toSellEquipmentList === undefined) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        // get wrightpieces
        let newWrightPieces = 0;
        const returnItemList: Record<number, number> = {}
        const returnEquipmentList: Object[] = []

        // sell stacks
        for (const toSell of toSellEquipmentList) {
            const equipmentId = toSell.equipment_id
            const sellCount = Math.max(1, (toSell as SellStackEquipmentListItem).number)
            const equipmentRarity = Math.floor(equipmentId / 1000000) - 1

            // get the data for the equipment
            const playerEquipmentData = getPlayerEquipmentSync(playerId, equipmentId)
            if (playerEquipmentData === null) return reply.status(400).send({
                "error": "Bad Request",
                "message": "Player does not own equipment."
            })

            // make sure that we have enough stacks
            const newStack = playerEquipmentData.stack - sellCount
            if (0 > newStack) return reply.status(400).send({
                "error": "Bad Request",
                "message": "Attempt to sell more stacks than owned."
            })

            newWrightPieces += (equipmentSellReward[equipmentRarity] ?? 0) * sellCount

            // update eqwuipment
            playerEquipmentData.stack = newStack
            updatePlayerEquipmentSync(playerId, equipmentId, {
                stack: newStack
            })
            returnEquipmentList.push(clientSerializeEquipment(equipmentId, playerEquipmentData))

            // give ability sould
            returnItemList[equipmentId] = givePlayerItemSync(playerId, equipmentId, sellCount)
        }

        // give wrightpieces
        returnItemList[wrightpieceItemId] = givePlayerItemSync(playerId, wrightpieceItemId, newWrightPieces)

        // respond to client
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "equipment_list": returnEquipmentList,
                "item_list": returnItemList,
                "mail_arrived": false
            }
        })
    }))

    fastify.post("/upgrade", { schema: upgradeSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as UpgradeBody

        const viewerId = request.viewer.viewerId
        const upgradeCount = Math.max(1, body.upgrade_count ?? 1)
        const useStack = body.use_stack
        const itemId = body.item_id
        const equipmentId = body.equipment_id
        if (isNaN(equipmentId) || useStack === undefined) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        // get equipment
        const equipment = getPlayerEquipmentSync(playerId, equipmentId)
        if (equipment === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Player does not own equipment."
        })

        // validate that we won't overflow the equipment's level.
        const newLevel = equipment.level + upgradeCount
        const maxLevel = getEquipmentMaxLevelSync(equipmentId) ?? 5
        if (newLevel > maxLevel) return reply.status(400).send({
            "error": "Bad Request",
            "message": `Cannot upgrade weapon above level ${maxLevel}.`
        })

        // check if the equipment can be upgraded
        const newStack = useStack ? equipment.stack - upgradeCount : equipment.stack
        if (0 > newStack) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not enough stack."
        })

        const equipmentRarity = Math.floor(equipmentId / 1000000) - 1
        const wrightPieces = getPlayerItemSync(playerId, wrightpieceItemId) ?? 0
        const upgradeCost = equipmentUpgradeCost[equipmentRarity] ?? 0
        const newWrightPieces = wrightPieces - (upgradeCost * upgradeCount)
        if (0 > newWrightPieces) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not enough of wrightpieces."
        }) 
        
        // without a duplicate, the ingot for the armament's rarity: any other item the client names is refused (SEC-15)
        if (!useStack && itemId !== starsteelIngotFor(equipmentId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Wrong item for this armament."
        })
        const itemCount = itemId ? getPlayerItemSync(playerId, itemId) ?? 0 : 0
        const newItemCount = !useStack ? itemCount - upgradeCount : itemCount
        if (0 > newItemCount) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not enough of item."
        })

        const returnItemList: Record<string, number> = {}

        // deduct item
        if (!useStack && itemId !== undefined) {
            returnItemList[itemId] = newItemCount
            updatePlayerItemSync(playerId, itemId, newItemCount)
        }

        // deduct wrightpiece
        returnItemList[wrightpieceItemId] = newWrightPieces
        updatePlayerItemSync(playerId, wrightpieceItemId, newWrightPieces)

        // upgrade weapon
        equipment.level = newLevel
        equipment.stack = newStack
        updatePlayerEquipmentSync(playerId, equipmentId, {
            "stack": newStack,
            "level": newLevel
        })

        // give ability cores
        returnItemList[equipmentId] = givePlayerItemSync(playerId, equipmentId, upgradeCount)
        const missionResult = updateMissionsSync(playerId, getServerDate(), [
            { pattern: MissionPattern.UPGRADE_EQUIPMENT_COUNT, amount: upgradeCount },
            ...collectionUpdatesSync(playerId)
        ])

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "equipment_list": [
                    clientSerializeEquipment(equipmentId, equipment)
                ],
                "item_list": returnItemList,
                ...missionReplyFields(missionResult)
            }
        })
    }))

    fastify.post("/set_protection", { schema: setProtectionSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SetProtectionBody

        const viewerId = request.viewer.viewerId

        const playerId = request.viewer.playerId
        const player = getPlayerSync(playerId)

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // update protection
        const newProtection = body.protection
        for (const equipmentId of body.equipment_ids) {
            if (playerOwnsEquipmentSync(playerId, equipmentId)) {
                updatePlayerEquipmentSync(playerId, equipmentId, {
                    protection: newProtection
                })
            }
        }
        
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {}
        })
    }))
}

export default routes;