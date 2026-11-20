// SEC-18: the anti-cheat tables (initializer: anticheat_flags, anticheat_players). Prepared per call: flags are rare.
import getDatabase, { Database } from ".";

export type FlagSeverity = "hard" | "soft" | "info"
export type FlagStatus = "open" | "dismissed" | "actioned"

export interface AnticheatFlag {
    id: number
    playerId: number
    rule: string
    severity: FlagSeverity
    route: string | null
    questId: number | null
    details: Record<string, unknown>
    reqId: string | null
    created: Date
    status: FlagStatus
    resolvedBy: number | null
}

interface FlagRow {
    id: number, player_id: number, rule: string, severity: FlagSeverity, route: string | null, quest_id: number | null,
    details: string, req_id: string | null, created: string, status: FlagStatus, resolved_by: number | null
}

const db = () => getDatabase(Database.WDFP_DATA)

function flagFromRow(row: FlagRow): AnticheatFlag {
    let details: Record<string, unknown> = {}
    try { details = JSON.parse(row.details) } catch { /* left empty */ }
    return {
        id: row.id, playerId: row.player_id, rule: row.rule, severity: row.severity, route: row.route,
        questId: row.quest_id, details, reqId: row.req_id, created: new Date(row.created), status: row.status,
        resolvedBy: row.resolved_by
    }
}

export function insertAnticheatFlagSync(flag: Omit<AnticheatFlag, "id" | "status" | "resolvedBy">): number {
    const result = db().prepare(`INSERT INTO anticheat_flags (player_id, rule, severity, route, quest_id, details, req_id, created)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(flag.playerId, flag.rule, flag.severity, flag.route, flag.questId,
        JSON.stringify(flag.details), flag.reqId, flag.created.toISOString())
    return Number(result.lastInsertRowid)
}

/**
 * Counts one more occurrence on the player's newest open flag of this rule and quest, if there is one: its details get
 * `repeats` (2 for the first repeat) and `lastSeen`. Returns whether a flag was updated (none: record a new one).
 */
export function repeatOpenAnticheatFlagSync(playerId: number, rule: string, questId: number | null, at: Date): boolean {
    return Number(db().prepare(`UPDATE anticheat_flags
        SET details = json_set(details, '$.repeats', COALESCE(json_extract(details, '$.repeats'), 1) + 1, '$.lastSeen', ?)
        WHERE id = (SELECT id FROM anticheat_flags WHERE player_id = ? AND rule = ? AND quest_id IS ? AND status = 'open'
            ORDER BY id DESC LIMIT 1)`).run(at.toISOString(), playerId, rule, questId).changes) > 0
}

/** How long a dismissed or actioned flag is kept (the hourly cleanup, src/lib/sessionCleanup.ts). */
export const RESOLVED_FLAG_RETENTION_MS = 180 * 24 * 3600_000

/**
 * Deletes dismissed and actioned flags created before `before` (by default RESOLVED_FLAG_RETENTION_MS ago). Open flags
 * stay however old. Returns how many.
 */
export function deleteResolvedAnticheatFlagsSync(before = new Date(Date.now() - RESOLVED_FLAG_RETENTION_MS)): number {
    return Number(db().prepare(`DELETE FROM anticheat_flags WHERE status != 'open' AND created < ?`).run(before.toISOString()).changes)
}

/** A player's flags, newest first. */
export function getPlayerAnticheatFlagsSync(playerId: number, limit = 100): AnticheatFlag[] {
    return (db().prepare(`SELECT * FROM anticheat_flags WHERE player_id = ? ORDER BY id DESC LIMIT ?`)
        .all(playerId, limit) as unknown as FlagRow[]).map(flagFromRow)
}

/** Open flags by player (hard and soft; informational flags don't count). */
export function countOpenAnticheatFlagsSync(): Map<number, number> {
    const rows = db().prepare(`SELECT player_id, COUNT(*) AS open FROM anticheat_flags
        WHERE status = 'open' AND severity != 'info' GROUP BY player_id`).all() as unknown as { player_id: number, open: number }[]
    return new Map(rows.map(row => [row.player_id, row.open]))
}

export function isPlayerRestrictedSync(playerId: number): boolean {
    const row = db().prepare(`SELECT restricted FROM anticheat_players WHERE player_id = ?`).get(playerId) as { restricted: number } | undefined
    return row?.restricted === 1
}

/** Every restricted player, for the shared boards to leave out. */
export function getRestrictedPlayerIdsSync(): number[] {
    return (db().prepare(`SELECT player_id FROM anticheat_players WHERE restricted = 1`).all() as unknown as { player_id: number }[])
        .map(row => row.player_id)
}

export type FlagStatusFilter = FlagStatus | "all"

export interface FlagQuery {
    status?: FlagStatusFilter
    playerId?: number
    limit?: number
}

/** Flags for the review page, newest first. Informational flags are included; the page labels them. */
export function listAnticheatFlagsSync(query: FlagQuery = {}): AnticheatFlag[] {
    const where: string[] = []
    const params: (string | number)[] = []
    if (query.status !== undefined && query.status !== "all") { where.push("status = ?"); params.push(query.status) }
    if (query.playerId !== undefined) { where.push("player_id = ?"); params.push(query.playerId) }
    params.push(query.limit ?? 200)
    return (db().prepare(`SELECT * FROM anticheat_flags ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
        .all(...params) as unknown as FlagRow[]).map(flagFromRow)
}

