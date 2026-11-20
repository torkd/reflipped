// The node:sqlite adapter (src/data/sqlite.ts, SH-13) must behave as better-sqlite3 did where the code relies on
// it. Each expectation below was read off better-sqlite3 13.0.3 with the same statements before it was removed.

import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import Sqlite, { sqlShape } from "../src/data/sqlite"

function memory(): Sqlite {
    const db = new Sqlite(":memory:")
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT UNIQUE, amount INTEGER, data BLOB)")
    return db
}

function count(db: Sqlite): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n
}

function code(fn: () => unknown): string | undefined {
    try {
        fn()
    } catch (error) {
        return (error as { code?: string }).code
    }
    assert.fail("expected an error")
}

test("rows are plain objects, integers are numbers and BLOBs are Buffers", () => {
    const db = memory()
    const insert = db.prepare("INSERT INTO items (name, amount, data) VALUES (?, ?, ?)")
    assert.deepStrictEqual(insert.run("a", 5, Buffer.from("xyz")), { changes: 1, lastInsertRowid: 1 })
    assert.deepStrictEqual(insert.run("b", null, null), { changes: 1, lastInsertRowid: 2 })

    const row = db.prepare("SELECT * FROM items WHERE id = ?").get(1) as Record<string, unknown>
    assert.equal(Object.getPrototypeOf(row), Object.prototype)
    assert.equal(Object.prototype.hasOwnProperty.call(row, "name"), true)
    assert.deepStrictEqual(row, { id: 1, name: "a", amount: 5, data: Buffer.from("xyz") })
    assert.equal(Buffer.isBuffer(row.data), true)
    assert.equal(typeof row.id, "number")

    assert.deepStrictEqual(db.prepare("SELECT id, amount FROM items ORDER BY id").all(), [{ id: 1, amount: 5 }, { id: 2, amount: null }])
    assert.equal(db.prepare("SELECT * FROM items WHERE id = ?").get(99), undefined)
    assert.deepStrictEqual(db.prepare("SELECT * FROM items WHERE id = ?").all(99), [])
    assert.deepStrictEqual([...db.prepare("SELECT id FROM items ORDER BY id").iterate()], [{ id: 1 }, { id: 2 }])
    // two columns of one name: the last wins
    assert.deepStrictEqual(db.prepare("SELECT 1 AS a, 2 AS a").get(), { a: 2 })
    db.close()
})

test("integers keep their type and large ones are rounded, not thrown", () => {
    const db = memory()
    // a number binds as REAL (an INTEGER column stores it as an integer), a bigint as INTEGER
    assert.deepStrictEqual(db.prepare("SELECT typeof(?) AS a, typeof(?) AS b, typeof(?) AS c, 7 / ? AS d").get(5, 1.5, BigInt(5), 2),
        { a: "real", b: "real", c: "integer", d: 3.5 })
    db.prepare("INSERT INTO items (id, amount) VALUES (?, ?)").run(2 ** 40, 1_700_000_000_000)
    assert.deepStrictEqual(db.prepare("SELECT id, amount, typeof(amount) AS t FROM items").get(),
        { id: 2 ** 40, amount: 1_700_000_000_000, t: "integer" })
    assert.equal(db.prepare("INSERT INTO items (amount) VALUES (1)").run().lastInsertRowid, 2 ** 40 + 1)
    // beyond 2^53 node:sqlite alone throws ERR_OUT_OF_RANGE; better-sqlite3 gave the nearest number
    assert.deepStrictEqual(db.prepare("SELECT 9007199254740993 AS big").get(), { big: 9007199254740992 })
    db.close()
})

