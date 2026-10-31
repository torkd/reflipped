import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { createTestServer } from "./helpers";

// PERF-1: without an index that starts with player_id, every per-player query scans the rows of all players.

let db: BetterSqlite3Database
let cleanup: () => Promise<void>

before(async () => {
    const server = await createTestServer()
    cleanup = server.cleanup
    const { default: getDatabase, Database } = await import("../src/data")
    db = getDatabase(Database.WDFP_DATA)
})

after(async () => {
    await cleanup()
})

function tables(): string[] {
    return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[])
        .map(row => row.name)
}

// leading columns of every index on the table, primary key included (a rowid table's INTEGER PRIMARY KEY has no entry)
function indexColumns(table: string): string[][] {
    const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]
    return indexes.map(index =>
        (db.prepare(`PRAGMA index_info(${index.name})`).all() as { seqno: number, name: string }[])
            .sort((a, b) => a.seqno - b.seqno)
            .map(column => column.name))
}

// true when some index starts with exactly these columns, in any order (equality lookups)
function isCovered(table: string, columns: string[]): boolean {
    return indexColumns(table).some(index =>
        index.length >= columns.length && columns.every(column => index.slice(0, columns.length).includes(column)))
}

test("every table with a player_id column has an index starting with it", () => {
    const missing = tables().filter(table => {
        const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name)
        return columns.includes("player_id") && !isCovered(table, ["player_id"])
    })
    assert.deepEqual(missing, [])
})

test("every foreign key's child columns are indexed, so cascading deletes don't scan", () => {
    const missing: string[] = []
    for (const table of tables()) {
        const keys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as { id: number, from: string }[]
        const byId = new Map<number, string[]>()
        for (const key of keys) byId.set(key.id, [...(byId.get(key.id) ?? []), key.from])
        for (const columns of byId.values())
            if (!isCovered(table, columns)) missing.push(`${table} (${columns.join(", ")})`)
    }
    assert.deepEqual(missing, [])
})

test("per-player queries search an index", () => {
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1) as { detail: string }[])
        .map(row => row.detail).join("; ")
    for (const sql of [
        `SELECT * FROM players_characters WHERE player_id = ?`,
        `SELECT * FROM players_quest_progress WHERE player_id = ?`,
        `SELECT * FROM players_items WHERE player_id = ?`,
        `SELECT * FROM players WHERE account_id = ?`,
    ]) assert.match(plan(sql), /SEARCH/, sql)
})
