// Missions (FT-2): regular, daily, event and degree (title) missions. The server counts each mission's progress, clears its stages
// and mails their rewards (mail reason 60, "Mission Reward"); a reply that cleared stages lists them in `mission_info`,
// and `mission/get_mission_progress` lists progress for the mission screen. Daily missions start over every game day.
// Degree missions give titles instead, straight away (`profile/get_degree_list` lists the titles a player has).
// Step Up Missions (active missions) count the same patterns, but their cleared stages wait in
// `all_active_mission_list` until the player claims them with `active_mission/receive`, which grants the rewards.
//
// Master data: `master/mission/{regular,daily,event}_mission` and `master/active_mission/active_mission` with their
// `_reward` tables, converted into `assets/mission.json` and `assets/active_mission.json` by scripts/converter.py.
// Table layout, patterns and what is still missing: docs/missions.md.

import missionAssets from "../../assets/mission.json";
import activeMissionAssets from "../../assets/active_mission.json";
import characterLevels from "../../assets/character_level.json";
import { MailType } from "../data/types";
import { deletePlayerMissionsSync, getPlayerActiveMissionsSync, getPlayerClearedRegularMissionListSync, getPlayerCollectionSync, getPlayerItemSync, insertPlayerDegreeSync, getPlayerMissionsSync, getPlayerReceivableMailCountSync, getPlayerSingleQuestProgressSync, getPlayerSync, givePlayerItemSync, setPlayerActiveMissionProgressSync, setPlayerActiveMissionStageSync, setPlayerClearedRegularMissionSync, setPlayerMissionSync, updatePlayerSync } from "../data/wdfpData";
import { getServerTime, masterDate } from "../utils";
import { getCharacterManaNodesSync } from "./assets";
import { getItemMaxCountSync, mailLimits, playerLimits } from "./limits";
import { sendPlayerMailSync } from "./mail";
import { QuestCategory } from "./types";
import mainQuests from "../../assets/main_quest.json";
import exQuests from "../../assets/ex_quest.json";

/** The client's `mission_category`. */
export enum MissionCategory {
    REGULAR = 1,
    DAILY = 2,
    EVENT = 3,
    /** title missions: each stage gives a title (degree) */
    DEGREE = 5
}

/** The client's MissionPatternKind, by the number the master tables use (only the patterns the server counts). */
export enum MissionPattern {
    TOTAL_LOGIN_DAYS = 0,
    PLAYER_RANK_ACHIEVEMENT = 1,
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
    CHARACTER_DETAIL_ZOOM_ILLUST_FOR_1MIN_COUNT = 37,
    CHARACTER_DETAIL_PLAY_DOT_SP_MOTION_COUNT = 38,
    HOME_TAP_TOWN_CHARACTER_COUNT = 39,
    HOME_CHANGE_VOICE_COUNT = 40,
    CHARACTER_LEVEL_100_AND_GOT_BOND_TOKEN = 41,
    TREASURE_SHOP_BOUGHT_ITEM_COUNT = 42,
    MANA_BOARD_2ND_OPEN_COUNT = 44,
    MANA_BOARD_2ND_COMPLETE_COUNT = 45,
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
    TRADED_COUNT_BY_BOSS_COIN_SHOP = 80
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
    missionIds?: number[]
    repeat?: boolean
    /** Step Up Missions only: the phase (1 Rookie, 2 Beginner, 3 Intermediate, 4 Advanced) */
    phase?: number
    /** the targets are cumulative: stage 2's counts from 0, not from stage 1's target */
    stages: { target: number, rewards: MissionReward[], clearSeconds?: number }[]
}

const missionTables = missionAssets as Record<string, Record<string, Mission>>
const activeMissions = activeMissionAssets as Record<string, Mission>
const CATEGORIES = [MissionCategory.REGULAR, MissionCategory.DAILY, MissionCategory.EVENT, MissionCategory.DEGREE]

export function getMission(category: MissionCategory, missionId: number): Mission | null {
    return missionTables[String(category)]?.[String(missionId)] ?? null
}

