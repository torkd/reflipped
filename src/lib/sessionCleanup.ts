// Background cleanup of expired openapi tokens (SEC-8, docs/hardening.md). Expired ZAT/ZRT rows are already
// rejected and deleted when presented; this removes the ones that never come back. Viewer sessions are kept.

import { deleteExpiredTokenSessionsSync } from "../data/wdfpData"

const defaultIntervalMs = 60 * 60 * 1000

/** `SESSION_CLEANUP_INTERVAL_MS` (default one hour); 0 disables the cleanup. */
export function sessionCleanupIntervalFromEnv(): number {
    const raw = process.env.SESSION_CLEANUP_INTERVAL_MS
    if (raw === undefined || raw.trim() === "") return defaultIntervalMs
    const value = Number.parseInt(raw, 10)
    return Number.isNaN(value) || value < 0 ? defaultIntervalMs : value
}

/**
 * Deletes expired ZAT/ZRT rows now and then every `intervalMs`. The timer doesn't keep the process alive.
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
        } catch (error) {
            console.error("session cleanup failed:", error)
        }
    }
    run()
    const timer = setInterval(run, intervalMs)
    timer.unref()
    return () => clearInterval(timer)
}
