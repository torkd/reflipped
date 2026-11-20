// Party codes (FT-41): the party screen's "Show party code" sends the party to party/publish, which stores it under a
// short code; "Enter party code" on another device sends the code to party/refer, which returns the stored party.
// The client checks a typed code against /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabdefghijmnqrty]{6,}$/ before sending it,
// so codes are made from that alphabet.
import type { Statement } from "./sqlite";
import { randomInt } from "crypto";
import getDatabase, { Database } from ".";

/** The characters the client accepts in a party code (its input check, see above). */
export const PARTY_CODE_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabdefghijmnqrty"
/** 48^8 codes, so a random one never needs more than a retry. The client takes any length from 6 up. */
export const PARTY_CODE_LENGTH = 8
/** The codes a player keeps; publishing more drops their oldest. */
export const PARTY_CODES_PER_PLAYER = 50

export interface StoredPartyCode {
    partyName: string
    /** the party as the client sent it to party/publish, already checked (src/lib/partyCodes.ts) */
    battleParty: unknown
}

let statements: {
    find: Statement<[string]>
    findSame: Statement<[number, string, string]>
    remove: Statement<[string]>
    insert: Statement<[string, number, string, string, number]>
    prune: Statement<[number, number, number]>
} | null = null

/** Prepared on first use, so importing this module doesn't open the database. */
function db() {
    if (statements) return statements
    const database = getDatabase(Database.WDFP_DATA)
    statements = {
        find: database.prepare(`SELECT party_name, battle_party FROM party_codes WHERE code = ?`),
        findSame: database.prepare(`SELECT code FROM party_codes WHERE player_id = ? AND party_name = ? AND battle_party = ?`),
        remove: database.prepare(`DELETE FROM party_codes WHERE code = ?`),
        insert: database.prepare(`INSERT OR IGNORE INTO party_codes (code, player_id, party_name, battle_party, created_at) VALUES (?, ?, ?, ?, ?)`),
        prune: database.prepare(`DELETE FROM party_codes WHERE player_id = ? AND rowid NOT IN (
            SELECT rowid FROM party_codes WHERE player_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`)
    }
    return statements
}

export function randomPartyCode(): string {
    let code = ""
    for (let i = 0; i < PARTY_CODE_LENGTH; i++) code += PARTY_CODE_ALPHABET[randomInt(PARTY_CODE_ALPHABET.length)]
    return code
}

/**
 * The code of the player's party: the one it already has when the same party was published before (showing the code
 * twice gives the same code), otherwise a new one. Keeps the player's PARTY_CODES_PER_PLAYER most recently shown
 * codes: showing an old code again makes it recent, so a code just handed out isn't the next one dropped.
 */
export function publishPartyCodeSync(playerId: number, partyName: string, battleParty: unknown, now: Date): string {
    const json = JSON.stringify(battleParty)
    const same = db().findSame.get(playerId, partyName, json) as { code: string } | undefined
    if (same !== undefined) {
        // stored again rather than updated, so it is the newest row even when the clock gives the same time
        db().remove.run(same.code)
        db().insert.run(same.code, playerId, partyName, json, now.getTime())
        return same.code
    }
    for (;;) {
        const code = randomPartyCode()
        if (db().insert.run(code, playerId, partyName, json, now.getTime()).changes === 0) continue
        db().prune.run(playerId, playerId, PARTY_CODES_PER_PLAYER)
        return code
    }
}

/** The party stored under a code; null for an unknown one. */
export function findPartyCodeSync(code: string): StoredPartyCode | null {
    const row = db().find.get(code) as { party_name: string, battle_party: string } | undefined
    if (row === undefined) return null
    return { partyName: row.party_name, battleParty: JSON.parse(row.battle_party) }
}
