// Welcome Back Portals (FT-62): gacha/gacha 700000-700004 (assets/comeback_gacha.json, the client's
// GachaPageKind.WithoutDaily, comeback portals by column 43), one per lineup, each opening on its own date until 2199.
//
// From the client: a comeback portal ignores its master period. It is shown, and drawable, only while the player's
// gacha_info_list entry for it carries `comeback_campaign: { period_start_time, period_end_time }` (UnixTime seconds)
// and the time is within it (getPeriod returns comebackGachaPeriod, from saveData.gachaStatus[id].comebackCampaign,
// which /load and the gacha/exec reply set). The client never asks for the period: the server grants it.
//
// The rule here: a player who returns after the absence of the comeback present (src/lib/loginBonus.ts,
// isReturningLoginSync: 60 days or more) gets the portal for COMEBACK_GACHA_DAYS from that login, as Japan's comeback
// portal ran "for 3 days after the returning player logs in" (2nd anniversary, https://gameo.jp/worldflipper/16451).
// The portal is the newest lineup open at the return; the others stay hidden. Nothing new is stored: the return is the
// comeback present's receipt (latestReturnSync), which a save import keeps.

import comebackGachas from "../../assets/comeback_gacha.json";
import { UserGachaInfo } from "../data/types";
import { masterDate } from "../utils";
import { isContentPeriodOpen } from "./eventSchedule";
import { latestReturnSync } from "./loginBonus";

/** Days the Welcome Back Portal stays open after the returning login (Japan's rule; see the header). */
export const COMEBACK_GACHA_DAYS = 3
const DAY_MS = 24 * 60 * 60 * 1000

const portals = comebackGachas as Record<string, { startDate: string, endDate: string }>

export interface ComebackGachaPeriod {
    gachaId: number
    start: Date
    /** the last moment it is open (inclusive, as the client's period check) */
    end: Date
}

/** Whether a portal is a Welcome Back Portal. */
export function isComebackGacha(gachaId: number): boolean {
    return String(gachaId) in portals
}

/** The newest Welcome Back Portal open at `date` (its lineup), or null before the first one. */
function comebackGachaAt(date: Date): number | null {
    let newest: { id: number, start: number } | null = null
    for (const [id, portal] of Object.entries(portals)) {
        const start = masterDate(portal.startDate).getTime()
        if (!isContentPeriodOpen(start, masterDate(portal.endDate).getTime(), date)) continue
        if (newest === null || start > newest.start) newest = { id: Number(id), start }
    }
    return newest?.id ?? null
}

/**
 * The Welcome Back Portal open to the player at `date`, with its period, or null: only from their latest return
 * until COMEBACK_GACHA_DAYS after it. A clock set back before the return closes it too.
 */
export function comebackGachaPeriodSync(playerId: number, date: Date): ComebackGachaPeriod | null {
    const returned = latestReturnSync(playerId)
    if (returned === null) return null
    const end = new Date(returned.getTime() + COMEBACK_GACHA_DAYS * DAY_MS)
    if (date.getTime() < returned.getTime() || date.getTime() > end.getTime()) return null
    const gachaId = comebackGachaAt(returned)
    return gachaId === null ? null : { gachaId, start: returned, end }
}

/** The `comeback_campaign` field of a gacha_info_list entry. */
export function serializeComebackCampaign(period: ComebackGachaPeriod): { period_start_time: number, period_end_time: number } {
    return {
        period_start_time: Math.floor(period.start.getTime() / 1000),
        period_end_time: Math.floor(period.end.getTime() / 1000)
    }
}

/**
 * /load's gacha_info_list with the open Welcome Back Portal's period added to its entry (one is added when the player
 * hasn't drawn on it yet: the client lists only portals with an entry carrying the period).
 */
export function withComebackCampaign(list: UserGachaInfo[], period: ComebackGachaPeriod | null): UserGachaInfo[] {
    if (period === null) return list
    const campaign = serializeComebackCampaign(period)
    const existing = list.find(entry => entry.gacha_id === period.gachaId)
    if (existing !== undefined) return list.map(entry => entry === existing ? { ...entry, comeback_campaign: campaign } : entry)
    return [...list, { gacha_id: period.gachaId, is_daily_first: true, is_account_first: true, gacha_exchange_point: 0, comeback_campaign: campaign }]
}
