import assert from "node:assert/strict"
import { test } from "node:test"
import Sqlite from "../src/data/sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { configureSqlite, sqlitePragmas } from "../src/lib/sqliteTuning"

test("lean SQLite defaults and opt-in budgets apply to a temporary file", (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sqlite-tuning-config-"))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const db = new Sqlite(path.join(root, "synthetic.db"))
    try {
        configureSqlite(db, {})
        for (const [name, expected] of Object.entries({ journal_mode: "wal", synchronous: 1, busy_timeout: 5000,
            cache_size: -16384, mmap_size: 0, temp_store: 1, foreign_keys: 1 }))
            assert.equal(db.pragma(name, { simple: true }), expected, name)
        configureSqlite(db, { SQLITE_CACHE_MB: "32", SQLITE_MMAP_MB: "64" })
        assert.equal(db.pragma("cache_size", { simple: true }), -32768)
        const effective = db.pragma("mmap_size", { simple: true }) as number
        assert.ok(effective >= 0 && effective <= 67108864)
        configureSqlite(db, { SQLITE_CACHE_MB: "2", SQLITE_MMAP_MB: "0" })
        assert.equal(db.pragma("mmap_size", { simple: true }), 0)
    } finally { db.close() }
})

test("budget validation rejects malformed/out-of-range values before changing the connection", () => {
    for (const [name, bad] of [
        ["SQLITE_CACHE_MB", "1"], ["SQLITE_CACHE_MB", "257"], ["SQLITE_MMAP_MB", "1025"],
        ...["-1", "1.5", "1e2", "8MiB", "Infinity", "9007199254740993"].map(value => ["SQLITE_CACHE_MB", value]),
    ]) assert.throws(() => sqlitePragmas({ [name]: bad }), new RegExp(name))
    assert.doesNotThrow(() => sqlitePragmas({ SQLITE_CACHE_MB: "256", SQLITE_MMAP_MB: "1024" }))
    const db = new Sqlite(":memory:")
    try {
        db.pragma("cache_size = -1234")
        assert.throws(() => configureSqlite(db, { SQLITE_CACHE_MB: "9", SQLITE_MMAP_MB: "-1" }), /SQLITE_MMAP_MB/)
        assert.equal(db.pragma("cache_size", { simple: true }), -1234)
    } finally { db.close() }
})

test("startup reopens with persisted budgets ahead of env, without importing serverSettings", (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sqlite-tuning-startup-"))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const file = path.join(root, "synthetic.db")
    const seed = new Sqlite(file)
    seed.exec("CREATE TABLE server_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO server_settings VALUES('database.cache_mib','16'),('database.mmap_mib','0')")
    seed.close()
    const reopened = new Sqlite(file)
    try {
        configureSqlite(reopened, { SQLITE_CACHE_MB: "not-used", SQLITE_MMAP_MB: "not-used" })
        assert.equal(reopened.pragma("cache_size", { simple: true }), -16384)
        assert.equal(reopened.pragma("mmap_size", { simple: true }), 0)
        assert.equal(reopened.pragma("temp_store", { simple: true }), 1)
    } finally { reopened.close() }
})


test("blank environment budgets use built-ins and padded numeric overrides are trimmed", () => {
    const defaults = sqlitePragmas({})
    for (const blank of ["", " ", "\t\n"]) {
        assert.deepEqual(sqlitePragmas({ SQLITE_CACHE_MB: blank, SQLITE_MMAP_MB: blank }), defaults)
    }
    assert.deepEqual(sqlitePragmas({ SQLITE_CACHE_MB: " 32 ", SQLITE_MMAP_MB: "\t64\n" }),
        sqlitePragmas({ SQLITE_CACHE_MB: "32", SQLITE_MMAP_MB: "64" }))
    assert.ok(defaults.includes("cache_size = -16384"))
})
