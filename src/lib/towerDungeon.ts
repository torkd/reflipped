// The Haunt (FT-6, `tower_dungeon_event`): a 30-floor tower that starts over every month.
//
// The master data gives every monthly cycle its own ten quests of three floors each ("The Haunt [Floors 1-3]" ...
// "[Floors 28-30]", event 1, quest ids 1001-1480), all carrying the cycle's period: from the 6th at 05:00 Japan time
// until the global service ended in October 2024, then on the Japanese schedule (the 20th to 23rd); the last cycles
// have no end. The periods are made back to back, each cycle running until the next one starts, for the server and the
// client's master alike (src/lib/scheduleTowerCycles.ts, FT-77). A cleared quest can't be played again within its
// cycle (the client greys it out: `tower_dungeon_event_cleared_quest_cannot_start`), and each quest unlocks with the
// one before it (the first one with main quest 4-11-5), which the client checks from `quest_progress`.
//
// The reset (`tower_dungeon_event_cleared_quest_cannot_start`, EN): "Each quest can only be cleared once a month.
// Progress is reset on the 6th. If, by the 6th, you have reached the 18th floor, you will start on the 16th floor even
// after the reset. (Rewards for the first 15 floors will be sent to your mail.)" So at the first /load of a new cycle
// (the cycles change at 05:00 Japan time, a game day change, when the client returns to the title), a player who
// cleared floors 16-18 (the cycle's sixth quest) in the cycle just before gets the new cycle's first five quests
// cleared and their rewards mailed. The /load reply then carries `tower_dungeon_list`, which shows the reset dialog
// once: status 1 rewards sent, 2 reset without rewards, 3 the Haunt has ended. The client keeps no record of a dialog
// it has shown, so each one is sent once. Only players who cleared something in the cycle that ended get one.
//
// The cycle a player was last in is stored with the clock's era (src/lib/serverClock.ts): when the clock moves back,
// to the start of the event calendar or by hand, a cycle shown again starts over too, and counts as following the
// one before the move.
//
// With modern event scheduling (FT-31, FT-48) the client gets the cycles' periods projected onto the event timeline,
// so the open cycle is the one at the timeline's date (`contentDate()`), not the clock's. The clock's era stays 0
// there; the timeline's run (`currentEventOccurrenceKey()`: a new pass of the archive or of a Manual playlist entry,
// or the calendar's "Go to" an event's opening) is stored instead and plays the era's part, so a timeline that comes
// back to a cycle starts it over.

import towerDungeonEventQuests from "../../assets/tower_dungeon_event_quest.json";
import { deletePlayerQuestProgressSync, getPlayerSingleQuestProgressSync, getPlayerTowerDungeonSync, insertPlayerQuestProgressSync, setPlayerTowerDungeonSync } from "../data/wdfpData";
import { MailType } from "../data/types";
import { contentDate, currentEventOccurrenceKey, scheduledContentEnabled } from "./eventSchedule";
import { getScoreRewardGroup, getRareScoreRewardGroup } from "./assets";
import { InvalidMailError, sendPlayerMailSync } from "./mail";
import { drawWeighted, elementRewardItemId, fixedWeight, pickFromRarePool, resolveElementReward, scoreRewardDrops } from "./quest";
import { getClockEra } from "./serverClock";
import { towerCyclePeriods } from "./scheduleTowerCycles";
import { CurrencyReward, EquipmentItemReward, ItemScoreReward, QuestCategory, RareScoreRewardGroup, RawQuests, Reward, RewardType, ScoreRewardType } from "./types";

/** The Haunt's event id: the only tower dungeon event. */
export const TOWER_DUNGEON_EVENT_ID = 1
/** Quests per cycle (three floors each). */
export const TOWER_QUESTS_PER_CYCLE = 10
/** Quests cleared for a player who reached the carryover floor: floors 1-15. */
export const TOWER_CARRYOVER_QUESTS = 5
/** The quest a player must have cleared for the carryover: floors 16-18. */
export const TOWER_CARRYOVER_CONDITION_QUEST = 6

