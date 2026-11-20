import { boardHiddenPlayers } from "./anticheat";
// Raid events (FT-12, "Sagas of Conquest", `RAID_EVENT`): solo battles against one boss the whole server fights.
// Each clear adds its difficulty's kill weight (`killWeight`: Novice 1 to Hell about 200) to the server's damage, and
// every full pool of the boss's HP is one kill (worldflipper.wiki.gg, "Raid Event: Sagas of Conquest Event": the
// defeats are "calculated based on the total number of event battles cleared by all adventurers", by difficulty).
//
// The original pools (`quest/event/raid_event` column 17: 50 to 194 million, 500,000 for the last two raids) were
// sized for the whole global server, so the pool here is a share of it: the original pool / 30,000 for each player it
// is sized for: the raid's own participants (automatic mode, the default) or a number the admin sets (fixed mode, with
// the players active this week as a suggestion). One player's share lets an active player reach every kill tier over a
// raid's two weeks.
//
// The kill tally rewards (`raid_event_overall_reward`: tiers at 1, 2, 3, 5 ... kills, and for the last two raids a
// reward for every kill) go to every player who has fought in the raid, by mail, when they open the raid (summary).
// Each raid quest has its ranking by clears ("Your best score does not affect your position in the rankings"); its
// rank bands (`raid_event_ranking_reward`) pay once during the results announcement, for the quest the player cleared
// most (the wiki: "calculated based on the difficulty that the player has cleared the most of").

import raidEvents from "../../assets/raid_event.json";
import raidQuests from "../../assets/raid_event_quest.json";
import overallRewards from "../../assets/raid_event_overall_reward.json";
import rankingRewards from "../../assets/raid_event_ranking_reward.json";
import { getStoredText, setStoredText } from "../data/serverSettings";
import {
    countPlayersLoggedInSinceSync, getPlayerRaidRecordsSync, getPlayerRaidStateSync, getPlayerSync, getRaidEventKillsSync,
    getRaidQuestRecordsSync, RaidRecord, setPlayerRaidRecordSync, setPlayerRaidStateSync
} from "../data/wdfpData";
import { masterDate } from "../utils";
import { clientSerializeDate } from "../data/utils";
import { playerRankSync } from "./assets";
import { BorderReward, BorderTier, MAIL_TYPES, mailBorderRewardsSync } from "./borderRewards";
import { gameDay } from "./resets";
import { isContentPeriodOpen } from "./eventSchedule";

const events = raidEvents as Record<string, { start: string, battleEnd: string, resultsStart: string, resultsEnd: string, bossHp: number }>
const quests = raidQuests as unknown as Record<string, { eventId: number, killWeight: number }>
type Overall = { tiers: (BorderTier & { kills: number })[], perKill: BorderTier | null }
const overall = overallRewards as Record<string, Overall>
type RankBand = BorderTier & { from: number, to: number }
const bandsByQuest = rankingRewards as Record<string, Record<string, RankBand[]>>

/** How many players one original pool is shared between: one player's share is the pool / 30,000. */
export const RAID_REFERENCE_PLAYERS = 30_000
/**
 * FT-75: a player counts as a whole participant for the automatic pool only after this many kills, and as a fraction
 * before (one kill: a third). Throwaway accounts with one light kill each otherwise grew the pool by a full player's
 * share and slowed the tally that pays everyone (security review 2026-11-13).
 */
export const RAID_FULL_PARTICIPANT_KILLS = 3
/** Auto-battles a day (the wiki: "This feature can be used 10 times a day"). */
export const RAID_DAILY_AUTO_STARTS = 10
/** The raid ranking's page size (`raid_event_config.ranking_max_records_per_page`). */
export const RAID_RANKING_PAGE_SIZE = 100
/** The client's result codes: summary outside the event (OutOfPeriod), ranking reward outside the announcement. */
export const RAID_OUT_OF_PERIOD = 5002
export const RAID_OUT_OF_RECEIVABLE_PERIOD = 5003

