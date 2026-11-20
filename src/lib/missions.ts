// Missions (FT-2): regular, daily, event and degree (title) missions. The server counts each mission's progress, clears its stages
// and mails their rewards (mail reason 60, "Mission Reward"); a reply that cleared stages lists them in `mission_info`,
// and `mission/get_mission_progress` lists progress for the mission screen. Daily missions start over every game day.
// Degree missions give titles instead, straight away (`profile/get_degree_list` lists the titles a player has).
// Collect item event missions (category 4) are the treasure hunts' and promo mission events' own missions, counted like
// event missions and listed per event.
// Step Up Missions (active missions) count the same patterns, but their cleared stages wait in
// `all_active_mission_list` until the player claims them with `active_mission/receive`, which grants the rewards.
//
// Master data: `master/mission/{regular,daily,event,collect_item_event,degree}_mission` and `master/active_mission/active_mission` with their
// `_reward` tables, converted into `assets/mission.json` and `assets/active_mission.json` by scripts/converter.py.
// Table layout, patterns and what is still missing: docs/missions.md.

import missionAssets from "../../assets/mission.json";
import activeMissionAssets from "../../assets/active_mission.json";
import characterLevels from "../../assets/character_level.json";
import { currentMissionRunSync, setCurrentMissionRunSync, missionRunProgressSync, setMissionRunProgressSync, rewardSnapshotSync, deleteRewardSnapshotSync, deleteRewardSnapshotCategorySync } from "../data/rewardSnapshots";
import { isContentPeriodOpen, currentEventOccurrenceKey, runOnCapturedEventContext, scheduledContentEnabled, type EventRunContext } from "./eventSchedule";
import { RUN_PROGRESS_PATTERNS, runOnEarnedRewardMultiplier, runProgress, scaleEarnedMailAmount } from "./rewardPolicy";
import { MailType } from "../data/types";
import { deletePlayerMissionRewardBacklogSync, getPlayerMissionRewardBacklogSync, insertPlayerMissionRewardBacklogSync, deletePlayerMissionsSync, getPlayerActiveMissionsSync, getPlayerClearedRegularMissionListSync, getPlayerCollectionSync, getPlayerItemSync, getPlayerItemsSync, insertPlayerDegreeSync, getPlayerMissionsSync, getPlayerReceivableMailCountSync, getPlayerSingleQuestProgressSync, getPlayerSync, givePlayerItemSync, setPlayerActiveMissionProgressSync, setPlayerActiveMissionStageSync, setPlayerClearedRegularMissionSync, setPlayerMissionSync, updatePlayerSync } from "../data/wdfpData";
import { getServerTime, masterDate } from "../utils";
import { getQuestFromCategorySync, getCharacterDataSync, getCharacterManaNodesSync } from "./assets";
import { getItemMaxCountSync, mailLimits, playerLimits } from "./limits";
import { InvalidMailError, sendPlayerMailSync } from "./mail";
import { QuestCategory } from "./types";
import mainQuests from "../../assets/main_quest.json";
import exQuests from "../../assets/ex_quest.json";

/** The client's `mission_category`. */
export enum MissionCategory {
    REGULAR = 1,
    DAILY = 2,
    EVENT = 3,
    /** a collect item event's missions (`collect_item_event`): treasure hunts and promo missions, listed per event */
    COLLECT_ITEM_EVENT = 4,
    /** title missions: each stage gives a title (degree) */
    DEGREE = 5
}

/** The client's MissionPatternKind, by the number the master tables use (only the patterns the server counts). */
export enum MissionPattern {
    TOTAL_LOGIN_DAYS = 0,
    PLAYER_RANK_ACHIEVEMENT = 1,
    MANA_ADDITION_COUNT = 2,
    TREASURE_SHOP_USED_MANA_COUNT = 3,
    CHARACTERS_COUNT = 4,
    CHARACTER_LEVEL_ACHIEVEMENT = 5,
    LEVEL_80_CHARACTER_COUNT = 6,
    TOTAL_RELEASED_MANA_NODE_COUNT = 7,
    TOTAL_OBTAINED_BOND_TOKEN_COUNT = 8,
    OVER_LIMIT_TOTAL_COUNT = 9,
    GOT_EQUIP_KIND_COUNT = 10,
    TARGET_MISSION_CLEAR = 11,
    SINGLE_BATTLE_CLEAR_COUNT = 12,
    SINGLE_BATTLE_CLEAR_TIME = 13,
    MULTI_BATTLE_CLEAR_COUNT = 14,
    MULTI_BATTLE_HOST_COUNT = 15,
    MULTI_BATTLE_GUEST_COUNT = 16,
    MULTI_BATTLE_MVP_COUNT = 17,
    ATTENTION_QUEST_CLEAR_COUNT = 18,
    EPISODE_CLEAR_COUNT = 19,
    CHAPTER_CLEAR = 20,
    BATTLE_CLEAR_COUNT = 21,
    HIGH_SCORE_ACHIEVEMENT = 23,
    SS_RANK_COUNT = 24,
    MAX_POWER_ACHIEVEMENT = 25,
    BATTLE_ZONE_STATISTICS_COUNT = 26,
    BATTLE_ZONE_STATISTICS_MAX_VALUE = 27,
    MAX_COMBO_ACHIEVEMENT = 28,
    MAX_SKILL_CHAIN_ACHIEVEMENT = 29,
    TOTAL_ATTAINED_DROP_MANA_COUNT = 30,
    UPGRADE_EQUIPMENT_COUNT = 32,
    SET_SOUL_SPHERE_COUNT = 33,
    LEVEL_MAX_EQUIPMENT_COUNT = 34,
    GET_ITEM_COUNT = 35,
    USED_STAMINA_COUNT = 36,
    CHARACTER_DETAIL_ZOOM_ILLUST_FOR_1MIN_COUNT = 37,
    CHARACTER_DETAIL_PLAY_DOT_SP_MOTION_COUNT = 38,
    HOME_TAP_TOWN_CHARACTER_COUNT = 39,
    HOME_CHANGE_VOICE_COUNT = 40,
    CHARACTER_LEVEL_100_AND_GOT_BOND_TOKEN = 41,
    TREASURE_SHOP_BOUGHT_ITEM_COUNT = 42,
    TOTAL_USED_MANA_COUNT = 43,
    MANA_BOARD_2ND_OPEN_COUNT = 44,
    MANA_BOARD_2ND_COMPLETE_COUNT = 45,
    /** time_attack_clear_phase_1-4 (FT-11): a ranking event (time attack) battle that cleared at least N phases */
    TIME_ATTACK_CLEAR_PHASE_1 = 46,
    /** raid_event_* (FT-12): take part in a raid (a raid battle played), and set up a raid set's Main, Sub 1, Sub 2 party */
    RAID_EVENT_PARTICIPATE = 75,
    RAID_EVENT_SET_MAIN_PARTY = 76,
    QUEST_CLEAR = 54,
    EQUIPPED_FIRST_TIME = 55,
    SET_UNISON_FIRST_TIME = 56,
    EVOLVED_CHARACTER_COUNT = 58,
    TOTAL_RELEASED_ABILITY_NODE_COUNT = 59,
    INJECTED_EXP_FIRST_TIME = 60,
    TRADED_COUNT_TO_EQUIPMENT_BY_BOSS_COIN = 61,
    QUEST_CHALLENGE = 62,
    CHAPTER_COMPLETE = 63,
    TWITTER_CHECK = 64,
    TRADED_COUNT_BY_BOSS_COIN_SHOP = 80,
    CHARACTER_ELECTION_VOTE_COUNT = 65,
    /**
     * ss_rank_clear_with_not_received_resistance_debuff (FT-23, the Inferno Steambot co-op boss event's "Challenge
     * Mission"): an S+ clear without receiving a resistance down debuff. The client sends nothing about the debuffs a
     * battle received (no statistic, no `mission/mission_client_check` row, not a client-reported pattern), so only the
     * S+ clear is checked.
     */
    SS_RANK_CLEAR_WITHOUT_RESISTANCE_DEBUFF = 81,
    BATTLE_CLIENT_CHECK = 82
}

