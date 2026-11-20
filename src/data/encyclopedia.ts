// Per-player encyclopedia read state. The asset's keys are the known composite information IDs; its old hardcoded
// read flags are not player history. Eligibility/availability is a separate policy from whether an entry was read.
import getDatabase, { Database } from ".";
import encyclopedia from "../../assets/encyclopedia.json";

export type EncyclopediaList = Record<string, { read: boolean }>
export const isKnownEncyclopediaId = (id: number): boolean => Number.isSafeInteger(id)
    && Object.prototype.hasOwnProperty.call(encyclopedia, String(id))

/** Retain the emulator's existing access to known entries, initially unread, then overlay the player's own history. */
export function getPlayerEncyclopediaSync(playerId: number): EncyclopediaList {
    const list: EncyclopediaList = Object.fromEntries(Object.keys(encyclopedia).map(id => [id, { read: false }]))
    const rows = getDatabase(Database.WDFP_DATA).prepare(
        `SELECT encyclopedia_id, is_read FROM players_encyclopedia WHERE player_id = ?`
    ).all(playerId) as { encyclopedia_id: number, is_read: number }[]
    for (const row of rows) if (isKnownEncyclopediaId(row.encyclopedia_id))
        list[row.encyclopedia_id] = { read: row.is_read === 1 }
    return list
}

/** Unlock never resets an already-read entry. Call inside the route's transaction after validating the entire batch. */
export function updatePlayerEncyclopediaSync(playerId: number, ids: number[], read: boolean): EncyclopediaList {
    const db = getDatabase(Database.WDFP_DATA)
    const insert = db.prepare(`INSERT INTO players_encyclopedia (player_id, encyclopedia_id, is_read) VALUES (?, ?, ?)
        ON CONFLICT (player_id, encyclopedia_id) DO UPDATE SET is_read = MAX(is_read, excluded.is_read)`)
    const find = db.prepare(`SELECT is_read FROM players_encyclopedia WHERE player_id = ? AND encyclopedia_id = ?`)
    const list: EncyclopediaList = {}
    for (const id of new Set(ids)) {
        insert.run(playerId, id, read ? 1 : 0)
        list[id] = { read: (find.get(playerId, id) as { is_read: number }).is_read === 1 }
    }
    return list
}
