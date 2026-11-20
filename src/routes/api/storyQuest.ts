import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerSingleQuestProgressSync, getPlayerSync, insertPlayerQuestProgressSync, updatePlayerQuestProgressSync } from "../../data/wdfpData";
import { getQuestFromCategorySync } from "../../lib/assets";
import { givePlayerEarnedRewardSync } from "../../lib/quest";
import { generateDataHeaders, getServerDate } from "../../utils";
import { QuestCategory } from "../../lib/types";
import { gameBody, integer } from "../schemas";
import { atomicHandler } from "../../lib/atomic";
import { collectionUpdatesSync, missionReplyFields, storyClearUpdates, updateMissionsSync } from "../../lib/missions";
import { characterEncyclopediaKey, givePlayerCharacterSync } from "../../lib/character";
import { questJoinCharacterIds } from "../../lib/storyJoin";
import { getPlayerCharacterSync } from "../../data/wdfpData";

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
        const rewardResult = !finished && questData.clearReward !== undefined ? givePlayerEarnedRewardSync(playerId, questData.clearReward) : null

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
        // a main story quest can bring a unit along (story_join_character, src/lib/storyJoin.ts): it joins on the first
        // read, unless the player already has it
        const joined = !finished && questSection === QuestCategory.MAIN
            ? questJoinCharacterIds(questId)
                .filter(characterId => getPlayerCharacterSync(playerId, characterId) === null)
                .map(characterId => ({ characterId, result: givePlayerCharacterSync(playerId, characterId) }))
                .filter((join): join is { characterId: number, result: NonNullable<typeof join.result> } => join.result !== null)
            : []
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
                "character_list": [...(rewardResult?.character_list || []), ...joined.map(join => ({ ...join.result.character, "viewer_id": viewerId }))],
                "joined_character_id_list": rewardResult?.joined_character_id_list || [],
                "equipment_list": rewardResult?.equipment_list || [],
                "items": rewardResult?.items || {},
                ...(joined.length === 0 ? {} : {
                    "encyclopedia_info": Object.fromEntries(joined.map(join => [characterEncyclopediaKey(join.characterId), { "read": false }])),
                    "story_join_character_id_list": joined.map(join => join.characterId)
                }),
                ...missionReplyFields(missionResult)
            } : [],
            
        })
    }))
}

export default routes;
