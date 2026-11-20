// Handles the insertion of mana into characters.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { deletePlayerEquipmentSync, getPlayerEquipmentSync, getPlayerItemSync, getPlayerSync, playerOwnsEquipmentSync, updatePlayerEquipmentSync, updatePlayerItemSync, updatePlayerPartyGroupSync } from "../../data/wdfpData";
import { generateDataHeaders, getServerDate } from "../../utils";
import { clientSerializeEquipment } from "../../lib/equipment";
import { getEquipmentMaxLevelSync } from "../../lib/assets";
import { UserEquipment } from "../../data/types";
import { arrayOf, boolean, gameBody, integer, object } from "../schemas";
import { atomicHandler } from "../../lib/atomic";
import { missionResourcesSync, resourceMissionUpdatesSync, collectionUpdatesSync, MissionPattern, missionReplyFields, updateMissionsSync } from "../../lib/missions";
import { applyAwakeningSync, creditAwakeningCoresSync, meltDuplicatesSync, meltEquipmentSync, OverflowMana, payOverflowManaSync, plannedAwakening, spendWrightpiecesSync } from "../../lib/duplicates";

interface BulkEquipmentBody {
    equipment_ids: number[]
    viewer_id: number
    api_count: number
}

// equipment/bulk_upgrade and bulk_sell_stack (FT-40): the armaments picked in the list's Bulk Select
const bulkEquipmentSchema = gameBody({
    equipment_ids: arrayOf(integer, 2000),
    api_count: integer
}, ["equipment_ids"])

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
        const resourcesBefore = missionResourcesSync(playerId)

        // melt each armament with its duplicates (src/lib/duplicates.ts)
        const returnItemList: Record<string, number> = {}
        const overflow: OverflowMana = { mana: 0 }
        for (const toSell of toSellEquipmentList) {
            const melted = meltEquipmentSync(playerId, toSell.equipment_id, returnItemList, overflow)
            if ("refusal" in melted) return reply.status(400).send({
                "error": "Bad Request",
                "message": melted.refusal
            })
        }
        // cores and Wrightpieces past their cap, as mana (FT-69)
        const overflowFields = payOverflowManaSync(playerId, overflow)

        const missionResult = updateMissionsSync(playerId, getServerDate(), [...resourceMissionUpdatesSync(playerId, resourcesBefore), ...collectionUpdatesSync(playerId)])

        // respond to client
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "item_list": returnItemList,
                ...overflowFields,
                ...missionReplyFields(missionResult)
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
        const resourcesBefore = missionResourcesSync(playerId)

        // melt the duplicates (src/lib/duplicates.ts): cores, Wrightpieces and Star Specks by rarity
        const returnItemList: Record<string, number> = {}
        const returnEquipmentList: Object[] = []
        const overflow: OverflowMana = { mana: 0 }
        for (const toSell of toSellEquipmentList) {
            const count = Math.max(1, (toSell as SellStackEquipmentListItem).number)
            const melted = meltDuplicatesSync(playerId, toSell.equipment_id, count, returnItemList, overflow)
            if ("refusal" in melted) return reply.status(400).send({
                "error": "Bad Request",
                "message": melted.refusal
            })
            returnEquipmentList.push(melted.equipment)
        }
        const overflowFields = payOverflowManaSync(playerId, overflow)

        const missionResult = updateMissionsSync(playerId, getServerDate(), [...resourceMissionUpdatesSync(playerId, resourcesBefore), ...collectionUpdatesSync(playerId)])

        // respond to client
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "equipment_list": returnEquipmentList,
                "item_list": returnItemList,
                ...overflowFields,
                ...missionReplyFields(missionResult)
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
        const resourcesBefore = missionResourcesSync(playerId)

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

        // give ability cores: those past the cap as mana, as the client's confirmation says (FT-69)
        const overflow: OverflowMana = { mana: 0 }
        creditAwakeningCoresSync(playerId, equipmentId, upgradeCount, returnItemList, overflow)
        const overflowFields = payOverflowManaSync(playerId, overflow)
        const missionResult = updateMissionsSync(playerId, getServerDate(), [
            { pattern: MissionPattern.UPGRADE_EQUIPMENT_COUNT, amount: upgradeCount },
            ...resourceMissionUpdatesSync(playerId, resourcesBefore),
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
                ...overflowFields,
                ...missionReplyFields(missionResult)
            }
        })
    }))

    // "Awaken All" (FT-40): each picked armament awakens with all the duplicates it can use (no Starsteel Ingots), for
    // the Wrightpieces of every level; all or nothing
    fastify.post("/bulk_upgrade", { schema: bulkEquipmentSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as BulkEquipmentBody
        const viewerId = request.viewer.viewerId
        const playerId = request.viewer.playerId
        const resourcesBefore = missionResourcesSync(playerId)

        const ids = [...new Set(body.equipment_ids)]
        const plans = []
        for (const equipmentId of ids) {
            const plan = plannedAwakening(playerId, equipmentId)
            if ("refusal" in plan) return reply.status(400).send({ "error": "Bad Request", "message": plan.refusal })
            plans.push({ equipmentId, plan })
        }
        const returnItemList: Record<string, number> = {}
        if (!spendWrightpiecesSync(playerId, plans.reduce((sum, { plan }) => sum + plan.cost, 0), returnItemList)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not enough of wrightpieces."
        })
        const overflow: OverflowMana = { mana: 0 }
        const returnEquipmentList = plans.map(({ equipmentId, plan }) => applyAwakeningSync(playerId, equipmentId, plan, returnItemList, overflow))
        const overflowFields = payOverflowManaSync(playerId, overflow)

        const missionResult = updateMissionsSync(playerId, getServerDate(), [
            { pattern: MissionPattern.UPGRADE_EQUIPMENT_COUNT, amount: plans.reduce((sum, { plan }) => sum + plan.levels, 0) },
            ...resourceMissionUpdatesSync(playerId, resourcesBefore),
            ...collectionUpdatesSync(playerId)
        ])
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "equipment_list": returnEquipmentList,
                "item_list": returnItemList,
                ...overflowFields,
                ...missionReplyFields(missionResult)
            }
        })
    }))

    // "Melt Down All" (FT-40): every duplicate of each picked armament is melted; locked armaments are refused, as the
    // client does; all or nothing
    fastify.post("/bulk_sell_stack", { schema: bulkEquipmentSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as BulkEquipmentBody
        const viewerId = request.viewer.viewerId
        const playerId = request.viewer.playerId
        const resourcesBefore = missionResourcesSync(playerId)

        const returnItemList: Record<string, number> = {}
        const returnEquipmentList: Object[] = []
        const overflow: OverflowMana = { mana: 0 }
        for (const equipmentId of new Set(body.equipment_ids)) {
            const stack = getPlayerEquipmentSync(playerId, equipmentId)?.stack ?? 0
            const melted = stack < 1 ? { refusal: "No duplicates to melt down." } : meltDuplicatesSync(playerId, equipmentId, stack, returnItemList, overflow, true)
            if ("refusal" in melted) return reply.status(400).send({ "error": "Bad Request", "message": melted.refusal })
            returnEquipmentList.push(melted.equipment)
        }
        const overflowFields = payOverflowManaSync(playerId, overflow)

        const missionResult = updateMissionsSync(playerId, getServerDate(), [...resourceMissionUpdatesSync(playerId, resourcesBefore), ...collectionUpdatesSync(playerId)])
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "equipment_list": returnEquipmentList,
                "item_list": returnItemList,
                ...overflowFields,
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