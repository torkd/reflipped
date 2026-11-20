// Cap earned credits against the current inventory at each authoritative grant. A reward batch can contain the
// same currency/item several times, and quest base, field, clear, score and overflow grants share these balances.
// Purchase costs and generic purchase grants do not use this helper.
import { getPlayerItemSync, getPlayerSync, givePlayerItemSync, updatePlayerSync } from "../data/wdfpData";
import { getItemMaxCountSync, playerLimits } from "./limits";

export interface EarnedCredit { amount: number, total: number }
const count = (amount: number) => Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0
export function creditEarnedCurrencySync(playerId: number, kind: "beads" | "mana" | "exp", requested: number): EarnedCredit {
    const player = getPlayerSync(playerId)
    if (!player) throw new Error("Cannot credit a missing player")
    const field = kind === "beads" ? "freeVmoney" : kind === "mana" ? "freeMana" : "expPool"
    const limit = kind === "beads" ? playerLimits.virtualMoney : kind === "mana" ? playerLimits.mana : playerLimits.expPool
    const owned = player[field]
    const occupied = owned + (kind === "beads" ? player.vmoney : 0)
    const amount = Math.min(count(requested), Math.max(0, limit - occupied))
    const total = owned + amount
    if (amount > 0) updatePlayerSync({ id: playerId, [field]: total })
    return { amount, total }
}
export function creditEarnedItemSync(playerId: number, itemId: number, requested: number): EarnedCredit {
    const owned = getPlayerItemSync(playerId, itemId) ?? 0
    // Ability cores are keyed by armament IDs and have no item-master row; keep their counts in the client's int range.
    const limit = getItemMaxCountSync(itemId) ?? 2 ** 31 - 1
    const amount = Math.min(count(requested), Math.max(0, limit - owned))
    return { amount, total: amount > 0 ? givePlayerItemSync(playerId, itemId, amount) : owned }
}