// ---- the boss's HP policy (admin Settings, Events tab) ----

export type RaidHpMode = "fixed" | "automatic"

export interface RaidHpPolicy {
    mode: RaidHpMode
    /** fixed mode: the players the pool is sized for */
    players: number
}

const POLICY_KEY = "raids.hp"
export const RAID_MAX_PLAYERS = 1_000_000

export function getRaidHpPolicy(): RaidHpPolicy {
    try {
        const stored = JSON.parse(getStoredText(POLICY_KEY) ?? "null")
        if (stored !== null && (stored.mode === "fixed" || stored.mode === "automatic") && Number.isSafeInteger(stored.players)) {
            return { mode: stored.mode, players: Math.min(Math.max(stored.players, 1), RAID_MAX_PLAYERS) }
        }
    } catch { /* an invalid stored value falls back to the default */ }
    // automatic by default: the pool grows with the players who fight, so a server of any size gets fair raids unset
    return { mode: "automatic", players: 1 }
}

/** Saves the policy; throws a RangeError for an invalid one. */
export function setRaidHpPolicy(policy: RaidHpPolicy) {
    if (policy.mode !== "fixed" && policy.mode !== "automatic") throw new RangeError("raid HP mode")
    if (!Number.isSafeInteger(policy.players) || policy.players < 1 || policy.players > RAID_MAX_PLAYERS) throw new RangeError(`raid HP players (1-${RAID_MAX_PLAYERS})`)
    setStoredText(POLICY_KEY, JSON.stringify(policy))
}

/** The players who logged in within the last week: the settings page's suggestion for the fixed size. */
export function activePlayersThisWeek(date: Date): number {
    return countPlayersLoggedInSinceSync(new Date(date.getTime() - 7 * 24 * 60 * 60 * 1000))
}

// ---- the boss ----

export function raidEventId(questId: number): number | null {
    return quests[String(questId)]?.eventId ?? null
}

/**
 * The event's pool: the original HP's share for the players it is sized for (at least 1). In automatic mode
 * `participants` may be fractional (RAID_FULL_PARTICIPANT_KILLS).
 */
export function raidPoolSize(eventId: number, participants: number, policy = getRaidHpPolicy()): number {
    const hp = events[String(eventId)]?.bossHp ?? 0
    const players = policy.mode === "fixed" ? policy.players : Math.max(1, participants)
    return Math.max(1, Math.round(hp * players / RAID_REFERENCE_PLAYERS))
}

/** The server's boss: total kills and the current boss's HP left, in percent. */
export function raidBossSync(eventId: number): { totalKills: number, hpPercentage: number } {
    // developer-mode and restricted players' clears don't count toward the shared tally (SEC-18)
    const left = boardHiddenPlayers()
    const kills = getRaidEventKillsSync(eventId).filter(kill => !left.has(kill.playerId))
    const damage = kills.reduce((sum, entry) => sum + entry.killCount * (quests[String(entry.questId)]?.killWeight ?? 0), 0)
    const killsByPlayer = new Map<number, number>()
    for (const entry of kills) killsByPlayer.set(entry.playerId, (killsByPlayer.get(entry.playerId) ?? 0) + entry.killCount)
    let participants = 0
    for (const playerKills of killsByPlayer.values()) participants += Math.min(1, playerKills / RAID_FULL_PARTICIPANT_KILLS)
    const pool = raidPoolSize(eventId, participants)
    const totalKills = Math.floor(damage / pool)
    return { totalKills, hpPercentage: Math.round(10000 * (1 - (damage % pool) / pool)) / 100 }
}

const serializeBoss = (boss: { totalKills: number, hpPercentage: number }) => ({ "hp_percentage": boss.hpPercentage, "total_kill_count": boss.totalKills })

export function raidBossReply(eventId: number): Record<string, unknown> {
    return serializeBoss(raidBossSync(eventId))
}

