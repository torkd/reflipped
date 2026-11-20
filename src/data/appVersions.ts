// SH-15: the Reflipped app version and build each account last signed in with (loginDevice), for the admin Players
// page. A sign-in that names no version (an app from before SH-15, or the original game) stores null for both.
import type { Statement } from "./sqlite";
import getDatabase, { Database } from ".";
import type { ReportedApp } from "../lib/appVersion";

export interface AccountApp {
    /** null: the last sign-in named no version */
    version: string | null
    build: string | null
    seenAt: Date
}

interface Row { version: string | null, build: string | null, seen_at: string | null }

let statements: {
    record: Statement<[string | null, string | null, string, number]>
    byPlayer: Statement<[number]>
    allPlayers: Statement<[]>
} | null = null

/** Prepared on first use, so importing this module doesn't open the database. */
function db() {
    if (statements) return statements
    const database = getDatabase(Database.WDFP_DATA)
    statements = {
        record: database.prepare(`UPDATE accounts SET app_version = ?, app_build = ?, app_seen_at = ? WHERE id = ?`),
        byPlayer: database.prepare(`SELECT accounts.app_version AS version, accounts.app_build AS build, accounts.app_seen_at AS seen_at
            FROM players JOIN accounts ON accounts.id = players.account_id WHERE players.id = ?`),
        allPlayers: database.prepare(`SELECT players.id AS player_id, accounts.app_version AS version, accounts.app_build AS build,
            accounts.app_seen_at AS seen_at FROM players JOIN accounts ON accounts.id = players.account_id`)
    }
    return statements
}

function build(row: Row | undefined): AccountApp | null {
    if (row === undefined || row.seen_at === null) return null
    const seenAt = new Date(row.seen_at)
    return Number.isNaN(seenAt.getTime()) ? null : { version: row.version, build: row.build, seenAt }
}

/** Remembers what app the account signed in with just now (real time, not the server clock). */
export function recordAccountAppSync(accountId: number, app: ReportedApp | null, now: Date = new Date()): void {
    db().record.run(app?.version ?? null, app?.build ?? null, now.toISOString(), accountId)
}

/** The app the player's account last signed in with; null when it hasn't signed in since app versions were recorded. */
export function getPlayerAppSync(playerId: number): AccountApp | null {
    return build(db().byPlayer.get(playerId) as Row | undefined)
}

/** getPlayerAppSync for every player, by player ID (players without a record are left out). */
export function getAllPlayerAppsSync(): Map<number, AccountApp> {
    const result = new Map<number, AccountApp>()
    for (const row of db().allPlayers.all() as (Row & { player_id: number })[]) {
        const app = build(row)
        if (app !== null) result.set(row.player_id, app)
    }
    return result
}