export function getAnticheatFlagSync(id: number): AnticheatFlag | null {
    const row = db().prepare(`SELECT * FROM anticheat_flags WHERE id = ?`).get(id) as FlagRow | undefined
    return row === undefined ? null : flagFromRow(row)
}

/** Closes one open flag (`dismissed`: nothing wrong; `actioned`: acted on). Returns whether a flag was open. */
export function resolveAnticheatFlagSync(id: number, status: "dismissed" | "actioned", by: number | null): boolean {
    return Number(db().prepare(`UPDATE anticheat_flags SET status = ?, resolved_by = ? WHERE id = ? AND status = 'open'`).run(status, by, id).changes) > 0
}

/** Closes every open flag of a player as acted on (restricting or blocking them). Returns how many. */
export function resolveOpenAnticheatFlagsOfPlayerSync(playerId: number, by: number | null): number {
    return Number(db().prepare(`UPDATE anticheat_flags SET status = 'actioned', resolved_by = ? WHERE player_id = ? AND status = 'open'`).run(by, playerId).changes)
}

/**
 * The restricted players as a set, for every board read (src/lib/anticheat.ts boardHiddenPlayers). Cached: restriction
 * changes only through setPlayerRestrictedSync, which drops the cache; a minute's lifetime also catches a change rolled
 * back after it was read.
 */
let restrictedCache: { players: ReadonlySet<number>, readAt: number } | null = null
const RESTRICTED_CACHE_MS = 60_000

export function restrictedPlayerSetSync(): ReadonlySet<number> {
    const now = Date.now()
    if (restrictedCache === null || now - restrictedCache.readAt > RESTRICTED_CACHE_MS) {
        restrictedCache = { players: new Set(getRestrictedPlayerIdsSync()), readAt: now }
    }
    return restrictedCache.players
}

export function setPlayerRestrictedSync(playerId: number, restricted: boolean, by: number | null): void {
    restrictedCache = null
    db().prepare(`INSERT INTO anticheat_players (player_id, restricted, restricted_at, restricted_by) VALUES (?, ?, ?, ?)
        ON CONFLICT (player_id) DO UPDATE SET restricted = excluded.restricted, restricted_at = excluded.restricted_at,
        restricted_by = excluded.restricted_by`).run(playerId, restricted ? 1 : 0, restricted ? new Date().toISOString() : null, restricted ? by : null)
}