/**
 * The patterns the client counts itself and reports with `mission/update_mission_progress`, by the name it sends
 * (the client's mission sender maps exactly these five). The server takes no other pattern from the client.
 */
export const CLIENT_REPORTED_PATTERNS: Record<string, MissionPattern> = {
    "character_detail_zoom_illust_for_1min_count": MissionPattern.CHARACTER_DETAIL_ZOOM_ILLUST_FOR_1MIN_COUNT,
    "character_detail_play_dot_sp_motion_count": MissionPattern.CHARACTER_DETAIL_PLAY_DOT_SP_MOTION_COUNT,
    "home_tap_town_character_count": MissionPattern.HOME_TAP_TOWN_CHARACTER_COUNT,
    "home_change_voice_count": MissionPattern.HOME_CHANGE_VOICE_COUNT,
    "twitter_check": MissionPattern.TWITTER_CHECK
}

/** A battle's `battle_kind` filter (patterns 21-31). */
enum BattleKind {
    SINGLE = 1,
    MULTI = 2,
    ANY = 3
}

/**
 * A mission's quest kind (master column 7) and the quest categories it covers. 12 is the daily content group
 * ("Clear N Kaleidoscope quests").
 */
const QUEST_KIND_CATEGORIES: Record<number, QuestCategory[]> = {
    0: [QuestCategory.MAIN],
    1: [QuestCategory.EX],
    2: [QuestCategory.BOSS_BATTLE],
    3: [QuestCategory.DAILY_WEEK_EVENT],
    4: [QuestCategory.DAILY_EXP_MANA_EVENT],
    5: [QuestCategory.ADVENT_EVENT_SINGLE, QuestCategory.ADVENT_EVENT_MULTI],
    6: [QuestCategory.STORY_EVENT_SINGLE],
    7: [QuestCategory.CHALLENGE_DUNGEON_EVENT],
    8: [QuestCategory.RANKING_EVENT_SINGLE],
    9: [QuestCategory.WORLD_STORY_EVENT],
    10: [QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE],
    11: [QuestCategory.PRACTICE],
    12: [QuestCategory.DAILY_WEEK_EVENT, QuestCategory.DAILY_EXP_MANA_EVENT, QuestCategory.CHALLENGE_DUNGEON_EVENT, QuestCategory.TOWER_DUNGEON_EVENT],
    13: [QuestCategory.TOWER_DUNGEON_EVENT],
    14: [QuestCategory.EXPERT_SINGLE_EVENT],
    15: [QuestCategory.CARNIVAL_EVENT],
    16: [QuestCategory.RAID_EVENT],
    17: [QuestCategory.RUSH_EVENT],
    18: [QuestCategory.SOLO_TIME_ATTACK_EVENT],
    19: [QuestCategory.HARD_MULTI_EVENT],
    20: [QuestCategory.SCORE_ATTACK_EVENT]
}

/** Quest kinds whose quest ids are chapter * 1000000 + stage * 1000 + quest (main, EX, boss battles). */
const CHAPTER_QUEST_KINDS = new Set([0, 1, 2])

/**
 * Zone statistics by the master's statistics kind (pattern 26, summed over the zones), read from the mission texts
 * ("Dash ::x_count:: times" is kind 2): the client only has the number. Kinds 3 and 6 are never used.
 */
const ZONE_STATISTICS: Record<number, string> = {
    0: "weak_point_attack_count",
    1: "use_power_flip_count",
    2: "use_dash_count",
    4: "use_skill_count",
    5: "fever_count",
    7: "enemy_kill_count",
    8: "use_emotion_count",
    9: "use_buff_to_all_party_members",
    10: "use_heal_to_all_party_members",
    11: "coffin_count_reduced_count",
    12: "clear_debuff_of_self_count",
    13: "use_debuff_to_enemy_count",
    14: "clear_buff_of_enemy_count",
    15: "fever_ms",
    16: "use_power_flip_count"
}

/** Zone statistics by the master's statistics max value kind (pattern 27, the highest zone's). */
const ZONE_MAX_STATISTICS: Record<number, string> = {
    0: "damage_deal_max",
    1: "max_coffin_count_by_revival"
}

/** The mission reward mail: the client fills in the reward (`::item::`) from the mail itself. */
export const missionRewardMailReasonId = 60
const missionRewardMailSubject = "Mission Reward"
const missionRewardMailDescription = "You have received the following mission reward(s)."

/** Progress values are 32-bit integers in the client. */
const MAX_PROGRESS = 2 ** 31 - 1

/** "Own N Lv. 5 armaments" (pattern 34): the awakening level the armament missions count. */
const MAX_EQUIPMENT_LEVEL = 5

/** The clear rank of S+, which "complete" chapters (pattern 63) need on every battle. */
const S_PLUS_RANK = 5

/** A title reward (MissionRewardKind `Degree`): given at once, not mailed. */
const TITLE_REWARD_KIND = 6

/** A reward kind (MissionRewardKind) and the mail that carries it. Titles (6) aren't mailed. */
const REWARD_MAIL_TYPES: Record<number, MailType> = {
    0: MailType.FREE_VMONEY,
    1: MailType.ITEM,
    2: MailType.EQUIPMENT,
    3: MailType.FREE_MANA,
    4: MailType.CHARACTER,
    5: MailType.EXP_POOL
}

interface MissionReward {
    kind: number
    amount?: number
    id?: number
}

export interface Mission {
    pattern: number
    /** collect item event missions only: the event (`collect_item_event` id) and the round they belong to */
    eventId?: number
    round?: number
    statistics?: number
    statisticsMaxValue?: number
    battleKind?: number
    clientCheck?: string
    questKind?: number
    /** [chapters or event, stages, quests]; an empty list matches any */
    questIds?: number[][]
    questRankId?: number
    itemId?: number
    equipmentId?: number
    characterId?: number
    needMissionId?: number
    needMissionStage?: number
    /** "YYYY-MM-DD HH:MM:SS", Japan time; no date is no limit */
    startDate?: string
    endDate?: string
    showStartDate?: string
    showEndDate?: string
    missionIds?: number[]
    repeat?: boolean
    /** Step Up Missions only: the phase (1 Rookie, 2 Beginner, 3 Intermediate, 4 Advanced) */
    phase?: number
    /** the targets are cumulative: stage 2's counts from 0, not from stage 1's target */
    stages: { target: number, rewards: MissionReward[], clearSeconds?: number }[]
}

const missionTables = missionAssets as Record<string, Record<string, Mission>>
const activeMissions = activeMissionAssets as Record<string, Mission>
const CATEGORIES = [MissionCategory.REGULAR, MissionCategory.DAILY, MissionCategory.EVENT, MissionCategory.COLLECT_ITEM_EVENT, MissionCategory.DEGREE]

export function getMission(category: MissionCategory, missionId: number): Mission | null {
    return missionTables[String(category)]?.[String(missionId)] ?? null
}

/** Whether a mission counts at a date (its enable period; regular missions have none). */
export function isMissionOpen(mission: Mission, date: Date): boolean {
    const start = mission.startDate === undefined ? undefined : masterDate(mission.startDate).getTime()
    const end = mission.endDate === undefined ? undefined : masterDate(mission.endDate).getTime()
    // Legacy fixtures include the master's entire final second; scheduled periods share the client's projected
    // whole-second boundary so an accelerated end does not close while the client still shows it open.
    return scheduledContentEnabled() ? isContentPeriodOpen(start, end, date)
        : isContentPeriodOpen(start, end === undefined ? undefined : end + 1000, date, false)
}

