// What a player can own, as the game's client enforces it, and the limits the admin mail sticks to.
//
// The client checks every grant with canGet* methods ("owned + amount <= max") and does its arithmetic in
// 32-bit ints, so a value past a limit (or past 2^31) can crash its main screen. These values are from the
// game's config table (`max_virtual_money`, `max_star_crumb`, ...), its item table (`max_count`, per item,
// assets/item_max_count.json) and constants in the client (units: 99 copies). See docs/game-system-unlocks.md
// for where the master data lives.

import itemMaxCounts from "../../assets/item_max_count.json";

export const playerLimits = {
    /** paid and free vmoney together (the client tests the sum) */
    virtualMoney: 999_999,
    starCrumb: 999_999,
    mana: 999_999_999,
    /** the client's pooled exp can be 2,000,000,000 but only shows up to 999,999,999 */
    expPool: 999_999_999,
    bondToken: 99_999,
    bossBoostPoint: 30,
    boostPoint: 20,
    /** copies of one armament; the client allows stack 999 on top of the first copy */
    equipmentCopies: 1000,
    /** copies of one unit (hardcoded in the client's canGetCharacter) */
    unitCopies: 99
}

/** Items the game's item table doesn't know are not limited by it; these are refused when sending anyway. */
export function getItemMaxCountSync(itemId: string | number): number | null {
    return (itemMaxCounts as Record<string, number>)[String(itemId)] ?? null
}

/** Limits for admin-sent mail. The game doesn't define them, so these are the admin form's own. */
export const mailLimits = {
    subjectLength: 100,
    descriptionLength: 500,
    /** mails a player can have waiting; the client's list pages hold 100 */
    pendingMails: 1000
}

/** Clamps a count from the database to 0..max, for values sent to the client. */
export function clampCount(value: number, max: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.min(Math.trunc(value), max)) : 0
}
