// SEC-18 phase 4: the tables of the soft review rules R9–R12 (src/lib/anticheatStats.ts; initializer:
// anticheat_finish_stats, anticheat_play_rate, anticheat_device_keys, anticheat_linked_pairs). These run on every
// finish, so their statements are cached.
import getDatabase, { Database } from ".";
import { createStatementCache } from "./statementCache";

const prepare = createStatementCache(getDatabase(Database.WDFP_DATA), 32)

// ---- R9, R10: finish distributions ----

export interface FinishStatsRow {
    metric: string
    band: number
    samples: number
    /** bin index → count */
    bins: Record<string, number>
}

/** The quest's rows for one mode, in one power band and the all-powers band (-1). */
export function getFinishStatsRowsSync(category: number, questId: number, coop: boolean, band: number): FinishStatsRow[] {
    const rows = prepare(`SELECT metric, band, samples, bins FROM anticheat_finish_stats
        WHERE category = ? AND quest_id = ? AND coop = ? AND band IN (?, -1)`).all(category, questId, coop ? 1 : 0, band) as
        { metric: string, band: number, samples: number, bins: string }[]
    return rows.map(row => {
        let bins: Record<string, number> = {}
        try { bins = JSON.parse(row.bins) } catch { /* an unreadable row starts again */ }
        return { metric: row.metric, band: row.band, samples: row.samples, bins }
    })
}

export function setFinishStatsRowSync(category: number, questId: number, coop: boolean, row: FinishStatsRow): void {
    prepare(`INSERT INTO anticheat_finish_stats (category, quest_id, coop, metric, band, samples, bins) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (category, quest_id, coop, band, metric) DO UPDATE SET samples = excluded.samples, bins = excluded.bins`)
        .run(category, questId, coop ? 1 : 0, row.metric, row.band, row.samples, JSON.stringify(row.bins))
}

// ---- R11: play rate ----

export interface PlayRateRow {
    hour: number
    hourCount: number
    sessionStart: number
    lastFinish: number
    flaggedHour: number
    flaggedSession: number
}

export function getPlayRateSync(playerId: number): PlayRateRow | null {
    const row = prepare(`SELECT hour, hour_count, session_start, last_finish, flagged_hour, flagged_session
        FROM anticheat_play_rate WHERE player_id = ?`).get(playerId) as Record<string, number> | undefined
    return row === undefined ? null : {
        hour: row.hour, hourCount: row.hour_count, sessionStart: row.session_start, lastFinish: row.last_finish,
        flaggedHour: row.flagged_hour, flaggedSession: row.flagged_session
    }
}

export function setPlayRateSync(playerId: number, row: PlayRateRow): void {
    prepare(`INSERT INTO anticheat_play_rate (player_id, hour, hour_count, session_start, last_finish, flagged_hour, flagged_session)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (player_id) DO UPDATE SET hour = excluded.hour, hour_count = excluded.hour_count,
        session_start = excluded.session_start, last_finish = excluded.last_finish, flagged_hour = excluded.flagged_hour,
        flagged_session = excluded.flagged_session`)
        .run(playerId, row.hour, row.hourCount, row.sessionStart, row.lastFinish, row.flaggedHour, row.flaggedSession)
}

// ---- R12: linked accounts ----

export function noteDeviceKeySync(deviceKey: string, playerId: number, nowMs: number): void {
    prepare(`INSERT INTO anticheat_device_keys (device_key, player_id, last_seen) VALUES (?, ?, ?)
        ON CONFLICT (device_key, player_id) DO UPDATE SET last_seen = excluded.last_seen`).run(deviceKey, playerId, nowMs)
}

/** Forgets device keys not seen since `beforeMs`. */
export function pruneDeviceKeysSync(beforeMs: number): number {
    return Number(prepare(`DELETE FROM anticheat_device_keys WHERE last_seen < ?`).run(beforeMs).changes)
}

/** The other players who finished battles with one of this player's device keys (seen since `sinceMs`). */
export function playersSharingDeviceKeySync(playerId: number, sinceMs: number): number[] {
    return (prepare(`SELECT DISTINCT other.player_id AS id FROM anticheat_device_keys own
        JOIN anticheat_device_keys other ON other.device_key = own.device_key
        WHERE own.player_id = ? AND other.player_id != own.player_id AND other.last_seen >= ? AND own.last_seen >= ?`)
        .all(playerId, sinceMs, sinceMs) as { id: number }[]).map(row => row.id)
}

/** The other players whose accounts belong to the same portal user as this account. */
export function playersOfSamePortalUserSync(accountId: number, playerId: number): number[] {
    return (prepare(`SELECT players.id AS id FROM accounts own
        JOIN accounts other ON other.user_id = own.user_id
        JOIN players ON players.account_id = other.id
        WHERE own.id = ? AND own.user_id IS NOT NULL AND players.id != ?`).all(accountId, playerId) as { id: number }[]).map(row => row.id)
}

/** Records a linked pair; false when it was recorded before (each pair is flagged once). */
export function insertLinkedPairSync(a: number, b: number, created: Date): boolean {
    const [low, high] = a < b ? [a, b] : [b, a]
    return Number(prepare(`INSERT OR IGNORE INTO anticheat_linked_pairs (player_id, other_id, created) VALUES (?, ?, ?)`)
        .run(low, high, created.toISOString()).changes) > 0
}
