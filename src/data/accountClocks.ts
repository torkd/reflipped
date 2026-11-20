// The `account_clocks` table (FT-5): how many days an account's clock is from the server clock
// (src/lib/playerClock.ts), and the account's own era. An account without a row follows the server clock.
import type { Statement } from "./sqlite";
import getDatabase, { Database } from ".";
import { SessionType } from "./types";

export interface AccountClock {
    /** days from the server clock; 0 follows it */
    offsetDays: number
    /** how often the account's clock was moved back by days (added to the server clock's era for its game days) */
    era: number
    source?: "player" | "admin"
}

/** The clock of an account that follows the server clock: no offset, no era of its own. */
export const SERVER_CLOCK: AccountClock = Object.freeze({ offsetDays: 0, era: 0 })

type ClockRow = { offset_days: number, era: number, source: "player" | "admin" }

let statements: {
    byAccount: Statement<[number]>
    byViewer: Statement<[string, number]>
    byPlayer: Statement<[]>
    upsert: Statement<[number, number, number, string]>
    clear: Statement<[number]>
} | null = null

/** Prepared on first use, so importing this module doesn't open the database. */
function db() {
    if (statements) return statements
    const database = getDatabase(Database.WDFP_DATA)
    statements = {
        byAccount: database.prepare(`SELECT offset_days, era, source FROM account_clocks WHERE account_id = ?`),
        byViewer: database.prepare(`
        SELECT account_clocks.offset_days, account_clocks.era, account_clocks.source
        FROM sessions JOIN account_clocks ON account_clocks.account_id = sessions.account_id
        WHERE sessions.token = ? AND sessions.type = ?
        `),
        byPlayer: database.prepare(`
        SELECT players.id AS player_id, account_clocks.offset_days, account_clocks.era, account_clocks.source
        FROM players JOIN account_clocks ON account_clocks.account_id = players.account_id
        `),
        upsert: database.prepare(`INSERT INTO account_clocks (account_id, offset_days, era, source) VALUES (?, ?, ?, ?) ON CONFLICT (account_id) DO UPDATE SET offset_days = excluded.offset_days, era = excluded.era, source = excluded.source`),
        clear: database.prepare(`DELETE FROM account_clocks WHERE account_id = ?`)
    }
    return statements
}

function clockOf(row: ClockRow | undefined): AccountClock {
    return row === undefined ? SERVER_CLOCK : { offsetDays: row.offset_days, era: row.era, source: row.source }
}

/** The account's clock (offset 0 and era 0: it follows the server clock). */
export function getAccountClockSync(accountId: number): AccountClock {
    return clockOf(db().byAccount.get(accountId) as ClockRow | undefined)
}

/** The clock of the account a viewer id belongs to; the server clock for an unknown viewer. Expiry doesn't matter: it only picks a clock. */
export function getViewerClockSync(viewerId: number): AccountClock {
    return clockOf(db().byViewer.get(String(viewerId), SessionType.VIEWER) as ClockRow | undefined)
}

/** Every player's clock, by player id, in one query; a player missing from it follows the server clock. */
export function getAllPlayerClocksSync(): Map<number, AccountClock> {
    const rows = db().byPlayer.all() as (ClockRow & { player_id: number })[]
    return new Map(rows.map(row => [row.player_id, clockOf(row)]))
}

/** Stores the account's clock; the server clock's (offset 0, era 0) removes the row. */
export function setAccountClockSync(accountId: number, clock: AccountClock) {
    if (clock.offsetDays === 0 && clock.era === 0) db().clear.run(accountId)
    else db().upsert.run(accountId, clock.offsetDays, clock.era, clock.source ?? "player")
}

/** Durable cooldown survives reconnects and clearing a personal selection. */
export function travelCooldownRemainingSync(accountId: number, now = Date.now()): number {
    db()
    const row = getDatabase(Database.WDFP_DATA).prepare("SELECT changed_at FROM account_content_travel WHERE account_id = ?").get(accountId) as { changed_at: number } | undefined
    return row ? Math.max(0, 60_000 - Math.max(0, now - row.changed_at)) : 0
}

export function recordTravelChangeSync(accountId: number, now = Date.now()): void {
    db()
    getDatabase(Database.WDFP_DATA).prepare("INSERT INTO account_content_travel(account_id, changed_at) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET changed_at = excluded.changed_at").run(accountId, now)
}
