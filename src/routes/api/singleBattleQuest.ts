import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { deletePlayerRushEventPlayedPartyListSync, getPlayerRushEventPlayedPartiesSync, getPlayerRushEventSync, getPlayerSingleQuestProgressSync, getPlayerSync, insertPlayerQuestProgressSync, insertPlayerRushEventClearedFolderSync, insertPlayerRushEventPlayedPartySync, updatePlayerQuestProgressSync, updatePlayerRushEventSync, updatePlayerSync } from "../../data/wdfpData";
import { getQuestFromCategorySync, getRushEventFolderClearRewards, playerRankSync } from "../../lib/assets";
import { getCharactersEvolutionImgLevels, givePlayerCharactersExpSync } from "../../lib/character";
import { givePlayerRewardsSync, givePlayerRewardSync, givePlayerScoreRewardsSync } from "../../lib/quest";
import { BattleQuest, EquipmentItemReward, PlayerRewardResult, QuestCategory } from "../../lib/types";
import { generateDataHeaders, getServerDate, getServerTime } from "../../utils";
import { clampCount, playerLimits } from "../../lib/limits";
import { rushEventFolderMaxRounds } from "./rushEvent";
import { RushEventBattleType, UserRushEventPlayedParty } from "../../data/types";
import { getSerializedPlayerRushEventPlayedPartiesSync } from "../../lib/rush";
import { any, arrayOf, boolean, gameBody, integer, nullable, number, object, string } from "../schemas";
import { atomicHandler } from "../../lib/atomic";
import { battleClearUpdates, collectionUpdatesSync, questChallengeUpdates, updateMissionsSync, missionReplyFields } from "../../lib/missions";

const startSchema = gameBody({
    quest_id: integer,
    use_boss_boost_point: boolean,
    use_boost_point: boolean,
    category: integer,
    play_id: string,
    is_auto_start_mode: boolean,
    party_id: integer,
    api_count: integer
}, ["quest_id", "category", "party_id"])

interface StartBody {
    quest_id: number
    use_boss_boost_point: boolean
    use_boost_point: boolean
    category: number
    viewer_id: number
    play_id: string
    is_auto_start_mode: boolean
    party_id: number
    api_count: number
}

const partySlots = arrayOf(nullable(object({ id: nullable(integer) })))

/** Battle statistics; the handlers read only party, the rest (zones, client_checks, ...) is stored or ignored. */
export const statisticsSchema = object({
    clear_phase: integer,
    party: object({
        unison_characters: partySlots,
        characters: partySlots,
        equipments: partySlots,
        ability_soul_ids: arrayOf(nullable(integer))
    }, ["unison_characters", "characters"])
}, ["party"])

interface QuestStatistics {
    clear_phase: number,
    party: {
        unison_characters: ({ id: (number | null) } | null)[],
        characters: ({ id: (number | null) } | null)[],
        equipments: ({ id: (number | null) } | null)[],
        ability_soul_ids: (number | null)[]
    }
}

export interface FinishBody {
    is_restored: boolean
    continue_count: number
    elapsed_time_ms: number
    quest_id: number
    category: number
    score: number
    viewer_id: number
    add_mana: number
    is_accomplished: boolean
    statistics: QuestStatistics
    api_count: number
}

const finishSchema = gameBody({
    is_restored: boolean,
    continue_count: integer,
    elapsed_time_ms: integer,
    quest_id: integer,
    category: integer,
    score: number,
    add_mana: integer,
    is_accomplished: boolean,
    statistics: statisticsSchema,
    api_count: integer,
    play_id: string,
    reproduce_log_data: any
}, ["statistics", "score", "quest_id", "category"])

interface PlayContinueBody {
    api_count: number,
    payment_type: number,
    quest_id: number,
    viewer_id: number,
    paly_id: string,
    category: number
}

const playContinueSchema = gameBody({
    api_count: integer,
    payment_type: integer,
    quest_id: integer,
    play_id: string,
    category: integer,
    statistics: any
})

interface AbortBody {
    api_count: number,
    finish_kind: number,
    statistics: QuestStatistics,
    viewer_id: number,
    quest_id: number,
    play_id: string,
    category: number
}

const abortSchema = gameBody({
    api_count: integer,
    finish_kind: integer,
    statistics: any,
    quest_id: integer,
    play_id: string,
    category: integer
})

