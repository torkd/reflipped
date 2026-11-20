// Background cleanup of expired openapi tokens (SEC-8, docs/hardening.md). Expired ZAT/ZRT rows are already
// rejected and deleted when presented; this removes the ones that never come back. Viewer sessions are kept.
// Expired device link codes (ACC-1), portal sessions (ACC-2), admin sessions (ACC-5) and shell sign-in codes (ACC-3) go on the same timer,
// and so do the accounts that never signed up (SEC-16), after their tokens, and dismissed or actioned anti-cheat flags
// older than 180 days (SEC-18).

import { adminSessions } from "../data/adminSessions"
import { deleteResolvedAnticheatFlagsSync } from "../data/anticheatData"
import { deleteExpiredPortalSessionsSync } from "../data/portalSessions"
import { deleteExpiredShellSignInsSync } from "../data/shellSignIns"
import { deleteExpiredLinkCodesSync } from "../data/users"
import { deleteExpiredTokenSessionsSync, deleteUnusedAccountsSync } from "../data/wdfpData"
import { UNUSED_ACCOUNT_AGE_MS } from "./accountLimits"

const defaultIntervalMs = 60 * 60 * 1000

/** `SESSION_CLEANUP_INTERVAL_MS` (default one hour); 0 disables the cleanup. */
export function sessionCleanupIntervalFromEnv(): number {
    const raw = process.env.SESSION_CLEANUP_INTERVAL_MS
    if (raw === undefined || raw.trim() === "") return defaultIntervalMs
    const value = Number.parseInt(raw, 10)
    return Number.isNaN(value) || value < 0 ? defaultIntervalMs : value
}

/**
 * Deletes expired ZAT/ZRT rows, link codes, portal and admin sessions and shell sign-in codes now and then every `intervalMs`. The timer doesn't keep the process alive.
 *
 * @returns A function that stops the timer.
 */
export function startSessionCleanup(
    intervalMs: number,
    log: (message: string) => void = message => console.log(message)
): () => void {
    if (intervalMs <= 0) return () => {}

    const run = () => {
        try {
            const deleted = deleteExpiredTokenSessionsSync()
            if (deleted > 0) log(`session cleanup: deleted ${deleted} expired zat/zrt sessions`)
            const codes = deleteExpiredLinkCodesSync()
            if (codes > 0) log(`session cleanup: deleted ${codes} expired link codes`)
            const portal = deleteExpiredPortalSessionsSync()
            if (portal > 0) log(`session cleanup: deleted ${portal} expired portal sessions`)
            const admin = adminSessions.deleteExpired()
            if (admin > 0) log(`session cleanup: deleted ${admin} expired admin sessions`)
            const signIns = deleteExpiredShellSignInsSync()
            if (signIns > 0) log(`session cleanup: deleted ${signIns} expired shell sign-in codes`)
            const accounts = deleteUnusedAccountsSync(new Date(Date.now() - UNUSED_ACCOUNT_AGE_MS))
            if (accounts > 0) log(`session cleanup: deleted ${accounts} accounts that never signed up`)
            const flags = deleteResolvedAnticheatFlagsSync()
            if (flags > 0) log(`session cleanup: deleted ${flags} resolved anti-cheat flags older than 180 days`)
        } catch (error) {
            console.error("session cleanup failed:", error)
        }
    }
    run()
    const timer = setInterval(run, intervalMs)
    timer.unref()
    return () => clearInterval(timer)
}