/** `tower_dungeon_list[].reset_status`, which picks the reset dialog's text. */
export enum TowerDungeonResetStatus {
    SENT_REWARDS = 1,
    NO_REWARDS = 2,
    EVENT_FINISHED = 3
}

export interface TowerCycle {
    /** the first quest's id, which names the cycle */
    id: number
    /** the cycle's quests by floor, lowest first */
    questIds: number[]
    start: Date
    /** when the next cycle starts or the period ends (exclusive); null for the last cycle */
    end: Date | null
    /** the month the cycle is named after, as the reset dialog shows it: the start's month in Japan time (1-12) */
    month: number
}

const cycles: TowerCycle[] = towerCyclePeriods().map(period => ({
    id: period.questIds[0],
    questIds: period.questIds,
    start: new Date(period.start),
    end: period.end === null ? null : new Date(period.end),
    month: new Date(period.start + 9 * 60 * 60 * 1000).getUTCMonth() + 1
}))
const cycleOfQuest = new Map<number, TowerCycle>(cycles.flatMap(cycle => cycle.questIds.map(questId => [questId, cycle] as const)))

/** Every cycle, by start. */
export function getTowerCycles(): readonly TowerCycle[] {
    return cycles
}

/**
 * The cycle open at a date, or null before the first. The cycles run back to back (src/lib/scheduleTowerCycles.ts):
 * where two master periods overlap (August to October 2024, when the global and the Japanese schedules meet in the
 * data), the later-starting one counts, and the client's master gets the same periods (FT-77).
 */
export function towerCycleAt(date: Date): TowerCycle | null {
    const time = date.getTime()
    let found: TowerCycle | null = null
    for (const cycle of cycles) {
        if (cycle.start.getTime() > time) break
        if (cycle.end === null || time < cycle.end.getTime()) found = cycle
    }
    return found
}

/**
 * The cycle open for a request at `date`: the one at the event timeline's date with modern event scheduling (the
 * client's floors carry the projected periods), the one at `date` without it.
 */
export function openTowerCycle(date: Date): TowerCycle | null {
    return towerCycleAt(contentDate(date))
}

/** The cycle a Haunt quest belongs to, or null for an unknown quest. */
export function towerCycleOfQuest(questId: number): TowerCycle | null {
    return cycleOfQuest.get(questId) ?? null
}

function isCleared(playerId: number, questId: number): boolean {
    return getPlayerSingleQuestProgressSync(playerId, QuestCategory.TOWER_DUNGEON_EVENT, questId)?.finished === true
}

/**
 * Why a player can't start a Haunt quest at a date, or null when they can: it belongs to the cycle open then, isn't
 * cleared yet in it, and the quest below it is (the client lets a player start only such a quest).
 */
export function towerQuestStartRefusal(playerId: number, questId: number, date: Date): string | null {
    const cycle = towerCycleOfQuest(questId)
    if (cycle === null) return "This quest isn't part of the Haunt."
    if (openTowerCycle(date) !== cycle) return "This Haunt cycle isn't open."
    if (isCleared(playerId, questId)) return "This floor is cleared until the Haunt resets."
    const index = cycle.questIds.indexOf(questId)
    if (index > 0 && !isCleared(playerId, cycle.questIds[index - 1])) return "The floors below aren't cleared yet."
    return null
}

/** The event timeline's run with modern event scheduling, null without it. */
function currentRun(): string | null {
    return scheduledContentEnabled() ? currentEventOccurrenceKey() : null
}

/** The stored cycle: `<first quest id>~<clock era>`, then `~<timeline run>` with modern event scheduling. */
function cycleKey(cycle: TowerCycle, era: number, run: string | null): string {
    return `${cycle.id}~${era}${run === null ? "" : `~${run}`}`
}

