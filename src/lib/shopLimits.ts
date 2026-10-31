// Shop purchase limits (SEC-15): what the client checks before it lets a player buy (its `canBuy`), checked again on
// the server. The limits come from the shop master tables (scripts/converter.py, `shop_limits`); the player's counts
// are in `players_shop_purchases`.

import { PlayerShopPurchases } from "../data/types";
import { getPlayerShopPurchasesSync, setPlayerShopPurchasesSync } from "../data/wdfpData";
import { ShopItem } from "./types";
import { masterDate } from "../utils";
import { playerRankSync } from "./assets";
import { gameDay } from "./resets";

export { gameDay }

/** A player's counts for a product as of `date`: the day's and month's counts start over when those change. */
export function currentPurchases(playerId: number, shopType: number, itemId: number, date: Date): PlayerShopPurchases {
    const { day, month } = gameDay(date)
    const stored = getPlayerShopPurchasesSync(playerId, shopType, itemId)
    return {
        total: stored?.total ?? 0,
        day,
        dayCount: stored?.day === day ? stored.dayCount : 0,
        month,
        monthCount: stored?.month === month ? stored.monthCount : 0
    }
}

/** Whether the product is on sale at `date`: its period, and its months for products sold only in some. */
export function isOnSale(item: ShopItem, date: Date): boolean {
    const now = date.getTime()
    if (now < masterDate(item.availableFrom).getTime()) return false
    if (item.availableUntil !== null && masterDate(item.availableUntil).getTime() <= now) return false
    if (item.specifiedMonths !== undefined) {
        const month = Number(gameDay(date).month.slice(5, 7))
        if (!item.specifiedMonths.includes(month)) return false
    }
    return true
}

/**
 * Why a player can't buy `number` of the product now, or null if it can. `purchases` are its counts as of now.
 */
export function purchaseRefusal(item: ShopItem, number: number, rankPoint: number, purchases: PlayerShopPurchases, date: Date): string | null {
    if (!Number.isSafeInteger(number) || number < 1 || number > item.buyMaxCount) return `Buy between 1 and ${item.buyMaxCount} at once.`
    if (!isOnSale(item, date)) return "Not on sale."
    if (item.releaseRank !== undefined && playerRankSync(rankPoint) < item.releaseRank) return `Needs rank ${item.releaseRank}.`
    if (item.maxFrequency !== undefined && purchases.total + number > item.maxFrequency) return "Out of stock."
    if (item.dailyStock !== undefined && purchases.dayCount + number > item.dailyStock) return "Out of stock today."
    if (item.monthlyStock !== undefined && purchases.monthCount + number > item.monthlyStock) return "Out of stock this month."
    return null
}

/** Records a purchase of `number` on top of `purchases` (as of now). */
export function recordPurchase(playerId: number, shopType: number, itemId: number, purchases: PlayerShopPurchases, number: number) {
    setPlayerShopPurchasesSync(playerId, shopType, itemId, {
        ...purchases,
        total: purchases.total + number,
        dayCount: purchases.dayCount + number,
        monthCount: purchases.monthCount + number
    })
}
