// Bead payments. Every bead cost on this server takes free and paid beads alike, free ones first: the original game had
// costs in paid beads only (the portals' daily discounted pull, the special exchange ticket bundles), which this
// server doesn't sell, so they accept any beads too (the AIR shell's any-beads-* patches let the client offer them).

export interface BeadBalance {
    free: number
    paid: number
}

/** The balance after paying `cost`, free beads first; null when both together don't cover it. */
export function payBeads(balance: BeadBalance, cost: number): BeadBalance | null {
    const free = Math.max(balance.free, 0), paid = Math.max(balance.paid, 0)
    if (cost < 0 || free + paid < cost) return null
    const fromFree = Math.min(free, cost)
    return { free: free - fromFree, paid: paid - (cost - fromFree) }
}

/**
 * Star Slivers a portal pull gives for the beads it cost (FT-61): 1 per 75 beads, 1 per 25 for the daily discounted pull
 * (https://worldflipper.wiki.gg/wiki/Star_Sliver), so a 150-bead pull and the 50-bead daily one each give 2. The original
 * counted paid beads only (its free-bead pulls replied without `star_crumb`, docs/routes/gacha_exec.md); this server
 * sells none, so every bead counts, as for the paid-only costs above. Every portal's cost is a multiple of its rate.
 */
export function starCrumbForPull(beadsSpent: number, dailyDiscount: boolean): number {
    if (!(beadsSpent > 0)) return 0
    return Math.floor(beadsSpent / (dailyDiscount ? 25 : 75))
}