function parseCycleKey(key: string | null): { cycle: TowerCycle, era: number, run: string | null } | null {
    const match = key === null ? null : /^(\d+)~(\d+)(?:~(.+))?$/.exec(key)
    if (match === null) return null
    const cycle = cycles.find(candidate => candidate.id === Number(match[1]))
    return cycle === undefined ? null : { cycle, era: Number(match[2]), run: match[3] ?? null }
}

/**
 * The rewards a quest's score reward group drops, as a clear without boost would pay them (src/lib/quest.ts,
 * `scoreRewardDrops`): the fixed entries are one weighted lottery drawn as often as the quest says, each rare pool slot
 * rolls its rarity once.
 */
function questDropRewards(questId: number): Reward[] {
    const quest = (towerDungeonEventQuests as RawQuests)[String(questId)]
    const group = quest?.scoreRewardGroup === undefined ? null : getScoreRewardGroup(quest.scoreRewardGroup)
    const rewards: Reward[] = []
    const fixed = (group ?? []).filter(entry => entry.type === ScoreRewardType.ITEM) as ItemScoreReward[]
    if (fixed.length > 0) {
        const weights = fixed.map(fixedWeight)
        const span = Math.max(1000, weights.reduce((sum, weight) => sum + weight, 0))
        for (let draw = 0; draw < (quest.scoreRewardRolls ?? scoreRewardDrops.rolls); draw++) {
            const hit = drawWeighted(weights, span)
            if (hit < 0) continue
            const drop = fixed[hit]
            const itemId = drop.reward_type === RewardType.ITEM ? drop.id : elementRewardItemId(drop.reward_type, drop.id, quest.enemyElement)
            if (itemId !== undefined) rewards.push({ type: RewardType.ITEM, id: itemId, count: drop.count } as EquipmentItemReward)
            else if (drop.reward_type === RewardType.MANA || drop.reward_type === RewardType.EXP) rewards.push({ type: drop.reward_type, count: drop.count } as CurrencyReward)
        }
    }
    for (const entry of group ?? []) {
        if (entry.type !== ScoreRewardType.RARE_POOL) continue
        const pool = entry as RareScoreRewardGroup
        const rare = getRareScoreRewardGroup(pool.id)
        if (rare === null || rare.length === 0 || !(scoreRewardDrops.random() < pool.rarity)) continue
        rewards.push(resolveElementReward(rare[pickFromRarePool(rare)], quest.enemyElement))
    }
    return rewards
}

/** The mail type and type id a reward is sent as, or null for one mail can't carry. */
function mailTypeOf(reward: Reward): { type: MailType, typeId?: number } | null {
    switch (reward.type) {
        case RewardType.ITEM: return { type: MailType.ITEM, typeId: (reward as EquipmentItemReward).id }
        case RewardType.EQUIPMENT: return { type: MailType.EQUIPMENT, typeId: (reward as EquipmentItemReward).id }
        case RewardType.BEADS: return { type: MailType.FREE_VMONEY }
        case RewardType.MANA: return { type: MailType.FREE_MANA }
        case RewardType.EXP: return { type: MailType.EXP_POOL }
        default: return null
    }
}

/**
 * Mails the drops of the quests a carryover clears, one mail per kind of reward. A mail the gift box can't take (full,
 * or past what the player may own) is skipped, as missions do, rather than failing /load.
 */
function mailCarryoverRewards(playerId: number, questIds: number[]) {
    const totals = new Map<string, { type: MailType, typeId?: number, number: number }>()
    for (const questId of questIds) {
        for (const reward of questDropRewards(questId)) {
            const mail = mailTypeOf(reward)
            if (mail === null) continue
            const key = `${mail.type}:${mail.typeId ?? ""}`
            const entry = totals.get(key) ?? { ...mail, number: 0 }
            entry.number += (reward as CurrencyReward).count
            totals.set(key, entry)
        }
    }
    for (const mail of totals.values()) {
        if (mail.number <= 0) continue
        try {
            sendPlayerMailSync(playerId, {
                type: mail.type,
                typeId: mail.typeId,
                number: mail.number,
                subject: "The Haunt",
                description: "Rewards for floors 1-15, cleared for you at the monthly reset.",
                durableReward: true
            })
        } catch (error) {
            if (!(error instanceof InvalidMailError)) throw error
        }
    }
}

