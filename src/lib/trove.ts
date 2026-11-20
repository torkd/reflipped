// The Trove (FT-9, the treasure shop, ShopType.TREASURE): "The selection and any discounts offered will change daily
// and is unique for each player" (worldflipper.wiki.gg, "Shop"); the client says "The lineup changes every day at
// ::resetTime::" (the game day, 05:00 Japan time, src/lib/resets.ts). The captured `shop/get_sales_list` lists 8
// products, some with a discount (`discount_id`, `discount_rate`, `discounted_price`: 500 at 10% off is 450), and
// each product's stock left for the day (`stock_quantity`: its daily stock less the day's purchases).
//
// The master table drives the draw, in two columns the client doesn't read (scripts/converter.py): each product's
// weight among the products on sale (`lineupWeight`: 10 for the medium elements, 7 the large, 1 the largest and the
// Astral Gem) and its chance of a discount (`discountChance`, 0.1-0.4); `treasure_shop_discount_rate` weighs the
// rates (10% 50, 30% 25, 50% 20, 90% 5). The draw is seeded by the player and the game day, so it needs no storage
// and every request that day gets the same lineup.
//
// With modern event scheduling (FT-31, FT-48) the client gets the products' periods projected onto the event timeline,
// so the draw takes the products on sale on the timeline during the real game day. A timeline day doesn't start at
// the game day's change, so on the day it passes the product switch of 2021-11-12 the draw mixes both sets, and the
// sales list drops the ones off sale (`isOnSale`) as the switch passes.

import treasureShopItems from "../../assets/treasure_shop.json";
import discountRates from "../../assets/treasure_shop_discount_rate.json";
import { masterDate } from "../utils";
import { GAME_DAY_MS, gameDayStart } from "./calendar";
import { isContentPeriodOpenOnRealDay, scheduledContentEnabled } from "./eventSchedule";
import { gameDay, isOnSale } from "./shopLimits";
import { ShopItem } from "./types";

/** How many products the day's lineup shows (the captured list). */
export const TROVE_LINEUP_SIZE = 8

export interface TroveDiscount {
    discountId: number
    rate: number
    /** the mana price after the discount */
    price: number
}

export interface TroveProduct {
    shopItemId: number
    discount: TroveDiscount | null
}

type TroveItem = ShopItem & { lineupWeight?: number, discountChance?: number }

const items = treasureShopItems as unknown as Record<string, TroveItem>
const rates = discountRates as Record<string, { rate: number, weight: number }>

/** A small seeded generator (mulberry32) over a string seed. */
function seededRandom(seed: string): () => number {
    let state = 2166136261
    for (let i = 0; i < seed.length; i++) state = Math.imul(state ^ seed.charCodeAt(i), 16777619)
    return () => {
        state = (state + 0x6D2B79F5) | 0
        let t = Math.imul(state ^ (state >>> 15), 1 | state)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

/** Picks an index by weight. */
function pickWeighted(weights: number[], random: () => number): number {
    const total = weights.reduce((sum, weight) => sum + weight, 0)
    let roll = random() * total
    for (let i = 0; i < weights.length; i++) {
        roll -= weights[i]
        if (roll < 0) return i
    }
    return weights.length - 1
}

/** Whether a product is on sale at some time during the game day of `date`, so the day's draw doesn't change. */
function onSaleDuringDay(item: TroveItem, date: Date): boolean {
    const from = masterDate(item.availableFrom).getTime()
    if (scheduledContentEnabled()) {
        return isContentPeriodOpenOnRealDay(from, item.availableUntil === null ? undefined : masterDate(item.availableUntil).getTime(), date)
    }
    const dayStart = gameDayStart(gameDay(date).day.split("~")[0])
    const until = item.availableUntil === null ? Infinity : masterDate(item.availableUntil).getTime()
    return from < dayStart + GAME_DAY_MS && until > dayStart
}

/**
 * The player's lineup for the game day of `date`: up to 8 products drawn by weight without repeats from those on sale
 * that day, each with its discount, if it drew one.
 */
export function troveLineup(playerId: number, date: Date): TroveProduct[] {
    const random = seededRandom(`${playerId}:${gameDay(date).day}`)
    const candidates = Object.entries(items)
        .filter(([, item]) => (item.lineupWeight ?? 0) > 0 && onSaleDuringDay(item, date))
        .map(([id, item]) => ({ id: Number(id), item }))
    const discountIds = Object.keys(rates)
    const lineup: TroveProduct[] = []
    while (lineup.length < TROVE_LINEUP_SIZE && candidates.length > 0) {
        const [{ id, item }] = candidates.splice(pickWeighted(candidates.map(candidate => candidate.item.lineupWeight!), random), 1)
        let discount: TroveDiscount | null = null
        if (random() < (item.discountChance ?? 0) && item.userCost !== undefined && discountIds.length > 0) {
            const discountId = discountIds[pickWeighted(discountIds.map(key => rates[key].weight), random)]
            const rate = rates[discountId].rate
            discount = { discountId: Number(discountId), rate, price: Math.round(item.userCost.amount * (1 - rate)) }
        }
        lineup.push({ shopItemId: id, discount })
    }
    return lineup
}

/** The day's lineup entry for a product, or null when the product isn't in the player's lineup now. */
export function troveProduct(playerId: number, shopItemId: number, date: Date): TroveProduct | null {
    const item = items[String(shopItemId)]
    if (item === undefined || !isOnSale(item, date)) return null
    return troveLineup(playerId, date).find(product => product.shopItemId === shopItemId) ?? null
}