test("parameters bind the way better-sqlite3 bound them", () => {
    const db = memory()
    const three = db.prepare("SELECT ? AS a, @run AS r, ? AS b")
    assert.deepStrictEqual(three.get(1, 2, { run: 9 }), { a: 1, r: 9, b: 2 })
    assert.deepStrictEqual(three.get({ run: 9 }, 1, 2), { a: 1, r: 9, b: 2 })
    assert.deepStrictEqual(three.get([1, 2], { run: 9, unused: 1 }), { a: 1, r: 9, b: 2 })
    assert.deepStrictEqual(db.prepare("SELECT @run AS a, ? AS b, @run AS c").get(5, { run: undefined }), { a: null, b: 5, c: null })
    assert.deepStrictEqual(db.prepare("SELECT ? AS a, ? AS b, ? AS c").get([1, 2], 3), { a: 1, b: 2, c: 3 })
    assert.deepStrictEqual(db.prepare("SELECT ? AS a, ? AS b").get(undefined, null), { a: null, b: null })
    assert.deepStrictEqual(db.prepare("SELECT typeof(?) AS t").get(new Uint8Array([1])), { t: "blob" })

    assert.throws(() => db.prepare("SELECT ? AS a").get(true), TypeError)
    assert.throws(() => db.prepare("SELECT ? AS a").get(new Date()), TypeError)
    assert.throws(() => db.prepare("SELECT ? AS a, ? AS b").get(1), new RangeError("Too few parameter values were provided"))
    assert.throws(() => db.prepare("SELECT ? AS a").get(1, 2), new RangeError("Too many parameter values were provided"))
    assert.throws(() => db.prepare("SELECT @run AS a").get({}), new RangeError('Missing named parameter "run"'))
    assert.throws(() => db.prepare("SELECT @run AS a").get(), new TypeError("Missing named parameters"))
    // a write with a missing value must not store NULL
    assert.throws(() => db.prepare("INSERT INTO items (name, amount) VALUES (?, ?)").run("a"), RangeError)
    assert.equal(count(db), 0)
    db.close()
})

test("the parameter count is read from the statement text", () => {
    assert.deepStrictEqual(sqlShape("SELECT '?', \"a?b\", `c@d`, [e:f], 'it''s ?' FROM t WHERE x = ? -- ? @no\n AND y = :y /* ? */ AND z = $z AND y2 = :y"),
        { anonymous: 1, named: ["y", "z"], checked: true, write: false, schema: false })
    assert.equal(sqlShape("  /* note */ insert INTO t VALUES (?, ?)").write, true)
    assert.equal(sqlShape("WITH x AS (SELECT 1) DELETE FROM t").write, true)
    assert.equal(sqlShape("ALTER TABLE t ADD COLUMN a$b").schema, true)
    assert.equal(sqlShape("SELECT ?1, ?2").checked, false)
    assert.equal(sqlShape("SELECT 1;  -- done\n").anonymous, 0)
    assert.throws(() => sqlShape("SELECT 1; SELECT 2"), RangeError)
    assert.throws(() => sqlShape("  -- nothing\n"), RangeError)
    // a trigger body has statements of its own
    assert.doesNotThrow(() => sqlShape("CREATE TRIGGER x AFTER INSERT ON t BEGIN UPDATE t SET a = 1; DELETE FROM u; END"))

    const db = memory()
    assert.throws(() => db.prepare("SELECT 1; SELECT 2"), RangeError)
    db.prepare("CREATE TEMP TRIGGER no_zero BEFORE INSERT ON items WHEN NEW.amount = 0 BEGIN SELECT RAISE(ABORT, 'zero'); END").run()
    assert.throws(() => db.prepare("INSERT INTO items (amount) VALUES (?)").run(0), /zero/)
    db.close()
})

test("run() counts only what the statement itself wrote", () => {
    const db = memory()
    const insert = db.prepare("INSERT INTO items (name) VALUES (?)")
    insert.run("a")
    insert.run("b")
    assert.equal(db.prepare("UPDATE items SET amount = 1").run().changes, 2)
    // node:sqlite alone would report the previous statement's 2 for these
    assert.equal(db.prepare("SELECT 1").run().changes, 0)
    assert.equal(db.prepare("CREATE TABLE other (x)").run().changes, 0)
    assert.equal(db.prepare("DELETE FROM items WHERE id = ?").run(99).changes, 0)
    assert.equal(db.prepare("INSERT INTO items (name) VALUES (?) ON CONFLICT DO NOTHING").run("a").changes, 0)
    assert.deepStrictEqual(db.prepare("INSERT INTO items (name) VALUES (?) RETURNING id").get("c"), { id: 3 })
    assert.equal(db.prepare("DELETE FROM items").run().changes, 3)
    // reading a statement that returns no rows is a mistake, and must not run it
    assert.throws(() => insert.get("d"), TypeError)
    assert.throws(() => insert.all("d"), TypeError)
    assert.equal(count(db), 0)
    db.close()
})

