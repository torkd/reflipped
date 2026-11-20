// Stamina (FT-25). A player's stamina is stored as a value (`stamina`) and the moment it was exact (`stamina_heal_time`);
// the client rebuilds the current value from both like the server does here: below the rank's max stamina, one point
// comes back every `recoverySeconds` (360 s, shortened by the rank's `stamina_heal_time_decrease_rate`) since that
// moment, up to the max; at or above the max (rank-ups, items and refills may push it there, up to `overflowMax`, 999),
// nothing comes back until it drops below.
//
// A battle start takes the quest's stamina cost (`staminaCost`, the quest table's `battle_stamina_cost`), lowered by an
// open stamina campaign (`campaign/stamina_campaign`: the lowest rate among those covering the quest; a rate or cost of
// 0 is free, any other at least 1). Giving up refunds it, except for the quests in `quest/battle_no_stamina_return`.
// A rank-up adds the new rank's max stamina to what is left, up to the overflow cap (device test 2026-11-02;
// gameranbu.jp/worldflipper/ee5818ea7183a71f1802: "ランクが上がるとその場でスタミナが最大値分まで全回復します。スタミナが
// あふれてしまっても余剰分はためておける"). A finish that gains several ranks adds one bar, of the rank reached: no source
// says more, and the client takes the stamina from the reply. Beads (`shop/recover_stamina`: 50 for 100) and stamina
// items (`item/use_item`) add to it, refused with result code 2102 once it reaches the overflow cap.
//
// Co-op (FT-60), as the client's StaminaCostCalculator shows it: the host pays the full cost; a guest who joined through
// an invitation (the client's `attentionKey`) or whose host is a mutual follow pays nothing; any other guest (one-way
// follow either way, or none) pays half, rounded down (`getHalvedCost`), and an open campaign then lowers that half.
// The guides agree: "joining from a rescue request or as a mutual follow costs no stamina", "a guest pays at most half"
// (gameranbu.jp/worldflipper/4a8fc30f20527f6db513, 2019-12; gamerch.com/worldflipper/113644).

import staminaData from "../../assets/stamina.json";
import { getPlayerSync, updatePlayerSync } from "../data/wdfpData";
import { masterDate } from "../utils";
import { playerRankSync } from "./assets";
import { isContentPeriodOpen } from "./eventSchedule";
import { IdLists, rangeCovers } from "./questRanges";
import { QuestCategory } from "./types";

interface StaminaData {
    recoverySeconds: number
    recoveryVmoney: number
    recoveryValue: number
    overflowMax: number
    ranks: { maxStamina: number, healTimeDecreaseRate: number }[]
    campaigns: { start: string, end: string, rate: number, kind: number, ids: IdLists }[]
    noStaminaReturn: { kind: number, ids: IdLists }[]
    items: Record<string, { kind: "fixed" | "rate", value: number }>
}

const data = staminaData as StaminaData

/** The client's result code for a stamina refill at the overflow cap (AlreadyStaminaMax). */
export const ALREADY_STAMINA_MAX = 2102

/** Beads a refill costs and the stamina it gives. */
export const STAMINA_REFILL = { vmoney: data.recoveryVmoney, stamina: data.recoveryValue }

/** `STAMINA=off` makes every battle free (the stamina gauge still refills and items still work); on by default. */
export function staminaCostsEnabled(value = process.env.STAMINA): boolean {
    return (value ?? "").trim().toLowerCase() !== "off"
}

/** What part of a quest's stamina cost a player pays: all (solo, the co-op host), half or none (co-op guests). */
export type StaminaShare = "full" | "half" | "free"

/**
 * A co-op guest's share (the client's StaminaCostCalculator): free when they joined through an invitation or the host
 * is a mutual follow, otherwise half, whatever the follow.
 */
export function coopGuestStaminaShare(joinedByInvitation: boolean, mutualFollow: boolean): StaminaShare {
    return joinedByInvitation || mutualFollow ? "free" : "half"
}

/**
 * The stamina a quest start takes at a date: its cost (halved for a co-op guest's "half" share, rounded down), lowered by
 * the open stamina campaigns covering it.
 */
export function questStaminaCost(category: QuestCategory, questId: number, baseCost: number | undefined, date: Date, share: StaminaShare = "full"): number {
    if (!staminaCostsEnabled() || share === "free") return 0
    const cost = share === "half" ? Math.floor((baseCost ?? 0) / 2) : baseCost ?? 0
    if (cost <= 0) return 0
    const rates = data.campaigns
        .filter(campaign => rangeCovers(campaign.kind, campaign.ids, category, questId))
        // projected like every event's period when event scheduling is on (src/lib/eventSchedule.ts)
        .filter(campaign => isContentPeriodOpen(masterDate(campaign.start).getTime(), masterDate(campaign.end).getTime(), date))
        .map(campaign => campaign.rate)
    if (rates.length === 0) return cost
    const rate = Math.min(...rates)
    return rate <= 0 ? 0 : Math.max(1, Math.floor(cost * rate))
}

/** Whether giving up a quest refunds its stamina. */
export function refundsStamina(category: QuestCategory, questId: number): boolean {
    return !data.noStaminaReturn.some(range => rangeCovers(range.kind, range.ids, category, questId))
}

