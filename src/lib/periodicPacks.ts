// Periodic packs (FT-89): the original's real-money monthly and Rank Achievement packs, which the server's owner gives to
// every player at once (Settings → Rewards, *Periodic packs*): a pack is on for all players or for none. Nothing is sold.
// Allowed under Automatic reward rules too: every player gets the same.
//
// Contents from the game data (payment/android_payment, columns 30-46): an immediate part ("paid" beads, mana) and either
// a daily part for a term (Monthly 30 days, 90-Day 90 days, Staminade 30 days) or free beads at rank thresholds (Rank
// Achievement Packs I-IV). Every bead here is a free bead (owner decision 2026-11-18): every bead cost on this server
// takes any beads (src/lib/beads.ts). Each delivery is a gift-box mail with the pack's own mail reason (mail/reason
// 9001-9010: "Monthly Pack Reward", ...), as the global server sent them.
//
// Terms: while a monthly pack is on, a player's term starts at their first login and renews when fewer than 3 days are
// left (the original let a pack be bought again with 3 days or less left, adding a term; the client's "expiring soon"
// reminder shows below 3 days, so a renewing pack never shows it). Each renewal sends the immediate part again, as a
// repurchase did. The daily part arrives at the first login of each game day of the term; missed days are lost, as in
// the original. Turning a pack off starts no new term: the running one ends as it would. /load reports the running
// terms in `premium_bonus_list` ({ store_product_id, remain_days }).
//
// Rank packs: while on, the immediate part once per player, and each threshold's beads once the player's rank reaches
// it, thresholds passed before included. Checked at /load.
//
// Receipts (players_periodic_pack_receipts) make every delivery happen once: per term start, per game day (with the
// clock's era, so a day the event calendar repeats counts again, src/lib/resets.ts) and per threshold. A gift box that
// is full skips the delivery without a receipt, so the next login tries again (a day's part only that day).

import getDatabase, { Database } from "../data";
import { getStoredText, setStoredText } from "../data/serverSettings";
import { MailType } from "../data/types";
import { getPlayerSync, runInTransactionSync } from "../data/wdfpData";
import { playerRankSync } from "./assets";
import { GAME_DAY_MS, gameDayOf, gameDayStart } from "./calendar";
import { InvalidMailError, sendPlayerMailSync } from "./mail";
import { gameDay } from "./resets";

const db = getDatabase(Database.WDFP_DATA)

export type PeriodicPackId = "monthly" | "monthly_90" | "staminade" | "rank_1" | "rank_2" | "rank_3" | "rank_4"

interface PackReward { type: MailType, typeId?: number, number: number }

interface PackBase {
    id: PeriodicPackId
    name: string
    /** the store product, as `premium_bonus_list` names it */
    storeProductId: string
    /** mail/reason row of its deliveries */
    reasonId: number
    /** what arrives at once: at a term's start, or once for a rank pack */
    start: PackReward[]
}
export interface TermPack extends PackBase { kind: "term", days: number, daily: PackReward }
export interface RankPack extends PackBase { kind: "rank", from: number, to: number, step: number, beads: number }
export type PeriodicPack = TermPack | RankPack

const beads = (number: number): PackReward => ({ type: MailType.FREE_VMONEY, number })

/** The packs, as payment/android_payment gives them (the 90-Day pack's text says 9,100 free beads; its rows give 100 a day). */
export const PERIODIC_PACKS: readonly PeriodicPack[] = [
    { id: "monthly", kind: "term", name: "Monthly Pack", storeProductId: "gs.kg.worldflipper.pakage_monthly", reasonId: 9002,
        start: [beads(500), { type: MailType.FREE_MANA, number: 30000 }], days: 30, daily: beads(50) },
    { id: "monthly_90", kind: "term", name: "90-Day Monthly Pack", storeProductId: "gs.kg.worldflipper.pakage_monthly_90", reasonId: 9003,
        start: [beads(1000)], days: 90, daily: beads(100) },
    { id: "staminade", kind: "term", name: "Staminade Monthly Pack", storeProductId: "gs.kg.worldflipper.pakage_monthly_stamina", reasonId: 9004,
        start: [beads(110)], days: 30, daily: { type: MailType.ITEM, typeId: 106, number: 1 } },
    { id: "rank_1", kind: "rank", name: "Rank Achievement Pack", storeProductId: "gs.kg.worldflipper.pakage_rank", reasonId: 9001,
        start: [beads(3000)], from: 10, to: 100, step: 10, beads: 500 },
    { id: "rank_2", kind: "rank", name: "Rank Achievement Pack II", storeProductId: "gs.kg.worldflipper.pakage_rank_2", reasonId: 9008,
        start: [beads(3000)], from: 105, to: 125, step: 5, beads: 1000 },
    { id: "rank_3", kind: "rank", name: "Rank Achievement Pack III", storeProductId: "gs.kg.worldflipper.pakage_rank_3_1", reasonId: 9009,
        start: [beads(3000)], from: 130, to: 150, step: 5, beads: 1000 },
    { id: "rank_4", kind: "rank", name: "Rank Achievement Pack IV", storeProductId: "gs.kg.worldflipper.pakage_rank_4", reasonId: 9010,
        start: [beads(3000)], from: 155, to: 175, step: 5, beads: 1000 },
]

/** Days before a term's end at which it renews (the original's repurchase rule, and the client's reminder threshold). */
export const RENEW_DAYS_LEFT = 3

// ------------------------------------------------------------------ the owner's setting

const SETTING_KEY = "packs.periodic"

