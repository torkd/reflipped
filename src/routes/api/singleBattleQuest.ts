import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerPartyBySlotSync, deletePlayerRushEventPlayedPartyListSync, getPlayerRushEventPlayedPartiesSync, getPlayerRushEventSync, getPlayerSingleQuestProgressSync, getPlayerSync, insertPlayerQuestProgressSync, insertPlayerRushEventClearedFolderSync, insertPlayerRushEventPlayedPartySync, updatePlayerQuestProgressSync, updatePlayerRushEventSync, updatePlayerSync } from "../../data/wdfpData";
import { getQuestFromCategorySync, getRushEventFolderClearRewards, playerRankSync } from "../../lib/assets";
import { giveCollectItemDropsSync } from "../../lib/collectItemDrops";
import { addStaminaSync, coopGuestStaminaShare, playerStaminaSync, questStaminaCost, refillStaminaOnRankUpSync, refundsStamina, serializeStamina, spendStaminaSync } from "../../lib/stamina";
import { getCharactersEvolutionImgLevels, givePlayerCharactersExpSync } from "../../lib/character";
import { givePlayerEarnedRewardsSync, givePlayerEarnedRewardSync, givePlayerScoreRewardsSync } from "../../lib/quest";
import { BattleQuest, EquipmentItemReward, PlayerRewardResult, QuestCategory } from "../../lib/types";
import { generateDataHeaders, getServerDate, getServerTime } from "../../utils";
import { clampCount, playerLimits } from "../../lib/limits";
import { rushEventFolderMaxRounds } from "./rushEvent";
import { RushEventBattleType, UserRushEventPlayedParty } from "../../data/types";
import { getSerializedPlayerRushEventPlayedPartiesSync } from "../../lib/rush";
import { any, arrayOf, boolean, gameBody, integer, nullable, number, object, string } from "../schemas";
import { creditEarnedCurrencySync } from "../../lib/rewardCredits";
import { getRewardPolicy, multiplierForCategory, scaleEarnedAmount } from "../../lib/rewardPolicy";
import { captureEventContext, scheduledContentEnabled, type EventRunContext } from "../../lib/eventSchedule";
import { atomicHandler, SyncRouteHandler } from "../../lib/atomic";
import { checkFinishClaims, PARTY_SLOTS } from "../../lib/questResult";
import { isQuestOpen } from "../../lib/questPeriods";
import { towerQuestStartRefusal } from "../../lib/towerDungeon";
import { expertQuestStartRefusal } from "../../lib/expertSingle";
import { questAttemptRefusal, spendQuestAttemptSync, systemUnlockRefusal } from "../../lib/questAttempts";
import { givePeriodicRewardSync, hardMultiUnlockRefusal } from "../../lib/hardMultiEvent";
import { questItemsStartRefusal, takeQuestItemsSync } from "../../lib/questItems";
import { finishChronoTrialSync } from "../../lib/chronoTrial";
import { partySlotIds } from "../../lib/borderRewards";
import { recordRecentQuestPartySync } from "../../lib/recentParties";
import { startPartyCategory } from "../../lib/eventParties";
import { finishScoreAttackSync, retireScoreAttackSync } from "../../lib/scoreAttack";
import { rewardBoostsFor } from "../../lib/rewardCampaigns";
import { coopChallengeRate, withCoopChallenge } from "../../lib/bossBattlePickup";
import { framesElapsedMs, recordPracticeBattleSync } from "../../lib/practice";
import { finishCarnivalSync } from "../../lib/carnival";
import { rankingEventId, recordRankingBattleSync } from "../../lib/ranking";
import { checkFinishSync } from "../../lib/anticheat";
import { checkFinishStatsSync } from "../../lib/anticheatStats";
import { finishRaidBattleSync } from "../../lib/raid";
import { takeRaidBattleParty } from "../../lib/raidParties";
import { serializeDailyChallengePoints } from "../../lib/rewardPoints";
import { coopStartHostViewerId, coopStartJoinedByInvitation, isInRoomFor } from "../../lib/coop/rooms";
import { establisherFollowSync, FollowState } from "../../lib/follows";
import { battleClientChecks, clientChecksField, clientCheckUpdates, missionResourcesSync, resourceMissionUpdatesSync, battleClearUpdates, collectionUpdatesSync, questChallengeUpdates, updateMissionsSync, missionReplyFields, clearPhaseUpdates, MissionPattern, missionMatchesQuest, type Mission } from "../../lib/missions";

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
    /** Solo earnings use the policy chosen when the quest started; co-op uses its room's immutable policy. */
    rewardMultiplier?: number
    /** An ongoing solo battle keeps its starting event run through travel or playlist changes. */
    eventContext?: EventRunContext & { rewardMultiplier: number }
    /** set by multi_battle_quest/start: the battle is a co-op one, hosted by this player or not */
    coop?: { host: boolean, backup?: boolean, eventContext?: import("../../lib/coop/rooms").CoopEventContext }
    /** the stamina the start took (FT-25): an abort gives it back, a finish counts it as used */
    staminaCost?: number
    /** SEC-18: when the start was answered, in real time (Date.now(); never the game clock, which can travel) */
    startedAtMs?: number
    /** SEC-18: the party the battle started with, its slot and main units; null for a quest's fixed party. A co-op
     * battle's is its start's client_battle_party (slot -1). */
    startParty?: { slot: number, characterIds: (number | null)[] } | null
    /** SEC-18: the continues (play_continue) the server answered in this battle; the time limit rule allows for them */
    continues?: number
}