// ---- periods ----

// master periods, projected like every event's when event scheduling is on (src/lib/eventSchedule.ts)
const period = (start: string, end: string, date: Date) => isContentPeriodOpen(masterDate(start).getTime(), masterDate(end).getTime(), date)

export function isRaidBattlePeriod(eventId: number, date: Date): boolean {
    const event = events[String(eventId)]
    return event !== undefined && period(event.start, event.battleEnd, date)
}

export function isRaidEventPeriod(eventId: number, date: Date): boolean {
    const event = events[String(eventId)]
    return event !== undefined && period(event.start, event.resultsEnd, date)
}

/** The results announcement: from the end of the results calculation (exclusive) to the end of the announcement. */
export function isRaidRewardPeriod(eventId: number, date: Date): boolean {
    const event = events[String(eventId)]
    return event !== undefined && period(event.resultsStart, event.resultsEnd, date) && !period(event.resultsStart, event.resultsStart, date)
}

// ---- auto-battles ----

function autoStartsLeft(playerId: number, eventId: number, date: Date): number {
    const state = getPlayerRaidStateSync(playerId, eventId)
    return state.autoDay === gameDay(date).day ? Math.max(0, RAID_DAILY_AUTO_STARTS - state.autoUsed) : RAID_DAILY_AUTO_STARTS
}

/** Spends one of the day's auto-battles; false when none is left. */
export function spendRaidAutoStartSync(playerId: number, eventId: number, date: Date): boolean {
    const left = autoStartsLeft(playerId, eventId, date)
    if (left <= 0) return false
    const state = getPlayerRaidStateSync(playerId, eventId)
    setPlayerRaidStateSync(playerId, eventId, { ...state, autoDay: gameDay(date).day, autoUsed: RAID_DAILY_AUTO_STARTS - left + 1 })
    return true
}

// ---- battles ----

/** SEC-18: a record's clears on the shared boards (the tally and the raid ranking): its own minus the excluded ones. */
export function boardKillCount(record: Pick<RaidRecord, "killCount" | "excludedKillCount">): number {
    return Math.max(0, record.killCount - (record.excludedKillCount ?? 0))
}

/**
 * A raid battle's finish: a clear in the battle period is a kill of its quest; the best score keeps the party group
 * that set it. `onBoards` false (SEC-18: an anti-cheat exclusion in enforce mode) still counts the kill as the player's
 * own (their summary, their kill tally rewards: they fought), but marks it excluded, so it stays out of the shared tally
 * and the raid ranking, and keeps its score off the record the ranking shows. Returns the finish reply's `raid_event`.
 */
export function finishRaidBattleSync(playerId: number, questId: number, accomplished: boolean, score: number, party: RaidRecord["party"], date: Date, onBoards = true): Record<string, unknown> {
    const eventId = raidEventId(questId) ?? 0
    const inPeriod = isRaidBattlePeriod(eventId, date)
    const current = getPlayerRaidRecordsSync(playerId, eventId).find(record => record.questId === questId)
    let record: RaidRecord = current ?? { questId, killCount: 0, excludedKillCount: 0, highScore: 0, party: [] }
    if (inPeriod) {
        const better = onBoards && (current === undefined || score > current.highScore)
        const kill = accomplished ? 1 : 0
        record = {
            questId,
            killCount: record.killCount + kill,
            excludedKillCount: (record.excludedKillCount ?? 0) + (onBoards ? 0 : kill),
            highScore: better ? score : record.highScore,
            party: better ? party : record.party
        }
        setPlayerRaidRecordSync(playerId, eventId, record)
    }
    return {
        "auto_start_point": autoStartsLeft(playerId, eventId, date),
        "is_out_of_period": !inPeriod,
        "quest_boss": { "kill_count": record.killCount },
        "raid_boss": raidBossReply(eventId)
    }
}

// ---- summary and the kill tally rewards ----

