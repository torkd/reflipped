// Server-wide limits on guest accounts (SEC-16, docs/hardening.md "Security review"). The per-IP limits on the login
// and signup routes (SEC-4) bound one address; many addresses together could still fill the database with accounts,
// so `loginDevice` also refuses a new guest account once NEW_ACCOUNTS_PER_HOUR were created in the last hour, and the
// session cleanup deletes the accounts that never signed up (src/data/wdfpData.ts, deleteUnusedAccountsSync).

import { countAccountsCreatedSinceSync } from "../data/wdfpData"

const HOUR_MS = 60 * 60 * 1000
const DEFAULT_NEW_ACCOUNTS_PER_HOUR = 600

/** How old an account that never signed up must be before the cleanup deletes it (it also needs no session left). */
export const UNUSED_ACCOUNT_AGE_MS = 7 * 24 * HOUR_MS

/** `NEW_ACCOUNTS_PER_HOUR` (default 600); 0 turns the cap off. */
export function newAccountsPerHourFromEnv(value = process.env.NEW_ACCOUNTS_PER_HOUR): number {
    if (value === undefined || value.trim() === "") return DEFAULT_NEW_ACCOUNTS_PER_HOUR
    const parsed = Number.parseInt(value, 10)
    return Number.isNaN(parsed) || parsed < 0 ? DEFAULT_NEW_ACCOUNTS_PER_HOUR : parsed
}

/** Whether another guest account may be created now. Devices that already have an account never ask. */
export function newAccountAllowedSync(limit = newAccountsPerHourFromEnv(), now = Date.now()): boolean {
    return limit === 0 || countAccountsCreatedSinceSync(new Date(now - HOUR_MS)) < limit
}