const continueVmoneyCost = 50;

/** The quest categories whose lost battles the game finishes with their result instead of an abort (see /finish). */
const LOST_FINISH_CATEGORIES = new Set<QuestCategory>([
    QuestCategory.SCORE_ATTACK_EVENT,
    QuestCategory.RAID_EVENT,
    QuestCategory.HARD_MULTI_EVENT,
    QuestCategory.RUSH_EVENT,
    QuestCategory.SOLO_TIME_ATTACK_EVENT,
    // a ranking battle that times out or is wiped out still counts for the ranking (FT-33)
    QuestCategory.RANKING_EVENT_SINGLE
])

const activeQuests: Record<number, ActiveQuest> = {}

export function insertActiveQuest(playerId: number, quest: ActiveQuest) {
    activeQuests[playerId] = { startedAtMs: Date.now(), ...quest }
}

/** The player's battle in progress, read-only (SEC-18: the rules compare a finish with its start). */
export function getActiveQuest(playerId: number): Readonly<ActiveQuest> | undefined {
    return activeQuests[playerId]
}

/** Read-only proof for the resource-version gate: only this authenticated player's active battle may continue. */
export function hasActiveBattleQuest(playerId: number, multi: boolean): boolean {
    const quest = activeQuests[playerId]
    return quest !== undefined && (quest.coop !== undefined) === multi
}

/** Marks a player's active quest as a co-op battle, for the co-op missions its finish counts. */
export function markActiveQuestCoop(playerId: number, host: boolean, backup: boolean = false, eventContext?: import("../../lib/coop/rooms").CoopEventContext) {
    const quest = activeQuests[playerId]
    if (quest !== undefined) {
        quest.coop = { host, backup, eventContext }
        // a co-op battle is a boss fight whatever category its quest reports (the events' co-op quests are not in the boss list)
        quest.rewardMultiplier = eventContext?.rewardMultiplier ?? getRewardPolicy().bossMultiplier
    }
}

/**
 * SEC-18: a co-op battle's party is the one its start sent (client_battle_party), not the slot the start named (whose
 * kind of party isn't known); null when the start sent none, so the party isn't compared.
 */
export function setActiveQuestStartParty(playerId: number, characterIds: (number | null)[] | null) {
    const quest = activeQuests[playerId]
    if (quest !== undefined) quest.startParty = characterIds === null ? null : { slot: -1, characterIds }
}

/** Quest state lives in memory, so restore it alongside a database rollback, including a failed COMMIT. */
function atomicQuestHandler(handler: SyncRouteHandler) {
    return (request: FastifyRequest, reply: FastifyReply) => {
        const playerId = request.viewer.playerId
        const previous = activeQuests[playerId] === undefined ? undefined : structuredClone(activeQuests[playerId])
        return atomicHandler(handler, () => {
            if (previous === undefined) delete activeQuests[playerId]
            else activeQuests[playerId] = previous
        })(request, reply)
    }
}

