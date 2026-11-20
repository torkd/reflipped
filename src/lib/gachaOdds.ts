// Public rate display uses the SAME rarity/guarantee calculation as drawGachaSync; no draw rules change here.
import { gachaRankWeights } from "./gacha"
import type { Gacha } from "./types"

export interface PortalOddsRow { id: number; stars: number; featured: boolean; standard: number; guaranteed: number }

export function portalOdds(gacha: Gacha): PortalOddsRow[] {
    const keys = ["1", "2", "3"]
    const normal = gachaRankWeights(gacha, false).map(n => Math.max(0, n))
    const guaranteed = gachaRankWeights(gacha, true).map(n => Math.max(0, n))
    const total = (values: number[]) => values.reduce((a, b) => a + b, 0)
    const normalTotal = total(normal), guaranteedTotal = total(guaranteed)
    if (![...normal, ...guaranteed].every(Number.isSafeInteger)) throw new Error("Portal has invalid rarity weights")
    if (normalTotal <= 0 || guaranteedTotal <= 0) throw new Error("Portal has no rarity weights")
    return keys.flatMap((key, index) => {
        const pool = gacha.pool[key] ?? []
        if (!pool.length && (normal[index] > 0 || guaranteed[index] > 0)) throw new Error("Portal has an empty active pool")
        const weights = pool.map(item => Math.max(0, item.odds))
        if (!weights.every(Number.isSafeInteger)) throw new Error("Portal has invalid item weights")
        const weightTotal = total(weights)
        const byId = new Map<number, PortalOddsRow>()
        pool.forEach((item, at) => {
            // drawGachaSync deliberately falls back to the first entry when every item weight is zero.
            const share = weightTotal > 0 ? weights[at] / weightTotal : Number(at === 0)
            const row = byId.get(item.id) ?? { id: item.id, stars: 5 - index, featured: false, standard: 0, guaranteed: 0 }
            row.featured ||= item.isRateUp
            row.standard += normal[index] / normalTotal * share
            row.guaranteed += guaranteed[index] / guaranteedTotal * share
            byId.set(item.id, row)
        })
        return [...byId.values()].sort((a,b) => Number(b.featured)-Number(a.featured) || a.id-b.id)
    })
}

export function oddsPercent(chance: number): string {
    if (chance > 0 && chance * 100 < 0.000001) return "<0.000001%"
    return `${(chance * 100).toFixed(6).replace(/\.?0+$/, "") || "0"}%`
}