test("errors carry better-sqlite3's codes", () => {
    const db = memory()
    db.exec("CREATE TABLE child (item INTEGER NOT NULL REFERENCES items (id))")
    db.prepare("INSERT INTO items (id, name) VALUES (1, 'a')").run()
    assert.equal(code(() => db.prepare("INSERT INTO items (name) VALUES ('a')").run()), "SQLITE_CONSTRAINT_UNIQUE")
    assert.equal(code(() => db.prepare("INSERT INTO items (id) VALUES (1)").run()), "SQLITE_CONSTRAINT_PRIMARYKEY")
    assert.equal(code(() => db.prepare("INSERT INTO child VALUES (NULL)").run()), "SQLITE_CONSTRAINT_NOTNULL")
    // foreign keys are enforced without a pragma, as with better-sqlite3
    assert.equal(code(() => db.prepare("INSERT INTO child VALUES (7)").run()), "SQLITE_CONSTRAINT_FOREIGNKEY")
    assert.equal(code(() => db.prepare("SELEC 1")), "SQLITE_ERROR")
    assert.equal(code(() => db.exec("INSERT INTO items (id) VALUES (1)")), "SQLITE_CONSTRAINT_PRIMARYKEY")
    // "name" in double quotes is a column, never a string
    assert.throws(() => db.prepare('SELECT "nope" FROM items'), /no such column/)
    assert.throws(() => db.prepare("INSERT INTO items (name) VALUES ('a')").run(), /UNIQUE constraint failed: items\.name/)
    db.close()
})

test("a transaction commits on return and rolls back on a throw", () => {
    const db = memory()
    const insert = db.prepare("INSERT INTO items (name) VALUES (?)")
    const add = db.transaction((name: string, fail: boolean) => {
        insert.run(name)
        if (fail) throw new Error("no")
        return db.inTransaction
    })
    assert.equal(db.inTransaction, false)
    assert.equal(add("a", false), true)
    assert.equal(db.inTransaction, false)
    assert.throws(() => add("b", true), /^Error: no$/)
    assert.equal(db.inTransaction, false)
    assert.throws(() => add("a", false), /UNIQUE/)
    assert.equal(db.inTransaction, false)
    assert.deepStrictEqual(db.prepare("SELECT name FROM items").all(), [{ name: "a" }])
    for (const begin of [add.default, add.deferred, add.immediate, add.exclusive]) assert.equal(begin(`x${count(db)}`, false), true)
    assert.equal(count(db), 5)

    // `this` and the arguments reach the function
    const echo = db.transaction(function (this: unknown, a: number, b: number) { return [this, a, b] })
    const self = { name: "self" }
    assert.deepStrictEqual(echo.call(self, 1, 2), [self, 1, 2])
    // an async function would commit before its writes: refused, and what it wrote so far is rolled back
    const promised = db.transaction(async () => { insert.run("async") })
    assert.throws(() => promised(), new TypeError("Transaction function cannot return a promise"))
    assert.equal(count(db), 5)
    db.close()
})

test("a nested transaction is a savepoint", () => {
    const db = memory()
    const insert = db.prepare("INSERT INTO items (name) VALUES (?)")
    const inner = db.transaction((name: string, fail: boolean) => {
        insert.run(name)
        if (fail) throw new Error("inner")
    })
    const outer = db.transaction((fail: boolean) => {
        insert.run("outer")
        inner("kept", false)
        assert.throws(() => inner("dropped", true), /inner/)
        // the outer transaction is still open, and the failed inner one took only its own write back
        assert.equal(db.inTransaction, true)
        assert.equal(count(db), 2)
        inner.immediate("kept too", false)
        if (fail) throw new Error("outer")
    })
    assert.throws(() => outer(true), /outer/)
    assert.equal(count(db), 0)
    outer(false)
    assert.deepStrictEqual(db.prepare("SELECT name FROM items ORDER BY id").all(), [{ name: "outer" }, { name: "kept" }, { name: "kept too" }])
    assert.equal(db.inTransaction, false)
    db.close()
})

test("a constraint that fails at COMMIT rolls the transaction back", () => {
    const db = memory()
    db.exec("CREATE TABLE child (item INTEGER REFERENCES items (id) DEFERRABLE INITIALLY DEFERRED)")
    const orphan = db.transaction(() => { db.prepare("INSERT INTO child VALUES (7)").run() })
    assert.equal(code(orphan), "SQLITE_CONSTRAINT_FOREIGNKEY")
    assert.equal(db.inTransaction, false)
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM child").get() as { n: number }).n, 0)
    db.close()
})