const routes = async (fastify: FastifyInstance) => {

    fastify.post("/finish", { schema: finishSchema }, atomicQuestHandler((request: FastifyRequest, reply: FastifyReply) => {
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

        // SEC-16: the game ends a lost battle with single_battle_quest/abort (give up, game over and retry all go through
        // its quest-failure exit), so a lost finish comes only from a battle the player is meant to lose (a lose
        // battle: it counts as cleared) or from the event modes whose lost battles finish with their result (score
        // attack, raid, hard multi, rush, solo time attack, ranking). Any other lost finish is refused and pays nothing.
        if (!body.is_accomplished && questData.loseBattle !== true && !LOST_FINISH_CATEGORIES.has(questCategory)) {
            request.log.info({ questId, category: questCategory }, "single_battle_quest/finish: a lost battle sent finish instead of abort")
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "A lost battle ends with abort."
            })
        }

        // SEC-18: the anti-cheat rules (src/lib/anticheatRules.ts), on every new finish, co-op ones included (the co-op
        // finish runs this route). Every mode but off records their flags; in enforce a hard flag keeps this finish's
        // records off the shared boards (ranking event, rush endless, raid kills and ranking, suggested parties) while
        // its rewards are paid as usual. A failing check never fails the finish.
        const { excluded: offBoards, flags: finishFlags } = checkFinishSync({
            start: {
                startedAtMs: activeQuestData.startedAtMs,
                startParty: activeQuestData.startParty,
                continues: activeQuestData.continues,
                coop: activeQuestData.coop !== undefined
            },
            body,
            quest: { category: questCategory, timeLimitMs: questData.timeLimitMs }
        }, {
            playerId, questId, reqId: request.id,
            route: activeQuestData.coop === undefined ? "single_battle_quest/finish" : "multi_battle_quest/finish",
            logError: error => request.log.error({ err: error }, "anti-cheat: finish check failed")
        })
        // SEC-18 phase 4 (src/lib/anticheatStats.ts): the soft review rules R9–R12, against the server's own finishes
        checkFinishStatsSync({
            accountId: request.viewer.accountId, viewerId, category: questCategory, coop: activeQuestData.coop !== undefined,
            body, ip: request.ip, ruleFlags: finishFlags, autoStart: activeQuestData.isAutoStartMode === true
        }, {
            playerId, questId, reqId: request.id,
            route: activeQuestData.coop === undefined ? "single_battle_quest/finish" : "multi_battle_quest/finish",
            logError: error => request.log.error({ err: error }, "anti-cheat: finish statistics failed")
        })

        const rewardMultiplier = activeQuestData.coop?.eventContext?.rewardMultiplier ?? activeQuestData.rewardMultiplier ?? multiplierForCategory(activeQuestData.category)
        // the run's speed the battle started at (FT-32); a battle without a captured run plays the original pace
        const runSpeed = (activeQuestData.coop?.eventContext ?? activeQuestData.eventContext)?.rate ?? 1
        const resourcesBefore = missionResourcesSync(playerId)

        // the client's claims, bounded (SEC-13): field mana, score, clear time and the party that earns exp
        const claims = checkFinishClaims(body)
        if (claims.clamped.length > 0) request.log.warn({ questId, category: questCategory, fields: claims.clamped }, "battle finish values out of range were bounded")
        const score = claims.score
        const scaledFieldMana = scaleEarnedAmount(claims.fieldMana, "mana", undefined, rewardMultiplier)

        // calculate clear rank
        const clearTime = claims.clearTimeMs
        const clearRank = questData.sPlusRankTime >= clearTime ? 5
            : questData.sRankTime >= clearTime ? 4
                : questData.aRankTime >= clearTime ? 3
                    : questData.bRankTime >= clearTime ? 2
                        : 1

        // reward boost campaigns (FT-37): exp, mana and drops of the quests a campaign covers, on the player's clock; a
        // co-op battle against a Co-Op Challenge spotlight's boss adds the season's rate to Boss Coins, exp and mana (FT-34)
        const boosts = withCoopChallenge(rewardBoostsFor(questCategory, questId, getServerDate()),
            activeQuestData.coop !== undefined ? coopChallengeRate(questCategory, questId, getServerDate()) : 1)

        // calculate player rewards
        const earnedPoolExp = creditEarnedCurrencySync(playerId, "exp", scaleEarnedAmount(questData.poolExpReward, "exp", undefined, rewardMultiplier * boosts.exp)).amount
        const earnedMana = creditEarnedCurrencySync(playerId, "mana", scaleEarnedAmount(questData.manaReward, "mana", undefined, rewardMultiplier * boosts.mana)).amount
        const fieldMana = creditEarnedCurrencySync(playerId, "mana", scaledFieldMana).amount
        const beforeRankPoint = playerData.rankPoint
        const newRankPoint = Math.min(2 ** 31 - 1, beforeRankPoint + scaleEarnedAmount(questData.rankPointReward, "exp", undefined, rewardMultiplier))

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
        // a lose battle, lost as intended, is cleared like a won one (the game shows its first-clear result)
        const questAccomplished = body.is_accomplished || questData.loseBattle === true

        if (questAccomplished) {
            // update quest progress
            if (questPreviouslyCompleted) {
                // simply update the quest progress if it already exists.
                updatePlayerQuestProgressSync(playerId, questCategory, {
                    questId: questId,
                    finished: true,
                    bestElapsedTimeMs: questProgress.bestElapsedTimeMs === undefined || questProgress.bestElapsedTimeMs === null ? clearTime : Math.min(clearTime, questProgress.bestElapsedTimeMs),
                    clearRank: questProgress.clearRank === undefined ? clearRank : Math.max(clearRank, questProgress.clearRank),
                    highScore: questProgress.highScore === undefined ? score : Math.max(score, questProgress.highScore)
                })
            } else {
                // insert if it doesn't already exist.
                insertPlayerQuestProgressSync(playerId, questCategory, {
                    questId: questId,
                    finished: true,
                    bestElapsedTimeMs: clearTime,
                    clearRank: clearRank,
                    highScore: score
                })
            }
        }

        // update player
        updatePlayerSync({
            id: playerId,
            rankPoint: newRankPoint,
            boostPoint: newBoostPoint,
            bossBoostPoint: newBossBoostPoint
        })

        // a rank-up adds a full bar of the new rank's stamina (FT-25, FT-49)
        refillStaminaOnRankUpSync(playerId, playerRankSync(beforeRankPoint), playerRankSync(newRankPoint), getServerDate())

        // clear rewards go after the update above, which writes freeMana and expPool from the
        // snapshot read at the start and would otherwise overwrite a mana or exp clear reward
        // Only a clear earns them: only a clear writes the progress that stops them from paying again (SEC-12)
        const clearReward = questAccomplished && !questPreviouslyCompleted && questData.clearReward !== undefined ? givePlayerEarnedRewardSync(playerId, questData.clearReward, rewardMultiplier) : null
        const sPlusClearReward = questAccomplished && (clearRank === 5) && (questProgress?.clearRank !== 5) && (questData.sPlusReward !== undefined) ? givePlayerEarnedRewardSync(playerId, questData.sPlusReward, rewardMultiplier) : null

        // quests with attempts (FT-7, FT-30): most spend one on a clear; the client reads the new count from the reply
        const spentAttempt = questAccomplished ? spendQuestAttemptSync(playerId, questCategory, questId, "clear", getServerDate()) : null

        // reward score rewards
        const scoreRewardsResult = givePlayerScoreRewardsSync(playerId, questData.scoreRewardGroupId, questData.scoreRewardGroup, useBoostPoint, questData.enemyElement, rewardMultiplier, questData.scoreRewardRolls, boosts, runSpeed)

        // collect item events (FT-2, the treasure hunts): a clear of a quest an event names drops the event's item
        const collectItemDrops = questAccomplished
            ? giveCollectItemDropsSync(playerId, questCategory, questId, questData.enemyLevel, getServerDate(), rewardMultiplier, runSpeed)
            : { drops: [], items: {} }

        // the co-op boss events (FT-23): a won battle with a daily count left spends one for the special reward
        const periodicReward = questAccomplished && questCategory === QuestCategory.HARD_MULTI_EVENT
            ? givePeriodicRewardSync(playerId, questId, rewardMultiplier)
            : { drops: [], items: {}, points: [] }

        // Chrono Trials (FT-11): the border rewards a clear newly reaches, mailed, and the reply's solo_time_attack_event
        const chronoTrial = questCategory === QuestCategory.SOLO_TIME_ATTACK_EVENT && questData.eventId !== undefined
            ? finishChronoTrialSync(playerId, questData.eventId, questId, questAccomplished, clearTime, questProgress?.bestElapsedTimeMs ?? null,
                partySlotIds(body.statistics.party.characters))
            : null

        // Score Scramble (FT-11): every battle scores, won or lost: border rewards, best score, history, score_attack_event
        const scoreAttack = questCategory === QuestCategory.SCORE_ATTACK_EVENT
            ? finishScoreAttackSync(playerId, {
                questId,
                accomplished: questAccomplished,
                score,
                elapsedMs: clearTime,
                clearRank: questAccomplished ? clearRank : null,
                statistics: body.statistics as unknown as Record<string, unknown>,
                date: getServerDate()
            })
            : null

        // suggested parties (FT-50): a won battle's party becomes the player's latest for the quest, which other players
        // see under the quest; not a lose battle's, nor a fixed party (not the player's own), nor an excluded finish's
        if (body.is_accomplished && questData.loseBattle !== true && questData.fixedParty === undefined && !offBoards) {
            recordRecentQuestPartySync(playerId, questCategory, questId, body.statistics.party, playerData.partySlot, new Date())
        }

        // Practice Combat (FT-17): every battle goes into the practice history (a given-up one from /abort)
        if (questCategory === QuestCategory.PRACTICE) {
            recordPracticeBattleSync(playerId, {
                questId,
                finishKind: 0,
                score,
                elapsedMs: clearTime,
                clearRank,
                statistics: body.statistics as unknown as Record<string, unknown>,
                date: getServerDate()
            })
        }

        // Hanifolk Carnival (FT-11): the clear's score, the boss's record and the total score rewards, carnival_event
        const carnival = questCategory === QuestCategory.CARNIVAL_EVENT
            ? finishCarnivalSync(playerId, {
                questId,
                quest: questData,
                accomplished: questAccomplished,
                elapsedMs: clearTime,
                characterIds: partySlotIds(body.statistics.party.characters),
                unisonCharacterIds: partySlotIds(body.statistics.party.unison_characters)
            })
            : null

        // ranking events (FT-33): every battle, won or lost, may improve the player's record in the event (an excluded
        // finish's record stays off the board, SEC-18)
        if (questCategory === QuestCategory.RANKING_EVENT_SINGLE && !offBoards) {
            recordRankingBattleSync(playerId, rankingEventId(questId), {
                accomplished: questAccomplished,
                elapsedTimeMs: clearTime,
                score,
                leaderCharacterId: partySlotIds(body.statistics.party.characters).find((id): id is number => id !== null) ?? 1
            })
        }

        // raid events (FT-12): a clear is a kill of the server's boss; the best score keeps its party group
        const raidEvent = questCategory === QuestCategory.RAID_EVENT
            ? finishRaidBattleSync(playerId, questId, questAccomplished, score, takeRaidBattleParty(playerId), getServerDate(), !offBoards)
            : null

        // quests that take items (FT-8, the Treasure Zone's Golden Skull): used up by the clear
        const takenItems = questAccomplished ? takeQuestItemsSync(playerId, questData, questProgress?.finished === true) : {}

        // reward character exp
        // each unit once, from the party's slots only: a repeated id would earn its exp (or, at the level cap, the
        // pooled overflow) once per copy
        const bodyPartyStatistics = body.statistics.party
        const partyCharacterIdsArray = claims.partyCharacterIds
        const addExpAmount = scaleEarnedAmount(questData.characterExpReward, "exp", undefined, rewardMultiplier * boosts.exp)

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
                const characterIds = bodyPartyStatistics.characters.slice(0, PARTY_SLOTS).map(val => val?.id ?? null)
                const unisonCharacterIds = bodyPartyStatistics.unison_characters.slice(0, PARTY_SLOTS).map(val => val?.id ?? null)

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

                    // the leaderboard's record; an excluded finish's stays off it (SEC-18)
                    if (!offBoards && ((playerNextRound >= playerMaxRound && playerBestClearTime >= clearTime) || (playerNextRound > playerMaxRound))) {
                        updatePlayerRushEventSync(playerId, {
                            eventId: rushEventId,
                            endlessBattleMaxRound: playerNextRound,
                            endlessBattleMaxRoundTime: clearTime,
                            endlessBattleMaxRoundCharacterIds: characterIds,
                            endlessBattleMaxRoundCharacterEvolutionImgLvls: evolutionImgLevels
                        })
                    }
                    
                } else if (rushEventBattleType === RushEventBattleType.FOLDER && questAccomplished && (rushEventRound >= (rushEventFolderMaxRounds[rushEventFolderId] ?? 0))) {
                    // only a won final round completes the folder (SEC-13)
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
                    equipmentIds: (bodyPartyStatistics.equipments ?? []).slice(0, PARTY_SLOTS).map(val => val?.id ?? null),
                    abilitySoulIds: (bodyPartyStatistics.ability_soul_ids ?? []).slice(0, PARTY_SLOTS),
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

                // a won final round pays the folder's rewards (SEC-13: a lost one paid them too)
                if (questAccomplished && rushEventRound >= (rushEventFolderMaxRounds[rushEventFolderId] ?? 0)) {
                    const rewards = getRushEventFolderClearRewards(rushEventId, rushEventFolderId) ?? []
                    rushEventRewardsResult = givePlayerEarnedRewardsSync(playerId, rewards, rewardMultiplier)

                    rushEventData.rush_battle_reward_list = rewards.map(reward => {
                        const itemReward = reward as EquipmentItemReward
                        return {
                            "kind": 1,
                            "kind_id": itemReward.id,
                            "number": scaleEarnedAmount(itemReward.count, "item", itemReward.id, rewardMultiplier)
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
                score,
                fieldMana,
                statistics: body.statistics as unknown as Record<string, unknown>
            }, playerRankSync(newRankPoint)) : clearPhaseUpdates(questCategory, questId, body.statistics as unknown as Record<string, unknown>, activeQuestData.coop !== undefined)),
            ...resourceMissionUpdatesSync(playerId, resourcesBefore),
            // the stamina the battle took (pattern 36, FT-25); an aborted battle got it back
            ...((activeQuestData.staminaCost ?? 0) > 0 ? [{ pattern: MissionPattern.USED_STAMINA_COUNT, amount: activeQuestData.staminaCost! }] : []),
            ...questChallengeUpdates(questCategory, questId),
            ...clientCheckUpdates(questCategory, questId, activeQuestData.coop !== undefined, (body.statistics as unknown as Record<string, unknown>).client_checks),
            // raid events (FT-12): any raid battle played takes part in the raid (pattern 75)
            ...(questCategory === QuestCategory.RAID_EVENT ? [{ pattern: MissionPattern.RAID_EVENT_PARTICIPATE, value: 1, matches: (mission: Mission) => missionMatchesQuest(mission, questCategory, questId) }] : []),
            ...collectionUpdatesSync(playerId)
        ], activeQuestData.coop?.eventContext ?? activeQuestData.eventContext, activeQuestData.coop !== undefined)

        // balances after every grant above (quest, clear, score, character exp overflow and rush rewards)
        const finalPlayer = getPlayerSync(playerId) ?? playerData

        // All database work succeeded; a failed reward transaction leaves the quest retryable.
        delete activeQuests[playerId]

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
                    ...serializeStamina(playerStaminaSync(playerId, getServerDate()) ?? { stamina: playerData.stamina, healTime: getServerDate() }),
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
                    "overflow_pool_exp": rewardCharacterExpResult.add_exp_list.reduce((sum, entry) => sum + entry.add_exp_pool, 0),
                    "converted_pool_exp": 0,
                    "reward_pool_exp": earnedPoolExp,
                    "reward_mana": earnedMana,
                    "field_mana": fieldMana
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
                "drop_additional_reward_ids": collectItemDrops.drops,
                "drop_periodic_reward_ids": periodicReward.drops,
                ...(periodicReward.points.length > 0 ? { "user_periodic_reward_point_list": periodicReward.points } : {}),
                "equipment_list": scoreRewardsResult.equipment_list,
                "category_id": questCategory,
                "start_time": dataHeaders['servertime'],
                "is_multi": "single",
                "quest_name": "",
                "item_list": {
                    ...scoreRewardsResult.items,
                    ...(rushEventRewardsResult?.items ?? {}),
                    ...collectItemDrops.items,
                    ...periodicReward.items,
                    ...takenItems
                },
                "rush_event": rushEventData,
                ...(chronoTrial === null ? {} : { "solo_time_attack_event": chronoTrial.reply }),
                ...(scoreAttack === null ? {} : { "score_attack_event": scoreAttack.reply }),
                ...(carnival === null ? {} : { "carnival_event": carnival.reply }),
                ...(raidEvent === null ? {} : { "raid_event": raidEvent }),
                ...(spentAttempt === null ? {} : { "user_daily_challenge_point_list": serializeDailyChallengePoints([spentAttempt]) }),
                ...missionReplyFields(missionResult, (chronoTrial?.mailArrived ?? false) || (scoreAttack?.mailArrived ?? false) || (carnival?.mailArrived ?? false))
            }
        })
    }))

    fastify.post("/abort", { schema: abortSchema }, atomicQuestHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as AbortBody

        const viewerId = request.viewer.viewerId

        const playerId = request.viewer.playerId

        const headers = generateDataHeaders({ viewer_id: request.viewer.viewerId })

        // delete existing active quest, giving its stamina back unless the quest keeps it (FT-25)
        const abortedQuest = activeQuests[playerId]
        delete activeQuests[playerId]
        const refund = abortedQuest?.staminaCost !== undefined && abortedQuest.staminaCost > 0 && refundsStamina(abortedQuest.category, abortedQuest.questId)
            ? abortedQuest.staminaCost : 0
        const stamina = refund > 0 ? addStaminaSync(playerId, refund, getServerDate()) : playerStaminaSync(playerId, getServerDate())

        // Practice Combat (FT-17): a given-up battle is in the practice history too, with no score or rank; the abort
        // has no elapsed time, so it comes from the battle's frames
        if (abortedQuest?.category === QuestCategory.PRACTICE && body.statistics !== null && typeof body.statistics === "object") {
            const statistics = body.statistics as unknown as Record<string, unknown>
            recordPracticeBattleSync(playerId, {
                questId: abortedQuest.questId,
                finishKind: Number.isSafeInteger(body.finish_kind) && body.finish_kind > 0 && body.finish_kind < 100 ? body.finish_kind : 1,
                score: null,
                elapsedMs: framesElapsedMs(statistics),
                clearRank: null,
                statistics,
                date: getServerDate()
            })
        }

        // Score Scramble (FT-33): a wiped-out or given-up battle ends here; it is in the history as retired, with its
        // damage and no score, and changes neither the best score nor the borders
        if (abortedQuest?.category === QuestCategory.SCORE_ATTACK_EVENT && body.statistics !== null && typeof body.statistics === "object") {
            const statistics = body.statistics as unknown as Record<string, unknown>
            retireScoreAttackSync(playerId, {
                questId: abortedQuest.questId,
                finishKind: Number.isSafeInteger(body.finish_kind) && body.finish_kind > 0 && body.finish_kind < 100 ? body.finish_kind : 1,
                elapsedMs: framesElapsedMs(statistics),
                statistics,
                date: getServerDate()
            })
        }

        // base64 msgpack like every game reply: without the type the reply went out as JSON, which the game can't read
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": headers,
            "data": {
                "user_info": stamina === null ? {} : serializeStamina(stamina),
                "category_id": body.category,
                "is_multi": "single",
                "start_time": headers['servertime'],
                "quest_name": ""
            }
        })
    }))

    fastify.post("/start", { schema: startSchema }, atomicQuestHandler((request: FastifyRequest, reply: FastifyReply) => {
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

        // an event quest only within its event's period, on the player's own clock (SEC-16); a co-op guest plays the
        // quest of a room whose host was checked when creating it, whatever the guest's own clock says
        if (!isQuestOpen(category, questId, getServerDate()) && !isInRoomFor(viewerId, questId, category)) {
            request.log.info({ questId, category }, "single_battle_quest/start: the quest's event isn't open")
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "This quest's event isn't open."
            })
        }

        // the Haunt (FT-6): a floor of the open cycle, not cleared yet in it, above a cleared one
        if (category === QuestCategory.TOWER_DUNGEON_EVENT) {
            const refusal = towerQuestStartRefusal(playerId, questId, getServerDate())
            if (refusal !== null) {
                request.log.info({ questId, category }, `single_battle_quest/start: ${refusal}`)
                return reply.status(400).send({
                    "error": "Bad Request",
                    "message": refusal
                })
            }
        }

        // Solo Boss Challenges (FT-7): the rank and the quest cleared before it; Chrono Trials (FT-30): the six Hell
        // Solo Boss Challenges cleared; co-op boss events (FT-23): their unlock; any quest with attempts (FT-30): one left
        const startRefusal = (category === QuestCategory.EXPERT_SINGLE_EVENT ? expertQuestStartRefusal(playerId, questId) : null)
            ?? (category === QuestCategory.SOLO_TIME_ATTACK_EVENT ? systemUnlockRefusal(playerId, "solo_time_attack") : null)
            // co-op boss events (FT-23): the event's unlock; a guest is let in by the host's room
            ?? (category === QuestCategory.HARD_MULTI_EVENT && !isInRoomFor(viewerId, questId, category) ? hardMultiUnlockRefusal(playerId, questId) : null)
            ?? questAttemptRefusal(playerId, category, questId, getServerDate())
            ?? questItemsStartRefusal(playerId, questData, getPlayerSingleQuestProgressSync(playerId, category, questId)?.finished === true)
        if (startRefusal !== null) {
            request.log.info({ questId, category }, `single_battle_quest/start: ${startRefusal}`)
            return reply.status(400).send({
                "error": "Bad Request",
                "message": startRefusal
            })
        }

        // stamina (FT-25): the quest's cost, lowered by an open stamina campaign; a co-op guest pays half, or nothing after
        // joining through an invitation or in a mutual follow's room (FT-60, src/lib/stamina.ts); the host pays it all
        const coopHost = coopStartHostViewerId(viewerId, questId, category)
        const staminaShare = coopHost === null || coopHost === viewerId ? "full"
            : coopGuestStaminaShare(coopStartJoinedByInvitation(viewerId, questId, category), establisherFollowSync(viewerId, coopHost) === FollowState.MUTUAL)
        const staminaCost = questStaminaCost(category, questId, questData.staminaCost, getServerDate(), staminaShare)
        const stamina = spendStaminaSync(playerId, staminaCost, getServerDate())
        if (stamina === null) {
            request.log.info({ questId, category, staminaCost }, "single_battle_quest/start: not enough stamina")
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Not enough stamina."
            })
        }

        // Chrono Trials spend their attempt here (FT-30)
        const spentAttempt = spendQuestAttemptSync(playerId, category, questId, "start", getServerDate())

        // add to active quests table
        const rewardMultiplier = multiplierForCategory(category)
        // SEC-18: the facts later rules compare the finish with (the party as it was saved when the battle started)
        // from the quest's own party set (the Carnival's, FT-11); none where that source is unknown
        const partyCategory = startPartyCategory(category)
        const slotParty = questData.fixedParty === undefined && partyCategory !== null ? getPlayerPartyBySlotSync(playerId, partyId, partyCategory) : null
        delete activeQuests[playerId]
        activeQuests[playerId] = {
            questId: questId,
            category: category,
            useBoostPoint: useBoostPoint,
            useBossBoostPoint: useBossBoostPoint,
            isAutoStartMode: isAutoStartMode,
            rewardMultiplier,
            eventContext: scheduledContentEnabled() ? Object.freeze({ ...captureEventContext(), rewardMultiplier }) : undefined,
            staminaCost,
            startedAtMs: Date.now(),
            startParty: slotParty === null ? null : { slot: partyId, characterIds: slotParty.characterIds }
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
                    "last_main_quest_id": body.quest_id,
                    ...serializeStamina(stamina)
                },
                "category_id": body.category,
                "is_multi": "single",
                "start_time": dataHeaders['servertime'],
                "quest_name": "",
                // the mission conditions the battle checks itself (pattern 82); the original leaves the key out without any
                ...clientChecksField(battleClientChecks(category, questId, false, getServerDate())),
                ...(spentAttempt === null ? {} : { "user_daily_challenge_point_list": serializeDailyChallengePoints([spentAttempt]) })
            }
        })
    }))

    fastify.post("/play_continue", { schema: playContinueSchema }, atomicQuestHandler((request: FastifyRequest, reply: FastifyReply) => {
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

        // the time limit rule allows one more limit per continue (SEC-18)
        activeQuestData.continues = (activeQuestData.continues ?? 0) + 1

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
