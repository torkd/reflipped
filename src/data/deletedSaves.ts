// Saves a player deleted (FT-59, src/lib/saveDeletion.ts): each one kept, gzipped, until it expires, for an admin to
// restore. Times are real time (ms), not the server clock.
import getDatabase, { Database } from ".";

const db = () => getDatabase(Database.WDFP_DATA)

export type DeletionSource = "game" | "portal"

export interface DeletedSave {
    id: number
    accountId: number
    playerId: number
    name: string
    rank: number
    source: DeletionSource
    deletedAt: Date
    expiresAt: Date
}

type Row = {
    id: number, account_id: number, player_id: number, name: string, rank: number, source: string,
    deleted_at: number, expires_at: number
}

const COLUMNS = "id, account_id, player_id, name, rank, source, deleted_at, expires_at"

function build(row: Row): DeletedSave {
    return {
        id: row.id, accountId: row.account_id, playerId: row.player_id, name: row.name, rank: row.rank,
        source: row.source === "portal" ? "portal" : "game", deletedAt: new Date(row.deleted_at), expiresAt: new Date(row.expires_at)
    }
}

export function insertDeletedSaveSync(save: Omit<DeletedSave, "id">, data: Buffer): number {
    return Number(db().prepare(`INSERT INTO deleted_saves (account_id, player_id, name, rank, source, deleted_at, expires_at, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(save.accountId, save.playerId, save.name, save.rank, save.source,
        save.deletedAt.getTime(), save.expiresAt.getTime(), data).lastInsertRowid)
}

/** The kept saves, newest first. */
export function listDeletedSavesSync(): DeletedSave[] {
    return (db().prepare(`SELECT ${COLUMNS} FROM deleted_saves ORDER BY deleted_at DESC, id DESC`).all() as Row[]).map(build)
}

export function getDeletedSaveSync(id: number): { save: DeletedSave, data: Buffer } | null {
    const row = db().prepare(`SELECT ${COLUMNS}, data FROM deleted_saves WHERE id = ?`).get(id) as (Row & { data: Uint8Array }) | undefined
    return row === undefined ? null : { save: build(row), data: Buffer.from(row.data) }
}

export function deleteDeletedSaveSync(id: number): void {
    db().prepare(`DELETE FROM deleted_saves WHERE id = ?`).run(id)
}

/** Removes the saves kept past their time; returns how many. */
export function purgeExpiredDeletedSavesSync(now: number = Date.now()): number {
    return Number(db().prepare(`DELETE FROM deleted_saves WHERE expires_at <= ?`).run(now).changes)
}