/** Whether a mission counts at a date (its enable period; regular missions have none). */
export function isMissionOpen(mission: Mission, date: Date): boolean {
    return (mission.startDate === undefined || masterDate(mission.startDate) <= date)
        && (mission.endDate === undefined || date <= masterDate(mission.endDate))
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
    multi: { host: boolean } | null
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
function applyUpdates(mission: Mission, progress: number, updates: MissionUpdate[]): number {
    for (const update of updates) {
        if (update.pattern !== mission.pattern || (update.matches !== undefined && !update.matches(mission))) continue
        const value = "amount" in update ? 0 : typeof update.value === "number" ? update.value : update.value(mission)
        progress = Math.min(MAX_PROGRESS, "amount" in update ? progress + update.amount : Math.max(progress, value))
    }
    return progress
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
                subject: missionRewardMailSubject,
                description: missionRewardMailDescription
            })
        } catch {
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
    while (entry.clearedStage < mission.stages.length && entry.progress >= mission.stages[entry.clearedStage].target) {
        const rewards = mission.stages[entry.clearedStage].rewards
        if (!mailStageRewards(playerId, rewards, now)) break
        for (const reward of rewards) {
            if (reward.kind === TITLE_REWARD_KIND && reward.id !== undefined) insertPlayerDegreeSync(playerId, reward.id)
        }
        entry.clearedStage++
        cleared.push({
            mission_category_id: category,
            mission_id: missionId,
            mission_reward_id: missionId * 1000 + entry.clearedStage
        })
    }
}

function store(playerId: number, category: MissionCategory, missionId: number, entry: { progress: number, clearedStage: number }, before: number) {
    setPlayerMissionSync(playerId, category, { missionId, ...entry })
    if (category === MissionCategory.REGULAR && entry.clearedStage > before) setPlayerClearedRegularMissionSync(playerId, missionId, entry.clearedStage)
}

/**
 * Applies progress updates to every open mission (regular, daily, event and Step Up), clears the stages they reach
 * and mails the regular, daily and event missions' rewards; Step Up stages wait to be claimed. "Clear the other
 * missions" missions (pattern 11) follow the missions they count.
 *
 * @returns The stages cleared (`mission_info`) and the Step Up missions that moved (`active_mission_list`).
 */
