// Handles mail.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PartyCategory, RushEventBattleType, UserRushEventPlayedParty } from "../../data/types";
import { deletePlayerRushEventPlayedPartiesUntilSync, deletePlayerRushEventPlayedPartyListSync, deletePlayerRushEventPlayedPartySync, getDefaultPlayerPartyGroupsSync, getDefaultPlayerRushEventSync, getPlayerCharacterSync, getPlayerPartyGroupListSync, getPlayerRushEventClearedFoldersSync, getPlayerRushEventNextEndlessBattleRoundSync, getPlayerRushEventPlayedPartiesSync, getPlayerRushEventSync, getRushEventEndlessRankingListSync, insertPlayerPartyGroupListSync, insertPlayerRushEventClearedFolderSync, insertPlayerRushEventPlayedPartySync, insertPlayerRushEventSync, serializePlayerRushEventPlayedParty, updatePlayerRushEventSync } from "../../data/wdfpData";
import { getQuestFromCategorySync, isRushEventSync } from "../../lib/assets";
import { BattleQuest, QuestCategory, RushEventFolder } from "../../lib/types";
import { generateDataHeaders, getServerDate, getServerTime } from "../../utils";
import { FinishBody, insertActiveQuest } from "./singleBattleQuest";
import { getPlayerRushEventEndlessBattleRankingSync, getRushEventEndlessBattleRankPlayedPartyListSync, getSerializedPlayerRushEventPlayedPartiesSync } from "../../lib/rush";
import { clientSerializeDate } from "../../data/utils";
import { boolean, gameBody, integer, string } from "../schemas";
import { atomicHandler } from "../../lib/atomic";

interface SummaryBody {
    event_id: number,
    viewer_id: number
}

const summarySchema = gameBody({ event_id: integer }, ["event_id"])

interface PartyBody {
    viewer_id: number
}

const partySchema = gameBody()

interface SelectFolderBody {
    folder_id: number,
    event_id: number,
    viewer_id: number
}

const selectFolderSchema = gameBody({ folder_id: integer, event_id: integer }, ["folder_id", "event_id"])

interface BattleStartBody {
    is_auto_start_mode: boolean,
    party_id: number,
    play_id: string,
    quest_id: number,
    viewer_id: number
}

const battleStartSchema = gameBody({
    is_auto_start_mode: boolean,
    party_id: integer,
    play_id: string,
    quest_id: integer
}, ["party_id", "quest_id"])

interface ResetBody {
    quest_type: number,
    event_id: number,
    viewer_id: number,
    reset_target_id?: number,
    is_reset_after_target_round?: boolean
}

const resetSchema = gameBody({
    quest_type: integer,
    event_id: integer,
    reset_target_id: integer,
    is_reset_after_target_round: boolean
}, ["quest_type", "event_id"])

interface RankingBody {
    viewer_id: number,
    event_id: number,
    page?: number,
    aggregated_time?: string
}

const rankingSchema = gameBody({
    event_id: integer,
    page: integer,
    aggregated_time: string
}, ["event_id"])

interface RankingPlayedPartyBody {
    viewer_id: number,
    rank_number: number,
    aggregated_time: string,
    event_id: number
}

const rankingPlayedPartySchema = gameBody({
    rank_number: integer,
    aggregated_time: string,
    event_id: integer
}, ["event_id", "rank_number"])

enum ResetQuestType {
    EMPTY,
    FOLDER,
    ENDLESS
}

interface RushParty {
    ability_soul_ids: (number | null)[],
    character_ids: (number | null)[],
    equipment_ids: (number | null)[],
    options: {
        allow_other_players_to_heal_me: boolean
    },
    party_edited: boolean,
    party_id: number,
    party_name: string,
    unison_character_ids: (number | null)[]
}

interface RushPartyGroup {
    party_group_color_id: number,
    party_group_id: number,
    party_list: RushParty[]
}

