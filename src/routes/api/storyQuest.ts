import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerSingleQuestProgressSync, getPlayerSync, insertPlayerQuestProgressSync, updatePlayerQuestProgressSync } from "../../data/wdfpData";
import { getQuestFromCategorySync } from "../../lib/assets";
import { givePlayerRewardSync } from "../../lib/quest";
import { generateDataHeaders, getServerDate } from "../../utils";
import { QuestCategory } from "../../lib/types";
import { gameBody, integer } from "../schemas";
import { atomicHandler } from "../../lib/atomic";
import { collectionUpdatesSync, missionReplyFields, storyClearUpdates, updateMissionsSync } from "../../lib/missions";

interface FinishBody {
    party_id: number,
    quest_id: number,
    viewer_id: number,
    category: number,
    api_count: number
}

const finishSchema = gameBody({
    party_id: integer,
    quest_id: integer,
    category: integer,
    api_count: integer
}, ["quest_id", "category"])

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/finish", { schema: finishSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as FinishBody

        const viewerId = request.viewer.viewerId

        const playerId = request.viewer.playerId
        const playerData = getPlayerSync(playerId)

        if (playerData === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        const questSection = body.category
        const questId = body.quest_id

        // get quest data & check if it is the right type
        const questData = getQuestFromCategorySync(questSection, questId)
        if (questData === null || ("sPlusReward" in questData)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid quest ID provided."
        })

        // get quest progress
        const questProgress = getPlayerSingleQuestProgressSync(playerId, questSection, questId);
        const finished = questProgress !== null ? questProgress.finished : false
        const rewardResult = !finished && questData.clearReward !== undefined ? givePlayerRewardSync(playerId, questData.clearReward) : null

        // missions (FT-2) count the first read; the chapter check counts this quest as read already
        const missionUpdates = !finished ? storyClearUpdates(playerId, questSection, questId) : []

        if (!finished) {
            // update quest progress
            if (questProgress === null) {
                // insert if it doesn't already exist.
                insertPlayerQuestProgressSync(playerId, questSection, {
                    questId: questId,
                    finished: true
                })
            } else {
                // simply update the quest progress if it already exists.
                updatePlayerQuestProgressSync(playerId, questSection, {
                    questId: questId,
                    finished: true
                })
            }
        }
        // a story can bring a unit along (story_join_character)
        const missionResult = updateMissionsSync(playerId, getServerDate(), !finished ? [...missionUpdates, ...collectionUpdatesSync(playerId)] : [])

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": !finished ? {
                "user_info": {
                    "free_vmoney": playerData.freeVmoney + (rewardResult?.user_info.free_vmoney || 0),
                    "free_mana": playerData.freeMana + (rewardResult?.user_info.free_mana || 0)
                },
                "character_list": rewardResult?.character_list || [],
                "joined_character_id_list": rewardResult?.joined_character_id_list || [],
                "equipment_list": rewardResult?.equipment_list || [],
                "items": rewardResult?.items || {},
                ...missionReplyFields(missionResult)
            } : [],
            
        })
    }))
}

export default routes;