/** Display dates may extend past the period in which progress can be earned. */
export function isMissionVisible(mission: Mission, date: Date): boolean {
    return isMissionOpen({ ...mission, startDate: mission.showStartDate ?? mission.startDate, endDate: mission.showEndDate ?? mission.endDate }, date)
}

/** One `mission_info` entry: a stage the server just cleared. */
export interface MissionInfo {
    mission_category_id: number
    mission_id: number
    mission_reward_id: number
}

/** What happened in a battle the player cleared, for the battle patterns. */
export interface BattleClear {
    category: QuestCategory
    questId: number
    /** co-op: whether the player hosted the room */
    multi: { host: boolean, backup?: boolean } | null
    clearRank: number
    /** the finish body's `elapsed_time_ms` */
    clearTimeMs: number
    score: number
    fieldMana: number
    /** the finish body's `statistics` as the client sent it */
    statistics: Record<string, unknown>
}

/**
 * A progress update: add `amount`, or keep the larger of `value` and the progress, for missions `matches` accepts.
 * `value` can depend on the mission (per-unit missions).
 */
export type MissionUpdate = { pattern: number, matches?: (mission: Mission) => boolean } & ({ amount: number } | { value: number | ((mission: Mission) => number) })

/** One `active_mission_list` entry: a Step Up mission whose progress changed, with the stages that changed. */
export interface ActiveMissionEntry {
    mission_id: number
    progress_value: number
    stages: { stage: number, received: boolean }[]
}

/** What a progress update did: the stages it cleared (`mission_info`) and the Step Up missions it moved. */
export interface MissionResult {
    missionInfo: MissionInfo[]
    activeMissions: ActiveMissionEntry[]
}

/**
 * The reply fields for a mission result: `mission_info`, `active_mission_list` (left out when empty, like the
 * original's replies) and `mail_arrived` (true when mission rewards were mailed, or `mailArrived` already was).
 */
/**
 * The titles a mission result gave (`degree_list` in `mission/update_mission_progress`): the rewards of the degree
 * mission stages it cleared.
 */
export function grantedDegreeIds(result: MissionResult): number[] {
    return result.missionInfo
        .filter(info => info.mission_category_id === MissionCategory.DEGREE)
        .flatMap(info => getMission(MissionCategory.DEGREE, info.mission_id)?.stages[info.mission_reward_id % 1000 - 1]?.rewards ?? [])
        .filter(reward => reward.kind === TITLE_REWARD_KIND && reward.id !== undefined)
        .map(reward => reward.id!)
}

export function missionReplyFields(result: MissionResult, mailArrived: boolean = false): Record<string, unknown> {
    return {
        "mission_info": result.missionInfo,
        ...(result.activeMissions.length > 0 ? { "active_mission_list": result.activeMissions } : {}),
        "mail_arrived": mailArrived || result.missionInfo.some(info => info.mission_category_id !== MissionCategory.DEGREE)
    }
}

type PlayerMissionState = Map<number, { progress: number, clearedStage: number }>

function loadState(playerId: number, category: MissionCategory): PlayerMissionState {
    const state: PlayerMissionState = new Map()
    for (const mission of getPlayerMissionsSync(playerId, category)) state.set(mission.missionId, { progress: mission.progress, clearedStage: mission.clearedStage })
    if (category === MissionCategory.REGULAR) {
        // an imported save only has the cleared stages (cleared_regular_mission_list)
        for (const [missionId, stage] of Object.entries(getPlayerClearedRegularMissionListSync(playerId))) {
            const entry = state.get(Number(missionId)) ?? { progress: 0, clearedStage: 0 }
            state.set(Number(missionId), { ...entry, clearedStage: Math.max(entry.clearedStage, stage) })
        }
    }
    return state
}

/** Whether the mission a mission waits for (`need_mission_id`, in the same table) has cleared the stage it needs. */
function isUnlocked(mission: Mission, clearedStage: (missionId: number) => number): boolean {
    if (mission.needMissionId === undefined) return true
    return clearedStage(mission.needMissionId) >= (mission.needMissionStage ?? 1)
}

function isComplete(mission: Mission, clearedStage: number): boolean {
    return mission.stages.length > 0 && clearedStage >= mission.stages.length
}

function safeCount(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), MAX_PROGRESS) : 0
}

/** A mission's progress after the updates that apply to it. */
/** `runBound`: an event or collect item event mission, whose counted effort goes at the run's speed (FT-32). */
function applyUpdates(mission: Mission, progress: number, updates: MissionUpdate[], runBound = false): number {
    for (const update of updates) {
        if (update.pattern !== mission.pattern || (update.matches !== undefined && !update.matches(mission))) continue
        const value = "amount" in update ? 0 : typeof update.value === "number" ? update.value : update.value(mission)
        const amount = "amount" in update ? safeCount(update.amount) : 0
        const counted = runBound && RUN_PROGRESS_PATTERNS.has(mission.pattern) ? runProgress(amount) : amount
        progress = Math.min(MAX_PROGRESS, "amount" in update ? progress + counted : Math.max(progress, safeCount(value)))
    }
    return progress
}

function earnedStageRewards(playerId: number, category: number, missionId: number, stage: number, rewards: MissionReward[]): MissionReward[] {
    return rewardSnapshotSync(playerId, category, missionId, stage, () => rewards.map(reward => ({
        ...reward,
        ...(reward.amount === undefined ? {} : { amount: scaleEarnedMailAmount(REWARD_MAIL_TYPES[reward.kind], reward.amount, reward.id) })
    })))
}

/** Mails a stage's rewards; false (and nothing sent) if they don't all fit in the gift box. */
function mailStageRewards(playerId: number, rewards: MissionReward[], now: Date): boolean {
    const mails = rewards.filter(reward => REWARD_MAIL_TYPES[reward.kind] !== undefined && (reward.amount ?? 0) > 0)
    if (getPlayerReceivableMailCountSync(playerId, now) + mails.length > mailLimits.pendingMails) return false
    for (const reward of mails) {
        const type = REWARD_MAIL_TYPES[reward.kind]
        try {
            sendPlayerMailSync(playerId, {
                type,
                typeId: type === MailType.ITEM || type === MailType.EQUIPMENT || type === MailType.CHARACTER ? reward.id ?? null : null,
                number: reward.amount!,
                reasonId: missionRewardMailReasonId,
                durableReward: true,
                subject: missionRewardMailSubject,
                description: missionRewardMailDescription
            })
        } catch (error) {
            if (!(error instanceof InvalidMailError)) throw error
            // a reward the game can't grant (an unplayable unit, an unknown item) is skipped rather than failing the
            // request that made the progress; sendPlayerMailSync checks before it writes anything
        }
    }
    return true
}

/**
 * Clears every stage a mission's progress reaches, mailing the rewards and giving titles at once. A stage whose
 * rewards don't fit in the gift box stays uncleared, so a later update (or the mission list) clears it once there
 * is room.
 */
function clearStages(playerId: number, category: MissionCategory, missionId: number, mission: Mission, entry: { progress: number, clearedStage: number }, now: Date, cleared: MissionInfo[]) {
    if (mission.repeat === true) return clearRepeatStages(playerId, category, missionId, mission, entry, now, cleared)
    // One action can reach several stages while the first reward is blocked. Freeze every reached stage now,
    // so clearing room or changing profiles later cannot give the later stages a different earning multiplier.
    for (let stage = entry.clearedStage + 1; stage <= mission.stages.length && entry.progress >= mission.stages[stage - 1].target; stage++)
        earnedStageRewards(playerId, category, missionId, stage, mission.stages[stage - 1].rewards)
    while (entry.clearedStage < mission.stages.length && entry.progress >= mission.stages[entry.clearedStage].target) {
        const stage = entry.clearedStage + 1
        const rewards = earnedStageRewards(playerId, category, missionId, stage, mission.stages[entry.clearedStage].rewards)
        if (!mailStageRewards(playerId, rewards, now)) break
        for (const reward of rewards) {
            if (reward.kind === TITLE_REWARD_KIND && reward.id !== undefined) insertPlayerDegreeSync(playerId, reward.id)
        }
        deleteRewardSnapshotSync(playerId, category, missionId, stage)
        entry.clearedStage++
        cleared.push({
            mission_category_id: category,
            mission_id: missionId,
            mission_reward_id: missionId * 1000 + entry.clearedStage
        })
    }
}