interface ReturnRushEvent {
    rush_battle_reward_list: {
        kind: number,
        kind_id: number,
        number: number
    }[],
    rush_battle_played_party_list: Record<number, UserRushEventPlayedParty> | null,
    endless_battle_played_party_list: Record<number, UserRushEventPlayedParty> | null,
    is_out_of_period: boolean
}

export interface ActiveQuest {
    questId: number,
    category: QuestCategory,
    useBossBoostPoint: boolean
    useBoostPoint: boolean
    isAutoStartMode: Boolean
    /** set by multi_battle_quest/start: the battle is a co-op one, hosted by this player or not */
    coop?: { host: boolean }
}

const continueVmoneyCost = 50;

const activeQuests: Record<number, ActiveQuest> = {}

export function insertActiveQuest(playerId: number, quest: ActiveQuest) {
    activeQuests[playerId] = quest
}

/** Marks a player's active quest as a co-op battle, for the co-op missions its finish counts. */
export function markActiveQuestCoop(playerId: number, host: boolean) {
    const quest = activeQuests[playerId]
    if (quest !== undefined) quest.coop = { host }
}

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

        // get active quest data
        const activeQuestData = activeQuests[playerId]
        if (activeQuestData === undefined) return reply.status(400).send({
            "error": "Bad Request",
            "message": "No active quest to finish."
        })

        // get quest data
        const questCategory = activeQuestData.category
        const questId = activeQuestData.questId
        const questData = getQuestFromCategorySync(questCategory, questId) as BattleQuest | null
        if (questData === null || !('rankPointReward' in questData)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Quest doesn't exist."
        })

        // delete the active quest data from global record
        delete activeQuests[playerId]

        // calculate clear rank
        const clearTime = body.elapsed_time_ms
        const clearRank = questData.sPlusRankTime >= clearTime ? 5
            : questData.sRankTime >= clearTime ? 4
                : questData.aRankTime >= clearTime ? 3
                    : questData.bRankTime >= clearTime ? 2
                        : 1

        // calculate player rewards
        const newExpPool = playerData.expPool + questData.poolExpReward
        const beforeRankPoint = playerData.rankPoint
        const newRankPoint = beforeRankPoint + questData.rankPointReward
        let newMana = playerData.freeMana + questData.manaReward + body.add_mana

        // calculate boost point
        // a point is spent only if the player has one, and only a spent point doubles the score rewards (SEC-15)
        const spendBoostPoint = activeQuestData.useBoostPoint && playerData.boostPoint > 0
        const spendBossBoostPoint = activeQuestData.useBossBoostPoint && playerData.bossBoostPoint > 0
        const newBoostPoint = playerData.boostPoint - (spendBoostPoint ? 1 : 0)
        const newBossBoostPoint = playerData.bossBoostPoint - (spendBossBoostPoint ? 1 : 0)
        const useBoostPoint = spendBoostPoint || spendBossBoostPoint

        // check current quest progress
        const questProgress = getPlayerSingleQuestProgressSync(playerId, questCategory, questId);
        const questPreviouslyCompleted = questProgress !== null
        const questAccomplished = body.is_accomplished

        if (questAccomplished) {
            // update quest progress
            if (questPreviouslyCompleted) {
                // simply update the quest progress if it already exists.
                updatePlayerQuestProgressSync(playerId, questCategory, {
                    questId: questId,
                    finished: true,
                    bestElapsedTimeMs: questProgress.bestElapsedTimeMs === undefined || questProgress.bestElapsedTimeMs === null ? clearTime : Math.min(clearTime, questProgress.bestElapsedTimeMs),
                    clearRank: questProgress.clearRank === undefined ? clearRank : Math.max(clearRank, questProgress.clearRank),
                    highScore: questProgress.highScore === undefined ? body.score : Math.max(body.score, questProgress.highScore)
                })
            } else {
                // insert if it doesn't already exist.
                insertPlayerQuestProgressSync(playerId, questCategory, {
                    questId: questId,
                    finished: true,
                    bestElapsedTimeMs: clearTime,
                    clearRank: clearRank,
                    highScore: body.score
                })
            }
        }

        // update player
        updatePlayerSync({
            id: playerId,
            freeMana: newMana,
            expPool: newExpPool,
            rankPoint: newRankPoint,
            boostPoint: newBoostPoint,
            bossBoostPoint: newBossBoostPoint
        })

        // clear rewards go after the update above, which writes freeMana and expPool from the
        // snapshot read at the start and would otherwise overwrite a mana or exp clear reward
        // Only a clear earns them: only a clear writes the progress that stops them from paying again (SEC-12)
        const clearReward = questAccomplished && !questPreviouslyCompleted && questData.clearReward !== undefined ? givePlayerRewardSync(playerId, questData.clearReward) : null
        const sPlusClearReward = questAccomplished && (clearRank === 5) && (questProgress?.clearRank !== 5) && (questData.sPlusReward !== undefined) ? givePlayerRewardSync(playerId, questData.sPlusReward) : null

        // reward score rewards
        const scoreRewardsResult = givePlayerScoreRewardsSync(playerId, questData.scoreRewardGroupId, questData.scoreRewardGroup, useBoostPoint)

        // reward character exp
        const bodyPartyStatistics = body.statistics.party
        const partyCharacterIds = [...bodyPartyStatistics.characters, ...bodyPartyStatistics.unison_characters]
        const partyCharacterIdsArray: number[] = []
        for (const value of partyCharacterIds.values()) {
            if (value !== null && value.id !== null) partyCharacterIdsArray.push(value.id);
        }
        const addExpAmount = questData.characterExpReward

        const rewardCharacterExpResult = givePlayerCharactersExpSync(
            playerId,
            partyCharacterIdsArray,
            addExpAmount,
            questData.fixedParty !== undefined
        )

        const dataHeaders = generateDataHeaders({
            viewer_id: viewerId
        })

        // handle event quest-specific data & rewards
        let rushEventData: ReturnRushEvent | null = null
        let rushEventRewardsResult: PlayerRewardResult | null = null

        if (questCategory === QuestCategory.RUSH_EVENT) {
            // rush event

            const rushEventId = questData.rushEventId
            const rushEventFolderId = questData.rushEventFolderId
            const rushEventRound = questData.rushEventRound

            if (rushEventFolderId !== undefined && rushEventRound !== undefined && rushEventId !== undefined) {
                // update rush event data
                const rushEventBattleType = rushEventRound === 0 ? RushEventBattleType.ENDLESS : RushEventBattleType.FOLDER

                // map character ids
                const characterIds = bodyPartyStatistics.characters.map(val => val?.id ?? null)
                const unisonCharacterIds = bodyPartyStatistics.unison_characters.map(val => val?.id ?? null)

                // get evolution image levels
                const evolutionImgLevels: (number | null)[] = getCharactersEvolutionImgLevels(playerId, characterIds)
                const unisonEvolutionImgLevels: (number | null)[] = getCharactersEvolutionImgLevels(playerId, unisonCharacterIds)

                let round: number = questId

                // update endless battle stats
                if (rushEventBattleType === RushEventBattleType.ENDLESS) {
                    // get player rush event data
                    const playerRushEventData = getPlayerRushEventSync(playerId, rushEventId)

                    const playerNextRound = playerRushEventData?.endlessBattleNextRound ?? 1
                    const playerMaxRound = playerRushEventData?.endlessBattleMaxRound ?? 1
                    const playerBestClearTime = playerRushEventData?.endlessBattleMaxRoundTime ?? Number.MAX_SAFE_INTEGER
                    round = playerNextRound

                    if ((playerNextRound >= playerMaxRound && playerBestClearTime >= clearTime) || (playerNextRound > playerMaxRound)) {
                        updatePlayerRushEventSync(playerId, {
                            eventId: rushEventId,
                            endlessBattleMaxRound: playerNextRound,
                            endlessBattleMaxRoundTime: clearTime,
                            endlessBattleMaxRoundCharacterIds: characterIds,
                            endlessBattleMaxRoundCharacterEvolutionImgLvls: evolutionImgLevels
                        })
                    }
                    
                } else if (rushEventBattleType === RushEventBattleType.FOLDER && (rushEventRound >= (rushEventFolderMaxRounds[rushEventFolderId] ?? 0))) {
                    // mark folder as complete since this is the final round
                    insertPlayerRushEventClearedFolderSync(playerId, rushEventId, rushEventFolderId)
                    // update the active folder value
                    updatePlayerRushEventSync(playerId, {
                        eventId: rushEventId,
                        activeRushBattleFolderId: null
                    })
                    // delete played parties
                    deletePlayerRushEventPlayedPartyListSync(playerId, rushEventId, rushEventBattleType)
                }

                // insert played party
                insertPlayerRushEventPlayedPartySync(playerId, rushEventId, {
                    characterIds: characterIds,
                    unisonCharacterIds: unisonCharacterIds,
                    equipmentIds: bodyPartyStatistics.equipments.map(val => val?.id ?? null),
                    abilitySoulIds: bodyPartyStatistics.ability_soul_ids,
                    evolutionImgLevels: evolutionImgLevels,
                    unisonEvolutionImgLevels: unisonEvolutionImgLevels,
                    battleType: rushEventBattleType,
                    round: round
                })

                // get serialized parties
                const serializedPlayedParties = getSerializedPlayerRushEventPlayedPartiesSync(playerId, rushEventId)

                // set rush event data
                rushEventData = {
                    "rush_battle_reward_list": [],
                    "rush_battle_played_party_list": serializedPlayedParties.folderParties,
                    "endless_battle_played_party_list": serializedPlayedParties.endlessParties,
                    "is_out_of_period": false
                }

                // give rewards if allowed
                if (rushEventRound >= (rushEventFolderMaxRounds[rushEventFolderId] ?? 0)) {
                    const rewards = getRushEventFolderClearRewards(rushEventId, rushEventFolderId) ?? []
                    rushEventRewardsResult = givePlayerRewardsSync(playerId, rewards)

                    rushEventData.rush_battle_reward_list = rewards.map(reward => {
                        const itemReward = reward as EquipmentItemReward
                        return {
                            "kind": 1,
                            "kind_id": itemReward.id,
                            "number": itemReward.count
                        }
                    })
                }
            }
        }

        // missions (FT-2): a cleared battle counts, any battle played to the end counts as attempted, and unit exp
        // and drops change what the player owns; their rewards go to the gift box
        const missionResult = updateMissionsSync(playerId, getServerDate(), [
            ...(questAccomplished ? battleClearUpdates(playerId, {
                category: questCategory,
                questId,
                multi: activeQuestData.coop ?? null,
                clearRank,
                clearTimeMs: clearTime,
                score: body.score,
                fieldMana: body.add_mana,
                statistics: body.statistics as unknown as Record<string, unknown>
            }, playerRankSync(newRankPoint)) : []),
            ...questChallengeUpdates(questCategory, questId),
            ...collectionUpdatesSync(playerId)
        ])

        // balances after every grant above (quest, clear, score, character exp overflow and rush rewards)
        const finalPlayer = getPlayerSync(playerId) ?? playerData

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": dataHeaders,
            "data": {
                "user_info": {
                    "free_mana": finalPlayer.freeMana,
                    "exp_pool": finalPlayer.expPool,
                    "exp_pooled_time": getServerTime(playerData.expPooledTime),
                    "free_vmoney": finalPlayer.freeVmoney,
                    "rank_point": newRankPoint,
                    "stamina": playerData.stamina,
                    "stamina_heal_time": getServerTime(playerData.staminaHealTime),
                    "boost_point": newBoostPoint,
                    "boss_boost_point": newBossBoostPoint
                },
                "add_exp_list": rewardCharacterExpResult.add_exp_list,
                "character_list": [
                    ...rewardCharacterExpResult.character_list,
                    ...(clearReward?.character_list || []),
                    ...(sPlusClearReward?.character_list || []),
                    ...scoreRewardsResult.character_list
                ],
                "bond_token_status_list": rewardCharacterExpResult.bond_token_status_list,
                "rewards": {
                    "overflow_pool_exp": 0,
                    "converted_pool_exp": 0,
                    "reward_pool_exp": questData.poolExpReward,
                    "reward_mana": questData.manaReward,
                    "field_mana": body.add_mana
                },
                "old_high_score": questProgress === null ? 0 : questProgress.highScore || 0,
                "joined_character_id_list": [
                    ...(clearReward?.joined_character_id_list || []),
                    ...(sPlusClearReward?.joined_character_id_list || []),
                    ...scoreRewardsResult.joined_character_id_list
                ],
                "before_rank_point": beforeRankPoint,
                "clear_rank": clearRank,
                "drop_score_reward_ids": scoreRewardsResult.drop_score_reward_ids,
                "drop_rare_reward_ids": scoreRewardsResult.drop_rare_reward_ids,
                "drop_additional_reward_ids": [],
                "drop_periodic_reward_ids": [],
                "equipment_list": scoreRewardsResult.equipment_list,
                "category_id": questCategory,
                "start_time": dataHeaders['servertime'],
                "is_multi": "single",
                "quest_name": "",
                "item_list": {
                    ...scoreRewardsResult.items,
                    ...(rushEventRewardsResult?.items ?? {})
                },
                "rush_event": rushEventData,
                ...missionReplyFields(missionResult)
            }
        })
    }))

    fastify.post("/abort", { schema: abortSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as AbortBody

        const viewerId = request.viewer.viewerId

        const playerId = request.viewer.playerId

        const headers = generateDataHeaders({ viewer_id: request.viewer.viewerId })

        // delete existing active quest
        delete activeQuests[playerId]

        return reply.status(200).send({
            "data_headers": headers,
            "data": {
                "user_info": {},
                "category_id": body.category,
                "is_multi": "single",
                "start_time": headers['servertime'],
                "quest_name": ""
            }
        })
    }))

    fastify.post("/start", { schema: startSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as StartBody

        const viewerId = request.viewer.viewerId
        const partyId = body.party_id
        const questId = body.quest_id
        const category = body.category
        const useBoostPoint = body.use_boost_point
        const useBossBoostPoint = body.use_boss_boost_point
        const isAutoStartMode = body.is_auto_start_mode
        if (isNaN(partyId) || isNaN(questId) || isNaN(category) || useBoostPoint === undefined || useBossBoostPoint === undefined || isAutoStartMode === undefined) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        // get quest data
        const questData = getQuestFromCategorySync(category, questId) as BattleQuest | null
        if (questData === null || !('rankPointReward' in questData)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Quest doesn't exist."
        })

        // add to active quests table
        delete activeQuests[playerId]
        activeQuests[playerId] = {
            questId: questId,
            category: category,
            useBoostPoint: useBoostPoint,
            useBossBoostPoint: useBossBoostPoint,
            isAutoStartMode: isAutoStartMode
        }

        // update player last quest id
        if (questData.fixedParty === undefined) {
            updatePlayerSync({
                id: playerId,
                partySlot: partyId
            })
        }

        const dataHeaders = generateDataHeaders({
            viewer_id: viewerId
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": dataHeaders,
            "data": {
                "user_info": {
                    "last_main_quest_id": body.quest_id
                },
                "category_id": body.category,
                "is_multi": "single",
                "start_time": dataHeaders['servertime'],
                "quest_name": ""
            }
        })
    }))

    fastify.post("/play_continue", { schema: playContinueSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as PlayContinueBody

        const viewerId = request.viewer.viewerId

        const playerId = request.viewer.playerId
        const player = isNaN(playerId) ? null : getPlayerSync(playerId)

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        // get active quest data
        const activeQuestData = activeQuests[playerId]
        if (activeQuestData === undefined) return reply.status(400).send({
            "error": "Bad Request",
            "message": "No active quest to continue."
        })

        // free beads first, the rest from paid ones; refused only when both together fall short
        const freeVmoney = player.freeVmoney
        const vmoney = player.vmoney
        const fromFree = Math.min(Math.max(freeVmoney, 0), continueVmoneyCost)
        const fromPaid = continueVmoneyCost - fromFree
        if (vmoney < fromPaid) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not enough vmoney to continue"
        })

        // update the player's vmoney balances
        const setNewFreeVmoney = freeVmoney - fromFree
        const newVmoney = vmoney - fromPaid
        updatePlayerSync({
            id: playerId,
            freeVmoney: setNewFreeVmoney,
            vmoney: newVmoney
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                // clamped like /load, which shows the same balances
                "user_info": {
                    "free_vmoney": clampCount(setNewFreeVmoney, playerLimits.virtualMoney - clampCount(newVmoney, playerLimits.virtualMoney)),
                    "vmoney": clampCount(newVmoney, playerLimits.virtualMoney)
                },
                "mail_arrived": false
            }
        })

    }))
}

export default routes;