export function updateMissionsSync(playerId: number, now: Date, updates: MissionUpdate[]): MissionResult {
    const result: MissionResult = { missionInfo: [], activeMissions: [] }
    if (updates.length === 0) return result
    for (const category of CATEGORIES) {
        const state = loadState(playerId, category)
        const clearedStage = (missionId: number) => state.get(missionId)?.clearedStage ?? 0
        let changed = false
        for (const [id, mission] of Object.entries(missionTables[String(category)])) {
            if (!isMissionOpen(mission, now) || !isUnlocked(mission, clearedStage)) continue
            const missionId = Number(id)
            const entry = { ...(state.get(missionId) ?? { progress: 0, clearedStage: 0 }) }
            if (isComplete(mission, entry.clearedStage)) continue
            const before = { ...entry }
            entry.progress = applyUpdates(mission, entry.progress, updates)
            if (entry.progress === before.progress) continue
            clearStages(playerId, category, missionId, mission, entry, now, result.missionInfo)
            store(playerId, category, missionId, entry, before.clearedStage)
            state.set(missionId, entry)
            changed = true
        }
        if (changed) settleTargetMissions(playerId, category, state, now, result.missionInfo)
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
        if (progress <= entry.progress) continue
        const before = entry.clearedStage
        entry.progress = progress
        clearStages(playerId, category, missionId, mission, entry, now, cleared)
        store(playerId, category, missionId, entry, before)
        state.set(missionId, entry)
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
        if (mission === undefined || entry === undefined) continue
        for (const stage of new Set(claim.stages)) {
            if (entry.stages.get(stage) !== false) continue
            const rewards = mission.stages[stage - 1]?.rewards ?? []
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
    // the boss battle rank filter (quest_rank_id) isn't known to the server, so such missions never match
    if (mission.questRankId !== undefined) return false
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

/** A battle played to the end, cleared or not (pattern 62, "Attempt a Practice Battle"). */
export function questChallengeUpdates(category: QuestCategory, questId: number): MissionUpdate[] {
    return [{ pattern: MissionPattern.QUEST_CHALLENGE, amount: 1, matches: mission => missionMatchesQuest(mission, category, questId) }]
}


/** The progress a cleared battle (solo or co-op) makes. Only cleared battles count, like the missions' texts say. */
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
    if (clear.clearRank === 5) updates.push({ pattern: MissionPattern.SS_RANK_COUNT, amount: 1, matches: battle })
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
        if (statistics.is_mvp === true) updates.push({ pattern: MissionPattern.MULTI_BATTLE_MVP_COUNT, amount: 1, matches: quest })
    }
    return updates.filter(update => !("amount" in update) || update.amount > 0)
}

/** A unit's level from its exp (the client's `character/character_level` table). */
export function characterLevel(exp: number): number {
    let level = 1
    while (level < characterLevels.length && exp >= characterLevels[level]) level++
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
    const levels = characters.map(character => characterLevel(character.exp))
    const levelOf = new Map(characters.map((character, index) => [character.id, levels[index]]))
    // a board's scroll is 1 once the board is complete and 2 once received
    const bondTokenStatus = new Map(bondTokens.map(token => [`${token.characterId}:${token.manaBoardIndex}`, token.status]))
    const unitMission = (mission: Mission) => mission.characterId !== undefined && owned.has(mission.characterId)
    const updates: MissionUpdate[] = [
        { pattern: MissionPattern.CHARACTERS_COUNT, value: characters.length, matches: mission => mission.characterId === undefined },
        { pattern: MissionPattern.CHARACTERS_COUNT, value: 1, matches: mission => mission.characterId !== undefined && owned.has(mission.characterId) },
        { pattern: MissionPattern.CHARACTER_LEVEL_ACHIEVEMENT, value: Math.max(0, ...levels) },
        { pattern: MissionPattern.LEVEL_80_CHARACTER_COUNT, value: levels.filter(level => level >= 80).length },
        { pattern: MissionPattern.GOT_EQUIP_KIND_COUNT, value: equipment.length },
        { pattern: MissionPattern.LEVEL_MAX_EQUIPMENT_COUNT, value: equipment.filter(entry => entry.level >= MAX_EQUIPMENT_LEVEL).length },
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

/** Daily missions start over every game day (a daily reset step). */
export function resetDailyMissionsSync(playerId: number) {
    deletePlayerMissionsSync(playerId, MissionCategory.DAILY)
}

/** One `mission_progress_list` entry. */
export interface MissionProgressEntry {
    mission_category: number
    mission_id: number
    progress_value: number
    /** the stage being worked on; the last one once all are cleared */
    stage: number
}

/**
 * The open missions of the categories asked for, with their progress. Stages whose rewards didn't fit in the gift
 * box earlier are cleared here first.
 */
export function getMissionProgressListSync(playerId: number, categories: number[], now: Date): { list: MissionProgressEntry[], cleared: MissionInfo[] } {
    const list: MissionProgressEntry[] = []
    const cleared: MissionInfo[] = []
    for (const category of CATEGORIES.filter(category => categories.includes(category))) {
        const state = loadState(playerId, category)
        for (const [id, mission] of Object.entries(missionTables[String(category)])) {
            if (mission.stages.length === 0 || !isMissionOpen(mission, now) || !isUnlocked(mission, missionId => state.get(missionId)?.clearedStage ?? 0)) continue
            const missionId = Number(id)
            const entry = { ...(state.get(missionId) ?? { progress: 0, clearedStage: 0 }) }
            const before = entry.clearedStage
            clearStages(playerId, category, missionId, mission, entry, now, cleared)
            if (entry.clearedStage > before) store(playerId, category, missionId, entry, before)
            list.push({
                mission_category: category,
                mission_id: missionId,
                progress_value: entry.progress,
                stage: Math.min(entry.clearedStage + 1, mission.stages.length)
            })
        }
    }
    return { list, cleared }
}
