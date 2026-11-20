// No app/data imports: startup can read saved budgets without recursing through getDatabase().
import type { Database } from "../data/sqlite"

export const DATABASE_BUDGETS = [
    { key: "database.cache_mib", env: "SQLITE_CACHE_MB", min: 2, max: 256, fallback: 16 },
    { key: "database.mmap_mib", env: "SQLITE_MMAP_MB", min: 0, max: 1024, fallback: 0 },
] as const
export type DatabaseBudgetKey = typeof DATABASE_BUDGETS[number]["key"]

export function databaseBudgetDefault(key: DatabaseBudgetKey, env: NodeJS.ProcessEnv = process.env): number {
    const spec = DATABASE_BUDGETS.find(candidate => candidate.key === key)!
    const raw = env[spec.env]?.trim()
    if (!raw) return spec.fallback
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < spec.min || Number(raw) > spec.max)
        throw new RangeError(`${spec.env} must be a whole number from ${spec.min} to ${spec.max} MiB`)
    return Number(raw)
}

function budgets(env: NodeJS.ProcessEnv, saved: Record<string, string> = {}): number[] {
    return DATABASE_BUDGETS.map(spec => {
        const raw = saved[spec.key]
        const n = raw !== undefined && /^\d{1,6}$/.test(raw) ? Number(raw) : NaN
        return Number.isInteger(n) && n >= spec.min && n <= spec.max ? n : databaseBudgetDefault(spec.key, env)
    })
}

export function sqlitePragmas(env: NodeJS.ProcessEnv = process.env, saved: Record<string, string> = {}): string[] {
    const [cacheMiB, mmapMiB] = budgets(env, saved)
    return [
        "journal_mode = WAL",
        "synchronous = NORMAL", // Power/OS failure may roll back recent commits; keep online backups.
        "busy_timeout = 5000", // The connection default (src/data/sqlite.ts), stated; lock waiting blocks this event loop.
        `cache_size = -${cacheMiB * 1024}`,
        `mmap_size = ${mmapMiB * 1024 * 1024}`,
        "temp_store = FILE", // Keep large temporary data outside the page-cache memory budget.
        "foreign_keys = ON",
    ]
}

function savedBudgets(db: Database): Record<string, string> {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='server_settings'").get()) return {}
    return Object.fromEntries((db.prepare("SELECT key,value FROM server_settings WHERE key IN (?,?)")
        .all(...DATABASE_BUDGETS.map(spec => spec.key)) as { key: string; value: string }[]).map(row => [row.key, row.value]))
}

export interface SqliteBudgets { cacheMiB: number; mmapMiB: number }

/** Validate the future policy before a save/reset changes any stored values. null deletes an override. */
export function resolveSqliteBudgets(db: Database, updates: Record<string, string | null> = {}, env: NodeJS.ProcessEnv = process.env): SqliteBudgets {
    const saved = savedBudgets(db)
    for (const [key, value] of Object.entries(updates)) {
        if (value === null) delete saved[key]
        else saved[key] = value
    }
    const [cacheMiB, mmapMiB] = budgets(env, saved)
    return { cacheMiB, mmapMiB }
}

/** Apply already validated numbers after commit, without re-reading environment defaults. */
export function applySqliteBudgets(db: Database, policy: SqliteBudgets): void {
    db.pragma(`cache_size = -${policy.cacheMiB * 1024}`)
    db.pragma(`mmap_size = ${policy.mmapMiB * 1024 * 1024}`)
}

export function configureSqlite(db: Database, env: NodeJS.ProcessEnv = process.env): void {
    // Read an existing settings table directly before init; no schema/version change and no circular imports.
    for (const pragma of sqlitePragmas(env, savedBudgets(db))) db.pragma(pragma)
}
