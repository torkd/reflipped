// Handles the insertion of mana into characters.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { deletePlayerBoxGachaDrawnRewardsSync, getPlayerBoxGachaDrawnRewardsSync, getPlayerBoxGachaSync, getPlayerItemSync, getPlayerSync, insertPlayerBoxGachaDrawnRewardSync, insertPlayerBoxGachaSync, playerOwnsEquipmentSync, updatePlayerBoxGachaDrawnRewardSync, updatePlayerBoxGachaSync, updatePlayerEquipmentSync, updatePlayerItemSync, updatePlayerPartyGroupSync } from "../../data/wdfpData";
import { generateDataHeaders, getServerDate, getServerTime, masterDate } from "../../utils";
import { isContentPeriodOpen } from "../../lib/eventSchedule";
import boxResets from "../../../assets/box_gacha_reset.json";
import { getBoxGachaSync } from "../../lib/assets";
import { drawBoxGachaSync, rewardPlayerBoxGachaResultSync } from "../../lib/gacha";
import { BoxGachaBoxes } from "../../lib/types";
import { boolean, gameBody, integer } from "../schemas";
import { atomicHandler } from "../../lib/atomic";

/** A box's reset rule (assets/box_gacha_reset.json): kind 2 resets once empty; limit null is unlimited. */
interface BoxReset {
    kind: number
    limit: number | null
    start: string
    end: string
}

/** box_gacha/reset outside the box's period (the client's InvalidPeriodError). */
const BOX_OUT_OF_PERIOD = 4608

const resetSchema = gameBody({ box_gacha_id: integer, box_id: integer }, ["box_gacha_id", "box_id"])

interface GetBoxListBody {
    box_gacha_id: number
    viewer_id: number
    api_count: number
}

interface ExecBody {
    stop_on_featured_rewards: boolean,
    box_gacha_id: number,
    box_id: number,
    api_count: number,
    viewer_id: number,
    number: number
}

interface CloseBody {
    box_gacha_id: number,
    box_id: number,
    viewer_id: number,
    api_count: number
}

/**
 * The box a player is on: the lowest-numbered one not closed yet. Boxes are played in order, so draws and closes go to
 * this one only (SEC-15). Null when every box is closed.
 */
function currentBoxId(playerId: number, boxGachaId: number, boxes: BoxGachaBoxes): number | null {
    const ids = Object.keys(boxes).map(Number).sort((a, b) => a - b)
    return ids.find(id => !(getPlayerBoxGachaSync(playerId, boxGachaId, id)?.isClosed ?? false)) ?? null
}

/**
 * Returns all of a box gacha's box statuses serialized for the client.
 * 
 * @param playerId The ID of the player.
 * @param boxGachaId The ID of the box gacha.
 * @param boxes A record of boxes to get the data of.
 * @param skipBoxId The ID of the box id to skip.
 */
function getAllBoxList(
    playerId: number,
    boxGachaId: number,
    boxes: BoxGachaBoxes,
    skipBoxId?: number
): Object[] {
    const boxInfo: Object[] = []
    for (const [boxId, _] of Object.entries(boxes)) {
        // get drawn rewards
        const parsedBoxId = Number(boxId)
        if (parsedBoxId !== skipBoxId) {
            const playerBoxData = getPlayerBoxGachaSync(playerId, boxGachaId, parsedBoxId)

            const playerDrawnRewards = getPlayerBoxGachaDrawnRewardsSync(playerId, boxGachaId, parsedBoxId)

            boxInfo.push({
                "box_id": parsedBoxId,
                "reset_times": playerBoxData?.resetTimes ?? 0,
                "all_drawn_reward_list": playerDrawnRewards.map(reward => {
                    return {
                        "reward_id": reward.id,
                        "number": reward.number
                    }
                }),
                "coming_next_reward_list": [],
                "is_closed": playerBoxData?.isClosed ?? false
            })
        }
    }
    return boxInfo
}

const closeSchema = gameBody({
    box_gacha_id: integer,
    box_id: integer,
    api_count: integer
})

const execSchema = gameBody({
    stop_on_featured_rewards: boolean,
    box_gacha_id: integer,
    box_id: integer,
    api_count: integer,
    number: integer
}, ["box_gacha_id", "box_id", "number"])