/** Completions one update may pay a repeatable mission. */
const MAX_REPEAT_ROUNDS = 100

/**
 * A repeatable mission (`is_repeat`, "Repeatable: can be achieved any number of times"; 55 backup-clear missions, one
 * stage each) pays again every time its progress reaches the target anew. `clearedStage` counts the stages paid over
 * all rounds, so once paid it stays complete for "clear the other missions" (pattern 11) and unlocks; `progress` counts
 * within the current round, and the client sees the current round's stage.
 */
function clearRepeatStages(playerId: number, category: MissionCategory, missionId: number, mission: Mission, entry: { progress: number, clearedStage: number }, now: Date, cleared: MissionInfo[]) {
    const length = mission.stages.length
    for (let paid = 0; length > 0 && paid < MAX_REPEAT_ROUNDS * length; paid++) {
        const index = entry.clearedStage % length
        if (entry.progress < mission.stages[index].target) break
        const rewards = earnedStageRewards(playerId, category, missionId, index + 1, mission.stages[index].rewards)
        if (!mailStageRewards(playerId, rewards, now)) break
        deleteRewardSnapshotSync(playerId, category, missionId, index + 1)
        entry.clearedStage++
        // a round is over: the next one counts from the progress beyond its last target
        if (entry.clearedStage % length === 0) entry.progress -= mission.stages[length - 1].target
        cleared.push({ mission_category_id: category, mission_id: missionId, mission_reward_id: missionId * 1000 + index + 1 })
    }
}

/** The stage the client shows: the one under way, the last once all are cleared (a repeatable mission's round's). */
function displayedStage(mission: Mission, clearedStage: number): number {
    const length = mission.stages.length
    if (mission.repeat === true && length > 0) return clearedStage % length + 1
    return Math.min(clearedStage + 1, length)
}

function store(playerId: number, category: MissionCategory, missionId: number, entry: { progress: number, clearedStage: number }, before: number) {
    setPlayerMissionSync(playerId, category, { missionId, ...entry })
    // a repeatable mission isn't listed as cleared: the client would show it done
    if (category === MissionCategory.REGULAR && entry.clearedStage > before && getMission(category, missionId)?.repeat !== true) setPlayerClearedRegularMissionSync(playerId, missionId, entry.clearedStage)
}

/**
 * Applies progress updates to every open mission (regular, daily, event and Step Up), clears the stages they reach
 * and mails the regular, daily and event missions' rewards; Step Up stages wait to be claimed. "Clear the other
 * missions" missions (pattern 11) follow the missions they count.
 *
 * @returns The stages cleared (`mission_info`) and the Step Up missions that moved (`active_mission_list`).
 */
export function updateMissionsSync(playerId: number, now: Date, updates: MissionUpdate[], eventContext?: EventRunContext & { rewardMultiplier?: number }, coop = false): MissionResult {
    const onEvent = <T>(fn: () => T): T => {
        if (!eventContext) return fn()
        return runOnCapturedEventContext(eventContext, () => eventContext.rewardMultiplier === undefined ? fn() : runOnEarnedRewardMultiplier(eventContext.rewardMultiplier, fn))
    }
    // A co-op battle plays in the room's event context (the host's period) but counts for the player's own mission run:
    // switching runs to the room's occurrence archived and restored the player's progress at every co-op battle.
    if (coop) ensureEventMissionRunSync(playerId)
    else onEvent(() => ensureEventMissionRunSync(playerId))
    const result: MissionResult = { missionInfo: [], activeMissions: [] }
    result.missionInfo.push(...drainPendingMissionRewardsSync(playerId, now))
    for (const category of CATEGORIES) {
        const runBound = category === MissionCategory.EVENT || category === MissionCategory.COLLECT_ITEM_EVENT
        const updateCategory = () => {
            const state = loadState(playerId, category)
            const clearedStage = (missionId: number) => state.get(missionId)?.clearedStage ?? 0
            let changed = false
            for (const [id, mission] of Object.entries(missionTables[String(category)])) {
                if (!isUnlocked(mission, clearedStage)) continue
                const missionId = Number(id)
                if (!isMissionOpen(mission, now) && !state.has(missionId)) continue
                const entry = { ...(state.get(missionId) ?? { progress: 0, clearedStage: 0 }) }
                if (isComplete(mission, entry.clearedStage) && mission.repeat !== true) continue
                const before = { ...entry }
                if (isMissionOpen(mission, now)) entry.progress = applyUpdates(mission, entry.progress, updates, runBound)
                clearStages(playerId, category, missionId, mission, entry, now, result.missionInfo)
                if (entry.progress === before.progress && entry.clearedStage === before.clearedStage) continue
                store(playerId, category, missionId, entry, before.clearedStage)
                state.set(missionId, entry)
                changed = true
            }
            if (changed) settleTargetMissions(playerId, category, state, now, result.missionInfo)
        }
        if (runBound) onEvent(updateCategory)
        else updateCategory()
    }
    result.activeMissions = updateActiveMissionsSync(playerId, now, updates)
    return result
}

/** Pattern 11 ("Clear all daily missions"): the progress is how many of its `mission_ids` are complete. */
function settleTargetMissions(playerId: number, category: MissionCategory, state: PlayerMissionState, now: Date, cleared: MissionInfo[]) {
    const clearedStage = (missionId: number) => state.get(missionId)?.clearedStage ?? 0
    for (const [id, mission] of Object.entries(missionTables[String(category)])) {
        if (mission.pattern !== MissionPattern.TARGET_MISSION_CLEAR || mission.missionIds === undefined) continue
        if (!isMissionOpen(mission, now) || !isUnlocked(mission, clearedStage)) continue
        const missionId = Number(id)
        const entry = { ...(state.get(missionId) ?? { progress: 0, clearedStage: 0 }) }
        const progress = mission.missionIds.filter(targetId => {
            const target = getMission(category, targetId)
            return target !== null && isComplete(target, clearedStage(targetId))
        }).length
        const before = entry.clearedStage
        const beforeProgress = entry.progress
        entry.progress = Math.max(progress, entry.progress)
        clearStages(playerId, category, missionId, mission, entry, now, cleared)
        if (entry.progress !== beforeProgress || entry.clearedStage !== before) {
            store(playerId, category, missionId, entry, before)
            state.set(missionId, entry)
        }
    }
}

/** A Step Up mission's progress and its cleared stages (stage number to whether its rewards were received). */
interface ActiveMissionState { progress: number, stages: Map<number, boolean> }

function loadActiveState(playerId: number): Map<number, ActiveMissionState> {
    const state = new Map<number, ActiveMissionState>()
    for (const [missionId, mission] of Object.entries(getPlayerActiveMissionsSync(playerId))) {
        const stages = new Map<number, boolean>()
        for (const [stage, received] of Object.entries(mission.stages)) stages.set(Number(stage), received)
        state.set(Number(missionId), { progress: mission.progress, stages })
    }
    return state
}

/**
 * Step Up Missions: applies the updates, then pattern 11 ("Clear all Rookie missions", which counts cleared missions
 * whether or not their rewards were claimed). Cleared stages are stored unreceived.
 */