/** A rank's max stamina. */
export function maxStamina(rank: number): number {
    const ranks = data.ranks
    return ranks[Math.min(Math.max(rank, 1), ranks.length) - 1].maxStamina
}

/** How long a rank waits for one point of stamina, in milliseconds. */
export function staminaRecoveryMs(rank: number): number {
    const ranks = data.ranks
    const rate = ranks[Math.min(Math.max(rank, 1), ranks.length) - 1].healTimeDecreaseRate
    return Math.floor(data.recoverySeconds * (1 - rate)) * 1000
}

export interface StaminaState {
    stamina: number
    healTime: Date
}

/** The current stamina and the moment it was exact, with the whole points recovered since then added. */
export function currentStamina(state: StaminaState, rank: number, now: Date): StaminaState {
    const max = maxStamina(rank)
    // a heal time ahead of the clock (the calendar wrapping back, a player clock set back) counts from now
    if (state.stamina >= max || state.healTime.getTime() > now.getTime()) return { stamina: Math.min(state.stamina, data.overflowMax), healTime: now }
    const step = staminaRecoveryMs(rank)
    const recovered = Math.max(0, Math.floor((now.getTime() - state.healTime.getTime()) / step))
    if (state.stamina + recovered >= max) return { stamina: max, healTime: now }
    // the part of a point under way stays under way
    return { stamina: state.stamina + recovered, healTime: new Date(state.healTime.getTime() + recovered * step) }
}

/** Adds (or with a negative amount takes) stamina, capped at the overflow max. */
function changeStamina(state: StaminaState, rank: number, amount: number, now: Date): StaminaState {
    const current = currentStamina(state, rank, now)
    const stamina = Math.min(data.overflowMax, Math.max(0, current.stamina + amount))
    // regeneration runs from now once the change takes stamina below the max from at or above it
    const healTime = current.stamina >= maxStamina(rank) ? now : current.healTime
    return { stamina, healTime }
}

function playerState(playerId: number) {
    const player = getPlayerSync(playerId)
    if (player === null) return null
    return { state: { stamina: player.stamina, healTime: player.staminaHealTime }, rank: playerRankSync(player.rankPoint) }
}

function save(playerId: number, state: StaminaState) {
    updatePlayerSync({ id: playerId, stamina: state.stamina, staminaHealTime: state.healTime })
}

/**
 * The player's stamina as `user_info` sends it. The heal time goes out as it is (epoch seconds), not through
 * `getServerTime`, which sends the clock's now on the historical clock.
 */
export function serializeStamina(state: StaminaState): { stamina: number, stamina_heal_time: number } {
    return { "stamina": state.stamina, "stamina_heal_time": Math.floor(state.healTime.getTime() / 1000) }
}

/** Takes a battle's stamina; null when the player has too little. */
export function spendStaminaSync(playerId: number, cost: number, now: Date): StaminaState | null {
    const player = playerState(playerId)
    if (player === null) return null
    const current = currentStamina(player.state, player.rank, now)
    if (current.stamina < cost) return null
    const next = changeStamina(player.state, player.rank, -cost, now)
    save(playerId, next)
    return next
}

/** Gives stamina back (an abort's refund, an item, a refill), up to the overflow max. */
export function addStaminaSync(playerId: number, amount: number, now: Date): StaminaState | null {
    const player = playerState(playerId)
    if (player === null) return null
    const next = changeStamina(player.state, player.rank, amount, now)
    save(playerId, next)
    return next
}

/** The player's current stamina, without saving it. */
export function playerStaminaSync(playerId: number, now: Date): StaminaState | null {
    const player = playerState(playerId)
    return player === null ? null : currentStamina(player.state, player.rank, now)
}

/** Whether the player's stamina is at the overflow cap, where refills are refused. */
export function staminaAtCapSync(playerId: number, now: Date): boolean {
    return (playerStaminaSync(playerId, now)?.stamina ?? 0) >= data.overflowMax
}

/**
 * A rank-up adds the new rank's max stamina to what is left, up to the overflow cap; once per rank-up, however many
 * ranks it gains (see the header).
 */
export function refillStaminaOnRankUpSync(playerId: number, oldRank: number, newRank: number, now: Date): StaminaState | null {
    if (newRank <= oldRank) return null
    const player = getPlayerSync(playerId)
    if (player === null) return null
    // the stamina recovered so far counts at the old rank's pace and max
    const current = currentStamina({ stamina: player.stamina, healTime: player.staminaHealTime }, oldRank, now)
    // the result is at least the new max, where nothing regenerates, so regeneration restarts from now
    const next = { stamina: Math.min(data.overflowMax, current.stamina + maxStamina(newRank)), healTime: now }
    save(playerId, next)
    return next
}

/** The stamina an item gives per copy: a fixed amount, or a share (percent) of the rank's max. */
export function itemStamina(itemId: number, rank: number): number | null {
    const item = data.items[String(itemId)]
    if (item === undefined) return null
    return item.kind === "fixed" ? item.value : Math.floor(maxStamina(rank) * item.value / 100)
}