/** A reward list for the client's dialogs, which read `kind` as a mail type (13 title, 6 armament), not GeneralRewardKind. */
const serializeRewards = (rewards: BorderReward[], times = 1) => rewards
    .filter(reward => MAIL_TYPES[reward.kind] !== undefined)
    .map(reward => ({ "kind": MAIL_TYPES[reward.kind], "kind_id": reward.id ?? null, "number": reward.number * times }))

/**
 * `event/raid/summary`: the boss, the player's clears per quest, the day's auto-battles left and the kill tally
 * rewards the server's kills newly reached, mailed now to a player who has fought in the raid.
 */
export function raidSummarySync(playerId: number, eventId: number, date: Date): Record<string, unknown> {
    const boss = raidBossSync(eventId)
    const records = getPlayerRaidRecordsSync(playerId, eventId)
    const state = getPlayerRaidStateSync(playerId, eventId)
    const fought = records.some(record => record.killCount > 0)

    let granted: Record<string, unknown>[] = []
    let receivedUpTo = state.killsReceived
    if (fought && boss.totalKills > state.killsReceived) {
        const rewards = overall[String(eventId)]
        const tiers = (rewards?.tiers ?? []).filter(tier => tier.kills > state.killsReceived && tier.kills <= boss.totalKills)
        mailBorderRewardsSync(playerId, tiers, "Raid Event")
        granted = tiers.flatMap(tier => serializeRewards(tier.rewards))
        const newKills = boss.totalKills - state.killsReceived
        if (rewards?.perKill) {
            const perKill = { ...rewards.perKill, rewards: rewards.perKill.rewards.map(reward => ({ ...reward, number: reward.number * newKills })) }
            mailBorderRewardsSync(playerId, [perKill], "Raid Event")
            granted.push(...serializeRewards(perKill.rewards))
        }
        receivedUpTo = boss.totalKills
        setPlayerRaidStateSync(playerId, eventId, { ...state, killsReceived: receivedUpTo })
    }

    const questList: Record<string, unknown> = {}
    for (const [questId, quest] of Object.entries(quests)) {
        if (quest.eventId !== eventId) continue
        questList[questId] = { "kill_count": records.find(record => record.questId === Number(questId))?.killCount ?? 0 }
    }
    return {
        "aggregated_time": clientSerializeDate(date),
        "auto_start_point": autoStartsLeft(playerId, eventId, date),
        "kill_count_reward_data": { "received_up_to": receivedUpTo, "reward_list": granted },
        "quest_list": questList,
        "raid_boss": serializeBoss(boss)
    }
}

// ---- rankings ----

type Ranked = RaidRecord & { playerId: number, rankNumber: number }

/**
 * A raid quest's ranking: by clears, then the best score; equal records share a rank number. Its kill counts are the
 * board's: clears anti-cheat excluded (SEC-18) are left out.
 */
export function raidQuestRankingSync(eventId: number, questId: number): Ranked[] {
    const left = boardHiddenPlayers()
    const records = getRaidQuestRecordsSync(eventId, questId)
        .map(record => ({ ...record, killCount: boardKillCount(record), excludedKillCount: 0 }))
        .filter(record => record.killCount > 0 && !left.has(record.playerId))
        .sort((a, b) => b.killCount - a.killCount || b.highScore - a.highScore || a.playerId - b.playerId)
    let rank = 0
    return records.map((record, index) => {
        if (index === 0 || records[index - 1].killCount !== record.killCount || records[index - 1].highScore !== record.highScore) rank = index + 1
        return { ...record, rankNumber: rank }
    })
}

function rankingEntry(record: Ranked): Record<string, unknown> {
    const player = getPlayerSync(record.playerId)
    const leaders = record.party.map(party => party.characterIds.find((id): id is number => id !== null)).filter((id): id is number => id !== undefined)
    return {
        "high_score": record.highScore,
        "kill_count": record.killCount,
        "leader_character_id": leaders[0] ?? 1,
        "leader_character_evolution_img_level": 1,
        "name": player?.name ?? "",
        "party_leader_list": leaders.map(id => ({ "character_id": id, "evolution_img_level": 1 })),
        "rank_number": record.rankNumber,
        "user_rank": playerRankSync(player?.rankPoint ?? 0)
    }
}