function updateActiveMissionsSync(playerId: number, now: Date, updates: MissionUpdate[]): ActiveMissionEntry[] {
    const state = loadActiveState(playerId)
    const clearedStage = (missionId: number) => state.get(missionId)?.stages.size ?? 0
    const changed = new Map<number, ActiveMissionEntry>()
    const advance = (missionId: number, mission: Mission, progress: number) => {
        const entry = state.get(missionId) ?? { progress: 0, stages: new Map<number, boolean>() }
        const reply = changed.get(missionId) ?? { mission_id: missionId, progress_value: progress, stages: [] }
        entry.progress = progress
        reply.progress_value = progress
        setPlayerActiveMissionProgressSync(playerId, missionId, progress)
        while (entry.stages.size < mission.stages.length && progress >= mission.stages[entry.stages.size].target) {
            const stage = entry.stages.size + 1
            earnedStageRewards(playerId, 0, missionId, stage, mission.stages[stage - 1].rewards)
            entry.stages.set(stage, false)
            setPlayerActiveMissionStageSync(playerId, missionId, stage, false)
            reply.stages.push({ stage, received: false })
        }
        state.set(missionId, entry)
        changed.set(missionId, reply)
    }
    for (const [id, mission] of Object.entries(activeMissions)) {
        if (!isMissionOpen(mission, now) || !isUnlocked(mission, clearedStage)) continue
        const missionId = Number(id)
        const entry = state.get(missionId)
        if (isComplete(mission, entry?.stages.size ?? 0)) continue
        const progress = applyUpdates(mission, entry?.progress ?? 0, updates)
        if (progress !== (entry?.progress ?? 0)) advance(missionId, mission, progress)
    }
    if (changed.size > 0) {
        for (const [id, mission] of Object.entries(activeMissions)) {
            if (mission.pattern !== MissionPattern.TARGET_MISSION_CLEAR || mission.missionIds === undefined) continue
            if (!isMissionOpen(mission, now) || !isUnlocked(mission, clearedStage)) continue
            const progress = mission.missionIds.filter(targetId => {
                const target = activeMissions[String(targetId)]
                return target !== undefined && isComplete(target, clearedStage(targetId))
            }).length
            if (progress > (state.get(Number(id))?.progress ?? 0)) advance(Number(id), mission, progress)
        }
    }
    return [...changed.values()]
}

/** What `active_mission/receive` granted. */
export interface ReceiveActiveMissionsResult {
    activeMissions: ActiveMissionEntry[]
    userInfo: Record<string, number>
    itemList: Record<string, number>
    /** armament and unit rewards (none in the Step Up tables) go to the gift box */
    mailArrived: boolean
}

/**
 * Claims cleared Step Up stages and grants their rewards directly (beads, items, mana, pooled exp). Stages that
 * aren't cleared, were claimed already or whose rewards would take the player past a limit are skipped.
 */
export function receiveActiveMissionsSync(playerId: number, claims: { missionId: number, stages: number[] }[], now: Date): ReceiveActiveMissionsResult | null {
    const player = getPlayerSync(playerId)
    if (player === null) return null
    const state = loadActiveState(playerId)
    const balances = { freeVmoney: player.freeVmoney, freeMana: player.freeMana, expPool: player.expPool }
    const items = new Map<number, number>()
    const changedFields = new Set<string>()
    const replies = new Map<number, ActiveMissionEntry>()
    let mailArrived = false

    for (const claim of claims) {
        const mission = activeMissions[String(claim.missionId)]
        const entry = state.get(claim.missionId)
        if (mission === undefined || entry === undefined || !isMissionVisible(mission, now)) continue
        if (Object.entries(activeMissions).some(([id, earlier]) => (earlier.phase ?? 1) < (mission.phase ?? 1)
            && earlier.stages.some(stage => (state.get(Number(id))?.progress ?? 0) < stage.target))) continue
        for (const stage of new Set(claim.stages)) {
            if (entry.stages.get(stage) !== false) continue
            const rewards = earnedStageRewards(playerId, 0, claim.missionId, stage, mission.stages[stage - 1]?.rewards ?? [])
            // the rewards of a stage are granted together or not at all
            const after = { ...balances }
            const afterItems = new Map(items)
            let fits = true
            for (const reward of rewards) {
                const amount = reward.amount ?? 0
                switch (reward.kind) {
                    case 0: after.freeVmoney += amount; fits &&= player.vmoney + after.freeVmoney <= playerLimits.virtualMoney; break
                    case 3: after.freeMana += amount; fits &&= after.freeMana <= playerLimits.mana; break
                    case 5: after.expPool += amount; fits &&= after.expPool <= playerLimits.expPool; break
                    case 1: {
                        const owned = afterItems.get(reward.id!) ?? getPlayerItemSync(playerId, reward.id!) ?? 0
                        const max = getItemMaxCountSync(reward.id!)
                        fits &&= max !== null && owned + amount <= max
                        afterItems.set(reward.id!, owned + amount)
                        break
                    }
                }
            }
            if (!fits) continue
            const mailed = rewards.filter(reward => reward.kind === 2 || reward.kind === 4)
            if (mailed.length > 0 && !mailStageRewards(playerId, mailed, now)) continue
            mailArrived ||= mailed.length > 0
            for (const reward of rewards) {
                if (reward.kind === 0) changedFields.add("free_vmoney")
                if (reward.kind === 3) changedFields.add("free_mana")
                if (reward.kind === 5) changedFields.add("exp_pool")
            }
            Object.assign(balances, after)
            for (const [itemId, count] of afterItems) items.set(itemId, count)
            deleteRewardSnapshotSync(playerId, 0, claim.missionId, stage)
            entry.stages.set(stage, true)
            setPlayerActiveMissionStageSync(playerId, claim.missionId, stage, true)
            const reply = replies.get(claim.missionId) ?? { mission_id: claim.missionId, progress_value: entry.progress, stages: [] }
            reply.stages.push({ stage, received: true })
            replies.set(claim.missionId, reply)
        }
    }

    const itemList: Record<string, number> = {}
    for (const [itemId, count] of items) {
        const owned = getPlayerItemSync(playerId, itemId) ?? 0
        if (count > owned) givePlayerItemSync(playerId, itemId, count - owned)
        itemList[itemId] = count
    }
    updatePlayerSync({ id: playerId, ...balances })
    const userInfo: Record<string, number> = {}
    if (changedFields.has("free_vmoney")) userInfo["free_vmoney"] = balances.freeVmoney
    if (changedFields.has("free_mana")) userInfo["free_mana"] = balances.freeMana
    if (changedFields.has("exp_pool")) {
        userInfo["exp_pool"] = balances.expPool
        // like mail/receive: the client adds the exp pooled since this time on its own (server) clock
        userInfo["exp_pooled_time"] = getServerTime(player.expPooledTime)
    }
    return { activeMissions: [...replies.values()], userInfo, itemList, mailArrived }
}

/** Whether a mission's quest filter (kind, id lists, quest rank) accepts a quest. */
export function missionMatchesQuest(mission: Mission, category: QuestCategory, questId: number): boolean {
    if (mission.questRankId !== undefined) {
        const quest = getQuestFromCategorySync(category, questId)
        // Match the authoritative rank; quest suffixes do not consistently encode difficulty.
        if (quest === null || !("questRankId" in quest) || quest.questRankId !== mission.questRankId) return false
    }
    if (mission.questKind === undefined) return true
    if (!(QUEST_KIND_CATEGORIES[mission.questKind] ?? []).includes(category)) return false
    const [first = [], second = [], third = []] = mission.questIds ?? []
    const matches = (list: number[], value: number) => list.length === 0 || list.includes(value)
    if (CHAPTER_QUEST_KINDS.has(mission.questKind)) {
        return matches(first, Math.floor(questId / 1000000)) && matches(second, Math.floor(questId / 1000) % 1000) && matches(third, questId % 1000)
    }
    // practice quests are listed by id; event quests by event (questId / 1000) and number within it
    if (mission.questKind === 11) return matches(third, questId)
    return matches(first, Math.floor(questId / 1000)) && matches(third, questId % 1000)
}

