// The Welcome Back Boost (FT-65): a returning player gets five times the daily Boss Boosts, 15 instead of 3, for a
// while after the returning login. Japan's "おかえりボーナス" (2021-11-27, standing from then on) gave a returning player
// the Welcome Back Portal, the Welcome Back Gift and "カムバックブースト: ボスブーストポイント使用回数が5倍の15回"
// (2nd anniversary broadcast, https://gameo.jp/worldflipper/16451; notice https://worldflipper.jp/news/detail.php?announce_id=1130
// via web.archive.org). The client's dialog says the same ("Welcome Back! As a bonus, you have 5x the Boss Boosts!",
// ui_string comeback_boss_boost_dialog_body).
//
// From the client: /load's `comeback_campaign_boss_boost: { period_end_time }` (UnixTime seconds, optional) makes the
// town and main screens show that dialog once a day while the time is before period_end_time ("Last Day!" on the last
// one; startDisplayComebackBossBoostPointGuideDialog). The count itself is the player's `boss_boost_point`, which the
// server sets; the client only refuses to go past its limit (playerLimits.bossBoostPoint, 30).
//
// Neither source gives the boost's length. Owner decision (2026-11-18): 7 days from the returning login.

import { getPlayerSync, updatePlayerSync } from "../data/wdfpData";
import { playerLimits } from "./limits";
import { latestReturnSync } from "./loginBonus";
import { DAILY_BOOST_POINTS } from "./resets";

/** Japan's factor: five times the daily Boss Boosts. */
export const COMEBACK_BOSS_BOOST_FACTOR = 5
/** No source gives it; owner decision 2026-11-18 (see the header). */
export const COMEBACK_BOSS_BOOST_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

export interface ComebackBossBoostPeriod {
    start: Date
    /** the last moment it is open (inclusive) */
    end: Date
}

/** The player's Welcome Back Boost at `date`: from their latest return for COMEBACK_BOSS_BOOST_DAYS, or null. */
export function comebackBossBoostPeriodSync(playerId: number, date: Date): ComebackBossBoostPeriod | null {
    const returned = latestReturnSync(playerId)
    if (returned === null) return null
    const end = new Date(returned.getTime() + COMEBACK_BOSS_BOOST_DAYS * DAY_MS)
    if (date.getTime() < returned.getTime() || date.getTime() > end.getTime()) return null
    return { start: returned, end }
}

/** The Boss Boosts a game day starts with during the boost: 15, within the client's limit. */
export function comebackDailyBossBoostPoints(): number {
    return Math.min(DAILY_BOOST_POINTS * COMEBACK_BOSS_BOOST_FACTOR, playerLimits.bossBoostPoint)
}

/**
 * At /load, after the daily resets and the login bonuses (which record a return): during the boost, a new game day or
 * the returning login itself starts with 15 Boss Boosts instead of 3; a player who has more keeps them. `fresh` says
 * whether this /load began a game day or recorded the return, so relaunching the same day refills nothing.
 */
export function topUpComebackBossBoostSync(playerId: number, date: Date, fresh: boolean): void {
    if (!fresh || comebackBossBoostPeriodSync(playerId, date) === null) return
    const player = getPlayerSync(playerId)
    if (player === null) return
    const points = comebackDailyBossBoostPoints()
    if (player.bossBoostPoint < points) updatePlayerSync({ id: playerId, bossBoostPoint: points })
}

/** /load's `comeback_campaign_boss_boost` while the boost runs, or undefined (the client then shows nothing). */
export function serializeComebackBossBoost(period: ComebackBossBoostPeriod | null): { period_end_time: number } | undefined {
    return period === null ? undefined : { period_end_time: Math.floor(period.end.getTime() / 1000) }
}