/** `event/raid/ranking`: a page of each requested quest's ranking, with the player's own place. */
export function raidRankingReply(playerId: number, eventId: number, questIds: number[], page: number, date: Date): Record<string, unknown> {
    const questList: Record<string, unknown> = {}
    for (const questId of questIds) {
        const ranking = raidQuestRankingSync(eventId, questId)
        const pageMax = Math.max(1, Math.ceil(ranking.length / RAID_RANKING_PAGE_SIZE))
        const current = Math.min(Math.max(page, 1), pageMax)
        const mine = ranking.find(record => record.playerId === playerId)
        questList[String(questId)] = {
            "current_page": current,
            "page_max": pageMax,
            "my_data": mine === undefined ? null : rankingEntry(mine),
            "ranking_list": ranking.slice((current - 1) * RAID_RANKING_PAGE_SIZE, current * RAID_RANKING_PAGE_SIZE).map(rankingEntry)
        }
    }
    return { "aggregated_time": clientSerializeDate(date), "quest_list": questList }
}

/** `event/raid/ranking/party`: the party group of the player at a rank on a quest. */
export function raidRankingPartyReply(eventId: number, questId: number, rankNumber: number): Record<string, unknown>[] {
    const record = raidQuestRankingSync(eventId, questId).find(entry => entry.rankNumber === rankNumber)
    return (record?.party ?? []).map(party => {
        const entry: Record<string, unknown> = {}
        for (let slot = 0; slot < 3; slot++) {
            entry[`character_id_${slot + 1}`] = party.characterIds[slot] ?? null
            entry[`unison_character_id_${slot + 1}`] = party.unisonCharacterIds[slot] ?? null
            entry[`equipment_id_${slot + 1}`] = party.equipmentIds[slot] ?? null
            entry[`ability_soul_id_${slot + 1}`] = party.abilitySoulIds[slot] ?? null
            entry[`evolution_img_level_${slot + 1}`] = 1
            entry[`unison_evolution_img_level_${slot + 1}`] = 1
        }
        return entry
    })
}

/**
 * `event/raid/ranking_reward`: the band of the quest the player cleared most (a tie goes to the harder quest), mailed
 * once. Status 1 sent now, 2 received before, 3 no clear in the raid. The band follows the ranking: clears anti-cheat
 * kept off the boards (SEC-18) count toward none.
 */
export function receiveRaidRankingRewardSync(playerId: number, eventId: number): { status: number, rewards: Record<string, unknown>[] } {
    const records = getPlayerRaidRecordsSync(playerId, eventId).map(record => ({ ...record, killCount: boardKillCount(record) }))
        .filter(record => record.killCount > 0)
    if (records.length === 0) return { status: 3, rewards: [] }
    const state = getPlayerRaidStateSync(playerId, eventId)
    const main = records.sort((a, b) => b.killCount - a.killCount || b.questId - a.questId)[0]
    const rank = raidQuestRankingSync(eventId, main.questId).find(record => record.playerId === playerId)?.rankNumber ?? Infinity
    const band = (bandsByQuest[String(eventId)]?.[String(main.questId)] ?? []).find(candidate => rank >= candidate.from && rank <= candidate.to)
    if (state.rankingRewarded) return { status: 2, rewards: band === undefined ? [] : serializeRewards(band.rewards) }
    if (band !== undefined) mailBorderRewardsSync(playerId, [band], "Raid Event")
    setPlayerRaidStateSync(playerId, eventId, { ...state, rankingRewarded: true })
    return { status: 1, rewards: band === undefined ? [] : serializeRewards(band.rewards) }
}
