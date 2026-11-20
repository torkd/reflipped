import assert from "node:assert/strict";
import { test } from "node:test";
import Sqlite from "../src/data/sqlite";
import { createStatementCache } from "../src/data/statementCache";

test("cached statements bind fresh values, see writes and preserve transaction rollback", () => {
    const db = new Sqlite(":memory:")
    try {
        db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)")
        const prepare = createStatementCache(db)
        const insert = prepare("INSERT INTO items VALUES (?, ?)")
        insert.run(1, "first")
        insert.run(2, "second")
        const select = prepare("SELECT value FROM items WHERE id = ?")
        assert.strictEqual(select, prepare("SELECT value FROM items WHERE id = ?"))
        assert.deepEqual(select.get(1), { value: "first" })
        assert.deepEqual(select.get(2), { value: "second" })
        assert.throws(db.transaction(() => {
            prepare("UPDATE items SET value = ? WHERE id = ?").run("changed", 1)
            assert.deepEqual(select.get(1), { value: "changed" })
            throw new Error("rollback")
        }), /rollback/)
        assert.deepEqual(select.get(1), { value: "first" })
    } finally { db.close() }
})

test("cache is bounded, keeps recently used SQL and does not cross connections", () => {
    const db = new Sqlite(":memory:")
    const other = new Sqlite(":memory:")
    try {
        const prepare = createStatementCache(db, 2)
        const first = prepare("SELECT 1")
        const second = prepare("SELECT 2")
        assert.strictEqual(first, prepare("SELECT 1"))
        prepare("SELECT 3")
        assert.strictEqual(first, prepare("SELECT 1"))
        assert.notStrictEqual(second, prepare("SELECT 2"))
        assert.notStrictEqual(first, createStatementCache(other)("SELECT 1"))
        assert.throws(() => createStatementCache(db, 0), RangeError)
        assert.throws(() => prepare("INVALID SQL"))
        assert.deepEqual(prepare("SELECT 2").get(), { "2": 2 })
    } finally { db.close(); other.close() }
})

test("closing a connection does not turn cached statements into cached results", () => {
    const db = new Sqlite(":memory:")
    const prepare = createStatementCache(db)
    const statement = prepare("SELECT 1")
    db.close()
    assert.throws(() => statement.get(), /not open/)
    assert.throws(() => prepare("SELECT 2"), /not open/)
})