export function enabledPeriodicPacks(): Set<PeriodicPackId> {
    try {
        const stored = JSON.parse(getStoredText(SETTING_KEY) ?? "[]") as unknown
        if (!Array.isArray(stored)) return new Set()
        return new Set(PERIODIC_PACKS.map(pack => pack.id).filter(id => stored.includes(id)))
    } catch {
        return new Set()
    }
}

export function setEnabledPeriodicPacks(ids: readonly string[]): void {
    const unknown = ids.filter(id => !PERIODIC_PACKS.some(pack => pack.id === id))
    if (unknown.length > 0) throw new RangeError(`Unknown periodic pack ${unknown[0]}`)
    const list = PERIODIC_PACKS.map(pack => pack.id).filter(id => ids.includes(id))
    setStoredText(SETTING_KEY, list.length === 0 ? null : JSON.stringify(list))
}

// ------------------------------------------------------------------ storage

interface Term { start: number, end: number }

function termOf(playerId: number, packId: string): Term | null {
    const row = db.prepare(`SELECT term_start, term_end FROM players_periodic_packs WHERE player_id = ? AND pack_id = ?`)
        .get(playerId, packId) as { term_start: number, term_end: number } | undefined
    return row === undefined ? null : { start: row.term_start, end: row.term_end }
}

function saveTerm(playerId: number, packId: string, term: Term): void {
    db.prepare(`INSERT INTO players_periodic_packs (player_id, pack_id, term_start, term_end) VALUES (?, ?, ?, ?)
        ON CONFLICT (player_id, pack_id) DO UPDATE SET term_start = excluded.term_start, term_end = excluded.term_end`)
        .run(playerId, packId, term.start, term.end)
}

function received(playerId: number, packId: string, key: string): boolean {
    return db.prepare(`SELECT 1 FROM players_periodic_pack_receipts WHERE player_id = ? AND pack_id = ? AND receipt_key = ?`)
        .get(playerId, packId, key) !== undefined
}

/** Mails the rewards and records the receipt, once; false (nothing recorded) when the gift box is full. */
function deliver(playerId: number, pack: PeriodicPack, key: string, rewards: PackReward[], now: Date): boolean {
    if (received(playerId, pack.id, key)) return true
    try {
        runInTransactionSync(() => {
            for (const reward of rewards) sendPlayerMailSync(playerId, {
                type: reward.type, typeId: reward.typeId, number: reward.number, reasonId: pack.reasonId,
                subject: pack.name, description: `A ${pack.name} reward.`, durableReward: true
            })
            db.prepare(`INSERT INTO players_periodic_pack_receipts (player_id, pack_id, receipt_key, received_at) VALUES (?, ?, ?, ?)`)
                .run(playerId, pack.id, key, Math.floor(now.getTime() / 1000))
        })
        return true
    } catch (error) {
        if (error instanceof InvalidMailError) return false
        throw error
    }
}

// ------------------------------------------------------------------ delivery

/** The start of the game day `date` is in (05:00 Japan time). */
function dayStart(date: Date): number {
    return gameDayStart(gameDayOf(date.getTime()))
}

/** Whole days left in a term from the game day of `now` (today counts). */
function daysLeft(term: Term, now: Date): number {
    return Math.max(0, Math.round((term.end - dayStart(now)) / GAME_DAY_MS))
}

function applyTermPack(playerId: number, pack: TermPack, on: boolean, now: Date): void {
    let term = termOf(playerId, pack.id)
    // a clock set back before the term began ends it (the next one starts over)
    const running = term !== null && now.getTime() >= term.start && now.getTime() < term.end
    if (on && !running) {
        const start = dayStart(now)
        term = { start, end: start + pack.days * GAME_DAY_MS }
        saveTerm(playerId, pack.id, term)
    } else if (on && term !== null && daysLeft(term, now) < RENEW_DAYS_LEFT) {
        term = { start: term.start, end: term.end + pack.days * GAME_DAY_MS }
        saveTerm(playerId, pack.id, term)
    }
    if (term === null || now.getTime() < term.start || now.getTime() >= term.end) return
    // the term's immediate part, once per term end (a renewal moves the end, so it pays again)
    if (on) deliver(playerId, pack, `start:${term.end}`, pack.start, now)
    deliver(playerId, pack, `day:${gameDay(now).day}`, [pack.daily], now)
}

function applyRankPack(playerId: number, pack: RankPack, now: Date): void {
    const player = getPlayerSync(playerId)
    if (player === null) return
    deliver(playerId, pack, "start", pack.start, now)
    const rank = playerRankSync(player.rankPoint)
    for (let threshold = pack.from; threshold <= Math.min(pack.to, rank); threshold += pack.step) {
        deliver(playerId, pack, `rank:${threshold}`, [beads(pack.beads)], now)
    }
}

/** At /load: the packs that are on start or renew their terms, and every running term and rank threshold pays what is due. */
export function applyPeriodicPacksSync(playerId: number, now: Date): void {
    const enabled = enabledPeriodicPacks()
    for (const pack of PERIODIC_PACKS) {
        const on = enabled.has(pack.id)
        if (pack.kind === "term") applyTermPack(playerId, pack, on, now)
        else if (on) applyRankPack(playerId, pack, now)
    }
}

/** /load's `premium_bonus_list`: each running term with its days left (today included). */
export function premiumBonusListSync(playerId: number, now: Date): { store_product_id: string, remain_days: number }[] {
    const list: { store_product_id: string, remain_days: number }[] = []
    for (const pack of PERIODIC_PACKS) {
        if (pack.kind !== "term") continue
        const term = termOf(playerId, pack.id)
        if (term === null || now.getTime() < term.start || now.getTime() >= term.end) continue
        list.push({ store_product_id: pack.storeProductId, remain_days: daysLeft(term, now) })
    }
    return list
}