export const rushEventFolderMaxRounds: { [key in RushEventFolder]?: number } = {
    [RushEventFolder.INTERMEDIATE]: 2,
    [RushEventFolder.ADVANCED]: 2,
    [RushEventFolder.GODLY]: 2
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/summary", { schema: summarySchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SummaryBody

        const viewerId = request.viewer.viewerId
        const eventId = body.event_id
        if (isNaN(eventId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        // only real events get a row (SEC-15)
        if (!isRushEventSync(eventId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Unknown rush event."
        })

        // get rush event data
        let rushEventData = getPlayerRushEventSync(playerId, eventId)
        if (rushEventData === null) {
            rushEventData = getDefaultPlayerRushEventSync(eventId)
            insertPlayerRushEventSync(playerId, rushEventData)
        }

        // get cleared folder id list
        const clearedFolderIdList = getPlayerRushEventClearedFoldersSync(playerId, eventId)

        // get serialized parties
        const serializedPlayedParties = getSerializedPlayerRushEventPlayedPartiesSync(playerId, eventId)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "endless_battle_next_round": rushEventData.endlessBattleNextRound,
                "active_rush_battle_folder_id": rushEventData.activeRushBattleFolderId,
                "endless_battle_played_max_round": rushEventData.endlessBattleNextRound,
                "cleared_folder_id_list": clearedFolderIdList,
                "endless_battle_played_party_list": serializedPlayedParties.endlessParties,
                "rush_battle_played_party_list": serializedPlayedParties.folderParties,
                "endless_battle_my_ranking": getPlayerRushEventEndlessBattleRankingSync(playerId, eventId, {
                    rushEventData: rushEventData
                }),
                "aggregated_time": clientSerializeDate(getServerDate()),
            }
        })
    }))

    fastify.post("/select_folder", { schema: selectFolderSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SelectFolderBody

        const viewerId = request.viewer.viewerId
        const eventId = body.event_id
        const folderId = body.folder_id
        if (isNaN(eventId) || isNaN(folderId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        // get existing rush event data 
        const rushEventData = getPlayerRushEventSync(playerId, eventId)
        if (rushEventData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": `No rush event data for rush event with id '${eventId}'`
        });

        // Error if a folder has already been selected
        if (rushEventData.activeRushBattleFolderId !== null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Already selected a folder for this rush event."
        });

        // update folder
        updatePlayerRushEventSync(playerId, {
            eventId: eventId,
            activeRushBattleFolderId: folderId
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "folder_id": folderId,
                "event_id": eventId
            }
        })
    }))

    fastify.post("/ranking", { schema: rankingSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as RankingBody

        const viewerId = request.viewer.viewerId
        const eventId = body.event_id
        const page = body.page ?? 0
        if (isNaN(eventId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        // get player endless rank
        const endlessRanking = getPlayerRushEventEndlessBattleRankingSync(playerId, eventId)

        // get all rankings for page
        const rankings = getRushEventEndlessRankingListSync(eventId, page);

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "aggregated_time": clientSerializeDate(getServerDate()),
                "current_page": page + 1,
                "page_max": rankings.pageMax,
                "my_data": endlessRanking,
                "ranking_list": rankings.list
            }
        })
    }))

    fastify.post("/ranking/played_party", { schema: rankingPlayedPartySchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as RankingPlayedPartyBody

        const viewerId = request.viewer.viewerId
        const eventId = body.event_id
        const rankNumber = body.rank_number
        if (isNaN(eventId) || isNaN(rankNumber)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        // get party list
        const partyList = getRushEventEndlessBattleRankPlayedPartyListSync(rankNumber, eventId) ?? []

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "rush_ranking_party": partyList
            }
        })
    }))

    fastify.post("/aggregated_time", { schema: summarySchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SummaryBody

        const viewerId = request.viewer.viewerId
        const eventId = body.event_id
        if (isNaN(eventId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "aggregated_time": clientSerializeDate(getServerDate())
            }
        })
    }))

    fastify.post("/party", { schema: partySchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as PartyBody

        const viewerId = request.viewer.viewerId

        const playerId = request.viewer.playerId

        // get parties
        let playerPartyGroups = getPlayerPartyGroupListSync(playerId, PartyCategory.EVENT)
        // insert default parties if no parties already exist
        if (0 >= Object.keys(playerPartyGroups).length) {
            playerPartyGroups = getPlayerPartyGroupListSync(playerId, PartyCategory.NORMAL)

            // convert party categories
            for (const group of Object.values(playerPartyGroups)) {
                for (const party of Object.values(group.list)) {
                    party.category = PartyCategory.EVENT
                }
                group.category = PartyCategory.EVENT
            }

            insertPlayerPartyGroupListSync(playerId, playerPartyGroups)
        }

        // convert to proper format
        const userPartyGroupList: RushPartyGroup[] = []

        for (const [idString, group] of Object.entries(playerPartyGroups)) {
            const partyList: RushParty[] = []

            // convert parties
            for (const [partyIdString, party] of Object.entries(group.list)) {
                partyList.push({
                    ability_soul_ids: party.abilitySoulIds,
                    character_ids: party.characterIds,
                    equipment_ids: party.equipmentIds,
                    unison_character_ids: party.unisonCharacterIds,
                    options: {
                        allow_other_players_to_heal_me: party.options.allowOtherPlayersToHealMe
                    },
                    party_edited: party.edited,
                    party_id: Number(partyIdString),
                    party_name: party.name
                })
            }

            userPartyGroupList.push({
                "party_group_color_id": group.colorId,
                "party_group_id": Number(idString),
                "party_list": partyList
            })
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_party_group_list": userPartyGroupList
            }
        })
    }))

    fastify.post("/battle/start", { schema: battleStartSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as BattleStartBody

        const viewerId = request.viewer.viewerId
        const isAutoStartMode = body.is_auto_start_mode
        const partyId = body.party_id
        const questId = body.quest_id
        if (isNaN(partyId) || isNaN(questId) || isAutoStartMode === undefined) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        // get quest
        const questData = getQuestFromCategorySync(QuestCategory.RUSH_EVENT, questId) as BattleQuest | null
        if (questData === null || !('rankPointReward' in questData) || questData.rushEventId === undefined) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Quest doesn't exist."
        })

        // insert active quest for '/single_battle_quest/finish' endpoint
        insertActiveQuest(playerId, {
            questId: questId,
            category: QuestCategory.RUSH_EVENT,
            useBoostPoint: false,
            useBossBoostPoint: false,
            isAutoStartMode: isAutoStartMode
        })

        const headers = generateDataHeaders({
            viewer_id: viewerId
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": headers,
            "data": {
                "user_info": {
                    "last_main_quest_id": body.quest_id
                },
                "is_multi": "single",
                "start_time": headers['servertime'],
                "quest_name": ""
            }
        })
    }))

    fastify.post("/reset", { schema: resetSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ResetBody

        const viewerId = request.viewer.viewerId
        const eventId = body.event_id
        const questType: ResetQuestType = body.quest_type
        const resetTargetId: number | undefined = body.reset_target_id
        const isResetAfterTargetRound: boolean | undefined = body.is_reset_after_target_round
        if (isNaN(eventId) || isNaN(questType)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        if (questType === ResetQuestType.FOLDER) {

            // if reset target was provided, we're not resetting the entire folder
            if (resetTargetId !== undefined) {
                deletePlayerRushEventPlayedPartiesUntilSync(playerId, eventId, RushEventBattleType.FOLDER, resetTargetId)
            } else {
                // reset entire folder
                // update the active folder value
                updatePlayerRushEventSync(playerId, {
                    eventId: eventId,
                    activeRushBattleFolderId: null
                })
                // delete played parties
                deletePlayerRushEventPlayedPartyListSync(playerId, eventId, RushEventBattleType.FOLDER)
            }

        } else if (resetTargetId !== undefined) {
            // endless battle resetting
            if (isResetAfterTargetRound) {
                // "reset up until here"
                deletePlayerRushEventPlayedPartiesUntilSync(playerId, eventId, RushEventBattleType.ENDLESS, resetTargetId)
            } else {
                // "reset only here"
                deletePlayerRushEventPlayedPartySync(playerId, eventId, resetTargetId, RushEventBattleType.ENDLESS)
            }
        }
        
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": []
        })
    }))
}

export default routes;