test("an immediate transaction takes the write lock at once, and files reopen with their data", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "reflipped-sqlite-"))
    const file = path.join(dir, "test.db")
    const first = new Sqlite(file)
    const second = new Sqlite(file, { timeout: 0 })
    try {
        assert.deepStrictEqual(first.pragma("journal_mode = WAL"), [{ journal_mode: "wal" }])
        first.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)")
        const write = second.prepare("INSERT INTO items (name) VALUES (?)")
        // deferred: no lock before the first write, so the other connection can still write
        first.transaction(() => { write.run("during deferred") })()
        // immediate: locked from BEGIN on
        first.transaction(() => {
            assert.equal(code(() => write.run("during immediate")), "SQLITE_BUSY")
        }).immediate()
        write.run("after")
        first.close()
        first.close() // closing twice is fine
        assert.equal(first.open, false)
        assert.equal(first.inTransaction, false)

        const readonly = new Sqlite(file, { readonly: true, fileMustExist: true })
        assert.deepStrictEqual(readonly.prepare("SELECT name FROM items ORDER BY id").all(), [{ name: "during deferred" }, { name: "after" }])
        assert.equal(code(() => readonly.prepare("DELETE FROM items").run()), "SQLITE_READONLY")
        assert.equal(readonly.pragma("quick_check", { simple: true }), "ok")
        readonly.close()
        assert.throws(() => new Sqlite(path.join(dir, "missing.db"), { fileMustExist: true }), TypeError)
        assert.throws(() => new Sqlite(path.join(dir, "missing.db"), { readonly: true }))
    } finally {
        first.close()
        second.close()
        rmSync(dir, { recursive: true, force: true })
    }
})

test("a closed connection refuses every call with one error", () => {
    const db = memory()
    const select = db.prepare("SELECT 1 AS one")
    const transaction = db.transaction(() => 1)
    db.close()
    const closed = new TypeError("The database connection is not open")
    assert.throws(() => select.get(), closed)
    assert.throws(() => select.all(), closed)
    assert.throws(() => select.run(), closed)
    assert.throws(() => db.prepare("SELECT 2"), closed)
    assert.throws(() => db.exec("SELECT 2"), closed)
    assert.throws(() => db.pragma("cache_size"), closed)
    assert.throws(() => transaction(), closed)
})

test("pragma() returns rows, or one value with simple", () => {
    const db = memory()
    assert.deepStrictEqual(db.pragma("cache_size = -4000"), [])
    assert.equal(db.pragma("cache_size = -4000", { simple: true }), undefined)
    assert.equal(db.pragma("cache_size", { simple: true }), -4000)
    assert.deepStrictEqual(db.pragma("cache_size"), [{ cache_size: -4000 }])
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1)
    assert.equal(db.pragma("busy_timeout", { simple: true }), 5000)
    assert.deepStrictEqual((db.pragma("table_info(items)") as { name: string }[]).map(column => column.name), ["id", "name", "amount", "data"])
    db.close()
})

test("a prepared SELECT * follows a schema change", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "reflipped-sqlite-"))
    const file = path.join(dir, "test.db")
    const db = new Sqlite(file)
    const other = new Sqlite(file)
    try {
        db.exec("CREATE TABLE t (a INTEGER, b INTEGER); INSERT INTO t VALUES (1, 2)")
        const all = db.prepare("SELECT * FROM t")
        assert.deepStrictEqual(all.get(), { a: 1, b: 2 })
        db.prepare("ALTER TABLE t ADD COLUMN c INTEGER DEFAULT 3").run()
        assert.deepStrictEqual(all.get(), { a: 1, b: 2, c: 3 })
        db.prepare("ALTER TABLE t RENAME COLUMN b TO renamed").run()
        assert.deepStrictEqual(all.get(), { a: 1, renamed: 2, c: 3 })
        db.exec("ALTER TABLE t RENAME COLUMN renamed TO b")
        assert.deepStrictEqual(all.all(), [{ a: 1, b: 2, c: 3 }])
        // a column added through another connection
        other.exec("ALTER TABLE t ADD COLUMN d INTEGER DEFAULT 4")
        assert.deepStrictEqual(all.get(), { a: 1, b: 2, c: 3, d: 4 })
    } finally {
        db.close()
        other.close()
        rmSync(dir, { recursive: true, force: true })
    }
})