function matchesBattleKind(mission: Mission, multi: boolean): boolean {
    if (mission.battleKind === undefined || mission.battleKind === BattleKind.ANY) return true
    return mission.battleKind === (multi ? BattleKind.MULTI : BattleKind.SINGLE)
}

/** The zone statistics of a finish body, summed (or their maximum) over the zones. */
function zoneStatistic(statistics: Record<string, unknown>, key: string, max: boolean): number {
    const zones = Array.isArray(statistics.zones) ? statistics.zones : []
    let result = 0
    for (const zone of zones) {
        if (zone === null || typeof zone !== "object") continue
        const value = safeCount((zone as Record<string, unknown>)[key])
        result = max ? Math.max(result, value) : Math.min(MAX_PROGRESS, result + value)
    }
    return result
}

type ChapterQuests = Record<string, { name: string, sPlusRankTime?: number }>
const mainQuestTable = mainQuests as ChapterQuests
const exQuestTable = exQuests as ChapterQuests

/** The main or EX quests of a chapter. */
function chapterQuestIds(quests: ChapterQuests, chapter: number): number[] {
    return Object.keys(quests).map(Number).filter(id => Math.floor(id / 1000000) === chapter)
}

/** The chapter a cleared main or EX quest completes, if every quest of it is now cleared. */
function completedChapter(playerId: number, category: QuestCategory, questId: number): number | null {
    const quests = category === QuestCategory.MAIN ? mainQuestTable : category === QuestCategory.EX ? exQuestTable : null
    if (quests === null) return null
    const chapter = Math.floor(questId / 1000000)
    const allCleared = chapterQuestIds(quests, chapter).every(id => id === questId || getPlayerSingleQuestProgressSync(playerId, category, id)?.finished === true)
    return allCleared ? chapter : null
}

/**
 * Whether every quest of a main or EX chapter is done the "complete" way (pattern 63, "Clear all missions up to
 * World 6 with a rank of S+"): battles cleared at S+, stories read. `readQuestId` is a story read just now, whose
 * progress isn't stored yet.
 */
function isChapterCompleteSync(playerId: number, category: QuestCategory, chapter: number, readQuestId: number | null): boolean {
    const quests = category === QuestCategory.MAIN ? mainQuestTable : category === QuestCategory.EX ? exQuestTable : null
    if (quests === null) return false
    const ids = chapterQuestIds(quests, chapter)
    return ids.length > 0 && ids.every(id => {
        if (id === readQuestId) return true
        const progress = getPlayerSingleQuestProgressSync(playerId, category, id)
        if (progress?.finished !== true) return false
        return quests[String(id)].sPlusRankTime === undefined || progress.clearRank === S_PLUS_RANK
    })
}

/**
 * Chapter clears for a finished main or EX quest, battles and story quests alike: pattern 20 when the quest's chapter
 * is now all cleared, and pattern 63 for missions whose chapters (or the quest's own) are now all complete.
 */
export function chapterClearUpdates(playerId: number, category: QuestCategory, questId: number, story: boolean = false): MissionUpdate[] {
    if (category !== QuestCategory.MAIN && category !== QuestCategory.EX) return []
    const updates: MissionUpdate[] = [{
        pattern: MissionPattern.CHAPTER_COMPLETE,
        value: 1,
        matches: mission => {
            if (!(QUEST_KIND_CATEGORIES[mission.questKind ?? -1] ?? [category]).includes(category)) return false
            const chapters = mission.questIds?.[0]?.length ? mission.questIds[0] : [Math.floor(questId / 1000000)]
            return chapters.every(chapter => isChapterCompleteSync(playerId, category, chapter, story ? questId : null))
        }
    }]
    if (completedChapter(playerId, category, questId) !== null) {
        updates.push({ pattern: MissionPattern.CHAPTER_CLEAR, value: 1, matches: mission => missionMatchesQuest(mission, category, questId) })
    }
    return updates
}

/** The progress a story quest read for the first time makes: unit episodes, and main or EX chapters it completes. */
export function storyClearUpdates(playerId: number, category: QuestCategory, questId: number): MissionUpdate[] {
    // "Clear World 1 of the main quest" (Step Up) is the chapter's last story quest
    const questClear: MissionUpdate = { pattern: MissionPattern.QUEST_CLEAR, amount: 1, matches: mission => missionMatchesQuest(mission, category, questId) }
    if (category === QuestCategory.CHARACTER) return [{ pattern: MissionPattern.EPISODE_CLEAR_COUNT, amount: 1 }, questClear]
    return [questClear, ...chapterClearUpdates(playerId, category, questId, true)]
}

/**
 * Pattern 82 (battle_client_check): a condition only the battle can see (e.g. `hard_multi_steam_robot_water`). The
 * battle start's reply names the checks of the open missions the quest can count for (`client_checks`), and the
 * finish's `statistics.client_checks` lists those the battle met.
 */
export function battleClientChecks(category: QuestCategory, questId: number, multi: boolean, now: Date): string[] {
    const checks = new Set<string>()
    for (const table of Object.values(missionTables)) {
        for (const mission of Object.values(table)) {
            if (mission.pattern !== MissionPattern.BATTLE_CLIENT_CHECK || mission.clientCheck === undefined) continue
            if (isMissionOpen(mission, now) && missionMatchesQuest(mission, category, questId) && matchesBattleKind(mission, multi)) checks.add(mission.clientCheck)
        }
    }
    return [...checks]
}

/** A start reply's `client_checks` (an Option in the client): only when there are some, as the captures leave it out. */
export function clientChecksField(checks: string[]): { client_checks?: string[] } {
    return checks.length === 0 ? {} : { "client_checks": checks }
}

/** The checks a finished battle met (pattern 82). */
export function clientCheckUpdates(category: QuestCategory, questId: number, multi: boolean, reported: unknown): MissionUpdate[] {
    const met = Array.isArray(reported) ? reported.filter((check): check is string => typeof check === "string") : []
    if (met.length === 0) return []
    return [{
        pattern: MissionPattern.BATTLE_CLIENT_CHECK, amount: 1,
        matches: mission => mission.clientCheck !== undefined && met.includes(mission.clientCheck)
            && missionMatchesQuest(mission, category, questId) && matchesBattleKind(mission, multi)
    }]
}

/** A battle played to the end, cleared or not (pattern 62, "Attempt a Practice Battle"). */
export function questChallengeUpdates(category: QuestCategory, questId: number): MissionUpdate[] {
    return [{ pattern: MissionPattern.QUEST_CHALLENGE, amount: 1, matches: mission => missionMatchesQuest(mission, category, questId) }]
}


/** The progress a cleared battle (solo or co-op) makes. Only cleared battles count, like the missions' texts say. */
/**
 * The battle's phases cleared (`statistics.clear_phase`, the client's count of its cleared phase results): each of
 * patterns 46-49 counts a battle that cleared at least 1-4 of them (ranking events, quest kind 8). A ranking battle
 * lost on time still counts the phases it cleared (FT-33).
 */
export function clearPhaseUpdates(category: QuestCategory, questId: number, statistics: Record<string, unknown>, multi: boolean = false): MissionUpdate[] {
    const battle = (mission: Mission) => matchesBattleKind(mission, multi) && missionMatchesQuest(mission, category, questId)
    const updates: MissionUpdate[] = []
    const phases = Math.min(safeCount(statistics.clear_phase), 4)
    for (let phase = 1; phase <= phases; phase++) {
        updates.push({ pattern: MissionPattern.TIME_ATTACK_CLEAR_PHASE_1 + phase - 1, amount: 1, matches: battle })
    }
    return updates
}