/**
 * Moves a player into the Haunt cycle open at `date` (`openTowerCycle`), if they aren't in it yet (run at /load,
 * src/lib/resets.ts): the new cycle's progress starts empty, the floor-15 carryover is applied, and the reset dialog
 * is stored for the next /load reply. A player seen for the first time is only placed in the cycle, with the progress they have.
 */
export function applyTowerDungeonCycleSync(playerId: number, date: Date) {
    const current = openTowerCycle(date)
    const era = getClockEra()
    const run = currentRun()
    const key = current === null ? null : cycleKey(current, era, run)
    const state = getPlayerTowerDungeonSync(playerId, TOWER_DUNGEON_EVENT_ID)
    if (state !== null && state.cycle === key) return

    const previous = state === null ? null : parseCycleKey(state.cycle)
    // a cycle stored before the run was (or with scheduling off): the same cycle carries on in this run
    if (state !== null && previous !== null && current === previous.cycle && previous.era === era && previous.run === null) {
        setPlayerTowerDungeonSync(playerId, TOWER_DUNGEON_EVENT_ID, { cycle: key, noticeMonth: state.noticeMonth, noticeStatus: state.noticeStatus })
        return
    }
    const playedPrevious = previous !== null && previous.cycle.questIds.some(questId => isCleared(playerId, questId))
    let notice: TowerDungeonResetStatus | null = null

    if (current !== null && state !== null) {
        deletePlayerQuestProgressSync(playerId, QuestCategory.TOWER_DUNGEON_EVENT, current.questIds)
        // the cycle before this one: the one open just before it started, or any when the clock moved back or the
        // event timeline started a new run since
        const follows = previous !== null && (previous.era < era || (previous.run !== null && previous.run !== run)
            || (previous.era === era && towerCycleAt(new Date(current.start.getTime() - 1)) === previous.cycle))
        const carryover = follows && isCleared(playerId, previous.cycle.questIds[TOWER_CARRYOVER_CONDITION_QUEST - 1])
        if (carryover) {
            const carried = current.questIds.slice(0, TOWER_CARRYOVER_QUESTS)
            for (const questId of carried) {
                insertPlayerQuestProgressSync(playerId, QuestCategory.TOWER_DUNGEON_EVENT, { questId, finished: true, clearRank: 1 })
            }
            mailCarryoverRewards(playerId, carried)
        }
        if (playedPrevious) notice = carryover ? TowerDungeonResetStatus.SENT_REWARDS : TowerDungeonResetStatus.NO_REWARDS
    } else if (current === null && playedPrevious) {
        notice = TowerDungeonResetStatus.EVENT_FINISHED
    }

    setPlayerTowerDungeonSync(playerId, TOWER_DUNGEON_EVENT_ID, {
        cycle: key,
        noticeMonth: notice === null ? state?.noticeMonth ?? null : previous!.cycle.month,
        noticeStatus: notice ?? state?.noticeStatus ?? null
    })
}

export interface TowerDungeonListEntry {
    event_id: number
    reset_month: number
    reset_status: number
}

/**
 * The reset dialog waiting for a player, as /load's `tower_dungeon_list`, and forgets it: the client shows each entry
 * it gets once and keeps no record of it, so a dialog sent again would show again.
 */
export function takeTowerDungeonNoticesSync(playerId: number): TowerDungeonListEntry[] {
    const state = getPlayerTowerDungeonSync(playerId, TOWER_DUNGEON_EVENT_ID)
    if (state === null || state.noticeMonth === null || state.noticeStatus === null) return []
    setPlayerTowerDungeonSync(playerId, TOWER_DUNGEON_EVENT_ID, { cycle: state.cycle, noticeMonth: null, noticeStatus: null })
    return [{ event_id: TOWER_DUNGEON_EVENT_ID, reset_month: state.noticeMonth, reset_status: state.noticeStatus }]
}