const getBoxListSchema = gameBody({
    box_gacha_id: integer,
    api_count: integer
}, ["box_gacha_id"])

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/close", { schema: closeSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {

        const body = request.body as CloseBody

        const viewerId = request.viewer.viewerId
        const boxGachaId = body.box_gacha_id
        const boxId = body.box_id
        if (isNaN(boxGachaId) || isNaN(boxId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        // get box asset data.
        const boxGachaData = getBoxGachaSync(boxGachaId)
        if (boxGachaData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid box gacha id."
        })

        if (boxId !== currentBoxId(playerId, boxGachaId, boxGachaData.boxes)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not the current box."
        })

        // get the box's data.
        const playerBoxData = getPlayerBoxGachaSync(playerId, boxGachaId, boxId)
        if (playerBoxData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Box doesn't exist"
        })

        // check if the box is already closed
        if (playerBoxData.isClosed) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Box is already closed."
        })

        // set box to be closed
        updatePlayerBoxGachaSync(playerId, boxGachaId, {
            boxId: boxId,
            isClosed: true
        })

        // get all boxes
        const allBoxDataList = getAllBoxList(playerId, boxGachaId, boxGachaData.boxes, boxId);

        // add box that we just closed to all box data.
        const playerDrawnRewards = getPlayerBoxGachaDrawnRewardsSync(playerId, boxGachaId, boxId)
        allBoxDataList.push({
            "box_id": boxId,
            "reset_times": playerBoxData?.resetTimes ?? 0,
            "all_drawn_reward_list": playerDrawnRewards.map(reward => {
                return {
                    "reward_id": reward.id,
                    "number": reward.number
                }
            }),
            "coming_next_reward_list": [],
            "is_closed": true
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "all_box_info": getAllBoxList(playerId, boxGachaId, boxGachaData.boxes)
            }
        })
    }))

    fastify.post("/exec", { schema: execSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ExecBody

        const viewerId = request.viewer.viewerId
        const boxGachaId = body.box_gacha_id
        const boxId = body.box_id
        const pullCount = body.number
        const stopOnFeaturedRewards = body.stop_on_featured_rewards
        if (isNaN(boxGachaId) || isNaN(boxId) || !Number.isSafeInteger(pullCount) || pullCount < 1 || stopOnFeaturedRewards === undefined) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId
        const player = getPlayerSync(playerId)

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // get box gacha data
        const boxGachaData = getBoxGachaSync(boxGachaId)
        if (boxGachaData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid box gacha id."
        })

        // make sure the player has enough currency
        const pullCurrencyId = boxGachaData.redeemItemId
        const playerPullCurrency = getPlayerItemSync(playerId, pullCurrencyId)
        if (playerPullCurrency === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "No pull currency."
        })
        if (0 > playerPullCurrency - pullCount * boxGachaData.redeemItemCount) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not enough pull currency."
        })

        // get the current box
        const boxRewards = boxGachaData.boxes[boxId]
        if (boxRewards === undefined) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid box ID."
        })

        if (boxId !== currentBoxId(playerId, boxGachaId, boxGachaData.boxes)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not the current box."
        })
        const playerBoxData = getPlayerBoxGachaSync(playerId, boxGachaId, boxId)

        const playerDrawnRewards = getPlayerBoxGachaDrawnRewardsSync(playerId, boxGachaId, boxId)

        // perform the draws
        const drawResult = drawBoxGachaSync(boxRewards, playerDrawnRewards, pullCount, stopOnFeaturedRewards)
        const drawnRewards = drawResult.rewards
        // pay for the draws made: fewer than asked when the box runs out or a featured reward stops them
        const drawsMade = drawnRewards.reduce((sum, reward) => sum + reward.number, 0)
        const newPullCurrency = playerPullCurrency - drawsMade * boxGachaData.redeemItemCount

        // reward the player
        const rewardResult = rewardPlayerBoxGachaResultSync(playerId, drawResult)

        // calculate all drawn reward list
        const playerDrawnRewardMap: Map<number, number> = new Map()
        const allDrawResultMap: Map<number, number> = new Map()
        let totalDrawCount = 0
        for (const drawnReward of drawnRewards) {
            const number = drawnReward.number
            totalDrawCount += number
            allDrawResultMap.set(drawnReward.id, number);
        }
        for (const playerDrawnReward of playerDrawnRewards) {
            const id = playerDrawnReward.id
            const number = playerDrawnReward.number
            totalDrawCount += number
            allDrawResultMap.set(id, (allDrawResultMap.get(id) ?? 0) + number);
            playerDrawnRewardMap.set(id, number)
        }

        // update box gacha data
        const remainingDrawsNumber = (boxGachaData.availableCounts[boxId] ?? totalDrawCount) - totalDrawCount
        const shouldClose = remainingDrawsNumber === 0
        if (playerBoxData === null) {
            insertPlayerBoxGachaSync(playerId, boxGachaId, {
                boxId: boxId,
                isClosed: shouldClose,
                remainingNumber: remainingDrawsNumber,
                resetTimes: 0
            })
        } else {
            // auto close the box if the remaining draws are 0
            updatePlayerBoxGachaSync(playerId, boxGachaId, {
                boxId: boxId,
                isClosed: shouldClose,
                remainingNumber: remainingDrawsNumber
            })
        }

        // upsert drawn rewards
        for (const drawnReward of drawnRewards) {
            const id = drawnReward.id
            const existing = playerDrawnRewardMap.get(drawnReward.id)
            if (existing === undefined) {
                insertPlayerBoxGachaDrawnRewardSync(playerId, boxGachaId, boxId, {
                    id: id,
                    number: drawnReward.number
                })
            } else {
                updatePlayerBoxGachaDrawnRewardSync(playerId, boxGachaId, boxId, id, existing + drawnReward.number)
            }
        }

        // update currency
        updatePlayerItemSync(playerId, pullCurrencyId, newPullCurrency)

        // generate totalDrawnRewards array
        const allBoxInfo: Object[] = getAllBoxList(playerId, boxGachaId, boxGachaData.boxes, boxId)

        // add current box to allBoxInfo
        {
            // build all drawn reward list
            const allDrawnRewardList: Object[] = []
            for (const [rewardId, number] of allDrawResultMap) {
                allDrawnRewardList.push({
                    "reward_id": rewardId,
                    "number": number
                })
            }

            allBoxInfo.push({
                "box_id": boxId,
                "reset_times": playerBoxData?.resetTimes ?? 0,
                "all_drawn_reward_list": allDrawnRewardList,
                "coming_next_reward_list": [],
                "is_closed": shouldClose ? true : playerBoxData?.isClosed ?? false
            })
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_info": {
                    "free_mana": player.freeMana + (rewardResult?.user_info.free_mana ?? 0),
                    "exp_pool": player.expPool + (rewardResult?.user_info.exp_pool ?? 0),
                    "exp_pooled_time": getServerTime(player.expPooledTime),
                },
                "drawn_reward_list": drawnRewards.map(reward => {
                    return {
                        "reward_id": reward.id,
                        "number": reward.number
                    }
                }),
                "all_box_info": allBoxInfo,
                "joined_character_id_list": rewardResult?.joined_character_id_list ?? [],
                "character_list": rewardResult?.character_list ?? [],
                "equipment_list": rewardResult?.equipment_list ?? [],
                "item_list": {
                    [pullCurrencyId]: newPullCurrency,
                    ...(rewardResult?.items ?? {})
                },
                "mail_arrived": false
            }
        })
    }))

    // Resetting a box (FT-14): refills it as it was, counting reset_times. The master data's reset rule (box_gacha/box,
    // assets/box_gacha_reset.json): every gacha's last box resets once it's empty, without limit; the other boxes never
    // do. Kind 1 (once every required reward is drawn) isn't in the data and is refused. Outside the box's period, 4608
    // (the client's InvalidPeriodError).
    fastify.post("/reset", { schema: resetSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const { box_gacha_id: boxGachaId, box_id: boxId } = request.body as { box_gacha_id: number, box_id: number }
        const { viewerId, playerId } = request.viewer
        const boxGachaData = getBoxGachaSync(boxGachaId)
        const rule = (boxResets as Record<string, Record<string, BoxReset>>)[String(boxGachaId)]?.[String(boxId)]
        if (boxGachaData === null || boxGachaData.boxes[boxId] === undefined || rule === undefined || rule.kind !== 2)
            return reply.status(400).send({ "error": "Bad Request", "message": "This box can't be reset." })
        if (!isContentPeriodOpen(masterDate(rule.start).getTime(), masterDate(rule.end).getTime(), getServerDate())) {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({ "data_headers": generateDataHeaders({ viewer_id: viewerId, result_code: BOX_OUT_OF_PERIOD }), "data": [] })
        }
        const playerBox = getPlayerBoxGachaSync(playerId, boxGachaId, boxId)
        if (playerBox === null || playerBox.remainingNumber > 0)
            return reply.status(400).send({ "error": "Bad Request", "message": "The box isn't empty." })
        if (rule.limit !== null && playerBox.resetTimes >= rule.limit)
            return reply.status(400).send({ "error": "Bad Request", "message": "The box's resets are used up." })

        deletePlayerBoxGachaDrawnRewardsSync(playerId, boxGachaId, boxId)
        updatePlayerBoxGachaSync(playerId, boxGachaId, {
            boxId,
            isClosed: false,
            remainingNumber: boxGachaData.availableCounts[boxId] ?? 0,
            resetTimes: playerBox.resetTimes + 1
        })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": { "all_box_info": getAllBoxList(playerId, boxGachaId, boxGachaData.boxes) }
        })
    }))

    fastify.post("/get_box_list", { schema: getBoxListSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetBoxListBody

        const viewerId = request.viewer.viewerId
        const boxGachaId = body.box_gacha_id
        if (isNaN(boxGachaId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId
        const player = getPlayerSync(playerId)

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // get box gacha data
        const boxGachaData = getBoxGachaSync(boxGachaId)
        if (boxGachaData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid box gacha id."
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "all_box_info": getAllBoxList(playerId, boxGachaId, boxGachaData.boxes)
            }
        })
    }))
}

export default routes;