export function battleClearUpdates(playerId: number, clear: BattleClear, playerRank: number): MissionUpdate[] {
    const multi = clear.multi !== null
    const statistics = clear.statistics
    const quest = (mission: Mission) => missionMatchesQuest(mission, clear.category, clear.questId)
    const battle = (mission: Mission) => matchesBattleKind(mission, multi) && quest(mission)
    const updates: MissionUpdate[] = [
        { pattern: MissionPattern.BATTLE_CLEAR_COUNT, amount: 1, matches: battle },
        { pattern: MissionPattern.QUEST_CLEAR, amount: 1, matches: quest },
        { pattern: MissionPattern.HIGH_SCORE_ACHIEVEMENT, value: safeCount(clear.score), matches: battle },
        { pattern: MissionPattern.MAX_POWER_ACHIEVEMENT, value: safeCount(statistics.max_power), matches: battle },
        { pattern: MissionPattern.MAX_COMBO_ACHIEVEMENT, value: safeCount(statistics.max_combo_count), matches: battle },
        { pattern: MissionPattern.MAX_SKILL_CHAIN_ACHIEVEMENT, value: safeCount(statistics.max_skill_chain_count), matches: battle },
        { pattern: MissionPattern.TOTAL_ATTAINED_DROP_MANA_COUNT, amount: safeCount(clear.fieldMana), matches: battle },
        { pattern: MissionPattern.PLAYER_RANK_ACHIEVEMENT, value: playerRank },
        ...chapterClearUpdates(playerId, clear.category, clear.questId)
    ]
    if (clear.clearRank === 5) {
        updates.push({ pattern: MissionPattern.SS_RANK_COUNT, amount: 1, matches: battle })
        updates.push({ pattern: MissionPattern.SS_RANK_CLEAR_WITHOUT_RESISTANCE_DEBUFF, amount: 1, matches: battle })
    }
    updates.push(...clearPhaseUpdates(clear.category, clear.questId, statistics, multi))
    for (const [kind, key] of Object.entries(ZONE_STATISTICS)) {
        // fever time is kept in ms and counted in seconds
        const total = zoneStatistic(statistics, key, false)
        const amount = key === "fever_ms" ? Math.floor(total / 1000) : total
        updates.push({ pattern: MissionPattern.BATTLE_ZONE_STATISTICS_COUNT, amount, matches: mission => mission.statistics === Number(kind) && battle(mission) })
    }
    for (const [kind, key] of Object.entries(ZONE_MAX_STATISTICS)) {
        updates.push({ pattern: MissionPattern.BATTLE_ZONE_STATISTICS_MAX_VALUE, value: zoneStatistic(statistics, key, true), matches: mission => mission.statisticsMaxValue === Number(kind) && battle(mission) })
    }
    if (clear.multi === null) {
        updates.push({ pattern: MissionPattern.SINGLE_BATTLE_CLEAR_COUNT, amount: 1, matches: quest })
        // "Clear a solo battle in under 60 seconds": every such mission has one stage, with its time limit
        const clearTime = safeCount(clear.clearTimeMs)
        updates.push({ pattern: MissionPattern.SINGLE_BATTLE_CLEAR_TIME, amount: 1, matches: mission => clearTime <= (mission.stages[0]?.clearSeconds ?? 0) * 1000 && quest(mission) })
    } else {
        updates.push({ pattern: MissionPattern.MULTI_BATTLE_CLEAR_COUNT, amount: 1, matches: quest })
        updates.push({ pattern: clear.multi.host ? MissionPattern.MULTI_BATTLE_HOST_COUNT : MissionPattern.MULTI_BATTLE_GUEST_COUNT, amount: 1, matches: quest })
        if (clear.multi.backup) updates.push({ pattern: MissionPattern.ATTENTION_QUEST_CLEAR_COUNT, amount: 1, matches: quest })
        if (statistics.is_mvp === true) updates.push({ pattern: MissionPattern.MULTI_BATTLE_MVP_COUNT, amount: 1, matches: quest })
    }
    return updates.filter(update => !("amount" in update) || update.amount > 0)
}

/** A unit's level from its exp (the client's `character/character_level` table). */
export function characterLevel(exp: number, rarity: number = 1): number {
    const thresholds = (characterLevels as Record<string, number[]>)[String(rarity)] ?? characterLevels["1"]
    let level = 1
    while (level < thresholds.length && exp >= thresholds[level]) level++
    return level
}

/** Whether a mana node is one of an ability's nodes (the mana node table's field6 names the ability). */
function isAbilityNode(characterId: number, value: number): boolean {
    for (const board of [1, 2]) {
        const node = getCharacterManaNodesSync(characterId, board)?.[String(value)]
        if (node !== undefined) return node.field6 !== ""
    }
    return false
}

/**
 * What the player owns, for the missions that count it rather than an action: units (4, also "Have Murakumo join
 * your team" with a unit filter), the highest unit level (5), level 80 units (6), armament kinds (10), Lv. 5
 * armaments (34), ability nodes unlocked on the mana boards (59), and per unit: level 100 and its first Amity Scroll
 * received (41, one each, so the target is 2) and its second mana board completed (45). Routes that change any of
 * these send them.
 */
export function collectionUpdatesSync(playerId: number): MissionUpdate[] {
    const { characters, manaNodes, equipment, bondTokens } = getPlayerCollectionSync(playerId)
    const owned = new Set(characters.map(character => character.id))
    const levels = characters.map(character => characterLevel(character.exp, getCharacterDataSync(character.id)?.rarity))
    const levelOf = new Map(characters.map((character, index) => [character.id, levels[index]]))
    // a board's scroll is 1 once the board is complete and 2 once received
    const bondTokenStatus = new Map(bondTokens.map(token => [`${token.characterId}:${token.manaBoardIndex}`, token.status]))
    const unitMission = (mission: Mission) => mission.characterId !== undefined && owned.has(mission.characterId)
    const updates: MissionUpdate[] = [
        { pattern: MissionPattern.CHARACTERS_COUNT, value: characters.length, matches: mission => mission.characterId === undefined },
        { pattern: MissionPattern.CHARACTERS_COUNT, value: 1, matches: mission => mission.characterId !== undefined && owned.has(mission.characterId) },
        { pattern: MissionPattern.CHARACTER_LEVEL_ACHIEVEMENT, value: mission => mission.characterId === undefined ? Math.max(0, ...levels) : levelOf.get(mission.characterId) ?? 0 },
        { pattern: MissionPattern.LEVEL_80_CHARACTER_COUNT, value: levels.filter(level => level >= 80).length },
        { pattern: MissionPattern.GOT_EQUIP_KIND_COUNT, value: mission => mission.equipmentId === undefined ? equipment.length : Number(equipment.some(entry => entry.id === mission.equipmentId)) },
        { pattern: MissionPattern.LEVEL_MAX_EQUIPMENT_COUNT, value: mission => equipment.filter(entry => entry.level >= MAX_EQUIPMENT_LEVEL && (mission.equipmentId === undefined || entry.id === mission.equipmentId)).length },
        { pattern: MissionPattern.TOTAL_RELEASED_ABILITY_NODE_COUNT, value: manaNodes.filter(node => isAbilityNode(node.characterId, node.value)).length },
        {
            pattern: MissionPattern.CHARACTER_LEVEL_100_AND_GOT_BOND_TOKEN,
            value: mission => Number(levelOf.get(mission.characterId!)! >= 100) + Number(bondTokenStatus.get(`${mission.characterId}:1`) === 2),
            matches: unitMission
        },
        {
            pattern: MissionPattern.MANA_BOARD_2ND_COMPLETE_COUNT,
            value: mission => Number((bondTokenStatus.get(`${mission.characterId}:2`) ?? 0) >= 1),
            matches: unitMission
        }
    ]
    return updates.filter(update => "value" in update && (typeof update.value !== "number" || update.value > 0))
}

export interface MissionResources { mana: number, items: Record<string, number> }
/** Snapshot immediately before a gameplay grant; inventory totals in replies are not acquisition counts. */
export function missionResourcesSync(playerId: number): MissionResources {
    const player = getPlayerSync(playerId)
    return { mana: (player?.freeMana ?? 0) + (player?.paidMana ?? 0), items: getPlayerItemsSync(playerId) }
}
export function resourceMissionUpdatesSync(playerId: number, before: MissionResources): MissionUpdate[] {
    const after = missionResourcesSync(playerId)
    const updates: MissionUpdate[] = [
        { pattern: MissionPattern.MANA_ADDITION_COUNT, amount: Math.max(0, after.mana - before.mana) },
        { pattern: MissionPattern.TOTAL_USED_MANA_COUNT, amount: Math.max(0, before.mana - after.mana) }
    ]
    for (const [id, count] of Object.entries(after.items)) {
        const amount = count - (before.items[id] ?? 0)
        if (amount > 0) updates.push({ pattern: MissionPattern.GET_ITEM_COUNT, amount, matches: mission => mission.itemId === undefined || mission.itemId === Number(id) })
    }
    return updates.filter(update => !("amount" in update) || update.amount > 0)
}

/** A login on a new game day: total login days (pattern 0). */
export function loginDayUpdates(): MissionUpdate[] {
    return [{ pattern: MissionPattern.TOTAL_LOGIN_DAYS, amount: 1 }]
}

/** A pattern the client reports (`update_mission_progress`); null for one it doesn't count itself. */
export function clientReportedUpdate(missionPattern: string, progressValue: number): MissionUpdate | null {
    const pattern = CLIENT_REPORTED_PATTERNS[missionPattern]
    if (pattern === undefined) return null
    const amount = safeCount(progressValue)
    return amount > 0 ? { pattern, amount } : null
}

/** Move reached stages to their durable backlog before their counter is replaced. */
function archiveCategoryRewardsSync(playerId: number, category: MissionCategory, markCleared: boolean): void {
    // A full gift box must not erase yesterday's earned rewards, including the all-objectives reward
    // whose prerequisite stages are themselves waiting for room in the box.
    const state = loadState(playerId, category)
    const earnedStage = (missionId: number, visiting = new Set<number>()): number => {
        const mission = getMission(category, missionId)
        if (!mission || visiting.has(missionId)) return 0
        const path = new Set(visiting).add(missionId)
        const entry = state.get(missionId)
        const progress = mission.pattern === MissionPattern.TARGET_MISSION_CLEAR
            ? (mission.missionIds ?? []).filter(id => {
                const target = getMission(category, id)
                return target !== null && isComplete(target, earnedStage(id, path))
            }).length
            : entry?.progress ?? 0
        let stage = entry?.clearedStage ?? 0
        while (stage < mission.stages.length && progress >= mission.stages[stage].target) stage++
        return stage
    }
    for (const [id, mission] of Object.entries(missionTables[String(category)])) {
        const missionId = Number(id)
        if (!state.has(missionId) && mission.pattern !== MissionPattern.TARGET_MISSION_CLEAR) continue
        const earned = earnedStage(missionId)
        const before = state.get(missionId)?.clearedStage ?? 0
        for (let stage = before + 1; stage <= earned; stage++) {
            const rewards = earnedStageRewards(playerId, category, missionId, stage, mission.stages[stage - 1].rewards)
            insertPlayerMissionRewardBacklogSync(playerId, category, missionId, stage, JSON.stringify(rewards))
        }
        // Event history records queued entitlements as cleared, so revisiting an older room/run cannot queue them twice.
        if (markCleared && earned > before) setPlayerMissionSync(playerId, category, {
            missionId, progress: Math.max(state.get(missionId)?.progress ?? 0, mission.stages[earned - 1].target), clearedStage: earned
        })
    }
    deleteRewardSnapshotCategorySync(playerId, category)
}

/** Daily counters use real reward days, independently from content dates and event occurrences. */
export function resetDailyMissionsSync(playerId: number) {
    archiveCategoryRewardsSync(playerId, MissionCategory.DAILY, false)
    deletePlayerMissionsSync(playerId, MissionCategory.DAILY)
}

/** New deterministic server occurrences repeat event objectives; revisits restore their paid-stage history. */
function ensureEventMissionRunSync(playerId: number): void {
    if (!scheduledContentEnabled()) return
    const key = currentEventOccurrenceKey()
    const previous = currentMissionRunSync(playerId)
    if (previous === key) return
    // Adopt existing progress on upgrade rather than reopening already-paid historical objectives.
    if (previous === null) { setCurrentMissionRunSync(playerId, key); return }
    const categories = [MissionCategory.EVENT, MissionCategory.COLLECT_ITEM_EVENT]
    for (const category of categories) archiveCategoryRewardsSync(playerId, category, true)
    setMissionRunProgressSync(playerId, previous, categories.flatMap(category => getPlayerMissionsSync(playerId, category).map(row => ({ category, ...row }))))
    for (const category of categories) deletePlayerMissionsSync(playerId, category)
    for (const row of missionRunProgressSync(playerId, key)) setPlayerMissionSync(playerId, row.category, row)
    setCurrentMissionRunSync(playerId, key)
}

/** Deliver earned rewards from previous daily periods, regardless of the mission's current dates. */
export function drainPendingMissionRewardsSync(playerId: number, now: Date): MissionInfo[] {
    const cleared: MissionInfo[] = []
    for (const pending of getPlayerMissionRewardBacklogSync(playerId)) {
        const stage = getMission(pending.category, pending.missionId)?.stages[pending.stage - 1]
        const rewards = pending.rewardsJson === null ? stage?.rewards : JSON.parse(pending.rewardsJson) as MissionReward[]
        // A pre-policy queue has no snapshot and keeps its original master amount.
        if (!stage || !rewards || !mailStageRewards(playerId, rewards, now)) continue
        deletePlayerMissionRewardBacklogSync(playerId, pending.id)
        cleared.push({ mission_category_id: pending.category, mission_id: pending.missionId, mission_reward_id: pending.missionId * 1000 + pending.stage })
    }
    return cleared
}

/** One `mission_progress_list` entry. */
export interface MissionProgressEntry {
    mission_category: number
    mission_id: number
    progress_value: number
    /** the stage being worked on; the last one once all are cleared */
    stage: number
}

/** One `category_list` entry of `mission/get_mission_progress`: a category, and for collect item events the event. */
export interface MissionProgressRequest {
    category: number
    eventId?: number
}

/**
 * The open missions of the categories asked for, with their progress; collect item event missions (category 4) only
 * of the events asked for. Stages whose rewards didn't fit in the gift box earlier are cleared here first.
 */
export function getMissionProgressListSync(playerId: number, requests: MissionProgressRequest[], now: Date): { list: MissionProgressEntry[], cleared: MissionInfo[] } {
    ensureEventMissionRunSync(playerId)
    const list: MissionProgressEntry[] = []
    const cleared = drainPendingMissionRewardsSync(playerId, now)
    const eventIds = new Set(requests.filter(request => request.category === MissionCategory.COLLECT_ITEM_EVENT && request.eventId !== undefined).map(request => request.eventId))
    for (const category of CATEGORIES.filter(category => requests.some(request => request.category === category))) {
        const state = loadState(playerId, category)
        for (const [id, mission] of Object.entries(missionTables[String(category)])) {
            if (category === MissionCategory.COLLECT_ITEM_EVENT && !eventIds.has(mission.eventId)) continue
            if (mission.stages.length === 0 || !isMissionVisible(mission, now) || !isUnlocked(mission, missionId => state.get(missionId)?.clearedStage ?? 0)) continue
            const missionId = Number(id)
            const entry = { ...(state.get(missionId) ?? { progress: 0, clearedStage: 0 }) }
            const before = entry.clearedStage
            clearStages(playerId, category, missionId, mission, entry, now, cleared)
            if (entry.clearedStage > before) store(playerId, category, missionId, entry, before)
            state.set(missionId, entry)
            list.push({
                mission_category: category,
                mission_id: missionId,
                progress_value: entry.progress,
                stage: displayedStage(mission, entry.clearedStage)
            })
        }
    }
    return { list, cleared }
}
